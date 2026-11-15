// schema 拆分子文件：系统设置表（widget_settings）。
function migrateWidget(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS widget_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      -- 工具箱默认关闭：首次进入不该先被一堆窗口围住，由引导页「功能开关」明确勾选才开。
      -- 只影响新建库；已有库的那一行保持原值（INSERT OR IGNORE 不会覆盖）。
      toolbox_enabled INTEGER DEFAULT 0,
      note_save_path TEXT DEFAULT '',
      screenshot_save_path TEXT DEFAULT '',
      -- desktop_apps：桌面小组件常用软件列表（JSON 数组文本）
      desktop_apps TEXT DEFAULT '[]',
      -- class_info：首页班级信息（班名/口号/班风/学风，JSON 文本）
      class_info TEXT DEFAULT '{}',
      -- 点名器是否排除「今天不在校」的学生；默认关，保持原有全员点名行为
      rollcall_exclude_absent INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO widget_settings (id) VALUES (1);
  `);

  // 旧库升级：CREATE TABLE IF NOT EXISTS 不会给已存在的表补列（同 schema.ai.js 的做法）。
  // 少了这一步，旧库上的 PUT /api/widget-settings 会直接报 no such column。
  const cols = conn.prepare('PRAGMA table_info(widget_settings)').all().map((c) => c.name);
  if (!cols.includes('rollcall_exclude_absent')) {
    conn.exec('ALTER TABLE widget_settings ADD COLUMN rollcall_exclude_absent INTEGER NOT NULL DEFAULT 0');
  }
}

module.exports = { migrateWidget };
