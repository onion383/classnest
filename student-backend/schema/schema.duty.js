const { dropObjectIfExists } = require('./schemaUtil');
// schema 拆分子文件：卫生值日槽位表（设置/当前/模板/权重/草稿）+ 只读逻辑视图。
function migrateDuty(conn) {
  // 这些名字在 SQL 里是 CREATE VIEW，但老库里可能还是表；DROP VIEW 遇到表会抛错，
  // 直接让 initSchema 中断。先按真实类型删干净，下面的 DROP VIEW/TABLE 就成了空操作。
  for (const n of ['duty_settings', 'duty_layout', 'duty_template', 'duty_weight', 'duty_draft']) dropObjectIfExists(conn, n);
  // 原 duty_settings / duty_layout / duty_template / duty_weight / duty_draft 五张同构单例表
  // 合并为 duty_slots，按 kind 区分：
  //   settings：全局「列名 + 劳动项目 + 模式配置」配置（days/items/settings）
  //   current ：当前值日表（cells/settings）
  //   template：值日模板（cells/settings）
  //   weight  ：项目权重表（weights/settings）
  //   draft   ：智能排表草稿（cells/settings/conditions/saved_at）
  conn.exec(`
    CREATE TABLE IF NOT EXISTS duty_slots (
      kind TEXT PRIMARY KEY CHECK (kind IN ('settings','current','template','weight','draft')),
      days TEXT NOT NULL DEFAULT '{"daily":["周一","周二","周三","周四","周五"],"big":[]}',
      items TEXT NOT NULL DEFAULT '[]',
      cells TEXT NOT NULL DEFAULT '{}',
      settings TEXT NOT NULL DEFAULT '{}',
      weights TEXT NOT NULL DEFAULT '{}',
      conditions TEXT NOT NULL DEFAULT '[]',
      saved_at TEXT NOT NULL DEFAULT ''
    );
    -- days 的 daily 分键存用户勾选的星期；big 分键**不存列名** ——
    --   大扫除的列名是「任务分组 + 数量」的纯函数（见 services/dutyConfig.bigColumnNames）：
    --   第1大组…第N大组（第1小组…第N小组）+ 全部。
    --   只存配置（settings.big：任务分组 + 数量），
    --   避免「存了数量又存一份列名」两处打架（改了数量忘了同步列名 → 列名对不上）。
    -- items 必须按模式分键（{daily,big}）：services/dutyMode.unpackMode 只认这个结构，
    -- 播种成扁平数组时全新库进值日页一个项目都看不到（界面保存一次才会被改成分键结构）。
    -- settings 是「按模式分键的模式配置」：
    --   daily → {}（日常值日没有额外配置）
    --   big   → { cycle, weekday, groupType, groupCount }（周期/星期几/任务分组/组数）
    INSERT OR IGNORE INTO duty_slots (kind, days, items, settings) VALUES
      ('settings',
       '{"daily":["周一","周二","周三","周四","周五"],"big":[]}',
       '{"daily":[{"name":"擦黑板","difficulty":0.6,"count":1},{"name":"倒垃圾","difficulty":0.7,"count":2},{"name":"扫地","difficulty":0.8,"count":2}],"big":[{"name":"擦黑板","difficulty":0.6,"count":1},{"name":"倒垃圾","difficulty":0.7,"count":2},{"name":"扫地","difficulty":0.8,"count":2}]}',
       '{"daily":{},"big":{"cycle":"week","weekday":"周三","groupType":"big","groupCount":3}}');
    INSERT OR IGNORE INTO duty_slots (kind) VALUES ('current'), ('template'), ('weight'), ('draft');

    -- 只读逻辑视图：保持既有 SELECT 的写法与结果形状不变（写统一走 services/slotStore.js）
    DROP VIEW IF EXISTS duty_settings;
    DROP TABLE IF EXISTS duty_settings;
    CREATE VIEW duty_settings AS
      SELECT 1 AS id, days, items, settings FROM duty_slots WHERE kind = 'settings';

    DROP VIEW IF EXISTS duty_layout;
    DROP TABLE IF EXISTS duty_layout;
    CREATE VIEW duty_layout AS
      SELECT 1 AS id, cells, settings FROM duty_slots WHERE kind = 'current';

    DROP VIEW IF EXISTS duty_template;
    DROP TABLE IF EXISTS duty_template;
    CREATE VIEW duty_template AS
      SELECT 1 AS id, cells, settings FROM duty_slots WHERE kind = 'template';

    DROP VIEW IF EXISTS duty_weight;
    DROP TABLE IF EXISTS duty_weight;
    CREATE VIEW duty_weight AS
      SELECT 1 AS id, weights, settings FROM duty_slots WHERE kind = 'weight';

    DROP VIEW IF EXISTS duty_draft;
    DROP TABLE IF EXISTS duty_draft;
    CREATE VIEW duty_draft AS
      SELECT 1 AS id, cells, settings, conditions, saved_at FROM duty_slots WHERE kind = 'draft';
  `);
}

module.exports = { migrateDuty };
