// schema 拆分子文件：加分/扣分记录表 + 索引。
//
// 外键声明（v6 · N2-03 第一步）：只写 `REFERENCES`，**不开 PRAGMA foreign_keys**。
// 声明对已存在的库是空操作（CREATE TABLE IF NOT EXISTS 不会改老表），对新建库只是
// 把「学生删了，他的加分记录也不该留着」这条约定写进表结构 —— 真正生效要等第 ③ 步。
// ON DELETE CASCADE 与现有应用层行为一致（删学生时逐个删子表），不是新增语义。
function migrateScore(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS score_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      姓名 TEXT,
      学号 TEXT,
      类型 TEXT,
      项目 TEXT,
      分值 REAL,
      原因 TEXT,
      加分时间 TEXT,
      created_at TEXT,
      source TEXT DEFAULT 'personal',
      group_name TEXT,
      成员数 INTEGER DEFAULT 0
    );
  `);

  // 优化：加分按学生过滤 + 时间排序展示
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_score_student_time ON score_records (student_id, 加分时间);`);
}

module.exports = { migrateScore };
