// =========================================================================
// mcp-token-copy-status.test.js —— 复制失败不能提示成功（v7 §5-8 / #27b）
//
// 原缺陷：`copy()` 把 navigator.clipboard.writeText 的异常吞掉，两个调用方
// （复制令牌 / 复制配置）无条件 notify.success。系统拒绝剪贴板时界面显示「已复制」，
// 用户粘到 Claude Desktop 才发现是空的 —— 排查方向全错。
//
// 判据：把真实的 copy / copyPlain / copyConfig 抽出来跑（axios / notify / configFor /
// navigator 全部注入），比对提示内容；不是复刻逻辑的镜像测试。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const VUE = 'student-frontend/src/components/data-manage/McpTokensDialog.vue'

function functionSource(src, name) {
  const start = src.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `找不到 async function ${name}`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`async function ${name} 的大括号没有配平`)
}

// 用给定的源码搭运行环境：clipboard 可注入成功/失败，axios 可注入接口错误
function build(src, { clipboard, apiError } = {}) {
  const body = ['copy', 'copyPlain', 'copyConfig']
    .map(n => functionSource(src, n))
    .join('\n')
  const notes = []
  const written = []
  const notify = {
    success: (m) => notes.push(['success', m]),
    error: (m) => notes.push(['error', m]),
  }
  const axios = {
    async get() {
      if (apiError) throw Object.assign(new Error('接口炸了'), { response: { data: { error: '接口炸了' } } })
      return { data: { token: 'tk_abc' } }
    },
  }
  const configFor = (token) => ({ mcpServers: { classnest: { args: [token] } } })
  const navigator = {
    clipboard: {
      async writeText(t) {
        if (clipboard === 'reject') throw new Error('NotAllowedError')
        written.push(t)
      },
    },
  }
  const factory = new Function(
    'axios', 'notify', 'configFor', 'navigator',
    `${body}\nreturn { copy, copyPlain, copyConfig };`,
  )
  return { api: factory(axios, notify, configFor, navigator), notes, written }
}

const src = fs.readFileSync(path.join(ROOT, VUE), 'utf8')
const hasSuccess = (notes) => notes.some(([k]) => k === 'success')
const errors = (notes) => notes.filter(([k]) => k === 'error').map(([, m]) => m)

test('行为：剪贴板正常时提示成功并写入内容', async () => {
  const env = build(src)
  await env.api.copyPlain('id-1')
  assert.deepEqual(env.notes.map(([k]) => k), ['success'])
  assert.deepEqual(env.written, ['tk_abc'], '写进剪贴板的必须是令牌明文')
})

test('行为：剪贴板被拒绝时复制令牌报失败，不报成功', async () => {
  const env = build(src, { clipboard: 'reject' })
  await env.api.copyPlain('id-1')
  assert.equal(hasSuccess(env.notes), false, '不能谎报「令牌已复制」')
  assert.equal(env.notes.length, 1)
  assert.match(errors(env.notes)[0], /剪贴板/, '错误提示要说清是剪贴板访问被拒')
})

test('行为：剪贴板被拒绝时复制配置同样报失败', async () => {
  const env = build(src, { clipboard: 'reject' })
  await env.api.copyConfig('id-1')
  assert.equal(hasSuccess(env.notes), false, '不能谎报「配置已复制」')
  assert.match(errors(env.notes)[0], /剪贴板/)
})

test('行为：接口失败仍走原来那条错误提示（回滚判据）', async () => {
  const env = build(src, { apiError: true })
  await env.api.copyPlain('id-1')
  assert.equal(hasSuccess(env.notes), false)
  assert.match(errors(env.notes)[0], /接口炸了/)
})

test('可测性：copy() 自身返回是否成功', async () => {
  const okEnv = build(src)
  assert.equal(await okEnv.api.copy('x'), true)
  const badEnv = build(src, { clipboard: 'reject' })
  assert.equal(await badEnv.api.copy('x'), false)
})

test('变异反证：调用方不看返回值（原来的写法）后失败用例必红', async () => {
  // 回到卡片描述的旧形态：copy() 照旧返回状态，但调用方无条件提示成功
  const mutated = src.replace(
    /if \(!await copy\((.*?)\)\) return notify\.error\('[^']*'\)/g,
    'await copy($1)',
  )
  assert.ok(mutated !== src, '变异没匹配到返回值判断')
  assert.equal((mutated.match(/await copy\(/g) || []).length, 2, '两处调用都要被变异')
  const env = build(mutated, { clipboard: 'reject' })
  await env.api.copyPlain('id-1')
  assert.equal(hasSuccess(env.notes), true, '变异后仍会谎报成功（判据有效）')
})
