// schema 拆分子文件：分组管理（维度 / 组 / 成员）+ 各列历史迁移 + 外键索引。
function migrateGroup(conn) {
  conn.exec(`
    -- 分组管理：分组维度（宿舍管理/学习小组…，设置维度级：组长称呼/每组人数/小组组数）
    CREATE TABLE IF NOT EXISTS group_dimensions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      leader_title TEXT DEFAULT '',
      members_per_group INTEGER DEFAULT 0,
      group_count INTEGER DEFAULT 0,
      is_default INTEGER DEFAULT 0,
      male_group_count INTEGER DEFAULT 0,
      female_group_count INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0
    );

    -- 分组管理：某个维度下的组（小组名字，如宿舍号 302/303；gender：0=男生 1=女生）
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dimension_id INTEGER NOT NULL REFERENCES group_dimensions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      gender INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0
    );

    -- 分组管理：组内成员（成员 + 备注）
    CREATE TABLE IF NOT EXISTS group_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      -- student_id 是**权威引用**（同名两人靠它区分）；member_name 是快照，只用于显示/导出。
      -- 姓名列故意不加外键：students.姓名 不唯一，SQLite 外键要求父列是 PK 或 UNIQUE。
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      member_name TEXT DEFAULT '',
      remark TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );
  `);

  // 优化：分组/班干部列表是「先查父级，再按父级 id 逐个查成员」的形态，
  // 没索引时每个父级一次全表扫。按外键列建索引（幂等，存量库下次打开自动补建）。
  // 注：cadre_members 的表在本文件末尾才创建，它的索引放在建表处（见下方）。
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_groups_dimension ON groups (dimension_id, sort_order, id);`);
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members (group_id, sort_order, id);`);
  // 按学生反查「他在哪些组」：删除学生、改名联动、学生详情面板都要走这个方向。
  conn.exec(`CREATE INDEX IF NOT EXISTS idx_group_members_student ON group_members (student_id);`);
}

module.exports = { migrateGroup };
