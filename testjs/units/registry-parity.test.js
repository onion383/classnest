// =========================================================================
// registry-parity.test.js —— v8 B-3 注册表/名单对账（Q3-01/02/03、X3-20~23）
//
// 判据：凡是「表名清单」都必须落在 tableRegistry 的已知名字里；
// 历史只读视图能真的被查询；AI 列表 / 搜索源 / 前端撤销 key 不再各自漂移。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb, ROOT, backendRequire } = require('./_db-express-fixture.cjs')

// 夹具必须先建：searchQuery / ai.constants 在 require 时可能触碰 db 的初始化链
const fx = createBackendDb({ label: 'registry-parity' })
test.after(() => fx.close())

const registry = require('../../student-backend/schema/tableRegistry')
const aiConstants = backendRequire(path.join(ROOT, 'student-backend/routes/ai/ai.constants.js'))
const { SEARCH_SOURCE_TABLES } = backendRequire(path.join(ROOT, 'student-backend/services/searchQuery.js'))

const unknown = (names) => names.filter((n) => !registry.isKnownName(n))

test('X3-20：三张历史只读视图登记为已知表名', () => {
  assert.deepEqual([...registry.HISTORY_VIEWS].sort(), ['duty_history', 'schedule_history', 'seat_history'])
  assert.deepEqual(unknown([...registry.HISTORY_VIEWS]), [])
})

test('X3-22：历史视图真实可查（不是只写在名单里）', () => {
  for (const view of registry.HISTORY_VIEWS) {
    const rows = fx.conn.prepare(`SELECT * FROM ${view} LIMIT 1`).all()
    assert.ok(Array.isArray(rows), `${view} 应可查询`)
  }
})

test('X3-21 / Q3-02：AI 可读 / 可写 / 搜索表名单都来自注册表已知名字', () => {
  assert.deepEqual(unknown(Object.keys(aiConstants.READ_TABLES)), [], 'READ_TABLES 出现未登记表名')
  assert.deepEqual(unknown(Object.keys(aiConstants.JSON_WRITE_TABLES)), [], 'JSON_WRITE_TABLES 出现未登记表名')
  assert.deepEqual(unknown(Object.keys(aiConstants.WRITE_TABLES)), [], 'WRITE_TABLES 出现未登记表名')
  assert.deepEqual(unknown([...registry.AI_SEARCH_TABLES]), [], 'AI_SEARCH_TABLES 出现未登记表名')
})

test('X3-23：全局搜索源表名引用注册表，不再手抄第三份', () => {
  assert.ok(SEARCH_SOURCE_TABLES.length >= 10)
  assert.deepEqual(unknown([...SEARCH_SOURCE_TABLES]), [])
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/services/searchQuery.js'), 'utf8')
  assert.match(src, /require\('\.\.\/schema\/tableRegistry'\)/, '搜索源必须引用注册表')
})

test('Q3-01：前端 AI 表的 LABELS / DOC_UNDO_KEY 含 widget_settings', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-frontend/src/composables/ai/aiConstants.js'), 'utf8')
  const labels = src.slice(src.indexOf('export const LABELS'), src.indexOf('// 整块写入'))
  assert.match(labels, /widget_settings:/)
  const undo = src.slice(src.indexOf('export const DOC_UNDO_KEY'), src.indexOf('// 前端设置项'))
  assert.match(undo, /widget_settings:/)
})

test('K05-08：座位对象格参与姓名检索（不再落成 [object Object]）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/services/searchQuery.js'), 'utf8')
  assert.match(src, /if \(typeof v === 'object'\)\s*\{[\s\S]{0,160}?nameOfSeat\(v\.student_id\)/)
  assert.match(src, /String\(v\.name \|\| ''\)/)
})

test('E01-04 / F07-08 / K01-11：外壳返回值、代理现取、路径归一', () => {
  const dlg = fs.readFileSync(path.join(ROOT, 'electron/main/main.dialogs.js'), 'utf8')
  const openFolderAt = dlg.indexOf('CH.OPEN_FOLDER')
  const openFolder = dlg.slice(openFolderAt, dlg.indexOf('CH.GET_DATA_DIRECTORIES', openFolderAt))
  assert.match(openFolder, /const error = await shell\.openPath\(safe\.path\)/)
  assert.match(openFolder, /if \(error\) return contract\.fail\(error\)/)

  const vite = fs.readFileSync(path.join(ROOT, 'student-frontend/vite.config.js'), 'utf8')
  assert.equal((vite.match(/router: \(\) => ports\.backendOrigin/g) || []).length, 2,
    '两个代理目标都必须每请求现取')

  const build = fs.readFileSync(path.join(ROOT, 'student-backend/build.bundle.mjs'), 'utf8')
  assert.match(build, /out\.push\(path\.relative\(HERE, full\)/)
  assert.match(build, /path\.relative\(HERE, abs\)/)
})

test('SUPP-02 / X1-05 / X1-07：字段限定命中、boot-status 主窗口角色、生成入口', () => {
  const sq = fs.readFileSync(path.join(ROOT, 'student-backend/services/searchQuery.js'), 'utf8')
  assert.match(sq, /\(!t\.cols \|\| t\.cols\.includes\(c\)\)/, 'hitColumn 必须尊重字段限定')
  assert.deepEqual(require(path.join(ROOT, 'electron/ipc-policy.json'))['boot-status'].sort(), ['main', 'setup'])
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts['policy:gen'], '必须有策略生成入口')
})

test('Q1-01 / Q1-07 / X3-01：拼音命中与成绩列名口径统一', () => {
  const pinyin = fs.readFileSync(path.join(ROOT, 'student-frontend/src/utils/pinyinSearch.js'), 'utf8')
  assert.match(pinyin, /export function pinyinHit/)
  assert.match(fs.readFileSync(path.join(ROOT, 'student-frontend/src/utils/tableSearch.js'), 'utf8'), /pinyinHit\(val, kw\)/)
  assert.match(fs.readFileSync(path.join(ROOT, 'student-frontend/src/views/SettingsView/SettingsView.vue'), 'utf8'), /pinyinHit\(label, q\)/)
  assert.match(fs.readFileSync(path.join(ROOT, 'student-frontend/src/components/data-manage/DataExportPanel.vue'), 'utf8'), /pinyinHit\(t\.label, q\)/)
  const score = fs.readFileSync(path.join(ROOT, 'student-frontend/src/views/ScoreManagement.vue'), 'utf8')
  assert.ok(!/加分原因/.test(score), '显示名应与存储列「原因」一致')
})
