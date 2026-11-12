// =========================================================================
// dashboard-summary.test.js —— 首屏 dashboard 摘要化（v6 性能专题 · 2-1）
//
// 实测基线（45 人 / 一学期 1000 条加减分 / 120 条班费）：整包 358.8KB，
// 其中 scores 占 326KB（91%），JSON.parse 仅 0.82ms —— 体积超标、解析不慢。
// 本用例锁三件事：
//   ① 全量 scores / fees 不再出现在响应里，students 只剩 id+姓名；
//   ② summary 的四个口径与改造前 DashboardView 的 computed 逐项一致（顺序/正负/月份前缀）；
//   ③ 同样数据量下整包 < 30KB（防止以后又把大数组塞回首屏）。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const express = backendRequire('express')

process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-summary-'))
process.env.DATA_DIR = tmp

const { initSchema } = require('../../student-backend/schema/schema')
const { localDateStr } = require('../../student-backend/utils/date')
const conn = new Database(':memory:')
initSchema(conn)

const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
const realDb = require(dbPath)
require.cache[dbPath].exports = { ...realDb, db: conn, getFields: () => [], renumber: () => {} }

const router = require('../../student-backend/routes/dashboard')

const TODAY = localDateStr()
const MONTH = TODAY.slice(0, 7)
const LAST_MONTH = (() => {
  const d = new Date(`${TODAY}T12:00:00`)
  d.setMonth(d.getMonth() - 1)
  return localDateStr(d).slice(0, 7)
})()

let server
let base
const rnd = (i, n) => i % n
const NAMES = ['张', '李', '王', '赵', '钱', '孙', '周', '吴', '郑', '冯']
const GIVEN = ['子涵', '雨桐', '浩然', '思远', '梓轩', '欣怡', '宇辰', '若曦']

test.before(async () => {
  const names = []
  for (let i = 0; i < 45; i++) {
    const name = NAMES[rnd(i, 10)] + GIVEN[rnd(i * 7, 8)]
    conn.prepare('INSERT INTO students (学号, 年级, 班级, 姓名, 家长联系电话, 学生联系电话, 备注) VALUES (?,?,?,?,?,?,?)')
      .run(`2026${String(i + 1).padStart(3, '0')}`, '八年级', '3 班', name, '13800138000', '13900139000', i % 5 === 0 ? '班级委员' : '')
    names.push(name)
  }
  // 1000 条加减分：前 5 条是今天的（覆盖加分/扣分/小组名），其余散在上月
  const insScore = conn.prepare('INSERT INTO score_records (student_id, 姓名, 学号, 类型, 项目, 分值, 原因, 加分时间, created_at, source, group_name) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  conn.transaction(() => {
    // 今天的 5 条：分值 9/7/5(扣分)/3(小组)/1(扣分)，Top4 里要能同时覆盖
    // 「扣分转负数」「小组名兜底」「截断到 4 条」三个分支
    const todayRows = [
      [1, 9, '加分', null], [2, 7, '加分', null], [3, 5, '扣分', null],
      [6, 3, '加分', '第三小组'], [4, 1, '扣分', null],
    ]
    todayRows.forEach(([sid, v, type, group], i) => {
      insScore.run(sid, group ? null : names[sid - 1], `2026${String(sid).padStart(3, '0')}`, type, '课堂表现', v, '课堂表现良好', `${TODAY} 0${8 + i}:00:00`, `${TODAY} 0${8 + i}:00:00`, group ? 'group' : 'personal', group)
    })
    for (let i = 5; i < 1000; i++) {
      const sid = rnd(i, 45) + 1
      const day = String((i % 28) + 1).padStart(2, '0')
      const t = `${LAST_MONTH}-${day} 10:00:00`
      insScore.run(sid, names[sid - 1], `2026${String(sid).padStart(3, '0')}`, i % 3 === 0 ? '扣分' : '加分', '作业完成', i % 3 === 0 ? -1 : 1, '作业按时完成', t, t, 'personal', null)
    }
  })()
  // 班费：本月 3 收 2 支 + 上月 2 笔（上月不应计入「本月」口径）
  const insFee = conn.prepare('INSERT INTO fee_records (收支编码, 收支类型, 收支金额, 收支时间, 备注) VALUES (?,?,?,?,?)')
  insFee.run('F001', '收入', 500, `${MONTH}-01`, '班费收取')
  insFee.run('F002', '收入', 300, `${MONTH}-05`, '班费收取')
  insFee.run('F003', '收入', 100, `${MONTH}-06`, '活动退款')
  insFee.run('F004', '支出', 120.5, `${MONTH}-10`, '采购文具')
  insFee.run('F005', '支出', 60, `${MONTH}-11`, '清洁用品')
  insFee.run('F006', '收入', 999, `${LAST_MONTH}-20`, '上月收入')
  insFee.run('F007', '支出', 88, `${LAST_MONTH}-21`, '上月支出')

  const app = express()
  app.use('/api/dashboard', router)
  await new Promise((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})

test.after(() => {
  server?.close()
  try { conn.close() } catch (_) { /* 忽略 */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 忽略 */ }
})

async function getPayload() {
  const res = await fetch(`${base}/api/dashboard`)
  assert.equal(res.status, 200)
  return res.json()
}

test('不再下发全量 scores / fees，students 只剩 id+姓名', async () => {
  const body = await getPayload()
  assert.deepEqual(body.scores, undefined, 'scores 不得再出现在首屏响应里')
  assert.deepEqual(body.fees, undefined, 'fees 不得再出现在首屏响应里')
  assert.equal(body.students.length, 45)
  assert.deepEqual(Object.keys(body.students[0]).sort(), ['id', '姓名'], '名册只保留 id 与姓名（其余字段不下发）')
  assert.ok(body.summary, '必须带 summary')
})

test('summary 口径与改造前 DashboardView 的 computed 逐项一致', async () => {
  const body = await getPayload()

  // 改造前的前端算法原样复刻（作为对照基准）
  const scoreRows = conn.prepare('SELECT * FROM score_records').all()
  const oldTopScores = scoreRows
    .filter((s) => s['加分时间'] && s['加分时间'].startsWith(TODAY))
    .sort((a, b) => Number(b['分值'] || 0) - Number(a['分值'] || 0))
    .slice(0, 4)
    .map((s) => {
      const name = s['姓名'] || s.group_name || '未知'
      const score = Number(s['分值'] || 0)
      return { name, score: s['类型'] === '扣分' ? -score : score }
    })

  const feeRows = conn.prepare('SELECT * FROM fee_records').all()
  const oldBalance = feeRows.reduce((sum, r) => {
    const amount = Number(r['收支金额'] || 0)
    const type = String(r['收支类型'] || '').trim()
    return type === '支出' ? sum - Math.abs(amount) : sum + Math.abs(amount)
  }, 0)
  const inMonth = (r) => String(r['收支时间'] || '').startsWith(MONTH)
  const oldIncome = feeRows.reduce((sum, r) => {
    if (!inMonth(r)) return sum
    return String(r['收支类型'] || '').trim() !== '支出' ? sum + Math.abs(Number(r['收支金额'] || 0)) : sum
  }, 0)
  const oldExpense = feeRows.reduce((sum, r) => {
    if (!inMonth(r)) return sum
    return String(r['收支类型'] || '').trim() === '支出' ? sum + Math.abs(Number(r['收支金额'] || 0)) : sum
  }, 0)

  assert.equal(body.summary.studentCount, 45)
  assert.equal(body.summary.scoreCount, 1000)
  assert.equal(body.summary.feeCount, 7)
  assert.deepEqual(body.summary.topScores, oldTopScores)
  // 扣分必须转成负数、小组行必须用小组名（这两条是改造前 computed 的显式分支）
  assert.ok(body.summary.topScores.some((s) => s.score < 0), 'Top4 里应包含扣分（负数）')
  assert.ok(body.summary.topScores.some((s) => s.name === '第三小组'), '小组加分应显示小组名')
  assert.equal(body.summary.topScores.length, 4)
  assert.equal(body.summary.feeBalance, oldBalance)
  assert.equal(body.summary.monthIncome, oldIncome)
  assert.equal(body.summary.monthExpense, oldExpense)
  // 上月的收支只进余额，不进「本月」
  assert.ok(oldBalance !== oldIncome - oldExpense, '本月口径与总余额必须不同（用例数据要能区分两者）')
})

test('同样 1000 条加分下整包 < 30KB（改造前 358.8KB）', async () => {
  const body = await getPayload()
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  assert.ok(bytes < 30 * 1024, `首屏整包应 < 30KB，实际 ${(bytes / 1024).toFixed(1)}KB`)
})

test('前端接线：normalize 不再兜 scores/fees，DashboardView 只读 summary', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'student-frontend/src/composables/useDashboardData.js'), 'utf8')
  assert.doesNotMatch(dash, /scores: \(d && d\.scores\)/)
  assert.doesNotMatch(dash, /fees: \(d && d\.fees\)/)
  assert.match(dash, /summary: \{ \.\.\.EMPTY_SUMMARY, \.\.\.summary \}/)

  const view = fs.readFileSync(path.join(ROOT, 'student-frontend/src/views/DashboardView.vue'), 'utf8')
  assert.doesNotMatch(view, /scores\.value/, '首页不得再遍历全量加分')
  assert.doesNotMatch(view, /fees\.value/, '首页不得再遍历全量班费')
  assert.doesNotMatch(view, /d\.scores|d\.fees/, '不得再从首屏数据里取全量数组')
  assert.match(view, /const topScores = computed\(\(\) => summary\.value\.topScores/)
  assert.match(view, /summary\.feeCount/)

  // 造数工具的「回读校验」也要跟着改，否则脚本一跑就抛 TypeError
  const seed = fs.readFileSync(path.join(ROOT, 'testjs/tools/seed-test-data.js'), 'utf8')
  assert.doesNotMatch(seed, /dash\.scores\.length|dash\.fees\.length/)
  assert.match(seed, /dash\.summary\.scoreCount/)
})
