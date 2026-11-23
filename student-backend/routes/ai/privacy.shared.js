// =========================================================================
// privacy.shared.js —— 数据保护「一份配置」的读写语义
//
// AI 助手和 MCP 各存一份（ai_settings.privacy_json / mcp_privacy_json），
// 但「哪些字段能写」「一档权限怎么落到两张清单」「表清单怎么下发」只有这一处实现，
// 否则两个面板迟早各长出一点差别：一边能写 closed_tables、另一边忘了归一化。
//
// 存哪一列、改完清哪个缓存，由调用方注入 io：
//   io.read()        读出该侧配置（含默认值）
//   io.set(patch)    写回，返回合并后的配置
//   io.invalidate()  清脱敏映射表缓存（可省略）
// =========================================================================
const { READ_TABLES, READ_TABLE_LABELS, WRITE_TABLES, JSON_WRITE_TABLES } = require('./ai.constants');

// privacy_json 里允许前端写的字段：布尔开关 + 被关表清单。closed_tables 只收真实可读表名，
// 防止前端塞入任意字符串导致「关掉一张不存在的表」而毫无效果却让用户以为生效了。
const PRIVACY_BOOL_KEYS = ['enabled', 'hide_phone', 'hide_path', 'hide_album'];

function normalizePrivacyPatch(body) {
  const patch = {};
  const src = body && typeof body === 'object' ? body : {};
  for (const k of PRIVACY_BOOL_KEYS) {
    if (src[k] !== undefined) patch[k] = !!src[k];
  }
  if (src.closed_tables !== undefined) {
    const arr = Array.isArray(src.closed_tables) ? src.closed_tables : [];
    patch.closed_tables = [...new Set(arr.map((t) => String(t).trim()).filter((t) => Object.prototype.hasOwnProperty.call(READ_TABLES, t)))];
  }
  return patch;
}

// 默认值刻意维持改造前行为：能写的表默认「读写」（提交提案仍需老师确认），不能写的默认「只读」。
const TABLE_LEVELS = ['none', 'read', 'write'];

function supportsWrite(table) {
  return !!(WRITE_TABLES[table] || JSON_WRITE_TABLES[table]);
}

function privacyTables(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const closed = Array.isArray(s.closed_tables) ? s.closed_tables : [];
  const ro = Array.isArray(s.readonly_tables) ? s.readonly_tables : [];
  return Object.keys(READ_TABLES).map((key) => {
    const ui = READ_TABLE_LABELS[key] || {};
    let level = 'read';
    if (closed.includes(key)) level = 'none';
    else if (!ro.includes(key) && supportsWrite(key)) level = 'write';
    return { key, label: ui.label || key, hint: ui.hint || READ_TABLES[key], level, writable: supportsWrite(key) };
  });
}

// 改单张表的权限档。先两边都删再按档放回：
//   none → 进 closed_tables（读闸门）+ readonly_tables（写闸门），读写一起断；
//          两张清单在 none 档刻意重叠，否则「完全禁止」的表还能提交写提案（#5）。
//   read → 只有「本来能写」的表才需要记进 readonly_tables（不能写的表本来就是只读）
//   write → 两边都不出现（写闸门见 aiWriteScope）
// 注：设档时互斥；仅 none 档同时出现在两张清单，UI 档位判定以 closed 优先。
function setTableLevel(table, level, io) {
  const key = String(table || '').trim();
  if (!Object.prototype.hasOwnProperty.call(READ_TABLES, key)) return { error: `没有这张可读表：${key || '未指定'}` };
  const lv = String(level || '');
  if (!TABLE_LEVELS.includes(lv)) return { error: '权限只能是：完全禁止 / 只读 / 读写' };
  if (lv === 'write' && !supportsWrite(key)) {
    return { error: `${(READ_TABLE_LABELS[key] || {}).label || key}不支持 AI 写入，只能设为「只读」或「完全禁止」` };
  }
  const cur = io.read();
  const closed = new Set(Array.isArray(cur.closed_tables) ? cur.closed_tables : []);
  const ro = new Set(Array.isArray(cur.readonly_tables) ? cur.readonly_tables : []);
  closed.delete(key);
  ro.delete(key);
  if (lv === 'none') { closed.add(key); ro.add(key); } // closed=断读，ro=断写：完全禁止必须读写一起拦
  if (lv === 'read' && supportsWrite(key)) ro.add(key);
  return io.set({ closed_tables: [...closed], readonly_tables: [...ro] });
}

module.exports = {
  PRIVACY_BOOL_KEYS,
  normalizePrivacyPatch,
  TABLE_LEVELS,
  supportsWrite,
  privacyTables,
  setTableLevel,
};
