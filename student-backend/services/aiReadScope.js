// =========================================================================
// aiReadScope.js —— AI 数据保护 §4「按表关闭」的单一作用域名
//
// 清单 §4.2 要求：query / aggregate / search_all / describe_table /
// list_tables / 子助手 六处读表入口共用同一个有效表集，别各写一次过滤。
// 这里就是那个「同一个」：effectiveReadTables() 读 closed_tables 后套
// ai.constants.filterReadTables，其余入口只调 isTableReadable / effectiveReadTables。
//
// 边界：按表关闭是「能力边界」，与总开关 enabled 无关——用户显式关掉一张表，
// 无论身份替换开没开都不许 AI 读。关闭立即生效，故不缓存（readPrivacy 仅一次查询）。
// 纯函数 makeReadScope 供单测注入，运行期单例 readScope 走 aiConfigStore。
// =========================================================================
const { READ_TABLES, filterReadTables } = require('../routes/ai/ai.constants')
const aiConfigStore = require('./aiConfigStore')

// 报错文案必须含「设置」——判据 §4 钉的就是这个词：空结果会让模型以为数据为空，
// 所以要明确告诉它「这张表是被人关掉的」，而不是「查不到」。
const CLOSED_MSG = '该表已在设置中关闭 AI 读取，请在「设置 → AI 数据保护」中重新开启'

function makeReadScope({ readClosed } = {}) {
  function effectiveReadTables() {
    let closed = []
    try { closed = (typeof readClosed === 'function' && readClosed()) || [] } catch (_) { closed = [] }
    return filterReadTables(READ_TABLES, closed)
  }
  function isTableReadable(table) {
    return Object.prototype.hasOwnProperty.call(effectiveReadTables(), String(table))
  }
  function closedError(table) {
    return { error: `${CLOSED_MSG}（${String(table)}）` }
  }
  // 供工具入参是数组（describe_table 的 tables、search_all 的 tables）时一次筛完
  function readableOnly(tables) {
    return (Array.isArray(tables) ? tables : []).filter((t) => isTableReadable(t))
  }
  return { effectiveReadTables, isTableReadable, closedError, readableOnly }
}

// 运行期单例：读当前账号库的 ai_settings.privacy_json.closed_tables。
const readScope = makeReadScope({ readClosed: () => aiConfigStore.readPrivacy().closed_tables })

module.exports = { makeReadScope, readScope, CLOSED_MSG }
