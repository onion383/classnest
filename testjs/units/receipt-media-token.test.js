// =========================================================================
// receipt-media-token.test.js —— 收据预览/下载要走媒体凭据刷新（v7 §5-9 / #28）
//
// 原缺陷：ReceiptDialog 用 `fetch(resourceUrl(path))` 直接取文件。resourceUrl() 只是把
// 当时 localStorage 里的媒体凭据拼进查询串 —— 凭据过期后一律 401，而这两处 fetch
// 既不会重试也不会续期，用户看到「无法读取该文件：HTTP 401」，重启应用又好了。
//
// 修法：统一走 fetchMedia()：先 ensureMediaToken()（缺失/临期才真的发请求），
// 401 时 refreshMediaToken() 强刷一次再重试。
// 判据：把真实的 fetchMedia 抽出来跑（fetch / resourceUrl / 两个刷新函数全部注入），
// 外加两处调用点的接线断言。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const VUE = 'student-frontend/src/components/dialogs/ReceiptDialog.vue'

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

// token 变量模拟 localStorage 里的媒体凭据：refresh 成功后换新值，
// resourceUrl 每次都现读 —— 与真实实现（resourceUrl 读 localStorage）同构。
function build(src, { statuses = [200], refreshReturns = 'new-token', onEnsure } = {}) {
  const calls = []
  let token = statuses.length > 1 ? 'old-token' : 'good-token'
  const fetches = []
  const fetch = async (url) => {
    fetches.push(url)
    const code = statuses[Math.min(fetches.length - 1, statuses.length - 1)]
    return { status: code, ok: code >= 200 && code < 300 }
  }
  const resourceUrl = (p) => `/api${p}?token=${token}`
  const ensureMediaToken = async () => { calls.push('ensure'); if (onEnsure) await onEnsure(); return token }
  const refreshMediaToken = async () => {
    calls.push('refresh')
    if (!refreshReturns) return null
    token = refreshReturns
    return token
  }
  const factory = new Function(
    'fetch', 'resourceUrl', 'ensureMediaToken', 'refreshMediaToken',
    `${functionSource(src, 'fetchMedia')}\nreturn fetchMedia;`,
  )
  return { fetchMedia: factory(fetch, resourceUrl, ensureMediaToken, refreshMediaToken), fetches, calls }
}

const src = fs.readFileSync(path.join(ROOT, VUE), 'utf8')

test('行为：凭据可用时只取一次，且先确保凭据再发请求', async () => {
  const env = build(src)
  const res = await env.fetchMedia('/uploads/a.md')
  assert.equal(res.status, 200)
  assert.equal(env.fetches.length, 1)
  assert.deepEqual(env.calls, ['ensure'], '必须先 ensureMediaToken 再 fetch')
})

test('行为：401 时强刷凭据并用新凭据重试一次', async () => {
  const env = build(src, { statuses: [401, 200], refreshReturns: 'fresh-token' })
  const res = await env.fetchMedia('/uploads/b.pdf')
  assert.equal(res.status, 200, '重试后应拿到 200')
  assert.equal(env.fetches.length, 2)
  assert.match(env.fetches[0], /old-token/, '第一次用的是旧凭据')
  assert.match(env.fetches[1], /fresh-token/, '重试必须带刷新后的凭据')
  assert.deepEqual(env.calls, ['ensure', 'refresh'])
})

test('行为：刷新也失败时把 401 原样交回（由调用方报错）', async () => {
  const env = build(src, { statuses: [401], refreshReturns: null })
  const res = await env.fetchMedia('/uploads/c.png')
  assert.equal(res.status, 401)
  assert.equal(env.fetches.length, 1, '没有新凭据就不要无意义地重试')
  assert.deepEqual(env.calls, ['ensure', 'refresh'])
})

test('接线：预览与下载都走 fetchMedia，且文件里不再有裸 fetch(resourceUrl(...))', () => {
  const openMarkdown = src.slice(src.indexOf('async function openMarkdown'))
  const download = src.slice(src.indexOf('async function download'))
  assert.match(openMarkdown.slice(0, 600), /await fetchMedia\(f\.path\)/, 'Markdown 预览没用 fetchMedia')
  assert.match(download.slice(0, 600), /await fetchMedia\(f\.path\)/, '下载没用 fetchMedia')
  // 不钉死总数 1（T06-06：fetchMedia 内部加一处探测/重试就会误红）；要求「函数体内至少一处、
  // 函数体外零处」，语义才与「只允许封装内部裸 fetch」一致。
  const body = sliceFunctionBody(src, 'fetchMedia')
  assert.ok(body.length > 0, '找不到 fetchMedia 函数体')
  assert.ok(/fetch\(resourceUrl\(/.test(body), 'fetchMedia 内部必须真的走裸 fetch（否则判据空转）')
  const outside = src.split(body).join('')
  assert.equal((outside.match(/fetch\(resourceUrl\(/g) || []).length, 0,
    'fetchMedia 之外不允许裸 fetch(resourceUrl(...))')
})

function sliceFunctionBody(s, name) {
  const i = s.indexOf('function ' + name)
  if (i < 0) return ''
  const open = s.indexOf('{', i)
  if (open < 0) return ''
  let depth = 0
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') depth++
    else if (s[j] === '}') {
      depth--
      if (depth === 0) return s.slice(open + 1, j)
    }
  }
  return ''
}

test('变异反证：下载改回裸 fetch 后接线判据必红', () => {
  const mutated = src.replace(
    /(async function download[\s\S]*?)const res = await fetchMedia\(f\.path\)/,
    '$1const res = await fetch(resourceUrl(f.path))',
  )
  assert.ok(mutated !== src, '变异没匹配到下载处的 fetchMedia')
  const download = mutated.slice(mutated.indexOf('async function download'))
  assert.doesNotMatch(download.slice(0, 600), /await fetchMedia\(f\.path\)/, '判据没有抓住裸 fetch')
})
