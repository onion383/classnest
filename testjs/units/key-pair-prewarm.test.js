// =========================================================================
// key-pair-prewarm.test.js —— 握手临时密钥对「预生成 + 用后补齐」回归
// 运行：node testjs/run-units.js --only=key-pair-prewarm
//
// 背景：P-256 generateKey 打包版实测 22~37ms，原先落在首屏首个请求的 ensureSession
// 里；改由 main.js 挂载前 prewarmKeyPair() 先备一把，握手时 takeKeyPair() 取用。
// 2026-11-14 修掉一个半拉子实现：takeKeyPair 里补的下一把「只发起、没写回槽位」，
// 于是只有首次握手吃到预生成，换号 / 重连又退回现生成，还白算一把没人用的密钥。
//
// 三层防线：
//   1. 补钥真的写回槽位，且取用的仍是上一把（每次握手各一把，前向保密不变）；
//   2. 空槽兜底与失败清理仍在（startKeyPair 的 catch 按槽位比对）；
//   3. 入口接线与时机：main.js 挂载前、只在有登录态时预热；ensureSession 走
//      takeKeyPair() 而不是直接 generateKey —— 只断言「导出了函数」会假绿。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const SC = path.join(ROOT, 'student-frontend/src/composables/secureChannel.js')
const MAIN = path.join(ROOT, 'student-frontend/src/main.js')

const read = (f) => fs.readFileSync(f, 'utf8')

// 只剥整行 // 注释：不剥的话，把调用注释掉之后，注释文字仍会被判据当成真接线，
// 变异反证实测假绿过一次。绝不用块注释正则（源码里有 url("image/*") 一类的属性值，
// 会从 /* 一路吞到很远的结束标记）。
const codeOnly = (f) => read(f).split(/\r?\n/).filter((line) => !/^\s*\/\//.test(line)).join('\n')

// 只取「真函数体」：从签名到第一个顶格 } —— 用全文 match 会被注释里的描述骗过去。
function bodyOf(src, signature) {
  const at = src.indexOf(signature)
  assert.ok(at > 0, `找不到 ${signature}`)
  const end = src.indexOf('\n}', at)
  assert.ok(end > at, `找不到 ${signature} 的函数体结束位置`)
  return src.slice(at, end)
}

test('补钥必须写回 keyPairSlot，且取用的是上一把（不许复用同一把）', () => {
  const src = read(SC)
  const body = bodyOf(src, 'function takeKeyPair()')
  assert.match(
    body,
    /keyPairSlot\s*=\s*startKeyPair\(\)/,
    '用掉后补的下一把必须写回槽位，否则第二次握手退回现生成',
  )
  assert.match(body, /keyPairSlot\s*\|\|\s*startKeyPair\(\)/, '槽位为空时仍要能现生成兜底')
  assert.match(body, /return\s+p\b/, '必须返回取走的那一把')
  assert.ok(!/return\s+keyPairSlot/.test(body), '不许返回槽位（那会两次握手共用一把密钥）')
  assert.ok(!/keyPairSlot\s*=\s*null/.test(body), '补钥写回后不许再把槽位清空')
})

test('startKeyPair 的失败清理按槽位比对，避免清掉别人的在途补钥', () => {
  const src = read(SC)
  const body = bodyOf(src, 'function startKeyPair()')
  assert.match(body, /subtle\.generateKey\(/, '必须真的生成 P-256 密钥对')
  assert.match(body, /\.catch\(/, '失败要自兜底，别让补钥变成 unhandledrejection')
  assert.match(body, /keyPairSlot\s*===\s*p/, '只清自己那一把')
  assert.match(body, /keyPairSlot\s*=\s*null/, '失败时槽位要清空，下次才会重新生成')
})

test('prewarmKeyPair 幂等、只在安全通道可用时预热', () => {
  const src = read(SC)
  const body = bodyOf(src, 'export function prewarmKeyPair()')
  assert.match(body, /if \(!safe\(\) \|\| !subtle\) return null/, '没有安全通道时不做白功')
  assert.match(body, /if \(keyPairSlot\) return keyPairSlot/, '重复调用不许再算一把')
  assert.match(body, /keyPairSlot\s*=\s*p/, '预热结果必须放进槽位给握手取用')
})

test('入口接线：挂载前、有登录态才预热，ensureSession 走 takeKeyPair', () => {
  const main = codeOnly(MAIN)
  assert.match(main, /import\s+\{\s*prewarmKeyPair\s*\}\s+from\s+'\.\/composables\/secureChannel'/)
  const callAt = main.indexOf('prewarmKeyPair()')
  const mountAt = main.indexOf('const mountStart')
  assert.ok(callAt > 0 && mountAt > 0, '预热调用与挂载起点都必须存在')
  assert.ok(callAt < mountAt, '预热必须在 Vue 挂载之前发起，否则赶不上首个握手')
  assert.match(main, /if \(getToken\(\)\) prewarmKeyPair\(\)/, '未登录（登录页）不预热')

  const src = read(SC)
  const es = src.slice(src.indexOf('async function ensureSession()'), src.indexOf('async function requestHandshake'))
  assert.ok(es.length > 0, '找不到 ensureSession 函数体')
  assert.match(es, /Promise\.all\(\[[\s\S]{0,400}?waitForBackendReady\([\s\S]{0,400}?takeKeyPair\(\)/, '取钥仍与后端就绪等待并行')
  assert.ok(!/subtle\.generateKey\(/.test(es), 'ensureSession 不许再直接 generateKey（那就白预热了）')
})
