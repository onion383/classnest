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

// N1-28：从真实源码抽函数、注入桩依赖真跑；变异直接改文件源码后走同一入口。
function runOnHistoryChanged(transform = (s) => s) {
  const source = transform(read(VIEW))
  const decl = extractFunctionDecl(source, 'onHistoryChanged')
  const calls = []
  const deps = {
    invalidateSeatDaily: () => calls.push('invalidate'),
    fetchHistoryWeeks: () => calls.push('weeks'),
  }
  const names = Object.keys(deps)
  const fn = new Function(...names, `return ${decl}`)(...names.map((k) => deps[k]))
  return { calls, invoke: () => fn() }
}

test('座位页：两个弹窗都绑 onHistoryChanged，且真执行时先作废缓存再刷新', () => {
  const src = read(VIEW)
  const bindings = (src.match(/@changed="onHistoryChanged"/g) || []).length
  assert.equal(bindings, 2, '补录与管理周记录两个弹窗都要绑 onHistoryChanged')
  const { calls, invoke } = runOnHistoryChanged()
  invoke()
  assert.deepEqual(calls, ['invalidate', 'weeks'], '必须先作废每日快照缓存，再刷新周列表')
})

test('变异反证：真源码删掉缓存作废后，刷新周列表但缓存不再失效', () => {
  const { calls, invoke } = runOnHistoryChanged((s) => {
    const out = s.replace(/(function onHistoryChanged\(\) \{\r?\n)  invalidateSeatDaily\(\)\r?\n/, '$1')
    if (out === s) throw new Error('变异没匹配到 invalidateSeatDaily()')
    return out
  })
  invoke()
  assert.deepEqual(calls, ['weeks'], '守卫失效：账本/指数会继续命中旧缓存')
})
