// =========================================================================
// interaction-safety.test.js —— 交互安全接线（v8 审查 A-4：F02-01/03/07/08/11、F06-10）
//
// 这些修复都在 Vue 组件里，单测不跑 DOM；判据是「破坏性动作是否真的经过确认层」
// 「提交按钮是否真的绑了在途态」——用源码结构断言，配合人工走查。
// 变异反证：删掉对应 ConfirmDialog / :disabled / 守卫分支，本文件必须红。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')


// 原生 confirm()（排除 confirmOpen / confirmDelete / ConfirmDialog 这类标识符）
const NATIVE_CONFIRM = /(^|[^.\w])confirm\s*\(/m

test('F02-01 MCP「删除配置」必须经 ConfirmDialog 确认后才 revoke', () => {
  const src = read('student-frontend/src/components/data-manage/McpTokensDialog.vue')
  assert.match(src, /@click="revokeTarget = t"/, '删除配置按钮只能打开确认层，不能直接调 revoke')
  assert.doesNotMatch(src, /@click="revoke\(/, '不能再有点击即失效的入口')
  assert.match(src, /:visible="!!revokeTarget"/)
  // @pin student-frontend/src/components/data-manage/McpTokensDialog.vue#doRevoke
  assert.match(src, /@confirm="doRevoke"/)
  // @pin student-frontend/src/components/data-manage/McpTokensDialog.vue#doRevoke
  assert.match(src, /async function doRevoke\(\)/)
  assert.match(src, /encodeURIComponent\(t\.id\)\}\/revoke/)
})

test('F02-03 Markdown 编辑：保存按钮有在途禁用，父级置位/复位', () => {
  const dlg = read('student-frontend/src/components/data-manage/MarkdownEditDialog.vue')
  assert.match(dlg, /pending: \{ type: Boolean/, '弹窗要有 pending prop')
  assert.match(dlg, /:disabled="!name\.trim\(\) \|\| pending"/)
  assert.match(dlg, /if \(props\.pending\) return/, '保存函数自身也要拦重复提交')
  const parent = read('student-frontend/src/components/data-manage/DataManageDialog.vue')
  assert.match(parent, /:pending="mdSaving"/)
  assert.match(parent, /async function onMdSave[\s\S]*?mdSaving\.value = true[\s\S]*?mdSaving\.value = false/)
})

test('F02-07 值日/座位回填：提交在途禁用 + 成功文案兜底', () => {
  for (const rel of [
    'student-frontend/src/components/dialogs/DutyBackfillDialog.vue',
    'student-frontend/src/components/dialogs/SeatBackfillDialog.vue',
  ]) {
    const src = read(rel)
    assert.match(src, /const submitting = ref\(false\)/, `${rel} 缺 submitting`)
    assert.match(src, /:disabled="submitting"/, `${rel} 按钮未绑在途态`)
    assert.match(src, /if \(submitting\.value\) return/, `${rel} 缺重复提交守卫`)
    assert.match(src, /res\.data && res\.data\.message\) \|\| '已写入该周记录'/, `${rel} 成功文案要有兜底`)
    assert.match(src, /finally \{ submitting\.value = false \}/)
  }
})

test('F02-08 临时生批量转正先确认；成绩删除走确认链路', () => {
  const ps = read('student-frontend/src/components/dialogs/ProvisionalStudentsDialog.vue')
  assert.match(ps, /@click="confirmOpen = true"/)
  assert.match(ps, /:visible="confirmOpen"/)
  assert.match(ps, /@confirm="convert"/)
  assert.match(ps, /confirmOpen\.value = false[\s\S]*?if \(!selectedIds\.value\.length \|\| converting\.value\) return/)

  const score = read('student-frontend/src/views/ScoreManagement.vue')
  assert.match(score, /@delete="rec => rec && askDelete\(rec\)"/, '删除必须经过 askDelete 的确认弹窗')
  assert.doesNotMatch(score, /@delete="rec => deleteScore\(/, '不能回到直接删')
})

test('F02-11 导入覆盖先确认，且校验失败不先关导入弹窗', () => {
  for (const rel of [
    'student-frontend/src/components/dialogs/SettingsDialog.vue',
    'student-frontend/src/components/dialogs/DutySettingsDialog.vue',
  ]) {
    const src = read(rel)
    assert.match(src, /:visible="!!importTarget"/, `${rel} 缺覆盖确认层`)
    assert.match(src, /function applyImport\(\)/, `${rel} 缺确认后的执行函数`)
    const fn = src.slice(src.indexOf('function onImportData'), src.indexOf('function applyImport'))
    const closeAt = fn.indexOf('importVisible.value = false')
    const errorsAt = fn.indexOf('if (errors.length)')
    assert.ok(errorsAt >= 0 && closeAt > errorsAt, `${rel} 必须先校验再关弹窗`)
    assert.match(fn, /importTarget\.value = next/)
  }
})

test('F06-10 相册删除照片不再用原生 confirm()', () => {
  const src = read('student-frontend/src/views/AlbumView.vue')
  // 先去掉 HTML / 行注释，避免说明文字里的 confirm() 误判
  const code = src.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, NATIVE_CONFIRM, '原生 confirm() 必须移除')
  assert.match(src, /<ConfirmDialog/)
  assert.match(src, /:visible="!!deleteTarget"/)
  // @pin student-frontend/src/views/AlbumView.vue#doDeletePhoto
  assert.match(src, /@confirm="doDeletePhoto"/)
  // @pin student-frontend/src/views/AlbumView.vue#deletePhoto
  assert.match(src, /function deletePhoto\(p\) \{\s*if \(!p\) return\s*deleteTarget\.value = p/)
})

// ---- V9 接线判据（从 v9-fixes.test.js 并入，同类纯源码判据不另起文件）----
test('V9-F01-01 候选下拉：模板用的 studentRowLabel 必须在 setup 作用域可解析', () => {
  const src = read('student-frontend/src/components/CadreTreeList.vue')
  // @pin student-frontend/src/components/CadreTreeList.vue#studentRowLabel
  assert.match(src, /\{\{\s*studentRowLabel\(s\)\s*\}\}/)
  // @pin student-frontend/src/components/CadreTreeList.vue#studentRowLabel
  assert.match(src, /import\s*\{\s*studentRowLabel\s*\}\s*from\s*['"]\.\.\/utils\/studentLabel\.js['"]/,
    '必须从 utils/studentLabel.js 导入；V9-F01-01 漏这一行会让候选下拉 ReferenceError')
})

test('V9-F02-01 快照「管理」：v-if 与 visible 的 ref 必须同一函数同时置位', () => {
  const src = read('student-frontend/src/views/SettingsView/SettingsView.vue')
  // @pin student-frontend/src/views/SettingsView/SettingsView.vue#openSnapshotPickerFromSettings
  assert.match(src, /@view-snapshots="openSnapshotPickerFromSettings"/)
  const fn = src.match(/function openSnapshotPickerFromSettings\(\)\s*\{([\s\S]*?)\}/)
  assert.ok(fn, '必须有统一打开函数')
  // @pin student-frontend/src/views/SettingsView/SettingsView.vue#openSnapshotPickerFromSettings
  assert.match(fn[1], /snapshotPickerOpened\.value\s*=\s*true/)
  // @pin student-frontend/src/views/SettingsView/SettingsView.vue#openSnapshotPickerFromSettings
  assert.match(fn[1], /snapshotPickerOpen\.value\s*=\s*true/)
})

test('V9-F03-01 GridView 手输改名不得残留原格子的 _studentId', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  const body = src.slice(src.indexOf('saveEditCell()'), src.indexOf('cancelEdit()'))
  // @pin student-frontend/src/components/tables/GridView/GridView.vue#saveEditCell
  assert.match(body, /const cell = \{ \.\.\.original/)
  // @pin student-frontend/src/components/tables/GridView/GridView.vue#saveEditCell
  assert.match(body, /cell\._studentId = null/)
  // @pin student-frontend/src/components/tables/GridView/GridView.vue#saveEditCell
  assert.match(body, /if \(ctx\.candidateIdField\.value[\s\S]*?\)\s*\{[\s\S]*?\}\s*else\s*\{/,
    '手输改名（id 已清）也要走 else 清掉残留 id')
})

// V9-F06-01 成功路径统一清明文口令（从 v9-fixes 同类判据并入）
test('登录页每个成功跳转前都清掉明文口令 ref', () => {
  const src = read('student-frontend/src/views/Login.vue')
  // @pin student-frontend/src/views/Login.vue#clearPlainPassword
  assert.match(src, /function clearPlainPassword\(\)[\s\S]{0,120}password\.value\s*=\s*''[\s\S]{0,60}confirm\.value\s*=\s*''/)
  const pushes = [...src.matchAll(/router\.push\('\/'\)/g)]
  assert.ok(pushes.length >= 6, `成功跳转应≥6处，实际 ${pushes.length}`)
  for (const m of pushes) {
    const before = src.slice(Math.max(0, m.index - 120), m.index)
    // @pin student-frontend/src/views/Login.vue#clearPlainPassword
    assert.match(before, /clearPlainPassword\(\)/, `跳转 ${m.index} 前必须先清明文口令`)
  }
})
