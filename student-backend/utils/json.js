// JSON 列读取的统一入口。
//
// 背景：座位表 / 课表 / 设置这类「整块 JSON」列，读取时各自裸调 JSON.parse，
// 全项目共 23 处。只要有一条记录畸形（历史 bug、外部工具改库、AI 写坏），
// 裸解析就会抛错 → 整条 GET 500 → 用户看到的是白板，而不是「这张表暂时读不出来」。
// 同一份「解析失败给默认值」的兜底此前在 duty / search / ai.dataRoutes 里逐字抄了 3 份，
// executors 里还有 2 份同形的 parseJson，这里收敛成一处。

// 解析单个 JSON 值，失败或为空时返回 fallback。
// label 只用于日志定位（通常是列名）。
function safeJson(value, fallback, label) {
  // 已经是对象/数组：部分调用方传的字段可能已解析过，原样返回，不做序列化往返
  if (value != null && typeof value === 'object') return stripVersion(value);
  if (value == null || value === '') return fallback;
  try {
    const v = JSON.parse(value);
    return v == null ? fallback : stripVersion(v);
  } catch (err) {
    console.warn(`[json] ${label || '字段'} 不是合法 JSON，按默认值处理：${err.message}`);
    return fallback;
  }
}

// 批量读取一条记录里的多个 JSON 列，返回以「输出名」为键的对象。
// spec 两种写法：
//   { settings: {} }                         输出名与列名相同
//   { aisleCols: ['aisle_cols', []] }        输出名与列名不同（前端要 camelCase）
// 判定 pair 时不能只看 Array.isArray：默认值本身可能就是一个数组（如 []），
// 那样 { cells: [] } 会被误当成 pair、解析出 undefined 列名。要求「长度 2 且首元素是字符串」。
// 注意：**写路径不能用它**。写库时把畸形数据兜底成空值会覆盖用户原有数据，
// 那种场景应该让解析失败显式抛错（见 routes/seats.js 的 updateSingleCell）。
const isPairSpec = (v) => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';

function readDocJson(row, spec) {
  const out = {};
  for (const [key, v] of Object.entries(spec)) {
    const pair = isPairSpec(v);
    const col = pair ? v[0] : key;
    const fallback = pair ? v[1] : v;
    out[key] = safeJson(row ? row[col] : null, fallback, col);
  }
  return out;
}

// ======================== JSON 结构版本 ========================
//
// 为什么要有：这些列存的是「整块 JSON」，形状随功能演进（座位矩阵化、隐私配置拆分
// 都改过形状）。没有版本标记时，读取端只能靠「数组是不是空的、有没有某个字段」猜
// 数据是哪一代；一旦猜错就是静默错位（不报错、界面正常、数字永久偏）。
//
// 规则：
//   · 写入对象时打上 __v（数组形态不加 —— 数组没法带字段，它们形状变更走重迁移）；
//   · 读取时统一剥掉 __v，上层代码永远看不到这个键；
//   · 版本号集中在本表，形状真要变时改数字，读取端按「库里 __v < 当前版本」决定怎么解码。
const JSON_VERSION_KEY = '__v'

const JSON_VERSION = Object.freeze({
  // 座位 / 课表 / 值日的整块文档
  settings: 1,
  conditions: 1,
  groups_config: 1,
  // AI 设置：数据保护、MCP 保护、提案偏好、访问记录
  privacy_json: 1,
  mcp_privacy_json: 1,
  mcp_prefs_json: 1,
  log_json: 1,
  // 其它对象形态
  class_info: 1,
  // 历史快照（domain_history.payload）：座位那次整体改过形状，是最需要版本标记的一列
  payload: 1,
  // 撤销记录里的「整行快照」（undo_history.payload）：撤销可能跨越很久，
  // 回放时必须知道这份快照是哪一代形状。与 domain_history.payload 分开计数：
  // 两者内容不同源（一份是当日业务快照，一份是单行前后值），形状不会同时变。
  undo_payload: 1,
  // MCP 提案里的写入意图（mcp_proposals.payload）：确认时直接拿它去执行，
  // 提案可能躺着几小时才被处理，形状变更也要能分辨新旧。
  proposal_payload: 1,
})

// 剥掉版本标记。对象才有，数组/标量原样返回。
function stripVersion(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && JSON_VERSION_KEY in v) {
    const { [JSON_VERSION_KEY]: _version, ...rest } = v
    return rest
  }
  return v
}

// 深度剥离：给「整行/整表直接抛给外部 AI」的场景用（MCP 读表、搜索、提案结果）。
// 单层 safeJson 只处理最外层，而读表返回的行里 JSON 列仍是**字符串**，那条路径会把 `__v`
// 一起交给外部模型，模型照抄回写时就多一个库里不存在的键。两层都要处理：
//   · 对象/数组：递归删键；
//   · 字符串：只有真的含 `"__v"` 才解析、删键、再序列化（没有标记的字符串不做任何事，
//     所以正常读取零额外开销）。
// 没有版本标记时返回原对象本身（不复制）：绝大多数结果本来就没有标记，
// 为「可能剥一个键」付出整份深拷贝不值得。
const JSON_VERSION_MARK = `"${JSON_VERSION_KEY}"`
// 只对长得像 JSON 对象的字符串尝试解析：避免把普通文本（几百 KB 的附件正文之类）白解析一遍。
function stripVersionInString(text) {
  if (!text || text.charCodeAt(0) !== 123 /* { */ || text.length > 1e6) return text
  if (!text.includes(JSON_VERSION_MARK)) return text
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return text
    return JSON.stringify(stripVersionDeep(parsed))
  } catch (_) {
    return text
  }
}

function stripVersionDeep(value) {
  if (typeof value === 'string') return stripVersionInString(value)
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((v) => {
      const r = stripVersionDeep(v)
      if (r !== v) changed = true
      return r
    })
    return changed ? out : value
  }
  if (value && typeof value === 'object') {
    let changed = false
    const out = {}
    for (const k of Object.keys(value)) {
      if (k === JSON_VERSION_KEY) { changed = true; continue }
      const r = stripVersionDeep(value[k])
      if (r !== value[k]) changed = true
      out[k] = r
    }
    return changed ? out : value
  }
  return value
}

// 写库前调用：对象补上当前版本，数组与标量原样序列化（与 JSON.stringify 行为一致）。
function packJson(value, col) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.stringify({ ...value, [JSON_VERSION_KEY]: JSON_VERSION[col] || 1 })
  }
  return JSON.stringify(value)
}

module.exports = {
  safeJson, readDocJson, packJson, stripVersion, stripVersionDeep,
  JSON_VERSION, JSON_VERSION_KEY,
};
