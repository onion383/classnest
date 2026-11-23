// =========================================================================
// leave-quick-tomorrow.test.js —— 「明天全天」= 明天 7 点 → 后天 7 点（v7 §5-7 / #25b）
//
// 原缺陷：快捷项「明天全天」把开始时间设成**此刻**，结束设成后天 7 点：
// 上午点一下就请了「今天剩下的时间 + 明天一整天 + 后天凌晨」，
// 而「今日不过夜」18:00→次日 7:00 已经说明学校日的边界是 7 点。
//
// 判据：把 .vue 里真实的 applyQuick 抽出来跑（Date 注入固定时刻），断言各快捷项
// 的起止时刻与时长 —— 不是复刻一份相同逻辑的镜像测试。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const VUE = 'student-frontend/src/components/dialogs/AddLeaveDialog.vue'

// 取 `function NAME(...) { ... }` 整段（括号配平；不能按固定行数截断）
function functionSource(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `找不到 function ${name}`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} 的大括号没有配平`)
}

// 固定「现在」= 2026-11-23 10:00（本地时间），方便断言「明天」到底是哪一天
const NOW = new Date(2026, 10, 23, 10, 0, 0, 0)

// 注入一个 Date：无参构造返回固定时刻，带参构造与原生一致（applyQuick 里用 at() 造日期）
function makeDate() {
  const Real = Date
  class FixedDate extends Real {
    constructor(...args) {
      if (args.length === 0) super(NOW.getTime())
      else super(...args)
    }
  }
  return FixedDate
}

function loadApplyQuick(src) {
  const fn = functionSource(src, 'applyQuick')
  const form = { value: { startLocal: '', endLocal: '' } }
  // toInput 只负责格式化成输入框字符串；测试只关心时刻，故原样透传 Date
  const toInput = (d) => d
  const factory = new Function('form', 'toInput', 'Date', `${fn}\nreturn applyQuick;`)
  return { applyQuick: factory(form, toInput, makeDate()), form }
}

const src = fs.readFileSync(path.join(ROOT, VUE), 'utf8')

function pick(label) {
  const { applyQuick, form } = loadApplyQuick(src)
  applyQuick(label)
  return { start: form.value.startLocal, end: form.value.endLocal }
}

test('行为：明天全天 = 明天 07:00 → 后天 07:00，正好 24 小时', () => {
  const { start, end } = pick('明天全天')
  assert.equal(start.getTime(), new Date(2026, 10, 24, 7, 0, 0, 0).getTime(), '开始必须是明天 7 点')
  assert.equal(end.getTime(), new Date(2026, 10, 25, 7, 0, 0, 0).getTime(), '结束必须是后天 7 点')
  assert.equal(end - start, 24 * 3600 * 1000, '「全天」必须恰好覆盖一天')
  assert.ok(start > NOW, '不能把今天剩余时间也算进明天')
})

test('行为：同族快捷项口径不变（防止改一处碰坏另一处）', () => {
  const today = pick('今日全天')
  assert.equal(today.start.getTime(), new Date(2026, 10, 23, 0, 0, 0, 0).getTime())
  assert.equal(today.end.getTime(), new Date(2026, 10, 24, 0, 0, 0, 0).getTime())

  const night = pick('今日不过夜')
  assert.equal(night.start.getTime(), new Date(2026, 10, 23, 18, 0, 0, 0).getTime())
  assert.equal(night.end.getTime(), new Date(2026, 10, 24, 7, 0, 0, 0).getTime(),
    '「今日不过夜」到次日 7 点 —— 「明天全天」的 7 点边界以此为口径')
})

test('变异反证：开始时间改回「此刻」后判据必失败', () => {
  const mutated = src.replace(
    'start = at(1, 7, 0); end = at(2, 7, 0);',
    'start = now; end = at(2, 7, 0);',
  )
  assert.ok(mutated !== src, '变异没匹配到「明天全天」分支')
  const { applyQuick, form } = loadApplyQuick(mutated)
  applyQuick('明天全天')
  assert.notEqual(
    form.value.endLocal - form.value.startLocal,
    24 * 3600 * 1000,
    '变异后时长应不再是 24 小时，否则判据无效',
  )
})
