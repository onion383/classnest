// =========================================================================
// interaction-safety.test.js —— 交互安全接线（v8 审查 A-4：F02-01/03/07/08/11、F06-10）
//
// 这些修复都在 Vue 组件里，单测不跑 DOM；判据是「破坏性动作是否真的经过确认层」
// 「提交按钮是否真的绑了在途态」——用源码结构断言，配合人工走查。
// 变异反证：删掉对应 ConfirmDialog / :disabled / 守卫分支，本文件必须红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// 原生 confirm()（排除 confirmOpen / confirmDelete / ConfirmDialog 这类标识符）
const NATIVE_CONFIRM = /(^|[^.\w])confirm\s*\(/m

test('F02-01 MCP「删除配置」必须经 ConfirmDialog 确认后才 revoke', () => {
  const src = read('student-frontend/src/components/data-manage/McpTokensDialog.vue')
  assert.match(src, /@click="revokeTarget = t"/, '删除配置按钮只能打开确认层，不能直接调 revoke')
  assert.doesNotMatch(src, /@click="revoke\(/, '不能再有点击即失效的入口')
  assert.match(src, /:visible="!!revokeTarget"/)
  assert.match(src, /@confirm="doRevoke"/)
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
  assert.match(src, /@confirm="doDeletePhoto"/)
  assert.match(src, /function deletePhoto\(p\) \{\s*if \(!p\) return\s*deleteTarget\.value = p/)
})
