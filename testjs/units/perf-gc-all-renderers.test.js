// =========================================================================
// perf-gc-all-renderers.test.js —— 「回收全部」要覆盖所有存活 renderer（#42）
//
// 原缺陷：PERF_GC 对工具箱与桌面挂件用 `if (工具箱) ... else if (桌面挂件) ...`。
// 两个窗口可以同时开着（工具箱常驻 + 桌面挂件打开），此时只给工具箱回收，
// 桌面挂件被静默跳过 —— 按钮承诺「全部」，实际漏了一个 renderer。
//
// 判据：① 行为：三个窗口都存活时，collect 必须被调用三次（且是并行发起，不是串行等）；
//       ② 位置映射：已销毁 / null 的窗口占 false，其余按输入顺序对位；
//       ③ 接线：PERF_GC 用这个函数，且不再有 else if 互斥分支。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const PERF = path.join(ROOT, 'electron/main/main.perf.js')

// 从源码里抠出 async function（先跳过参数列表，避免参数里的 {} 把配平带偏）
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

function loadCollector() {
  const src = fs.readFileSync(PERF, 'utf8')
  const fnSrc = extractAsyncFn(src, 'collectAllRendererGarbage')
  // 不依赖 electron：该函数只吃窗口数组与 collect 回调
  return new Function(`${fnSrc}\nreturn collectAllRendererGarbage;`)()
}

function fakeWindow(id, destroyed = false) {
  return { id, isDestroyed: () => destroyed, webContents: { id } }
}

test('三个窗口都存活：每一个都被回收，不再互斥跳过', async () => {
  const collectAll = loadCollector()
  const main = fakeWindow('main')
  const toolbox = fakeWindow('toolbox')
  const desktop = fakeWindow('desktop')
  const called = []

  const out = await collectAll([main, toolbox, desktop], async (wc) => { called.push(wc.id); return true })

  assert.deepEqual(called.sort(), ['desktop', 'main', 'toolbox'], '三个 renderer 都要回收')
  assert.deepEqual(out, [true, true, true], '结果按输入位置对位')
})

test('并行发起：不等第一个结束就开始第二个', async () => {
  const collectAll = loadCollector()
  const started = []
  let release
  const pending = new Promise((r) => { release = r })

  const promise = collectAll([fakeWindow('a'), fakeWindow('b')], (wc) => {
    started.push(wc.id)
    return pending.then(() => true)
  })
  // 同步断点：若实现是串行 `for ... await`，此刻只会有 'a'
  assert.deepEqual(started, ['a', 'b'], '应同时发起，而不是一个 await 完再下一个')

  release()
  assert.deepEqual(await promise, [true, true])
})

test('已销毁 / 缺失的窗口占 false，不影响其它窗口的位置', async () => {
  const collectAll = loadCollector()
  const called = []
  const out = await collectAll(
    [fakeWindow('main'), null, fakeWindow('desktop', true), fakeWindow('toolbox')],
    async (wc) => { called.push(wc.id); return wc.id === 'main' },
  )
  assert.deepEqual(called, ['main', 'toolbox'], '只回收存活的')
  assert.deepEqual(out, [true, false, false, false], '按原位置对位，失败/缺失都是 false')
})

test('接线：PERF_GC 不再用 else if 互斥，返回的 widget 表示任一挂件回收成功', () => {
  const src = fs.readFileSync(PERF, 'utf8')
  const start = src.indexOf('IPC.handle(CH.PERF_GC')
  assert.ok(start >= 0, '找不到 PERF_GC handler')
  const body = src.slice(start, src.indexOf('\n  })', start))

  assert.doesNotMatch(body, /else if \(desktopWidgetWindow/, '不能再用 else if 互斥（会漏掉一个窗口）')
  assert.match(body, /collectAllRendererGarbage\(/, '应统一走并行回收')
  assert.match(body, /widget: toolbox \|\| desktop/, 'widget 仍表示「有挂件被回收」，保持返回形状')
})
