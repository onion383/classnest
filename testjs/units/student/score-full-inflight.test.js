// =========================================================================
// score-full-inflight.test.js —— 加分统计全量拉取的「在途单飞」
//
// 原缺陷：loadFullOf 没有在途去重，fullLoaded 只在响应回来后才置 true。
// 跨页定位(_applyRowFocus) / 切加分对象(watch scoreMode) / 切统计页签(watch activeTab)
// 三处可能在同一轮里对同一 mode 各发一次整表请求。
//
// 判据（源码文本事实 + 变异反证）：
//   ① 有按 mode 的在途表 fullInFlight，且 loadFullOf 入口先查 fullLoaded、再查在途表；
//   ② finally 里清在途槽（失败可重试）；resetPaging 里也清（新数据周期不复用旧 Promise）；
//   ③ 变异反证：抹掉在途表的判断 → 判据 ① 必须失败。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const SRC = 'student-frontend/src/views/ScoreManagement.vue'
const src = () => fs.readFileSync(abs(SRC), 'utf8')

const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
function bodyOf(source, marker) {
  const m = /^(?:async\s+)?function\s+(\w+)\s*\(/.exec(marker)
  if (!m) throw new Error('起点不是函数声明：' + marker)
  return extractFunctionDecl(source, m[1])
}

test('有按 mode 的在途单飞表', () => {
  assert.match(src(), /const fullInFlight\s*=\s*\{\s*personal:\s*null,\s*group:\s*null\s*\}/)
})

test('loadFullOf 先查 fullLoaded、再查在途表，命中直接复用', () => {
  const body = bodyOf(src(), 'function loadFullOf(mode)')
  assert.match(body, /if\s*\(\s*fullLoaded\[mode\]\s*\)\s*return/)
  assert.match(body, /if\s*\(\s*fullInFlight\[mode\]\s*\)\s*return\s+fullInFlight\[mode\]/)
  assert.match(body, /fullInFlight\[mode\]\s*=\s*task/)
})

test('失败/结束清在途槽，resetPaging 也清', () => {
  const body = bodyOf(src(), 'function loadFullOf(mode)')
  assert.match(body, /finally\s*\{[\s\S]*?fullInFlight\[mode\]\s*=\s*null/)
  const reset = bodyOf(src(), 'function resetPaging()')
  assert.match(reset, /fullInFlight\[k\]\s*=\s*null/)
})

test('变异反证：抹掉在途表判断 → 单飞判据必须失败', () => {
  const body = bodyOf(src(), 'function loadFullOf(mode)')
  const broken = body.replace(/if\s*\(\s*fullInFlight\[mode\]\s*\)\s*return\s+fullInFlight\[mode\]/, '')
  assert.notEqual(broken, body, '变异没生效')
  assert.throws(() => assert.match(broken, /if\s*\(\s*fullInFlight\[mode\]\s*\)\s*return\s+fullInFlight\[mode\]/))
})
