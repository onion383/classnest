// =========================================================================
// importSheet.js —— 「从文件导入数据」的表头识别与行映射（纯函数，无 DOM 依赖）
//
// 为什么单独抽出来：这里最容易出的错是**列错位**。
// 老实现先 `map` 再 `filter` 掉空表头，然后用过滤后的数组下标去取值：
//   表头 ['姓名', '', '学号']  →  过滤后 ['姓名', '学号']
//   取值时 姓名←第0列（对）、学号←第1列（错，实际是空表头那一列）
// 于是空表头右边的所有列整体左移一格，导入后数据串列。
// 现在每个表头都带着它的**原始列下标**，取值一律用原下标。
//
// 另一个隐蔽问题：同名表头（两份「备注」）在对象里会互相覆盖，
// 只剩最后一列的值。这里给重复表头加序号后缀，保住两列数据。
// =========================================================================

// 单元格是否算「有内容」：空串 / null / undefined 都算空（数字 0 算有内容）
function hasValue(cell) {
  return cell !== '' && cell !== null && cell !== undefined
}

function cellText(cell) {
  return cell === undefined || cell === null ? '' : String(cell).trim()
}

// ============================ 模糊匹配 ============================
// 不同来源的表格常把同一个名字写成不同形态：「项目 / 劳动项目」、
// 「d_周一 / 周一 / 星期一」、全角括号、带空格、项目名后加（ 3 人）等。
// 比较前先做「宽松归一」：全角转半角、去掉空白与常见标点、转小写、去掉导出列的 d_ 前缀。
// 只用于**表头 / 项目名 / 行标签**这类有限枚举值，不用于人名等自由文本。
const LOOSE_STRIP = /[\s\u3000_\-—–·•:：,，.。;；、/\\|"'“”‘’()（）[\]【】{}「」<>《》]/g

export function normalizeLoose(value) {
  let s = value == null ? '' : String(value)
  if (s.normalize) s = s.normalize('NFKC')
  s = s.replace(/^d_/i, '').toLowerCase().replace(LOOSE_STRIP, '')
  // 星期写法统一：星期一 / 礼拜一 / 周1 / 星期7 / 周日 / 周天 都归一成「周一…周日」
  const dayNum = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '日' }
  s = s.replace(/^(?:周|星期|礼拜)([1-7])$/, (_, n) => `周${dayNum[n]}`)
  return s.replace(/^(?:星期|礼拜)([一二三四五六日天])$/, (_, d) => `周${d === '天' ? '日' : d}`)
}

// Levenshtein 编辑距离（两行动态规划）：候选列表很短，O(lenA×lenB) 足够
function editDistance(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    prev = cur
  }
  return prev[b.length]
}

// 归一后的相似度：1 = 完全相同，0 = 完全不像
export function textSimilarity(a, b) {
  const x = normalizeLoose(a)
  const y = normalizeLoose(b)
  if (!x || !y) return 0
  if (x === y) return 1
  return 1 - editDistance(x, y) / Math.max(x.length, y.length)
}

// 在候选里找与 target 最接近的一个。
// 返回 { value, score, exact? }；多个候选同分时返回 { value: null, ambiguous: [...] }，
// 让调用方选择「报错并列出候选」而不是随意挑一个（例如两个项目名都很像）。
export function matchCandidate(target, candidates, { threshold = 0.7 } = {}) {
  const t = normalizeLoose(target)
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((c) => ({ value: String(c == null ? '' : c), norm: normalizeLoose(c) }))
    .filter((c) => c.norm)
  if (!t || !list.length) return null

  const exact = list.filter((c) => c.norm === t)
  // 精确同名：取第一个（项目重名时与旧行为一致）
  if (exact.length) return { value: exact[0].value, score: 1, exact: true }

  let best = null
  let ties = []
  for (const c of list) {
    let score = 1 - editDistance(t, c.norm) / Math.max(t.length, c.norm.length)
    // 包含关系（「项目」⊂「劳动项目」、「扫地」⊂「扫地拖地」）给固定分，
    // 但要求双方至少 2 个字，避免单字候选命中一切。
    if (Math.min(t.length, c.norm.length) >= 2 && (c.norm.includes(t) || t.includes(c.norm))) {
      score = Math.max(score, 0.85)
    }
    if (score < threshold) continue
    if (!best || score > best.score + 1e-9) {
      best = { value: c.value, score }
      ties = [c.value]
    } else if (Math.abs(score - best.score) < 1e-9) {
      ties.push(c.value)
    }
  }
  if (!best) return null
  if (ties.length > 1) return { value: null, score: best.score, ambiguous: ties }
  return best
}

// 表头解析：按候选词的顺序逐个尝试，返回文件里实际出现的那个列名。
// 候选顺序有意义：先给最标准的写法，避免「项目」被更长的「劳动项目」抢走。
export function resolveHeader(fields, candidates) {
  const names = (Array.isArray(fields) ? fields : [])
    .map((f) => (typeof f === 'string' ? f : (f && f.name)))
    .filter(Boolean)
  const cands = Array.isArray(candidates) ? candidates : [candidates]
  for (const cand of cands) {
    const hit = matchCandidate(cand, names)
    if (hit && hit.value) return hit.value
  }
  return null
}

// 一行 → 带原列下标的表头列表；空表头列被跳过（跳过的是它自己，不是它右边的列）
export function headerColumns(row) {
  const used = new Set()
  const columns = []
  ;(Array.isArray(row) ? row : []).forEach((cell, index) => {
    const name = cellText(cell)
    if (!name) return
    let unique = name
    let n = 2
    // 同名表头：第二个起加「_2」「_3」避免对象键互相覆盖丢数据。
    // 后缀**不能用「 (2)」**（空格+括号）：这个 name 会原样作为列名 POST 给后端，
    // 而 assertValidColumn 的白名单是 /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/，
    // 空格与括号都不在字符集里 → 含同名表头的 Excel 会整体导入失败（硬失败，不是跳过）。
    while (used.has(unique)) unique = `${name}_${n++}`
    used.add(unique)
    columns.push({ name: unique, index })
  })
  return columns
}

// 一行里有多少格「像已知字段名」：用宽松匹配，容忍 d_ 前缀、星期写法、括号说明等。
// 有期望字段清单时，表头识别从「猜哪行格子最多」升级为「哪行最像表头」，
// 能显著降低把数据行/说明行误当表头的概率（尤其是表头有空列、数据列更满的表格）。
function expectedHits(row, expected) {
  if (!expected.length) return 0
  let hits = 0
  for (const cell of row) {
    if (!hasValue(cell)) continue
    const hit = matchCandidate(cellText(cell), expected)
    // 0.85 ≈ 包含关系（「项目」⊂「劳动项目」），足够排除普通数据值
    if (hit && hit.score >= 0.85) hits++
  }
  return hits
}

// 智能提取表头：分三步，避免把「标题行」或「数据行」误当表头。
// 1) 有期望字段时：前 20 行内「命中已知字段最多（至少 2 个）」的一行优先；
// 2) 经典形态（表头下面紧接数据）：取「非空列最多、且下一行也有内容」的一行；
//    最后一行的数据不参与，避免数据行因空表头列填了值而列数超过表头（B11-01 的用例）。
// 3) 标准导入表形态（表头下面全是空白行）：取非空列最多的一行——
//    合并居中的标题行只有 1 格，表头行有全部列名，所以会选中表头。
export function detectHeader(data, expectedFields = []) {
  const rows = Array.isArray(data) ? data : []
  const maxScan = Math.min(rows.length, 20)

  // 1) 期望字段命中数优先（至少 2 个；只有一个期望字段时降到 1）
  const expected = [...new Set((Array.isArray(expectedFields) ? expectedFields : [])
    .map((f) => normalizeLoose(f))
    .filter(Boolean))]
  const minHits = Math.min(2, expected.length)
  let expectedIndex = -1
  let bestHits = 0
  let bestNonEmpty = 0
  for (let i = 0; i < maxScan && expected.length; i++) {
    const row = rows[i]
    if (!Array.isArray(row) || !row.some(hasValue)) continue
    const hits = expectedHits(row, expected)
    if (hits < minHits) continue
    const nonEmpty = row.filter(hasValue).length
    if (hits > bestHits || (hits === bestHits && nonEmpty > bestNonEmpty)) {
      expectedIndex = i
      bestHits = hits
      bestNonEmpty = nonEmpty
    }
  }
  if (expectedIndex >= 0) {
    return { headerRowIndex: expectedIndex, columns: headerColumns(rows[expectedIndex]) }
  }

  let classicIndex = -1
  let classicCount = -1
  for (let i = 0; i < maxScan - 1; i++) {
    const row = rows[i]
    const next = rows[i + 1]
    if (!Array.isArray(row) || !Array.isArray(next)) continue
    if (!row.some(hasValue) || !next.some(hasValue)) continue
    const count = row.filter(hasValue).length
    if (count > classicCount) {
      classicCount = count
      classicIndex = i
    }
  }
  // 至少 2 列才当作表头；只有 1 列时交给下面的兜底逻辑
  if (classicIndex >= 0 && classicCount >= 2) {
    return { headerRowIndex: classicIndex, columns: headerColumns(rows[classicIndex]) }
  }

  let headerRowIndex = -1
  let bestCount = -1
  for (let i = 0; i < maxScan; i++) {
    const row = rows[i]
    if (!Array.isArray(row) || !row.some(hasValue)) continue
    const count = row.filter(hasValue).length
    // 严格大于：同列数时保留更靠前的行，避免把数据行当成表头
    if (count > bestCount) {
      bestCount = count
      headerRowIndex = i
    }
  }
  // 全表找不到「像表头」的行时退化为第一行（与老行为一致）
  if (headerRowIndex === -1) headerRowIndex = 0
  return { headerRowIndex, columns: headerColumns(rows[headerRowIndex]) }
}

// 数据行 → 对象数组；缺少必填字段的行计入 skipped。
// 取值用表头的原始列下标，空表头列只跳过自己，不影响右侧列。
export function mapSheetRows(data, headerRowIndex, columns, requiredFields = []) {
  const rows = []
  let skipped = 0
  const body = (Array.isArray(data) ? data : []).slice(headerRowIndex + 1)
  for (const row of body) {
    if (!Array.isArray(row) || !row.some(hasValue)) continue
    const obj = {}
    for (const col of columns) obj[col.name] = cellText(row[col.index])
    const missing = requiredFields.some((field) => !obj[field] || obj[field].trim() === '')
    if (missing) { skipped++; continue }
    rows.push(obj)
  }
  return { rows, skipped }
}

// 必填列解析：requiredFields 里的每一项可以是字符串，也可以是「同义写法数组」，
// 例如 ['项目', '劳动项目', '值日项目']。解析时按候选顺序做宽松匹配，
// 命中文件里的实际列名后用它做缺值判断——否则表头写成「劳动项目」时，
// 按「项目」判断会把整表所有行都当成缺值过滤掉。
function requiredColumnsOf(columns, requiredFields) {
  const names = columns.map((c) => c.name)
  return (requiredFields || []).map((spec) => {
    const candidates = Array.isArray(spec) ? spec : [spec]
    const matched = resolveHeader(names, candidates)
    return { name: matched || String(candidates[0] == null ? '' : candidates[0]), matched: !!matched }
  })
}

// 一站式解析：sheet_to_json(header:1) 得到的二维数组 → 表头 + 对象行
// expectedFields 是「已知字段名清单」（表结构 / 模板表头），用于提高表头识别命中率。
export function parseSheet(data, requiredFields = [], expectedFields = []) {
  const rows = Array.isArray(data) ? data : []
  if (rows.length === 0) return { headerRowIndex: 0, columns: [], fields: [], rows: [], skipped: 0, requiredColumns: [], missingRequired: [] }
  const { headerRowIndex, columns } = detectHeader(rows, expectedFields)
  const required = requiredColumnsOf(columns, requiredFields)
  const mapped = mapSheetRows(rows, headerRowIndex, columns, required.map((r) => r.name))
  return {
    headerRowIndex,
    columns,
    fields: columns.map((c) => c.name),
    rows: mapped.rows,
    skipped: mapped.skipped,
    // 命中的实际列名 / 完全没识别到的必填列（供弹窗提示具体缺哪一列）
    requiredColumns: required.map((r) => r.name),
    missingRequired: required.filter((r) => !r.matched).map((r) => r.name),
  }
}
