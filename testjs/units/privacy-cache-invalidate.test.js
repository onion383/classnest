// =========================================================================
// privacy-cache-invalidate.test.js —— 1-9 遗留：脱敏映射必须随库内数据自动失效
//
// 原缺陷：aiPrivacy 按库缓存「姓名 → 别名、电话 → 令牌」。缓存建立后新增学生 /
// 改名 / 新号码都不会失效，新真名与新号码就以明文发给外部模型。
//
// 根因修法：不在写路径逐个调 invalidate（新增写入口照样会漏），而是给缓存加
// 「数据库变更号」（连接级 totalChanges）：任何写操作都会让它变化，下次取映射时
// 自动重建。本测试用**裸 SQL 写入**验证 —— 完全不经过任何业务写接口，仍能失效。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { createBackendDb, ROOT } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'privacy-invalidate', currentSlug: '@pc' })
const SLUG = '@pc'

let aiConfigStore
let aiPrivacyMod
let privacy
let aiStore

test.before(() => {
  aiConfigStore = require(path.join(ROOT, 'student-backend/services/aiConfigStore'))
  aiPrivacyMod = require(path.join(ROOT, 'student-backend/services/aiPrivacy'))
  privacy = aiPrivacyMod.privacy
  aiStore = require(path.join(ROOT, 'student-backend/services/aiStore'))
})

test.after(() => fx.close())

test.beforeEach(() => {
  fx.reset()
  aiConfigStore.setPrivacy({ enabled: true })
  privacy.invalidate()
})

const sub = (v) => privacy.substitute(v, SLUG)
const ALIAS_RE = /^S-[0-9a-z]{6,10}$/
const TOKEN_RE = /^P-[0-9a-z]{6,10}$/

function rawInsertStudent(name, sno = '') {
  fx.conn.prepare('INSERT INTO students (姓名, 学号, is_provisional, position) VALUES (?, ?, 0, 1)')
    .run(name, sno)
}

test('裸 SQL 新增学生（不经过任何业务写接口）也会让映射失效', () => {
  assert.equal(sub('张三'), '张三', '库里还没有这个人时应原样返回')
  rawInsertStudent('张三', '001')
  assert.match(sub('张三'), ALIAS_RE, '写入后仍返回明文 = 缓存没有随库变化失效')
})

test('裸 SQL 改姓名后，新名字被脱敏、旧名字恢复明文', () => {
  rawInsertStudent('李四', '002')
  assert.match(sub('李四'), ALIAS_RE)
  fx.conn.prepare('UPDATE students SET 姓名 = ? WHERE 姓名 = ?').run('李五', '李四')
  assert.equal(sub('李四'), '李四', '旧名已不在名册，不应再被替换')
  assert.match(sub('李五'), ALIAS_RE)
})

test('裸 SQL 删学生后，别名不再命中', () => {
  rawInsertStudent('王五', '003')
  assert.match(sub('王五'), ALIAS_RE)
  fx.conn.prepare('DELETE FROM students WHERE 姓名 = ?').run('王五')
  assert.equal(sub('王五'), '王五')
})

test('请假的联系电话写入后立即换成令牌', () => {
  fx.conn.prepare(`INSERT INTO leave_records (position, student_id, 姓名, 类型, 开始时间, 结束时间, 家长联系电话, 状态)
    VALUES (1, NULL, '钱七', '病假', '2026-11-20 08:00', '2026-11-21 18:00', '13800138000', '请假中')`).run()
  assert.match(sub('13800138000'), TOKEN_RE)
})

test('没有写入时复用同一份映射（缓存仍然生效，不会每次重建）', () => {
  const m1 = privacy.buildMap(SLUG)
  const m2 = privacy.buildMap(SLUG)
  assert.equal(m1, m2, '无写入却重建映射 = 缓存形同虚设')
  rawInsertStudent('赵六', '006')
  const m3 = privacy.buildMap(SLUG)
  assert.notEqual(m1, m3, '有写入后必须重建')
})

test('业务写路径（aiStore / tableService）同样自动失效', () => {
  require(path.join(ROOT, 'student-backend/services/tableService'))
    .insertRow('students', { 姓名: '孙八', 学号: '008' })
  assert.match(sub('孙八'), ALIAS_RE)

  aiStore.insertRow('students', ['姓名', '学号'], ['周九', '009'])
  assert.match(sub('周九'), ALIAS_RE)
  const row = fx.conn.prepare('SELECT id FROM students WHERE 姓名 = ?').get('周九')
  aiStore.deleteRow('students', row.id)
  assert.equal(sub('周九'), '周九')
})

// ————————————————————————— 变异反证 —————————————————————————

test('变异反证：拿掉变更号（readRevision 恒为 null）后，同一份缓存必须漏出真名', () => {
  const students = () => aiStore.listPrivacyStudents()
  const stale = aiPrivacyMod.createAiPrivacy({
    readSeed: () => 'fixed-seed',
    listStudents: students,
    listLeaves: () => [],
    readEnabled: () => true,
    readRevision: () => null, // 模拟「没有自动失效」
  })
  assert.equal(stale.substitute('吴十', SLUG), '吴十')
  rawInsertStudent('吴十', '010')
  assert.equal(stale.substitute('吴十', SLUG), '吴十',
    '无变更号时确实漏成明文 —— 证明生产实例的修复来自 totalChanges 自动失效')
})

test('接线：生产单例用连接级 total_changes() 作为变更号', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'student-backend/services/aiPrivacy.js'), 'utf8')
  assert.match(src, /readRevision:\s*\(\)\s*=>\s*aiStore\.privacyRevision\(\)/)
  assert.match(src, /cached\.rev === rev/, 'stateOf 必须比较变更号后才复用缓存')
  const storeSrc = fs.readFileSync(path.join(ROOT, 'student-backend/services/aiStore.js'), 'utf8')
  assert.match(storeSrc, /SELECT total_changes\(\) AS n/, 'SQL 必须留在 aiStore（aiPrivacy 不留裸 SQL）')
})
