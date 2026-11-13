// =========================================================================
// packaged-csp.test.js —— 打包版 CSP 与构建产物内联脚本的对账
// 运行：npm run test:units
//
// 背景（2026-11-12）：加 CSP 后打包版「样式全乱」，dev 正常。根因是两处内联脚本被拦：
//   1. vite.config.js 的 nonBlockingCss 给样式表加的 onload="this.media='all'"
//      —— 内联事件处理器归 script-src 管，被拦 → 4 个入口 CSS 永远停在 media=print，整页无基础样式；
//   2. splash/splash.html 里的主题抢跑脚本 —— 被拦 → 深色模式启动先闪一下浅色。
// 修法是只放行这两段固定内容的 sha256（配 'unsafe-hashes'），不放开 'unsafe-inline'。
//
// 这个测试存在的理由：hash 与源内容是一对"必须同步、但改漏了不会有任何报错"的配置。
// 改 vite.config.js 的 handler 或 splash.html 的脚本而不重算 hash，打包版会静默失去基础样式。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname, '../..')
const PROTOCOL = path.join(ROOT, 'electron/main/main.protocol.js')
const VITE_CFG = path.join(ROOT, 'student-frontend/vite.config.js')
const SPLASH = path.join(ROOT, 'student-frontend/splash/splash.html')

const sha256 = (s) => 'sha256-' + crypto.createHash('sha256').update(s, 'utf8').digest('base64')

const protocolSrc = () => fs.readFileSync(PROTOCOL, 'utf8')

// 与探针同样的读法：script-src 是模板字符串拼了 hash 常量
function readScriptSrc() {
  const src = protocolSrc()
  const consts = {}
  for (const m of src.matchAll(/const (\w+_HASH) = '(sha256-[^']+)'/g)) consts[m[1]] = m[2]
  const tpl = src.match(/const SCRIPT_SRC = `([^`]*)`/)
  assert.ok(tpl, 'main.protocol.js 必须有 SCRIPT_SRC 模板')
  return tpl[1].replace(/\$\{(\w+)\}/g, (_, n) => consts[n] ?? `<缺失常量 ${n}>`)
}

// ==================== hash 与源内容对账 ====================
test('样式表 onload handler 的 sha256 与 vite.config.js 里那句一致', () => {
  const cfg = fs.readFileSync(VITE_CFG, 'utf8')
  // 构建时写进产物的就是这段：onload="this.media='all'"
  const m = cfg.match(/onload="([^"]*)"/)
  assert.ok(m, 'vite.config.js 里应当有 onload="…" 的注入')
  const handler = m[1]
  const expected = sha256(handler)
  const scriptSrc = readScriptSrc()
  assert.ok(
    scriptSrc.includes(expected),
    `script-src 缺少当前 handler 的 hash（应重算为 ${expected}）；handler=${JSON.stringify(handler)}`,
  )
})

test('首屏主题抢跑脚本的 sha256 与 splash/splash.html 里那段一致', () => {
  const html = fs.readFileSync(SPLASH, 'utf8')
  const m = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, 'splash.html 里应当有一段内联脚本')
  const body = m[1]
  const expected = sha256(body)
  const scriptSrc = readScriptSrc()
  assert.ok(
    scriptSrc.includes(expected),
    `script-src 缺少首屏主题脚本的 hash（应重算为 ${expected}）；脚本长度 ${body.length} 字符`,
  )
})

// ==================== 策略本身不能放宽过头 ====================
test("script-src 用 'unsafe-hashes' + hash，而不是 'unsafe-inline'", () => {
  const scriptSrc = readScriptSrc()
  assert.ok(
    scriptSrc.includes("'unsafe-hashes'"),
    "事件处理器只认 hash + 'unsafe-hashes'，少一个都不生效",
  )
  assert.ok(
    !scriptSrc.includes("'unsafe-inline'"),
    "主页面 script-src 不得出现 'unsafe-inline'（那等于允许任意内联脚本）",
  )
  // hash 至少两条：样式表 handler + 首屏主题脚本
  const hashes = scriptSrc.match(/sha256-[A-Za-z0-9+/=]+/g) || []
  assert.ok(hashes.length >= 2, `script-src 应当含 ≥2 个 hash，实际 ${hashes.length} 个`)
})

test('引导页例外只追加 unsafe-inline，不丢掉原有的 hash 与 unsafe-hashes', () => {
  const src = protocolSrc()
  assert.ok(
    /const CSP_SETUP = CSP\.replace\(SCRIPT_SRC, `\$\{SCRIPT_SRC\} 'unsafe-inline'`\)/.test(src),
    'CSP_SETUP 必须基于同一个 SCRIPT_SRC 追加，别改成字符串字面量替换（改一处会漏另一处）',
  )
})

// ==================== wasm：PDF 字体子集化 ====================
// 背景（2026-11-12 实测）：script-src 不含 'wasm-unsafe-eval' 时，WebAssembly.compile()
// 直接抛 CSP 违规 → hbSubset 退回全量字体嵌入。PDF 从 121KB / 22ms 变成 1.78MB / 386ms，
// 而且只有一句 console.warn，界面上看不出来（静默退化）。
const HB_SUBSET = path.join(ROOT, 'student-frontend/src/utils/hbSubset.js')

test("script-src 必须含 'wasm-unsafe-eval'（PDF 字体子集化依赖 WebAssembly）", () => {
  const hb = fs.readFileSync(HB_SUBSET, 'utf8')
  assert.ok(
    /WebAssembly\.compile\(/.test(hb),
    'hbSubset.js 应仍用 WebAssembly.compile() 编译 wasm；若改为纯 JS 实现，本条断言与对应 CSP 需一起重新评估',
  )
  const scriptSrc = readScriptSrc()
  assert.ok(
    scriptSrc.includes("'wasm-unsafe-eval'"),
    "缺少 'wasm-unsafe-eval'：WebAssembly.compile 会被 CSP 拦下，PDF 字体子集化静默退化为全量嵌入",
  )
  // 只放行 wasm 字节码编译，不能顺带把 eval / new Function 的闸门打开
  const withoutWasm = scriptSrc.replace("'wasm-unsafe-eval'", '')
  assert.ok(
    !withoutWasm.includes("'unsafe-eval'"),
    "'wasm-unsafe-eval' 已够用，不得再放开 'unsafe-eval'（那会允许 eval/new Function 执行字符串）",
  )
})

// ==================== 产物形态：样式表确实是 media="print" + onload ====================
test('vite.config.js 的 nonBlockingCss 仍生成 media=print + onload（否则上面的 hash 失去意义）', () => {
  const cfg = fs.readFileSync(VITE_CFG, 'utf8')
  assert.ok(/media="print"/.test(cfg), 'nonBlockingCss 仍应给样式表加 media="print"')
  assert.ok(/onload="this\.media='all'"/.test(cfg), 'nonBlockingCss 仍应用 onload 切回 all')
})

// ==================== frame-src：iframe 预览不能被 default-src 回落拦掉 ====================
// 背景（2026-11-12）：CSP 没写 frame-src 时由 default-src 回落，而 default-src 'self' 只认同源
// app://，于是 ReceiptDialog 的 PDF 预览（iframe → 后端媒体绝对地址）在打包版被
// ERR_BLOCKED_BY_CSP 拦成一片空白。dev 不发 CSP，所以只有打包版暴露。
const BACKEND_ORIGIN_SRC = path.join(ROOT, 'student-frontend/src/utils/backendOrigin.js')
const RECEIPT_DIALOG = path.join(ROOT, 'student-frontend/src/components/dialogs/ReceiptDialog.vue')

// 整条 CSP 拼出来（与探针同一套读法，不复制字符串）
function readCsp() {
  const src = protocolSrc()
  const consts = {}
  for (const m of src.matchAll(/const (\w+_HASH) = '(sha256-[^']+)'/g)) consts[m[1]] = m[2]
  const tpl = src.match(/const SCRIPT_SRC = `([^`]*)`/)
  assert.ok(tpl, 'main.protocol.js 必须有 SCRIPT_SRC 模板')
  const scriptSrc = tpl[1].replace(/\$\{(\w+)\}/g, (_, n) => consts[n] ?? `<缺失常量 ${n}>`)
  const arr = src.match(/const CSP = \[([\s\S]*?)\]\.join\('; '\)/)
  assert.ok(arr, 'main.protocol.js 必须有 CSP 数组')
  const parts = []
  for (const raw of arr[1].split('\n')) {
    const line = raw.trim().replace(/,$/, '')
    if (!line) continue
    if (line === 'SCRIPT_SRC') { parts.push(scriptSrc); continue }
    const m = line.match(/^"([^"]*)"$/)
    if (m) parts.push(m[1])
  }
  return parts.join('; ')
}

// 取某条指令的取值列表；指令不存在时返回 null（与「存在但为空」区分开）
function directive(name) {
  const hit = readCsp().split(';').map((s) => s.trim()).find((s) => s.split(/\s+/)[0] === name)
  return hit ? hit.split(/\s+/).slice(1) : null
}

function readBackendOrigin() {
  const src = fs.readFileSync(BACKEND_ORIGIN_SRC, 'utf8')
  const m = src.match(/export const BACKEND_ORIGIN = '([^']+)'/)
  assert.ok(m, 'backendOrigin.js 必须有 BACKEND_ORIGIN 常量')
  return m[1]
}

test('CSP 必须显式声明 frame-src（不能靠 default-src 回落）', () => {
  const frameSrc = directive('frame-src')
  assert.ok(frameSrc !== null, "缺少 frame-src：会由 default-src 'self' 回落，iframe 全部被拦")
  assert.ok(frameSrc.includes("'self'"), "frame-src 应保留 'self'")
})

test('frame-src 的后端 origin 与 backendOrigin.js 的 BACKEND_ORIGIN 一致', () => {
  const origin = readBackendOrigin()
  const frameSrc = directive('frame-src')
  assert.ok(Array.isArray(frameSrc), '缺少 frame-src 指令')
  assert.ok(
    frameSrc.includes(origin),
    `frame-src 必须包含后端媒体 origin ${origin}（PDF 预览的 iframe 指向它）；实际：${frameSrc.join(' ')}`,
  )
  assert.ok(frameSrc.includes('blob:'), 'frame-src 应包含 blob:（本地生成的预览地址）')
})

test('frame-src 不得整段放开', () => {
  const frameSrc = directive('frame-src')
  assert.ok(Array.isArray(frameSrc), '缺少 frame-src 指令')
  for (const bad of ['*', 'http:', 'https:', 'data:']) {
    assert.ok(
      !frameSrc.includes(bad),
      `frame-src 不得包含 ${bad}，否则等于允许嵌入任意网页（本轮只需放行自己的后端 + blob:）`,
    )
  }
})

test('PDF 预览仍走 resourceUrl（地址形态一变，这条 CSP 判据就要重新评估）', () => {
  const vue = fs.readFileSync(RECEIPT_DIALOG, 'utf8')
  assert.ok(
    /pdfSrc[\s\S]{0,200}resourceUrl\(/.test(vue),
    'ReceiptDialog 的 pdfSrc 应仍由 resourceUrl() 生成（→ BACKEND_ORIGIN），否则 frame-src 需重新评估',
  )
})
