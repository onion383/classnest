// 表格首屏分页的纯决策逻辑（useTableCRUD 与学生管理页共用，单测直接执行真源码）。
//
// 口径：首屏带 limit/offset 只拉一页，滚到底逐页追加；导出/去重/搜索/跨页定位等
// 需要整表的动作走 full，把 rows 补成全量后 hasMore 恒 false。
// 一旦补过全量，后续刷新也保持全量（buildParams 传 fullLoaded=true），不再缩回第一页。

/**
 * 组装列表 GET 参数。
 * @param {object} o
 * @param {object|null} o.extra 页面附加查询（如 { formal: 1 }）
 * @param {number} o.pageSize 每页行数；0/undefined 表示不分页
 * @param {number} o.offset 已加载行数
 * @param {boolean} o.full 本次是否显式要全量
 * @param {boolean} o.fullLoaded 当前是否已是全量
 * @returns {URLSearchParams}
 */
export function buildListParams({ extra = null, pageSize = 0, offset = 0, full = false, fullLoaded = false } = {}) {
  const params = new URLSearchParams()
  if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, String(v))
  if (pageSize && !full && !fullLoaded) {
    params.set('limit', String(pageSize))
    params.set('offset', String(offset))
  }
  return params
}

/**
 * 应用一次响应后的分页游标。
 * @param {object} o
 * @param {'replace'|'append'|'full'} o.mode 本次响应怎么应用
 * @param {number} o.loaded 应用后的已加载行数
 * @param {number|string} o.total 后端回传的总数（全量模式无此值）
 * @returns {{offset:number,total:number,hasMore:boolean,fullLoaded:boolean}}
 */
export function nextPageState({ mode, loaded, total = 0 }) {
  if (mode === 'full') {
    return { offset: loaded, total: loaded, hasMore: false, fullLoaded: true }
  }
  const n = Number(total) || loaded
  return { offset: loaded, total: n, hasMore: loaded < n, fullLoaded: false }
}
