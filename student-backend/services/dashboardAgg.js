// ==================== 首屏聚合的 SQL 出口 ====================
// routes/dashboard.js 只保留编排与降级；这里负责「只取首页要用的列/聚合」，
// 避免 students / fee_records 整表读进内存（K03-09）。
const { db } = require('../db')

// 首页值日卡片只需要 id → 姓名；电话/备注等列一律不下发、不读入。
function studentsLite() {
  return db.prepare('SELECT id, 姓名 FROM students').all()
}

// 座位/值日概览用：除展示姓名外还要用学号区分同名学生（值日指数列表），
// 但其余列（电话/备注/缴费…）一律不下发。
function studentsBrief() {
  return db.prepare('SELECT id, 姓名, 学号 FROM students').all()
}

// 余额 / 本月收入 / 本月支出 / 总条数，口径与改造前 JS 累加逐行对齐：
//   支出记负、其余记正；月份按 收支时间 前 7 位比较（与前端 YYYY-MM 同口径）。
function feeSummary(monthPrefix) {
  return db.prepare(`
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN TRIM(收支类型) = '支出' THEN -ABS(COALESCE(收支金额, 0)) ELSE ABS(COALESCE(收支金额, 0)) END), 0) AS balance,
      COALESCE(SUM(CASE WHEN SUBSTR(COALESCE(收支时间, ''), 1, 7) = ? AND TRIM(收支类型) <> '支出'
                        THEN ABS(COALESCE(收支金额, 0)) ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN SUBSTR(COALESCE(收支时间, ''), 1, 7) = ? AND TRIM(收支类型) = '支出'
                        THEN ABS(COALESCE(收支金额, 0)) ELSE 0 END), 0) AS expense
    FROM fee_records
  `).get(monthPrefix, monthPrefix)
}

module.exports = { studentsLite, studentsBrief, feeSummary }
