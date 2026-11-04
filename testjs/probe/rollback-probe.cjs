// =========================================================================
// rollback-probe.cjs —— 「失败后 UI 必须回滚」回归探针
//
// 背景（v4 审查 P2）：
//   一类共同 bug：**先改本地状态、再发请求，失败后不恢复**。
//   用户看到的是「改好了」，但后端根本没存 → 刷新一下就变回去，比直接报错更让人困惑。
//   典型：
//     · useTableCRUD.saveCell：v-model 已写新值，PUT 失败只弹提示，格子仍显示新值
//     · AiSettingsDialog.onCardModelChange：PUT 失败仍 emit('saved')，父组件以为成功
//     · AlbumTaskDialog.togglePauseAll：失败后 queuePaused 仍为 true，队列卡死
//     · ScheduleView.master.saveMasterSettings：失败后设置不回滚、弹窗已关
//     · DutyArrangementDialog.dimension.fetchDimensions：写 rejectText 不调 showReject → 提示条永驻
//
// 这个探针做什么：
//   对每个「乐观更新」调用点，静态断言它的失败路径里存在回滚动作。
//   判据是「失败分支里出现了回滚标识（写回旧值 / 恢复可见性 / 条件化 emit）」，
//   不是完整 AST 分析 —— 目的是让「失败后忘了回滚」变成可检测的失败，而不是靠人记得。
//
// ⚠️ 这批 bug 有一个共同陷阱：**回滚写成「无条件恢复」也是错的**
//   （例如 saveCell 失败时把 undefined 写进字段，把「本来没这个字段」变成「字段值为 undefined」）。
//   所以第 3 组断言专门覆盖这类边界。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'student-frontend', 'src')

let failures = 0
function assert(cond, msg, okMsg) {
  if (!cond) {
    failures++
    console.error('  ✗ ' + msg)
  } else {
    console.log('  ✓ ' + (okMsg || msg))
  }
}

function read(rel) {
  const p = path.join(SRC, rel)
  if (!fs.existsSync(p)) {
    failures++
    console.error(`  ✗ 文件不存在：${rel}`)
    return ''
  }
  return fs.readFileSync(p, 'utf8')
}

// ---------------------------------------------------------------------------
// 1) 乐观更新失败必须有回滚
// ---------------------------------------------------------------------------
console.log('== 1) 失败路径必须回滚 ==')
const ROLLBACK = [
  {
    file: 'composables/useTableCRUD.js',
    id: 'V4-B10-12',
    what: 'saveCell：单元格保存失败后本地值要回滚',
    // 失败分支里必须出现写回旧值的动作
    expect: /live\[field\.name\]\s*=\s*oldVal/,
  },
  {
    file: 'components/dialogs/AiSettingsDialog.vue',
    id: 'V4-B07-06',
    what: 'onCardModelChange：保存失败不能 emit("saved")',
    // emit('saved') 必须在 ok 为真的条件下
    expect: /if\s*\(\s*ok\s*\)\s*emit\('saved'\)/,
  },
  {
    file: 'components/dialogs/AlbumTaskDialog.vue',
    id: 'V4-B07-09',
    what: 'togglePauseAll：暂停失败要把队列冻状态拨回去',
    expect: /if\s*\(\s*!ok\s*\)\s*queuePaused\.value\s*=\s*prev/,
  },
  {
    file: 'views/ScheduleView/ScheduleView.master.js',
    id: 'V4-B06-08',
    what: 'saveMasterSettings：保存失败要回滚设置与表头',
    expect: /ctx\.masterSettings\.value\s*=\s*prev\.settings/,
  },
]
for (const r of ROLLBACK) {
  const src = read(r.file)
  if (!src) continue
  assert(r.expect.test(src), `${r.id} ${r.file}：失败路径缺少回滚动作（${r.what}）`, `${r.id} ${r.file}：失败路径有回滚`)
}

// ---------------------------------------------------------------------------
// 2) 回滚要覆盖「全部被改动的本地状态」，不能只回滚一半
// ---------------------------------------------------------------------------
console.log('== 2) 回滚覆盖全部被改动的状态 ==')
{
  const src = read('views/ScheduleView/ScheduleView.master.js')
  // saveMasterSettings 改了 3 处：settings / colHeaders / cells（+ 弹窗可见性）
  for (const [what, re] of [
    ['settings', /ctx\.masterSettings\.value\s*=\s*prev\.settings/],
    ['colHeaders', /ctx\.masterColHeaders\.value\s*=\s*prev\.headers/],
    ['cells', /ctx\.masterCells\.value\s*=\s*prev\.cells/],
    ['弹窗可见性', /ctx\.masterSettingsVisible\.value\s*=\s*true/],
  ]) {
    assert(re.test(src),
      `V4-B06-08 views/ScheduleView/ScheduleView.master.js：回滚漏了 ${what}（只回滚一部分 → 界面仍然半新半旧）`,
      `V4-B06-08：回滚覆盖了 ${what}`)
  }
}

// ---------------------------------------------------------------------------
// 3) 回滚本身不能引入新问题：无旧值时要删字段，不能写 undefined
// ---------------------------------------------------------------------------
console.log('== 3) 回滚不会把「无此字段」变成「值为 undefined」 ==')
{
  const src = read('composables/useTableCRUD.js')
  assert(/if\s*\(\s*oldVal\s*===\s*undefined\s*\)\s*delete\s+live\[field\.name\]/.test(src),
    'V4-B10-12 composables/useTableCRUD.js：旧值为 undefined 时应 delete 字段，而不是写 undefined',
    'V4-B10-12：oldVal 为 undefined 时删字段')
}

// ---------------------------------------------------------------------------
// 4) 提示条类失败必须成对出现（写文案 + 启动清除定时器）
//    只写文案不启动清除 → 提示条永久驻留
// ---------------------------------------------------------------------------
console.log('== 4) 提示条失败路径成对（文案 + 清除） ==')
{
  const src = read('components/dialogs/DutyArrangementDialog/DutyArrangementDialog.dimension.js')
  const m = src.match(/catch\s*\([^)]*\)\s*\{([\s\S]*?)\}/)
  assert(m && /rejectText\.value\s*=/.test(m[1]),
    'V4-B07-10：失败分支应写 rejectText',
    'V4-B07-10：失败分支写了 rejectText')
  assert(m && /showReject\(\)/.test(m[1]),
    'V4-B07-10：失败分支只写 rejectText 不调 showReject() → 提示条永久驻留（showReject 负责起 2500ms 清除定时器）',
    'V4-B07-10：失败分支成对调用了 showReject()')
}

console.log('')
if (failures) {
  console.error(`✗ rollback-probe：${failures} 项未通过`)
  process.exit(1)
}
console.log('✓ rollback-probe 全部通过')
