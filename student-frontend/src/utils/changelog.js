// 更新历史解析器：把仓库根目录的 CHANGELOG.md 转成关于页要渲染的
// [{ version, date, notes }] 列表。
//
// 约定格式（详见 CHANGELOG.md 顶部说明）：
//   ## 0.1.0 · 2026-10-10
//   - 改动一
//   - 改动二
//
// 设计取舍：
// - 只认二级标题（##）作为版本分隔，三级小标题（### 新增 / ### 修复）不会截断条目；
// - 版本号前的 v 可写可不写，日期必须是 YYYY-MM-DD；
// - 最终按日期倒序返回，写文件时不必手动保证顺序；
// - 其他行（标题、说明、HTML 注释）全部忽略，方便在文件里写维护说明。

const VERSION_HEADING_RE = /^\s{0,3}##\s+(.+?)\s*$/
const ANY_HEADING_RE = /^\s{0,3}#{1,6}\s/
const BULLET_RE = /^\s{0,3}[-*+]\s+(.+?)\s*$/
const VERSION_RE = /^v?(\d+(?:\.\d+)*)\b/i
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/

// 条目里只做最轻量的 Markdown 去壳：链接取文字、去掉加粗/行内代码标记。
// 关于页把每条当纯文本渲染，不做 HTML 注入，避免更新历史成为 XSS 入口。
function cleanNote(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// 解析版本标题；不是「版本号 + 日期」的二级标题返回 null。
function parseVersionHeading(text) {
  const versionMatch = text.match(VERSION_RE)
  const dateMatch = text.match(DATE_RE)
  if (!versionMatch || !dateMatch) return null
  return {
    // 统一去掉 v 前缀：模板里已经固定渲染 `v{{ version }}`
    version: versionMatch[1],
    date: dateMatch[1],
  }
}

export function parseChangelog(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return []

  // 先去掉 HTML 注释：维护说明里常会放「示例条目」，不能让它被当成真实版本。
  const normalized = markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const entries = []
  let current = null

  for (const line of lines) {
    const heading = line.match(VERSION_HEADING_RE)
    if (heading) {
      // 二级标题：是版本条目就开新段，否则（如「维护说明」）停止收集，
      // 避免把无关列表项挂到上一个版本里。
      const parsed = parseVersionHeading(heading[1])
      current = parsed ? { ...parsed, notes: [] } : null
      if (current) entries.push(current)
      continue
    }
    // 三级及以下标题不结束条目，允许用「### 新增 / ### 修复」给条目分组
    if (ANY_HEADING_RE.test(line)) continue
    if (!current) continue

    const bullet = line.match(BULLET_RE)
    if (!bullet) continue
    const note = cleanNote(bullet[1])
    if (note) current.notes.push(note)
  }

  // 按日期倒序；同日期保持文件里的先后顺序（sort 是稳定的）
  const sorted = entries
    .map((entry, index) => ({ ...entry, _index: index }))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || a._index - b._index)
  return sorted.map((entry) => ({
    version: entry.version,
    date: entry.date,
    notes: entry.notes,
  }))
}
