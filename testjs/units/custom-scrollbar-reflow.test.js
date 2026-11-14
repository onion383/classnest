// =========================================================================
// custom-scrollbar-reflow.test.js —— 滚动条测量不许制造强制同步布局
//
// 背景（2026-11-14 V8 采样）：启动期主线程热点只有一个 —— CustomScrollbar 的
// 测量函数 updateThumb，单个自耗 89.7ms，首屏窗口（0~400ms）内约 55ms。
// 原因是两件事叠加：
//   ① bind() 里同步调 updateThumb()：首屏多个实例在同一 tick 挂载 → N 次强制布局；
//   ② 测量里「读布局 → 写 ref → 再读布局」交替：每次写都让下一次读重新排版。
// 现在要求：① 首次测量并入 scheduleUpdate()（rAF 合并，一帧只测一次）；
//           ② 写回一律走 setIfChanged（值没变不写，读写分离）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const FILE = 'student-frontend/src/components/base/CustomScrollbar.vue'

function read() {
  return fs.readFileSync(path.join(ROOT, FILE), 'utf8')
}

test('bind 的首次测量必须并入 rAF 批处理', () => {
  const src = read()
  const at = src.indexOf('function bind(')
  assert.ok(at > 0, 'bind 必须存在')
  const body = src.slice(at, src.indexOf('\n}\n', at) + 1)
  assert.match(
    body,
    /scheduleUpdate\(\)/,
    'bind 末尾必须走 scheduleUpdate()，否则每个实例各强制布局一次',
  )
  assert.ok(
    !/\n\s+updateThumb\(\)\s*\n/ .test(body.slice(body.lastIndexOf('observeFirstChild'))),
    'bind 里不许再同步调 updateThumb()（那是首屏 N 次强制布局的来源）',
  )
})

test('updateThumb 必须读写分离且写入去重', () => {
  const src = read()
  const at = src.indexOf('function updateThumb(')
  assert.ok(at > 0, 'updateThumb 必须存在')
  const body = src.slice(at, src.indexOf('\n}\n', at) + 1)

  assert.match(body, /setIfChanged\(/, 'updateThumb 必须用 setIfChanged 写回')
  // 直接给 ref 赋值会跳过去重，也就回到了「写一次、下一次读就重排」的老路
  for (const name of ['offsetTop', 'trackHeight', 'thumbHeight', 'thumbTop', 'visible']) {
    assert.ok(
      !new RegExp(`${name}\\.value\\s*=`).test(body),
      `updateThumb 里不许直接写 ${name}.value，必须走 setIfChanged`,
    )
  }
  // 读布局的几处必须在「第一次跟布局有关的写回」之前读完
  // （前面的 `visible = false` 属于提前返回分支，不读布局，不算）
  const firstWrite = body.indexOf('setIfChanged(offsetTop')
  for (const read of ['el.offsetTop', 'el.clientHeight', 'el.scrollHeight', 'el.scrollTop']) {
    const at2 = body.indexOf(read)
    assert.ok(at2 > 0, `updateThumb 必须读 ${read}`)
    assert.ok(at2 < firstWrite, `${read} 必须在第一次写回之前读掉（读写交替会强制同步布局）`)
  }
})
