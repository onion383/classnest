// =========================================================================
// seat-history-cache-invalidate.test.js —— 快照变更后座位账本/指数缓存必须作废（4-7 / #26）
//
// 原缺陷：座位页把「每日快照」的拉取结果按区间缓存在 seatDailyKey 里，命中就不再发请求。
// 两个记录弹窗改完快照（补录一周 / 删除一周）只刷新了周列表：
//   · SeatBackfillDialog 已 emit('changed')，但父页处理器只调 fetchHistoryWeeks()；
//   · SeatRecordSettingsDialog 删周后什么都不通知。
// 于是账本与座位指数继续按旧区间命中缓存，用户看到的是改动前的数字。
//
// 判据：
//   ① 两个弹窗在写操作成功后都要 emit('changed')；
//   ② 父页两个 @changed 都指向 onHistoryChanged，且它先调 invalidateSeatDaily()；
//   ③ 变异反证：去掉 invalidateSeatDaily 调用后判据失败。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const assert = require('node:assert/strict')


const VIEW = 'student-frontend/src/views/SeatView.vue'
const SETTINGS = 'student-frontend/src/components/dialogs/SeatRecordSettingsDialog.vue'
const BACKFILL = 'student-frontend/src/components/dialogs/SeatBackfillDialog.vue'

test('管理周记录弹窗：删周成功后 emit(changed)', () => {
  const src = read(SETTINGS)
  assert.match(src, /defineEmits\(\['close', 'changed'\]\)/, '必须声明 changed 事件')
  const body = src.slice(src.indexOf('async function confirmDelete'), src.indexOf('</script>'))
  const del = body.indexOf('await axios.delete')
  const emitAt = body.indexOf("emit('changed')")
  assert.ok(del >= 0, '未找到删周请求')
  assert.ok(emitAt > del, 'emit(changed) 必须在删除请求成功之后')
})

test('补录弹窗：提交周记录后 emit(changed)', () => {
  const src = read(BACKFILL)
  const body = src.slice(src.indexOf('async function submitWeek'), src.indexOf('</script>'))
  assert.ok(body.indexOf("emit('changed')") > body.indexOf('await axios.post'),
    '提交成功后必须通知父页（写操作在前，通知在后）')
})

// 判据抽成函数（T07-02）：正例与变异反证共用，变异体回喂同一入口
function onHistoryChangedGuard(body) {
  const inv = body.indexOf('invalidateSeatDaily()')
  const weeks = body.indexOf('fetchHistoryWeeks()')
  return { ok: inv >= 0 && weeks >= 0 && inv < weeks, inv, weeks }
}

test('座位页：两个弹窗的 changed 都指向 onHistoryChanged，且先作废账本/指数缓存', () => {
  const src = read(VIEW)
  const bindings = (src.match(/@changed="onHistoryChanged"/g) || []).length
  assert.equal(bindings, 2, '补录与管理周记录两个弹窗都要绑 onHistoryChanged')
  const body = extractFunctionDecl(src, 'onHistoryChanged')
  const r = onHistoryChangedGuard(body)
  assert.ok(r.inv >= 0, 'onHistoryChanged 必须作废每日快照缓存，否则账本/指数仍是旧数字')
  assert.ok(r.weeks >= 0, '仍要刷新周列表')
  assert.ok(r.inv < r.weeks, '先作废缓存再刷新列表（顺序无关正确性，但保持读写口径一致）')
})

test('变异反证：去掉 invalidateSeatDaily 调用后，判据必须失败', () => {
  const src = read(VIEW)
  const body = extractFunctionDecl(src, 'onHistoryChanged')
  assert.equal(onHistoryChangedGuard(body).ok, true, '基线必须通过，否则反证无意义')
  const mutated = body.replace(/\s*invalidateSeatDaily\(\)\r?\n/, '')
  // @pin student-frontend/src/views/SeatView.vue#onHistoryChanged
  assert.ok(mutated !== body, '变异没匹配到 invalidateSeatDaily()')
  assert.equal(onHistoryChangedGuard(mutated).ok, false, '判据假绿：去掉缓存作废仍判 PASS')
})
