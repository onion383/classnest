// =========================================================================
// usb-auto-open-generation.test.js —— 关闭后迟到探测不开新盘（3-6 / #41）
//
// 原缺陷：轮询 await getDriveLetters()（慢盘数百 ms）期间用户关闭开关，旧 await
// 回来后仍 shell.openPath 打开新盘、覆盖 knownDrives。修法：generation 令牌，
// start/stop 各 ++，await 后校验未变才开盘/写状态；基线同样带 gen。
//
// 判据：① 行为：mock 慢盘探测，在探测进行中关开关，断言 openPath 未被调用；
//       ② 接线：start/stop 都改 generation、await 后校验；③ 变异反证（执行变异后的函数体）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const USB_SRC = path.join(ROOT, 'electron/main/main.usb.js')

const flush = () => new Promise((r) => setImmediate(r))

// 把 main.usb.js 的三个监听函数抽出来，在注入环境里执行（T08-01）。
// 参数 getDriveLetters / shell / setInterval / clearInterval 全部可注入，
// 这样「探测进行中关开关」的时序是真的跑出来的，不是对源码做正则。
function makeHarness(src) {
  const startFn = src.slice(src.indexOf('function startUsbWatch'), src.indexOf('function readDriveLettersBaseline'))
  const baselineFn = src.slice(src.indexOf('function readDriveLettersBaseline'), src.indexOf('function stopUsbWatch'))
  const stopFn = src.slice(src.indexOf('function stopUsbWatch'), src.indexOf('// 当前开关状态'))
  assert.ok(startFn && baselineFn && stopFn, '未能从 main.usb.js 抽出监听函数')

  const opened = []
  const shell = { openPath: (d) => opened.push(d) }
  const pending = []
  const getDriveLetters = () => new Promise((res) => pending.push(res))
  // 定时器槽位：setInterval 存回调，clearInterval 清掉；tick 从这里取当前一轮回调
  const slot = { cb: null, timer: null }
  const setIntervalFake = (fn) => { slot.cb = fn; slot.timer = { id: 1 }; return slot.timer }
  const clearIntervalFake = (t) => { if (t === slot.timer) { slot.timer = null; slot.cb = null } }

  const factory = new Function(
    'getDriveLetters', 'shell', 'setInterval', 'clearInterval', 'slot',
    `
    let usbBaselineReady = false;
    let usbProbing = false;
    let usbGeneration = 0;
    let usbPollTimer = null;
    let usbAutoOpenEnabled = true;
    let knownDrives = new Set();
    ${startFn}
    ${baselineFn}
    ${stopFn}
    return {
      start: startUsbWatch,
      stop: stopUsbWatch,
      setEnabled: (v) => { usbAutoOpenEnabled = v },
      tick: () => (slot.cb ? slot.cb() : null),
      state: () => ({ baselineReady: usbBaselineReady, probing: usbProbing, generation: usbGeneration }),
      known: () => new Set(knownDrives),
    };
    `,
  )
  const api = factory(getDriveLetters, shell, setIntervalFake, clearIntervalFake, slot)
  // 逐个兑现挂起的 getDriveLetters（FIFO），模拟「慢盘探测返回」
  const resolveNext = (set) => { const r = pending.shift(); assert.ok(r, '没有挂起的探测'); r(set) }
  return { api, opened, resolveNext, pendingCount: () => pending.length }
}

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

// 控制组：不关开关时，慢探测返回的新盘必须真的被打开 —— 否则下一条用例的「没打开」毫无意义
test('行为对照：探测返回新盘且代次未变 → 打开该盘并更新 knownDrives', async () => {
  const src = fs.readFileSync(USB_SRC, 'utf8')
  const { api, opened, resolveNext } = makeHarness(src)
  api.start()
  resolveNext(new Set())            // 基线：空盘
  await flush()
  assert.equal(api.state().baselineReady, true, '基线应就绪')
  const p = api.tick()
  resolveNext(new Set(['E:\\']))
  await p
  await flush()
  assert.deepEqual(opened, ['E:\\'], '代次未变时必须真的打开新盘')
  assert.ok(api.known().has('E:\\'), 'knownDrives 应更新')
})

test('行为：探测进行中关开关，旧结果回来后不得打开新盘、不得覆盖 knownDrives（T08-01）', async () => {
  const src = fs.readFileSync(USB_SRC, 'utf8')
  const { api, opened, resolveNext } = makeHarness(src)
  api.start()
  resolveNext(new Set())            // 基线：空盘
  await flush()
  const p = api.tick()              // 进入 await getDriveLetters（慢盘）
  api.stop()                        // 用户关闭开关：generation++
  resolveNext(new Set(['E:\\']))    // 旧探测迟到返回一个「新盘」
  await p
  await flush()
  assert.deepEqual(opened, [], '关闭开关后，旧代探测不得打开新盘')
  assert.ok(!api.known().has('E:\\'), '旧代结果不得覆盖 knownDrives')
  assert.equal(api.state().generation, 2, 'stop 必须递增代次')
})

test('变异反证：把开盘前代次校验写反后，同一行为判据必须失败', async () => {
  const src = fs.readFileSync(USB_SRC, 'utf8')
  const mutated = src.replace(/if \(gen !== usbGeneration\) return/, 'if (gen === usbGeneration) return')
  assert.ok(mutated !== src, '变异没匹配到开盘前代次校验')
  const { api, opened, resolveNext } = makeHarness(mutated)
  api.start()
  resolveNext(new Set())
  await flush()
  const p = api.tick()
  api.stop()
  resolveNext(new Set(['E:\\']))
  await p
  await flush()
  assert.notDeepEqual(opened, [], '判据假绿：代次校验写反后仍没打开旧代的新盘')
})
