// schema 拆分子文件：请假记录表 + 索引。
// 外键声明：见 schema.score.js 头部说明（只声明、不开 PRAGMA）。
function migrateLeave(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS leave_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position INTEGER DEFAULT 1,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      -- 姓名是**快照**，不是引用：请假表格直接展示它，不必 join students。
      -- 关联依据是 student_id；手输的名单外姓名会通过 resolveOne 建临时学生再回填 id，
      -- 同名歧义时 id 留空、姓名照存（不替用户猜）。
      姓名 TEXT,
      类型 TEXT,
      开始时间 TEXT,
      结束时间 TEXT,
      家长联系电话 TEXT,
      学生联系电话 TEXT,
      状态 TEXT DEFAULT '请假中',
      返校时间 TEXT,
      备注 TEXT,
      created_at TEXT
    );
  `);

  // 优化：请假按学生+状态过滤（看板统计/时段冲突校验）
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_leave_student_status ON leave_records (student_id, 状态);`);
}

module.exports = { migrateLeave };
