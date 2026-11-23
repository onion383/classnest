// =========================================================================
// about-license-timeout-recover.test.js —— 超时后又加载成功要清掉错误（#48）
//
// 原缺陷：英文许可证按需 import，8 秒未完成就置 licenseError（「加载超时」）并结束 loading。
// 若那个 import 最终 resolve，成功分支只写 sections.text，没有清 licenseError；
// 模板是 v-if="licenseError" 优先 → 错误分支一直挡住已经加载好的全文，
// 用户只能关掉弹窗重开。属低频但完全可恢复的展示故障。
//
// 判据：真实执行 loadLicenseTexts（把 `await import(...)` 换成注入的 loadTexts），
//       跑「先超时、后成功」的时序：错误必须被清掉，正文必须写进去。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ABOUT = path.join(__dirname, '../../student-frontend/src/views/AboutView.vue')

function extractAsyncFn(src, name) {
  const start = src.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `找不到 async function ${name}`)
  const parenOpen = src.indexOf('(', start)
  let pd = 0
  let parenClose = parenOpen
  for (let i = parenOpen; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1
    else if (src[i] === ')') { pd -= 1; if (pd === 0) { parenClose = i; break } }
  }
  const open = src.indexOf('{', parenClose)
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

// 把动态 import 换成注入的 loader —— 这是唯一被替换的点，其余逻辑原样执行
function loadLicenseFn() {
  const src = fs.readFileSync(ABOUT, 'utf8')
  const fnSrc = extractAsyncFn(src, 'loadLicenseTexts')
  const patched = fnSrc.replace(
    "const { LICENSE_TEXTS } = await import('../utils/licenseDocs.js')",
    'const { LICENSE_TEXTS } = await loadTexts()',
  )
  assert.notEqual(patched, fnSrc, '没找到动态 import，测试手法需要更新')

  return new Function(
    'activeLicense', 'licenseLoading', 'licenseError', 'licenseLatest', 'loadTimeout', 'loadTexts',
    `${patched}\nreturn loadLicenseTexts;`,
  )
}

function makeEnv({ sections = [{ title: 'MIT', text: '' }] } = {}) {
  const env = {
    activeLicense: { value: { lib: { own: false }, sections } },
    licenseLoading: { value: false },
    licenseError: { value: '' },
    // 只用一个 token，模拟「当前这次加载」
    licenseLatest: { isCurrent: (t) => t === 1 },
    timeouts: [],
    cancelled: 0,
  }
  env.loadTimeout = (fn, ms) => { env.timeouts.push({ fn, ms }) }
  env.loadTimeout.cancel = () => { env.cancelled += 1; env.timeouts.length = 0 }
  return env
}

test('先超时、后加载成功：错误必须被清掉，正文写进去', async () => {
  const env = makeEnv()
  let resolveTexts
  const pending = new Promise((r) => { resolveTexts = r })

  env.loadTexts = () => pending
  const loadLicenseTexts = loadLicenseFn()(
    env.activeLicense, env.licenseLoading, env.licenseError, env.licenseLatest, env.loadTimeout, env.loadTexts,
  )

  const running = loadLicenseTexts(1)
  // 超时先到（8 秒后的兜底）
  assert.equal(env.timeouts.length, 1, '应排一个 8 秒兜底定时器')
  assert.equal(env.timeouts[0].ms, 8000)
  env.timeouts[0].fn()
  assert.match(env.licenseError.value, /超时/, '超时应先给出提示')
  assert.equal(env.licenseLoading.value, false)

  // import 最终 resolve
  resolveTexts({ LICENSE_TEXTS: { MIT: 'Permission is hereby granted...' } })
  await running

  assert.equal(env.licenseError.value, '', '文本已到，超时错误必须清掉（否则模板一直显示错误）')
  assert.equal(env.activeLicense.value.sections[0].text, 'Permission is hereby granted...')
  assert.equal(env.licenseLoading.value, false)
})

test('加载失败才保留错误（这条不能被上面的清理抵消）', async () => {
  const env = makeEnv()
  env.loadTexts = async () => { throw new Error('chunk 404') }
  const loadLicenseTexts = loadLicenseFn()(
    env.activeLicense, env.licenseLoading, env.licenseError, env.licenseLatest, env.loadTimeout, env.loadTexts,
  )

  await loadLicenseTexts(1)
  assert.match(env.licenseError.value, /失败/, '真失败要留着提示')
  assert.equal(env.licenseLoading.value, false)
})

test('非当前 token 的迟到结果不写状态（连点场景）', async () => {
  const env = makeEnv()
  let resolveTexts
  const pending = new Promise((r) => { resolveTexts = r })
  env.loadTexts = () => pending
  env.licenseLatest = { isCurrent: () => false }
  const loadLicenseTexts = loadLicenseFn()(
    env.activeLicense, env.licenseLoading, env.licenseError, env.licenseLatest, env.loadTimeout, env.loadTexts,
  )

  const running = loadLicenseTexts(1)
  resolveTexts({ LICENSE_TEXTS: { MIT: '旧结果' } })
  await running
  assert.equal(env.activeLicense.value.sections[0].text, '', '旧 token 的结果不能覆盖当前弹窗')
})

test('本软件自己的 MIT 协议不触发懒加载', async () => {
  const env = makeEnv()
  env.activeLicense.value.lib = { own: true }
  let touched = false
  env.loadTexts = async () => { touched = true; return { LICENSE_TEXTS: {} } }
  const loadLicenseTexts = loadLicenseFn()(
    env.activeLicense, env.licenseLoading, env.licenseError, env.licenseLatest, env.loadTimeout, env.loadTexts,
  )

  await loadLicenseTexts(1)
  assert.equal(touched, false, 'own 协议全文已静态注入，不该再去拉第三方 MIT')
})
