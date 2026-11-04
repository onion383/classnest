// 本地日期工具（**零依赖**，供 dbManager 这类底层模块使用）。
//
// 为什么单独一个文件、不放进 utils/sql.js：
//   sql.js 虽然是"工具"，但它 require('../db')，而 db.js 又 require('./dbManager/dbManager')。
//   底层模块（如 dbManager.memory.js）去引 sql.js 就成环了（db 可能拿到 undefined）。
//   这里只放不碰数据库的纯函数，谁都能安全引用。
//
// 为什么不能用 new Date().toISOString().slice(0, 10)：
//   toISOString 是 UTC 口径。东八区在本地 00:00–08:00 之间它给出的还是「昨天」——
//   记忆条目会被写进昨天的小标题下，周键/文件名也会错一天。

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 取「本地时区」的 YYYY-MM-DD；非法日期返回空串（调用方按「没有日期」处理）
function localDateStr(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  if (!date || isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

const todayStr = () => localDateStr(new Date());

// 取「本地时区」的 YYYY-MM-DD HH:mm:ss。
//
// 用于「保存时间/操作时间」这类要给人看的完整时间戳。
// 不要用 new Date().toISOString()：它是 UTC，东八区本地 00:00–08:00 之间
// 直接截前 10 位得到的是「昨天」，一旦有人拿它当日期用就会错一天。
// 本项目是单机本地库（无跨时区同步），全库统一本地口径，不留「有的列 UTC、有的列本地」。
function localDateTimeStr(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  if (!date || isNaN(date.getTime())) return '';
  return `${localDateStr(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

// YYYY-MM-DD -> 本地零点 Date；非法输入返回 Invalid Date（调用方自行判 isNaN）
function parseDateStr(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// 日期字符串按天偏移：YYYY-MM-DD -> YYYY-MM-DD
function shiftDateStr(s, days) {
  const d = parseDateStr(s);
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

// 某天所在周的周一（一周从周一开始）。入参可为 YYYY-MM-DD 或 Date，出参为 YYYY-MM-DD。
// ⚠️ 传 Date 时**先复制**再 setDate：调用方（如 ai.dataRoutes 的 snapshotBeforeWrite）
//    后面还要用同一个 Date 取「今天」的快照日期，就地改会把今天改成周一。
function mondayOf(s) {
  const d = s instanceof Date
    ? new Date(s.getFullYear(), s.getMonth(), s.getDate())
    : parseDateStr(s);
  const day = d.getDay();
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  return localDateStr(d);
}

module.exports = { pad2, localDateStr, localDateTimeStr, todayStr, parseDateStr, shiftDateStr, mondayOf };
