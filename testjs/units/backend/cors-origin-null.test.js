// =========================================================================
// cors-origin-null.test.js —— CORS 不许无条件信任 Origin: null
//
// 根因：app.js 对 `Origin: null` 无条件放行且 credentials:true。应用早已从 file://
// 迁到 app://local（file:// 在浏览器里正是发 null），与沙盒 iframe 发的 null 无法区分
// —— 任意本地 HTML/沙盒 iframe 可跨域读公开 API，对登录/恢复做可读的在线口令探测。
// 修法：移除 null 与 file:// 信任，只保留 app:// 与本机回环；无 Origin（非跨域）仍放行。
//
// 判据：①静态核验源码不再信任 null/file；
//       ②抽出真实 corsOriginAllowed 函数体，真跑各来源验放行/拒绝。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { extractFunctionInner } = require('#testjs/units/_mechanism.cjs')

const APP = abs('student-backend/app.js')
const src = fs.readFileSync(APP, 'utf8')

/** 抽出 corsOriginAllowed 函数体并用真 CORS_ORIGIN_RE 跑 */
function loadAllowed() {
  const reLine = src.match(/const CORS_ORIGIN_RE = (\/.*\/);/)
  assert.ok(reLine, '必须定义 CORS_ORIGIN_RE')
  // 函数体按 AST 取：手写括号配平会被字符串/模板里的 `{` 骗到（本文件原来就是这么写的）
  const body = extractFunctionInner(src, 'corsOriginAllowed')
  const CORS_ORIGIN_RE = eval(reLine[1]) // 正则字面量来自产品源码本身
  return new Function('CORS_ORIGIN_RE', 'origin', body).bind(null, CORS_ORIGIN_RE)
}

test('静态：不再信任 null / file://，无 Origin 仍放行', () => {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(!/origin\s*===\s*'null'/.test(noComments), '不许再有 origin === null 放行')
  const reLine = src.match(/const CORS_ORIGIN_RE = (\/.*\/);/)
  assert.ok(reLine && !reLine[1].includes('file:'), '白名单正则不许含 file://')
  assert.match(noComments, /function corsOriginAllowed\(origin\)/, '判定应抽成可测的纯函数')
  assert.match(noComments, /origin\(origin, cb\)[\s\S]{0,120}corsOriginAllowed\(origin\)/, 'cors 中间件必须用该判定')
})

test('真跑判定：null / file:// / 外部站点一律拒绝', () => {
  const allowed = loadAllowed()
  for (const bad of [
    'null',
    'file://',
    'file:///C:/secret.html',
    'https://evil.example.com',
    'http://attacker.lan',
    'https://localhost.evil.com', // 后缀伪装
  ]) {
    assert.equal(allowed(bad), false, `${bad} 必须被拒绝`)
  }
})

test('真跑判定：app:// 与本机回环放行，无 Origin 放行', () => {
  const allowed = loadAllowed()
  for (const good of [
    undefined, '',
    'app://local',
    'app://local/index.html',
    'http://localhost:5173',
    'http://127.0.0.1:8765',
    'http://[::1]:9000',
  ]) {
    assert.equal(allowed(good), true, `${String(good)} 应当放行`)
  }
})

test('静态对账：前端确实用 app://，file:// 已是历史注释', () => {
  const main = fs.readFileSync(abs('electron/main/main.js'), 'utf8')
  assert.match(main, /app:\/\/local\/index\.html/, '应用走 app:// 协议')
  assert.match(main, /避免 file:\/\/ 的「不透明 origin」/, 'file:// 已被明确弃用')
})
