// marked / DOMPurify 异步懒加载（减少页面 chunk 大小，降低 LCP）
// 模块级单例：整个应用共用一份，避免重复 import 与重复 addHook。
let _marked = null
let _purify = null
// 在途加载 Promise：首屏多处同时调 ensureMarkdown() 时只真正 import 一次，
// 否则并发会各自 import + 各自 addHook（hook 重复注册，审查 v4 · B10-13）。
let _loading = null

export async function ensureMarkdown() {
  if (_marked) return
  if (_loading) return _loading
  _loading = (async () => {
    const [markedModule, purifyModule] = await Promise.all([
      import('marked'),
      import('dompurify'),
    ])
    _marked = markedModule.marked
    _purify = purifyModule.default
    _marked.setOptions({ gfm: true, breaks: true })
    _purify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') node.setAttribute('target', '_blank')
    })
  })()
  try {
    await _loading
  } catch (err) {
    // 加载失败允许下次重试，不能把失败 Promise 永久缓存
    _loading = null
    throw err
  }
}

// markdown 库是否已就绪（供「重算全部 HTML」等场景判断，避免在未加载时解析报错）
export function isMarkdownReady() {
  return !!(_marked && _purify)
}

/**
 * 把一段 markdown 渲染成可直接 v-html 的 HTML（已 sanitize）。
 * 应用内第二处渲染 markdown 的地方（收据里的 .md 附件）也走这里 ——
 * 别再自己 import 一次 marked，否则 sanitize 配置会分叉。
 */
export async function renderMarkdown(text) {
  await ensureMarkdown()
  return _purify.sanitize(_marked.parse(String(text || '')))
}

// 回复里的 ```record 代码块：AI 只指认「表名 + id」，由 AiRecordTable 去后端取完整数据渲染
export function parseRecordSpec(raw) {
  try {
    const spec = JSON.parse(raw.trim())
    const table = typeof spec?.table === 'string' ? spec.table : ''
    const rawIds = Array.isArray(spec?.ids) ? spec.ids : spec?.id != null ? [spec.id] : []
    const ids = rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 30)
    return table && ids.length ? { table, ids } : null
  } catch (_) {
    return null
  }
}
// 饼图最多保留的扇区数，与后端 show_chart 的聚合规则保持一致
const PIE_MAX_SLICES = 6

// 饼图 Top N：按数值从大到小取前 5 项，其余合并成「其他」；已有「其他」也并入这个桶。
// 后端已经聚合过，这里再兜一层，保证历史消息或模型手写的数据块也不会画出 12 个小扇区。
function aggregatePie(labels, values) {
  if (labels.length <= PIE_MAX_SLICES) return { labels, values }
  const named = []
  let rest = 0
  labels.forEach((label, i) => {
    const v = Math.max(0, values[i])
    if (label === '其他') rest += v
    else named.push({ label, value: v })
  })
  named.sort((a, b) => b.value - a.value)
  const head = named.slice(0, PIE_MAX_SLICES - 1)
  rest += named.slice(PIE_MAX_SLICES - 1).reduce((sum, p) => sum + p.value, 0)
  const out = {
    labels: head.map((p) => p.label),
    values: head.map((p) => p.value),
  }
  if (rest > 0) {
    out.labels.push('其他')
    out.values.push(rest)
  }
  return out
}

// 回复里的 ```chart 代码块：AI 只给「类型 + 标签 + 数值」，由 AiChart 组件绘制
export function parseChartSpec(raw) {
  try {
    const spec = JSON.parse(raw.trim())
    const type = ['bar', 'barh', 'pie', 'line'].includes(spec?.type) ? spec.type : 'bar'
    const labels = Array.isArray(spec?.labels) ? spec.labels.map((x) => String(x == null ? '' : x)) : []
    const values = Array.isArray(spec?.values) ? spec.values.map(Number) : []
    const n = Math.min(labels.length, values.length, 12)
    if (!n) return null
    let outLabels = labels.slice(0, n)
    let outValues = values.slice(0, n).map((v) => (Number.isFinite(v) ? v : 0))
    if (type === 'pie') {
      const pie = aggregatePie(outLabels, outValues)
      outLabels = pie.labels
      outValues = pie.values
    }
    return {
      type,
      title: String(spec?.title || ''),
      unit: String(spec?.unit || ''),
      labels: outLabels,
      values: outValues,
    }
  } catch (_) {
    return null
  }
}
export function parseBlocks(text) {
  const blocks = []
  const re = /```(record|chart)[ \t]*([\s\S]*?)```/g
  let last = 0
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) blocks.push({ type: 'md', text: text.slice(last, m.index) })
    const kind = m[1]
    const raw = m[2]
    const spec = kind === 'record' ? parseRecordSpec(raw) : parseChartSpec(raw)
    // 解析不出（流式输出中途、数据不全等）就退化成普通代码块，避免内容被吞掉
    blocks.push(spec ? { type: kind, ...(kind === 'record' ? spec : { data: spec }) } : { type: 'md', text: '```' + kind + raw + '```' })
    last = m.index + m[0].length
  }
  if (last < text.length) blocks.push({ type: 'md', text: text.slice(last) })
  return blocks.filter((b) => b.type !== 'md' || b.text.trim())
}

// 把回复拆块：markdown 片段做 DOMPurify 清洗，record 数据块交给 AiRecordTable 组件
export function buildBlocks(content) {
  return parseBlocks(content).map((b) =>
    b.type === 'md' ? { ...b, html: _purify.sanitize(_marked.parse(b.text)) } : b
  )
}

// 把「已完成的行」切成可独立渲染的稳定块。
//
// 为什么需要它：流式渲染原本每跨一行就把整个 head 重跑 marked.parse + DOMPurify.sanitize，
// 总成本是 O(n²)。实测（50 行 1.9ms → 200 行 4.7ms → 500 行 47.9ms）里 91% 花在 sanitize 上，
// 按块缓存后每块只算一次，总成本降到 O(n)。
//
// 切点必须保证「分开渲染再拼接」与「整段一起渲染」结果一致，否则结构会被切坏：
//   · 代码围栏（``` / ~~~）内部不切 —— 切开后两半都变成未闭合代码块；
//   · 列表项前后不切 —— 切开后一个 <ul> 变成两个，多出间距；
//   · 表格行前后不切 —— 表格必须整块解析才认得出。
// 其余位置只在空行（真正的段落边界）切。
// 不变量：返回的块按顺序拼接**必须与入参逐字符相等** —— 切块只是分批渲染，不能吃掉分隔空行。
// 导出供单测直接验证切点规则（node 里不需要 DOM，因为它不碰 marked/DOMPurify）。
export function splitStableBlocks(head) {
  if (!head) return []
  const lines = head.split('\n')
  const fenceRe = /^\s{0,3}(`{3,}|~{3,})/
  const listRe = /^\s{0,3}([-*+]|\d+[.)])\s/
  const tableRe = /^\s{0,3}\|/
  const out = []
  let inFence = false
  let start = 0
  let pos = 0
  // 只需走到倒数第二行：最后一个元素是末尾换行后的空串，不属于任何空行切点
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    if (fenceRe.test(line)) inFence = !inFence
    pos += line.length + 1 // 本行连同换行符结束的位置
    if (inFence || line.trim() !== '') continue
    // 空行 → 候选切点。只有「同一结构延续到下一段」才禁止切：
    // 列表项之间、表格行之间切开会让 <ul>/<table> 断裂；而切在结构**之前**是安全的。
    const prev = lines[i - 1] || ''
    const next = lines[i + 1] || ''
    if (listRe.test(prev) && listRe.test(next)) continue
    if (tableRe.test(prev) && tableRe.test(next)) continue
    out.push(head.slice(start, pos))
    start = pos
  }
  if (start < head.length) out.push(head.slice(start))
  return out
}

// 流式输出中按「已完成的行」增量渲染 markdown：每输出完一行就渲染一行，未完成的行先按纯文本
export function updateLiveRender(m) {
  const text = m.content || ''
  // markdown 库未就绪时退回纯文本，避免已输出的内容不显示
  if (!_marked || !_purify) { m._liveHtml = ''; m._liveTail = text; return }
  const cut = text.lastIndexOf('\n')
  const head = cut === -1 ? '' : text.slice(0, cut + 1)
  m._liveTail = cut === -1 ? text : text.slice(cut + 1)
  // 没有新增完整行就不重算，保证「一行一渲染」而不是每个字符都重排
  if (head === m._liveSrc) return
  // _liveSrc 为 null/undefined 表示切换消息或重新生成：分块缓存必须一起作废，
  // 否则会把上一条回复的 HTML 拼到这一条上
  if (!m._liveSrc) m._liveBlocks = []
  m._liveSrc = head
  if (!head) { m._liveHtml = ''; return }

  const blocks = splitStableBlocks(head)
  // 最后一块还在增长（下一次追加会把它补齐，例如 '段落\n' → '段落\n\n'），
  // 所以只有它之前的块算「已定型」可以缓存；最后一块每帧重算，代价限于它自身大小。
  const stable = blocks.slice(0, -1)
  const lastSrc = blocks.length ? blocks[blocks.length - 1] : ''
  const cache = m._liveBlocks || []
  // 前缀命中就复用：流式只在尾部追加，已定型的块内容不会再变
  const next = []
  let i = 0
  while (i < stable.length && i < cache.length && stable[i] === cache[i].src) {
    next.push(cache[i])
    i++
  }
  for (; i < stable.length; i++) {
    next.push({ src: stable[i], html: _purify.sanitize(_marked.parse(stable[i])) })
  }
  m._liveBlocks = next
  m._liveHtml = next.map((b) => b.html).join('') + (lastSrc ? _purify.sanitize(_marked.parse(lastSrc)) : '')
}
