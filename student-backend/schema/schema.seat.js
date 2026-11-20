const { dropObjectIfExists } = require('./schemaUtil');
// schema 拆分子文件：座位槽位表（当前/模板/草稿/权重）+ 只读逻辑视图。
function migrateSeat(conn) {
  // 这些名字在 SQL 里是 CREATE VIEW，但老库里可能还是表；DROP VIEW 遇到表会抛错，
  // 直接让 initSchema 中断。先按真实类型删干净，下面的 DROP VIEW/TABLE 就成了空操作。
  for (const n of ['seat_layout', 'seat_template', 'seat_weight', 'seat_draft']) dropObjectIfExists(conn, n);
  // 原 seat_layout / seat_template / seat_draft / seat_weight 四张同构单例表合并为 seat_slots：
  //   current ：当前座位（mode/rows/cols/seats/types/aisle_cols/groups_config/settings）
  //   template：座位模板（同上）
  //   draft   ：智能排表草稿（同上 + conditions/saved_at）
  //   weight  ：座位位置权重（mode/rows/cols/weights/settings）
  //
  // types：与 seats 同尺寸的格子类型矩阵（0 座位 / 1 走廊 / 2 空位）。
  // 走廊从「渲染时按公式虚拟插入的列」变成「矩阵里的一格状态」，显示列与数据列合并成一套，
  // 那种「数据第几列 / 显示第几列」的双编号换算才能删掉而不是继续改。
  conn.exec(`
    CREATE TABLE IF NOT EXISTS seat_slots (
      kind TEXT PRIMARY KEY CHECK (kind IN ('current','template','draft','weight')),
      mode TEXT NOT NULL DEFAULT 'single',
      rows INTEGER NOT NULL DEFAULT 6,
      cols INTEGER NOT NULL DEFAULT 7,
      seats TEXT NOT NULL DEFAULT '[]',
      types TEXT NOT NULL DEFAULT '[]',
      desk_pattern TEXT NOT NULL DEFAULT '[]',
      aisle_cols TEXT NOT NULL DEFAULT '[]',
      groups_config TEXT NOT NULL DEFAULT '[]',
      weights TEXT NOT NULL DEFAULT '[]',
      settings TEXT NOT NULL DEFAULT '{}',
      conditions TEXT NOT NULL DEFAULT '[]',
      saved_at TEXT NOT NULL DEFAULT ''
    );
  `);

  // 默认几何直接写成网格口径：单人桌 6 行 × 7 个座位列，走廊作为真实列展开 → 13 列。
  // seats / types 必须是满矩阵 —— 前后端所有读取都按下标 seats[r][c] 取，
  // 存空数组会在第一次打开座位页时就 index 出错。走廊格 seats 一律 null，
  // 「这格是走廊」由 types 单独承担（0 座位 / 1 走廊 / 2 空位，同 services/sanitize 的 SEAT_CELL）。
  // weight 行不存 seats / weights（它的数据在 weights 列），只写 types 作为几何标记。
  const SEAT_COLS = 7;
  const DEFAULT_ROWS = 6;
  const GRID_COLS = SEAT_COLS * 2 - 1;
  const seatRow = Array(GRID_COLS).fill(null);
  const typeRow = Array.from({ length: GRID_COLS }, (_, c) => (c % 2 === 1 ? 1 : 0));
  const seatsJson = JSON.stringify(Array.from({ length: DEFAULT_ROWS }, () => [...seatRow]));
  const typesJson = JSON.stringify(Array.from({ length: DEFAULT_ROWS }, () => [...typeRow]));
  const seedSlot = conn.prepare(
    `INSERT OR IGNORE INTO seat_slots (kind, rows, cols, seats, types, weights) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const kind of ['current', 'template', 'draft']) {
    seedSlot.run(kind, DEFAULT_ROWS, GRID_COLS, seatsJson, typesJson, '[]');
  }
  seedSlot.run('weight', DEFAULT_ROWS, GRID_COLS, '[]', typesJson, '[]');

  conn.exec(`
    -- 只读逻辑视图：保持既有 SELECT 的写法与结果形状不变（写统一走 services/slotStore.js）
    DROP VIEW IF EXISTS seat_layout;
    DROP TABLE IF EXISTS seat_layout;
    CREATE VIEW seat_layout AS
      SELECT 1 AS id, mode, rows, cols, seats, types, desk_pattern, aisle_cols, groups_config, settings
      FROM seat_slots WHERE kind = 'current';

    DROP VIEW IF EXISTS seat_template;
    DROP TABLE IF EXISTS seat_template;
    CREATE VIEW seat_template AS
      SELECT 1 AS id, mode, rows, cols, seats, types, desk_pattern, aisle_cols, groups_config, settings
      FROM seat_slots WHERE kind = 'template';

    DROP VIEW IF EXISTS seat_weight;
    DROP TABLE IF EXISTS seat_weight;
    CREATE VIEW seat_weight AS
      SELECT 1 AS id, mode, rows, cols, weights, types, settings
      FROM seat_slots WHERE kind = 'weight';

    DROP VIEW IF EXISTS seat_draft;
    DROP TABLE IF EXISTS seat_draft;
    CREATE VIEW seat_draft AS
      SELECT 1 AS id, mode, rows, cols, seats, types, desk_pattern, aisle_cols, groups_config, settings, conditions, saved_at
      FROM seat_slots WHERE kind = 'draft';
  `);
}

module.exports = { migrateSeat };
