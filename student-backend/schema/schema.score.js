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
      -- 姓名/学号是**快照**，不是引用：导出、检索、AI 描述直接用它们，不必每次 join students。
      -- 关联依据永远是 student_id；改学生姓名不会回写这里（历史记录就该记当时的名字）。
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
  // 列表分页（v6 · 2-23）：GET /api/scores 的排序键是 `加分时间 DESC, id DESC`，
  // 没这个索引时每一页都要把整表排一遍（分页只省了传输和渲染，省不了排序）。
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_score_time ON score_records (加分时间 DESC, id DESC);`);

  // 成绩导入幂等（F07-04）：同一份表重复导入不产生重复记录。
  // 用独立表而非给 score_records 加列——本项目无历史包袱、schema 按最终形态建表，
  // 新表对老库是 CREATE IF NOT EXISTS 空操作、零风险，主表与 insertMany 完全不动。
  // fingerprint = 导入入参的稳定 hash；created_json = 那次导入新建的行 id（回读给撤销登记用）。
  conn.exec(`
    CREATE TABLE IF NOT EXISTS import_batches (
      fingerprint TEXT PRIMARY KEY,
      created_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

module.exports = { migrateScore };
