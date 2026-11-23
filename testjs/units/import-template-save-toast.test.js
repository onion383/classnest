// =========================================================================
// import-template-save-toast.test.js —— 下载标准导入表保存成功后弹提示条
// saveBlobWithDialog 语义：非空路径=成功、空串=用户取消、抛异常=失败。
// 只有成功才该提示；取消不打扰，失败走既有 parseError。
// =========================================================================
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '../../student-frontend/src/components/import-export/ImportExcel.vue')
const s = fs.readFileSync(SRC, 'utf8')

test('引入并初始化 useNotification 的 success', () => {
  assert.match(s, /import \{ useNotification \} from '\.\.\/\.\.\/composables\/useNotification'/, '缺少 useNotification 引入')
  assert.match(s, /const \{ success: notifySuccess \} = useNotification\(\)/, '缺少 notifySuccess 初始化')
})

test('保存成功的返回值被接住，且只在非空（真保存）时弹提示', () => {
  const fn = s.match(/async function downloadTemplate\(\)[\s\S]*?\n\}/)
  assert.ok(fn, '找不到 downloadTemplate')
  const body = fn[0]
  assert.match(body, /const saved = await saveBlobWithDialog\(/, '必须接住 saveBlobWithDialog 的返回值')
  assert.match(body, /if \(saved\) notifySuccess\('标准导入表已保存'\)/, '只在成功时弹「标准导入表已保存」')
  // 提示必须在 try 内、catch 之前 —— 失败时不该报成功
  const tryAt = body.indexOf('try {')
  const catchAt = body.indexOf('} catch')
  const toastAt = body.indexOf('notifySuccess(')
  assert.ok(tryAt < toastAt && toastAt < catchAt, '提示应位于 try 内、catch 之前')
})
