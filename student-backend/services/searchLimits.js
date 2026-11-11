// =========================================================================
// 全局搜索的分页与防失控阈值 —— 唯一来源（P3-08 / Q1-02，§4-5）
//
// 事故：PER_GROUP=12 / MAX_TERMS=5 / PINYIN_VALUES=400 三个常量本来只是保护
// SQL 占位符数量与响应体积，却被写成了产品语义 —— 第 13 条命中、第 6 个关键词
// 静默消失，前端连「还有更多」都不知道。
//
// 根因不是「12 太小」，是**没有分页**：一次查询必须定死上限。把上限从 12 放大到
// 200 只是把天花板往外挪，查询量随上限线性上涨，超 200 照样截断 —— 那是补丁。
// 这里改成固定页大小 + OFFSET 翻页：命中再多也能一页页翻到底，每页成本恒定。
//
// 每页固定 12 且**不接受请求覆盖**：一旦允许 perGroup 随请求放大，就又退回
// 「放大阈值」那条老路。maxTerms / pinyinValues 是防失控阀门、不是产品语义，
// 仍允许按请求调，但都有硬上限。
//
// hasMore 用「每源多取一条」判定，不跑 COUNT：十几个源再各扫一次表只为算总数，
// 比多读一行贵得多。
//
// 纯模块（不连库）：能直接在 node 单测里真跑各档边界。
// =========================================================================

const LIMITS = Object.freeze({
  PAGE_SIZE: 12,
  MAX_PAGE: 1000,
  DEFAULT_MAX_TERMS: 12,
  HARD_MAX_TERMS: 20,
  DEFAULT_PINYIN_VALUES: 400,
  MAX_PINYIN_VALUES: 5000,
})

// 只接受「能安全转成整数」的入参；NaN / 负数 / 数组 / 对象一律回默认值。
// 字符串数字也接受：Express 的 query 全是字符串。
function clampInt(raw, fallback, min, max) {
  if (Array.isArray(raw) || (raw !== null && typeof raw === 'object')) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

/**
 * 解析 /api/search 的分页与阈值参数。
 * @returns {{ page: number, perGroup: number, offset: number, probeLimit: number,
 *            maxTerms: number, pinyinValues: number }}
 */
function resolveSearchLimits(query = {}) {
  const page = clampInt(query.page, 0, 0, LIMITS.MAX_PAGE)
  const perGroup = LIMITS.PAGE_SIZE
  return {
    page,
    perGroup,
    offset: page * perGroup,
    probeLimit: perGroup + 1,
    maxTerms: clampInt(query.maxTerms, LIMITS.DEFAULT_MAX_TERMS, 1, LIMITS.HARD_MAX_TERMS),
    pinyinValues: clampInt(query.pinyinValues, LIMITS.DEFAULT_PINYIN_VALUES, 1, LIMITS.MAX_PINYIN_VALUES),
  }
}

/**
 * 把一个源「从 offset 起、最多 probeLimit 条」的候选裁成一页，并顺带判 hasMore。
 * SQL 源由 LIMIT ? OFFSET ? 完成跳过；内存源先过 windowOf，两者在这里汇合成同一口径。
 * @param {{ hasMore: boolean }} state 整个请求共用一个，任一组多出一条就置位
 */
function clipPage(rows, limits, state) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length > limits.perGroup) state.hasMore = true
  return list.slice(0, limits.perGroup)
}

/** 内存型数据源（课表 / 座位 / 值日的 JSON 单元格）先按页取窗口，再交给 clipPage。 */
function windowOf(list, limits) {
  return Array.isArray(list) ? list.slice(limits.offset, limits.offset + limits.probeLimit) : []
}

module.exports = { LIMITS, clampInt, resolveSearchLimits, clipPage, windowOf }
