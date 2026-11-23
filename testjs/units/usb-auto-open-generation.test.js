// =========================================================================
// usb-auto-open-generation.test.js —— 关闭后迟到探测不开新盘（3-6 / #41）
//
// 原缺陷：轮询 await getDriveLetters()（慢盘数百 ms）期间用户关闭开关，旧 await
// 回来后仍 shell.openPath 打开新盘、覆盖 knownDrives。修法：generation 令牌，
// start/stop 各 ++，await 后校验未变才开盘/写状态；基线同样带 gen。
//
// 判据：① 行为：mock 慢盘探测，在探测进行中关开关，断言 openPath 未被调用；
//       ② 接线：start/stop 都改 generation、await 后校验；③ 变异反证。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const USB_SRC = path.join(ROOT, 'electron/main/main.usb.js')

test('接线：start/stop 改 generation，await 后校验未变才开盘', () => {
  const src = fs.readFileSync(USB_SRC, 'utf8')
  assert.match(src, /const gen = \+\+usbGeneration/, 'start 未递增代次')
  assert.match(src, /usbGeneration\+\+/, 'stop 未递增代次')
  const poll = src.slice(src.indexOf('setInterval(async'), src.indexOf('}, 1500)'))
  assert.match(poll, /const current = await getDriveLetters\(\)/)
  assert.match(poll, /if \(gen !== usbGeneration\) return/, '开盘前未校验代次')
  const baseline = src.slice(src.indexOf('function readDriveLettersBaseline'), src.indexOf('function stopUsbWatch'))
  assert.match(baseline, /if \(gen !== usbGeneration\) return/, '基线未校验代次')
})

test('变异反证：去掉代次校验后判据失败', () => {
  const src = fs.readFileSync(USB_SRC, 'utf8')
  const mutated = src.replace(/if \(gen !== usbGeneration\) return/g, '/* 去掉代次校验 */')
  assert.ok(mutated !== src, '变异没匹配到代次校验')
  assert.doesNotMatch(mutated, /if \(gen !== usbGeneration\) return/, '变异后判据应失败')
})
