const express = require('express')
const router = express.Router()
const { db } = require('../db')
// 值日数据「按模式拆分」的唯一实现（此前本文件自己抄了一份 toModeMap）
const { unpackMode } = require('../services/dutyMode')
// 值日列名的唯一读取入口（日常值日=星期几，大扫除=分组名+全部）
const dutyConfig = require('../services/dutyConfig')
const { safeJson } = require('../utils/json')

// 标题栏「全局搜索」的服务端数据源：对若干业务表的文本列做 LIKE 匹配，分组返回。
// 表名/列名全部来自本文件的白名单常量（不接受请求参数拼接），杜绝注入。
//
// 性能取向（2026-11-04 调的）：这个接口由前端每次输入 debounce 后触发，且 better-sqlite3
// 是同步的 —— 一次慢查询会卡住整个进程。所以：
//   · 排序交给 SQL（主列命中优先 + id 倒序），LIMIT 直接截 PER_GROUP 条，不再「拉 1000 行再 JS 排」；
//   · 拼音只对主列的 **distinct 值** 做（班级数据里「姓名」只有几十个不同值），
//     不再拉 1000 行宽记录逐列转拼音；
//   · 拼音补扫只在 LIKE 命中不足时才做 —— 中文查询通常第一次就够数，直接跳过。

const PER_GROUP = 12

// 自定义列：students / fee_records 支持用户自行加列（services/tableService.addColumn 会同步写
// table_meta），但 SOURCES 里的 match 是写死的白名单 —— 新加的列永远搜不到。这里按 table_meta
// 动态补上：加列时列名已按 COLUMN_NAME_RE 校验过，读回来再校验一次才拼进 SQL（存量库可能被外部改动）。
// 收据存的是文件路径，搜「jpg」会命中半张表，排除。
const COLUMN_NAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]+$/
const DYNAMIC_EXCLUDE = new Set(['id', 'position', '收据'])
function dynamicColumns(table) {
  try {
    return db.prepare('SELECT column_name FROM table_meta WHERE table_name = ? ORDER BY sort_order').all(table)
      .map(r => r.column_name)
      .filter(c => c && COLUMN_NAME_RE.test(c) && !DYNAMIC_EXCLUDE.has(c))
  } catch (_) {
    return [] // 存量库没这张表 / 读不到：退化为静态白名单，不影响其它分组
  }
}

// 拼音匹配（懒加载）：仅当查询为纯字母（如 zs / zhangsan）时启用。
// 首次真正需要时才 require，避免拖慢启动；require 失败则退化为纯 LIKE 匹配。
let pinyinMatch = null
let pinyinLoaded = false
function getPinyinMatch() {
  if (!pinyinLoaded) {
    pinyinLoaded = true
    try { pinyinMatch = require('pinyin-match').match } catch (_) { pinyinMatch = null }
  }
  return pinyinMatch
}

// 拼音补充匹配的候选「值」上限：拼音只对主列的 distinct 值做，
// 班级数据里姓名/组名这类去重后通常只有几十个，400 是留足余量的保险值。
const PINYIN_VALUES = 400

// 维度名命中的维度 id（每次请求前重算，供 groups 源的 extra 子句使用）。
// 请求处理全程同步（better-sqlite3），不存在跨请求交错的窗口。
let dimHitIds = []

// 每个数据源：table=表名；match=参与 LIKE 匹配的文本列（白名单）；
// dynamic=true 表示还要把 table_meta 里的自定义列并进来（只有支持加列的表才有意义）；
// label/sub 从命中行派生展示文案；focus 生成跳转页的定位 id。
const SOURCES = [
  {
    table: 'students',
    group: '学生',
    emoji: '📚',
    route: '/students',
    dynamic: true,
    // primary=主列：命中它算强相关（排序靠前），拼音也只对这一列做
    primary: '姓名',
    match: ['姓名', '学号', '年级', '班级', '家长联系电话', '学生联系电话', '备注'],
    label: r => r['姓名'] || r['学号'] || ('学生#' + r.id),
    sub: r => [r['年级'], r['班级'], r['学号']].filter(Boolean).join(' · '),
    focus: r => String(r.id),
  },
  {
    table: 'leave_records',
    group: '请假记录',
    emoji: '🛌',
    route: '/leaves',
    primary: '姓名',
    match: ['姓名', '类型', '开始时间', '结束时间', '家长联系电话', '学生联系电话', '状态', '返校时间', '备注'],
    label: r => [r['姓名'], r['类型']].filter(Boolean).join(' ') || ('请假#' + r.id),
    sub: r => [r['开始时间'], r['结束时间']].filter(Boolean).join(' ~ '),
    // 请假记录对应时间轴上的「离开校园」节点（无开始时间则退回「已申请」）：focus 加 tl: 前缀，
    // 目标页据此定位到时间轴那一项。时间轴渲染了全部记录，比分页表格更可靠地命中目标。
    focus: r => 'tl:' + r.id + (r['开始时间'] ? '-leave' : '-apply'),
  },
  {
    table: 'score_records',
    group: '加扣分记录',
    emoji: '🏅',
    route: '/scores',
    primary: '姓名',
    match: ['姓名', '学号', '类型', '项目', '原因', '加分时间', 'group_name', 'source'],
    label: r => [r['姓名'], r['项目'] || r['类型']].filter(Boolean).join(' · ') || ('记录#' + r.id),
    sub: r => [r['分值'], r['原因']].filter(v => v !== null && v !== undefined && v !== '').join(' · '),
    focus: r => String(r.id),
  },
  {
    table: 'fee_records',
    group: '班费记录',
    emoji: '💰',
    route: '/fee',
    dynamic: true,
    primary: '收支编码',
    // 收支编码是数字/字母，拼音匹配无意义：关掉省一次去重查询
    pinyin: false,
    match: ['收支编码', '收支类型', '收支时间', '备注'],
    label: r => r['收支编码'] || r['收支类型'] || ('记录#' + r.id),
    sub: r => [r['收支金额'], r['收支时间'], r['备注']].filter(v => v !== null && v !== undefined && v !== '').join(' · '),
    focus: r => String(r.id),
  },
  {
    table: 'activities',
    group: '班级活动',
    emoji: '🎉',
    route: '/activities',
    primary: '主题',
    match: ['时间', '主题', '地点', '简介', '参与人员'],
    label: r => r['主题'] || ('活动#' + r.id),
    sub: r => [r['时间'], r['地点']].filter(Boolean).join(' · '),
    focus: r => String(r.id),
  },
  {
    table: 'countdowns',
    group: '倒计时',
    emoji: '⏳',
    route: '/activities',
    primary: '名称',
    match: ['名称', '截止日'],
    label: r => r['名称'] || ('倒计时#' + r.id),
    sub: r => r['截止日'] || '',
    // 倒计时挂在「班级活动」页的倒计时页签：focus 加前缀让该页先切页签再定位
    focus: r => 'countdown:' + r.id,
  },
  {
    table: 'groups',
    group: '分组',
    emoji: '👥',
    route: '/group-manage',
    primary: 'name',
    match: ['name'],
    label: r => r['name'] || ('分组#' + r.id),
    // 补上所属维度名：搜「宿舍管理」时靠 extra 命中该维度下所有组，结果里也要看得出是哪个维度
    sub: r => {
      try {
        const d = db.prepare('SELECT name FROM group_dimensions WHERE id = ?').get(r.dimension_id)
        return d ? String(d.name || '') : ''
      } catch (_) { return '' }
    },
    // 维度名也算命中：维度本身没有可定位的行（点开只能切维度），所以不单独成组，
    // 改为把该维度下的所有组一起带出来，点哪一组就切到该维度并定位到它。
    extra: () => dimHitIds.length
      ? { clause: `dimension_id IN (${dimHitIds.map(() => '?').join(',')})`, params: dimHitIds }
      : null,
    focus: r => `dim:${r.dimension_id}:${r.id}`,
  },
  {
    table: 'albums',
    group: '相册',
    emoji: '📷',
    route: '/album',
    primary: 'name',
    match: ['name'],
    label: r => r['name'] || ('相册#' + r.id),
    sub: () => '',
    focus: r => String(r.id),
  },
  {
    table: 'cadres',
    group: '班干部职务',
    emoji: '🎖️',
    route: '/students',
    primary: 'name',
    match: ['name'],
    label: r => r['name'] || ('职务#' + r.id),
    // 副标题给担任人，让「班长」这类常见职务能一眼看出是谁在任（多于 3 人只列前 3 个）
    sub: r => {
      try {
        const names = db.prepare('SELECT student_name FROM cadre_members WHERE cadre_id = ? ORDER BY sort_order, id').all(r.id)
          .map(m => String(m.student_name || '')).filter(Boolean)
        if (!names.length) return '暂无担任'
        return names.slice(0, 3).join('、') + (names.length > 3 ? ` 等 ${names.length} 人` : '')
      } catch (_) { return '' }
    },
    // 班干部挂在「学生管理」页的「班干部管理」页签下：focus 加 cadre: 前缀，
    // 该页据此先切页签，再由 CadreManage 按职务 id 定位（见 ClassroomView / CadreManage）
    focus: r => 'cadre:' + r.id,
  },
  {
    table: 'semesters',
    group: '学期',
    emoji: '🗓️',
    route: '/settings',
    primary: 'name',
    match: ['name', 'start_date', 'end_date'],
    label: r => r['name'] || ('学期#' + r.id),
    sub: r => [r['start_date'], r['end_date']].filter(Boolean).join(' ~ '),
    // 学期列表在「系统设置 · 学期设置」分区里：focus 直接给分区 key（设置页接受 section 级锚点）
    focus: () => 'semester',
  },
]

// 课程表：内容不是按行存储，而是存在 cells 这一列的二维 JSON 里
// （cells[节次索引][周几索引] = { course, ... }），无法用 LIKE + 行 id，
// 故单独解析后分组返回；focus 形如 `s:节次:周几`（s=实行课表，m=一般课表）。
const SCHEDULE_TABLES = [
  { table: 'schedule', group: '课程 · 实行课表', anchor: 's' },
  { table: 'master_schedule', group: '课程 · 一般课表', anchor: 'm' },
]
const DEFAULT_DAYS = ['周一', '周二', '周三', '周四', '周五']

// 座位表：seats 是二维 JSON（seats[行][列] = 学生 id 或姓名，走廊格为 null）。
// 异形网格改造后 cols 是**网格总列数**（含走廊列），走廊是真实列，
// 所以 focus 里的列号直接就是数组下标，目标页不需要任何换算。
// 但给人看的「列N」仍按座位列序号（跳走廊），见下方 seatNo 的算法。
const SEAT_TABLES = [
  { table: 'seat_layout', group: '座位 · 当前座位', anchor: 'seat' },
  { table: 'seat_template', group: '座位 · 座位模板', anchor: 'seatt' },
]

// 值日表：cells 是 {项目:{星期:[人名]}}，页面按项目人数把每个项目展开成多行；
// items/cells 有日常(daily)/大扫除(big) 两套（可能按模式分键打包），需按模式解包。
// focus 形如 `duty:<mode>:行:列`（dutyt 为值日模板）。
const DUTY_TABLES = [
  { table: 'duty_layout', group: '值日 · 当前值日', anchor: 'duty' },
  { table: 'duty_template', group: '值日 · 值日模板', anchor: 'dutyt' },
]

// 模式解包复用 services/dutyMode（见文件顶部 import）：顶层键全是 daily/big 视为新模式结构，
// 否则整块归入日常。这段判断与 duty.js / ai.dataRoutes.js / AI 工具执行器必须完全一致。

// LIKE 元字符转义：把用户输入里的 % _ \ 当作普通字符，避免被当成通配符。
function likePattern(q) {
  return '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'
}

// 单列拼音匹配：值转拼音后判断是否命中查询（支持首字母缩写与全拼）。空值/异常不命中。
function matchPinyin(fn, value, q) {
  if (value === null || value === undefined || value === '') return false
  try { return !!fn(String(value), q) } catch (_) { return false }
}

// 名称匹配（用于非 SQL 的课程表数据）：文本子串（忽略大小写）或拼音。
function nameHit(name, q, pm) {
  if (name.toLowerCase().includes(q)) return true
  return pm ? matchPinyin(pm, name, q) : false
}

// 多词版：每个词都要命中（词内仍支持拼音），语义与 SQL 侧一致。
// 字段限定的词（`姓名:张三`）在非 SQL 数据里没有列的概念，按普通词处理。
function allTermsHit(name, terms, pm) {
  const s = String(name)
  return terms.every(t => nameHit(s, t.text.toLowerCase(), pm))
}

// ==================== 分词 / 字段限定 / 排序 / 命中列 ====================

// 空格分词：多个词是「且」关系（「张三 请假」= 姓名含张三、且某列含请假）。
// 上限 5 个词：输入「a b c d e f g…」时不让 SQL 的占位符数量失控。
const MAX_TERMS = 5

// 字段限定：`姓名:张三` 只在姓名列里搜。
// 别名表 = 用户可能输入的字段名 → 实际列名。一个别名可映射多列（电话 = 家长/学生两列；
// 姓名 = 学生表的姓名、分组成员的 member_name、班干部的 student_name），
// 而某张表里一列都没有时，这张表整组跳过 —— 既符合语义，也顺带省掉一次全表扫描。
const FIELD_ALIASES = {
  姓名: ['姓名', 'student_name', 'member_name'],
  名字: ['姓名', 'student_name', 'member_name'],
  学号: ['学号'],
  备注: ['备注', 'remark'],
  类型: ['类型'],
  状态: ['状态'],
  项目: ['项目'],
  原因: ['原因'],
  地点: ['地点'],
  主题: ['主题'],
  名称: ['名称', 'name'],
  电话: ['家长联系电话', '学生联系电话'],
  编码: ['收支编码'],
  年级: ['年级'],
  班级: ['班级'],
  文件: ['file_name'],
}
// 冒号前限 1~6 个字符：像「12:30」这种用户真可能搜的时间不会被误认成字段
const FIELD_RE = /^([^:：]{1,6})[:：](.+)$/

function splitTerms(q) {
  return String(q)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map(raw => {
      const m = FIELD_RE.exec(raw)
      const cols = m ? FIELD_ALIASES[m[1].trim()] : null
      return cols ? { text: m[2].trim(), cols } : { text: raw }
    })
    .filter(t => t.text)
}

// 单词的 WHERE：限定的词只查它那几列，未限定的词查该表全部匹配列。
// 返回 null = 该表没有这个字段，整组跳过。
// prefix 用于联表查询的列限定（如 'm.'）：引号只包列名，拼成 m."member_name"——
// 写成 "m.member_name" 会被当成一个带点的列名，查不到列且被 try/catch 吞掉，表现为「静默搜不到」。
function termWhere(term, cols, prefix = '') {
  const cs = term.cols ? term.cols.filter(c => cols.includes(c)) : cols
  if (!cs.length) return null
  return {
    sql: '(' + cs.map(c => `${prefix}"${c}" LIKE ? ESCAPE '\\'`).join(' OR ') + ')',
    params: cs.map(() => likePattern(term.text)),
  }
}

// 整条查询的 WHERE：词之间 AND
function buildWhere(terms, cols, prefix = '') {
  const parts = []
  const params = []
  for (const t of terms) {
    const w = termWhere(t, cols, prefix)
    if (!w) return null
    parts.push(w.sql)
    params.push(...w.params)
  }
  return { sql: parts.join(' AND '), params }
}

// 相关性排序：主列（姓名/名称/主题）命中全部关键词的排最前，同级按 id 倒序（最近的先出）。
// 交给 SQL 排序的目的不只是好看 —— 这样 LIMIT 能直接截断，不必把上千行拉回 JS 再排。
// 返回的 params 对应 ORDER BY 里的占位符，必须排在 WHERE 参数之后。
function orderByClause(src, cols, terms) {
  const p = src.primary
  if (!p || !cols.includes(p)) return { sql: 'id DESC', params: [] }
  // 只拿「能落到主列上」的词做排序条件：`备注:请假` 这种限定词与主列无关，不参与
  const usable = terms.filter(t => !t.cols || t.cols.includes(p))
  if (!usable.length) return { sql: 'id DESC', params: [] }
  const cond = usable.map(() => `"${p}" LIKE ? ESCAPE '\\'`).join(' AND ')
  return { sql: `(CASE WHEN ${cond} THEN 0 ELSE 1 END), id DESC`, params: usable.map(t => likePattern(t.text)) }
}

// 命中列：第一个包含某个关键词的匹配列。用来告诉用户「这条为什么被搜出来」。
// 拼音命中的行不会有任何列字面包含关键词，返回空串（此时不贴标签）。
function hitColumn(cols, terms, row) {
  for (const c of cols) {
    const v = row[c]
    if (v === null || v === undefined || v === '') continue
    const s = String(v).toLowerCase()
    if (terms.some(t => s.includes(t.text.toLowerCase()))) return c
  }
  return ''
}

router.get('/', (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q) return res.json({ groups: [] })
    const terms = splitTerms(q)
    if (!terms.length) return res.json({ groups: [] })
    const single = terms.length === 1
    // 纯字母的单词查询才启用拼音匹配（zs / zhangsan 这类，字段限定同样支持：姓名:zs）；多词与中文走纯 LIKE
    const pm = single && /^[a-z]+$/i.test(terms[0].text) ? getPinyinMatch() : null
    // 维度名命中的维度：先算出来，groups 源的 extra 要用（搜「宿舍管理」→ 该维度下所有组）
    dimHitIds = []
    try {
      for (const d of db.prepare('SELECT id, name FROM group_dimensions ORDER BY id').all()) {
        const name = String(d.name || '')
        if (allTermsHit(name, terms, pm)) dimHitIds.push(d.id)
      }
    } catch (_) {}
    const groups = []
    for (const src of SOURCES) {
      // 列名来自本文件常量白名单（dynamic 源额外并入 table_meta 里已校验过的自定义列），直接内联到 SQL
      const cols = src.dynamic ? Array.from(new Set(src.match.concat(dynamicColumns(src.table)))) : src.match
      // 字段限定：本表没有该字段时 buildWhere 返回 null，整组跳过（也省掉这次扫描）
      const w = buildWhere(terms, cols)
      if (!w) continue
      const extra = src.extra ? src.extra() : null
      const where = extra ? `(${w.sql}) OR ${extra.clause}` : w.sql
      const od = orderByClause(src, cols, terms)
      // 拼音：先把主列的 distinct 值过一遍，拿到命中值再与 LIKE 合并成**一次**查询。
      // 不写成「先 LIKE 查一遍、不够再回表查一遍」—— 那是两次全表扫描，这里省掉一半。
      // 字段限定到别的列时（备注:zs）不做拼音：拼音只对姓名/名称这类主列有意义。
      const pinyinOk = pm && src.primary && src.pinyin !== false && (!terms[0].cols || terms[0].cols.includes(src.primary))
      let pinyinHits = []
      if (pinyinOk) {
        try {
          const vals = db.prepare(
            `SELECT DISTINCT "${src.primary}" AS v FROM ${src.table}
             WHERE "${src.primary}" IS NOT NULL AND "${src.primary}" <> '' LIMIT ?`
          ).all(PINYIN_VALUES)
          pinyinHits = vals.map(r => r.v).filter(v => matchPinyin(pm, v, terms[0].text))
        } catch (_) {}
      }
      let rows = []
      try {
        const ph = pinyinHits.map(() => '?').join(',')
        const whereSql = ph ? `((${where}) OR "${src.primary}" IN (${ph}))` : where
        rows = db.prepare(`SELECT * FROM ${src.table} WHERE ${whereSql} ORDER BY ${od.sql} LIMIT ?`)
          .all(...w.params, ...(extra ? extra.params : []), ...pinyinHits, ...od.params, PER_GROUP)
      } catch (_) {
        rows = [] // 单表异常（如存量库缺列）不影响其它分组
      }
      if (!rows.length) continue
      groups.push({
        table: src.table,
        group: src.group,
        emoji: src.emoji,
        route: src.route,
        items: rows.map(r => {
          const hit = hitColumn(cols, terms, r)
          return {
            id: r.id,
            label: src.label(r),
            // 命中在非主列时补一句「命中「备注」」，让人看出这条为什么被搜出来
            sub: [src.sub(r), hit && hit !== src.primary ? `命中「${hit}」` : ''].filter(Boolean).join(' · '),
            focus: src.focus(r),
          }
        }),
      })
    }
    // 课程表（cells 是二维 JSON，不走 SQL LIKE，单独解析）
    for (const sc of SCHEDULE_TABLES) {
      let row = null
      try { row = db.prepare(`SELECT cells, settings FROM ${sc.table} WHERE id = 1`).get() } catch (_) { continue }
      if (!row) continue
      let cells = []
      let settings = {}
      // 统一走 safeJson（解析失败给默认值并告警），不再各自内联 try/catch 样板
      cells = safeJson(row.cells, [], `${sc.table}.cells`)
      settings = safeJson(row.settings, {}, `${sc.table}.settings`)
      if (!Array.isArray(cells) || !cells.length) continue
      const days = Array.isArray(settings.days) && settings.days.length ? settings.days : DEFAULT_DAYS
      const items = []
      for (let li = 0; li < cells.length && items.length < PER_GROUP; li++) {
        const line = cells[li]
        if (!Array.isArray(line)) continue
        for (let di = 0; di < line.length && items.length < PER_GROUP; di++) {
          const cell = line[di]
          const name = cell && typeof cell === 'object' && cell.course != null ? String(cell.course).trim() : ''
          if (!name || !allTermsHit(name, terms, pm)) continue
          items.push({
            id: li + ':' + di,
            label: name,
            sub: (days[di] || '第' + (di + 1) + '列') + ' 第' + (li + 1) + '节',
            focus: sc.anchor + ':' + li + ':' + di,
          })
        }
      }
      if (items.length) groups.push({ table: sc.table, group: sc.group, emoji: '📖', route: '/schedule', items })
    }

    // 座位表（cells 存学生 id 或姓名，需 id→姓名映射后再按姓名匹配；focus 用页面显示列）
    let idNameMap = null
    const nameOfSeat = (v) => {
      if (v === null || v === undefined || v === '') return ''
      if (typeof v === 'number') {
        if (!idNameMap) {
          idNameMap = {}
          try { for (const s of db.prepare('SELECT id, 姓名 FROM students').all()) idNameMap[s.id] = s['姓名'] || '' } catch (_) {}
        }
        return idNameMap[v] || ''
      }
      return String(v)
    }
    for (const st of SEAT_TABLES) {
      let row = null
      try { row = db.prepare(`SELECT seats, types FROM ${st.table} WHERE id = 1`).get() } catch (_) { continue }
      if (!row) continue
      let seats = []
      seats = safeJson(row.seats, [], `${st.table}.seats`)
      if (!Array.isArray(seats) || !seats.length) continue
      const types = safeJson(row.types, [], `${st.table}.types`)
      // 座位列序号：整列都是走廊的列不占号（与页面表头「列N」同一口径）。
      // 走廊格的值本身就是 null，不会成为命中项；但**列号**必须按座位列数，
      // 否则搜索结果会写「列13」而页面只有 7 个座位列，人找不到。
      let maxCols = 0
      for (const line of seats) if (Array.isArray(line) && line.length > maxCols) maxCols = line.length
      const seatNo = []
      let seatSeq = 0
      for (let c = 0; c < maxCols; c++) {
        let allAisle = Array.isArray(types) && types.length > 0
        for (let r = 0; r < types.length; r++) {
          if (!Array.isArray(types[r]) || types[r][c] !== 1) { allAisle = false; break }
        }
        seatNo.push(allAisle ? 0 : ++seatSeq)
      }
      const items = []
      for (let r = 0; r < seats.length && items.length < PER_GROUP; r++) {
        const line = Array.isArray(seats[r]) ? seats[r] : []
        for (let c = 0; c < line.length && items.length < PER_GROUP; c++) {
          const name = nameOfSeat(line[c]).trim()
          if (!name || !allTermsHit(name, terms, pm)) continue
          if (seatNo[c] === 0) continue
          // focus 用**网格列下标**（走廊已是真实列，目标页不再做任何换算）
          items.push({ id: r + ':' + c, label: name, sub: `第${r + 1}行 · 列${seatNo[c]}`, focus: st.anchor + ':' + r + ':' + c })
        }
      }
      if (items.length) groups.push({ table: st.table, group: st.group, emoji: '🪑', route: '/seats', items })
    }

    // 值日表（项目×列；行按项目人数展开，与页面 buildGridRows 的行号一致）
    // 列名按模式分键（日常值日=星期几，大扫除=分组名+全部），走 dutyConfig 唯一入口取
    let dutyItemsField = null
    try {
      const g = db.prepare('SELECT items FROM duty_settings WHERE id = 1').get()
      if (g) dutyItemsField = g.items
    } catch (_) {}
    for (const dt of DUTY_TABLES) {
      let row = null
      try { row = db.prepare(`SELECT cells FROM ${dt.table} WHERE id = 1`).get() } catch (_) { continue }
      if (!row) continue
      for (const mode of ['daily', 'big']) {
        const dutyDays = dutyConfig.readDays(mode)
        const cells = unpackMode(row.cells, mode)
        const items = dutyItemsField ? unpackMode(dutyItemsField, mode, []) : []
        if (!Array.isArray(items) || !items.length) continue
        if (!cells || !Object.keys(cells).length) continue
        const out = []
        let rowIdx = 0
        for (const it of items) {
          const n = Math.max(1, Number(it.count) || 1)
          for (let k = 0; k < n; k++) {
            if (out.length >= PER_GROUP) break
            const byDay = cells[it.name] || {}
            for (let di = 0; di < dutyDays.length && out.length < PER_GROUP; di++) {
              const raw = byDay[dutyDays[di]]
              const name = Array.isArray(raw) ? String(raw[k] || '').trim() : String(raw || '').trim()
              if (!name || !allTermsHit(name, terms, pm)) continue
              out.push({ id: mode + ':' + rowIdx + ':' + di, label: name, sub: `${it.name} · ${dutyDays[di]}`, focus: dt.anchor + ':' + mode + ':' + rowIdx + ':' + di })
            }
            rowIdx++
          }
          if (out.length >= PER_GROUP) break
        }
        if (out.length) groups.push({ table: dt.table, group: dt.group + (mode === 'big' ? '（大扫除）' : ''), emoji: '🧹', route: '/duty', items: out })
      }
    }

    // 值日「项目名」：擦黑板 / 扫地 / 倒垃圾 这类劳动项目本身（上面那块匹配的是人名）。
    // 项目名存在 duty_settings.items 里，不在 cells 中，故单独成组；行号按项目人数展开累计，
    // 与页面 buildGridRows 一致，点进去落在该项目第一行第一列（不是某个人）。
    for (const mode of ['daily', 'big']) {
      const items = dutyItemsField ? unpackMode(dutyItemsField, mode, []) : []
      if (!Array.isArray(items) || !items.length) continue
      const out = []
      let rowIdx = 0
      for (const it of items) {
        const n = Math.max(1, Number(it.count) || 1)
        const name = String(it.name || '').trim()
        if (name && allTermsHit(name, terms, pm)) {
          out.push({
            id: mode + ':' + rowIdx,
            label: name,
            sub: (mode === 'big' ? '大扫除' : '日常') + (n > 1 ? ` · ${n} 人` : ''),
            focus: `duty:${mode}:${rowIdx}:0`,
          })
        }
        rowIdx += n
        if (out.length >= PER_GROUP) break
      }
      if (out.length) groups.push({ table: 'duty_items', group: '值日项目' + (mode === 'big' ? '（大扫除）' : ''), emoji: '🧹', route: '/duty', items: out })
    }

    // 分组成员（成员名 / 组内备注）：回答「某人在哪个组」。focus 沿用「分组」的 dim:<维度>:<组> 协议。
    const MEMBER_SQL = `SELECT m.id, m.group_id, m.member_name, m.remark,
                               g.name AS gname, g.dimension_id, d.name AS dname
                        FROM group_members m
                        JOIN groups g ON g.id = m.group_id
                        LEFT JOIN group_dimensions d ON d.id = g.dimension_id`
    try {
      // 字段限定：`姓名:张三` 里的姓名别名含 member_name，能命中分组成员；限定到本表没有的字段则整组跳过
      const mw = buildWhere(terms, ['member_name', 'remark'], 'm.')
      let rows = []
      if (mw) {
        try {
          rows = db.prepare(`${MEMBER_SQL} WHERE ${mw.sql} ORDER BY m.id DESC LIMIT ?`)
            .all(...mw.params, PER_GROUP)
        } catch (_) { rows = [] }
      }
      // 拼音补充：只在单词纯字母查询、且 LIKE 没凑够时才跑（distinct 成员名，量很小）
      const memberPinyinOk = pm && mw && (!terms[0].cols || terms[0].cols.includes('member_name'))
      if (memberPinyinOk && rows.length < PER_GROUP) {
        try {
          const vals = db.prepare(`SELECT DISTINCT member_name AS v FROM group_members WHERE member_name <> '' LIMIT ?`).all(PINYIN_VALUES)
          const hits = vals.map(r => r.v).filter(v => matchPinyin(pm, v, terms[0].text))
          if (hits.length) {
            const ph = hits.map(() => '?').join(',')
            rows = db.prepare(`${MEMBER_SQL} WHERE (${mw.sql}) OR m.member_name IN (${ph}) ORDER BY m.id DESC LIMIT ?`)
              .all(...mw.params, ...hits, PER_GROUP)
          }
        } catch (_) {}
      }
      if (rows.length) {
        groups.push({
          table: 'group_members',
          group: '分组成员',
          emoji: '👥',
          route: '/group-manage',
          items: rows.map(r => ({
            id: r.id,
            label: r.member_name || ('成员#' + r.id),
            sub: [r.dname, r.gname, r.remark].filter(Boolean).join(' · '),
            focus: `dim:${r.dimension_id}:${r.group_id}`,
          })),
        })
      }
    } catch (_) {}

    // 班干部「任职」：按担任学生名查他任了哪些职务（职务名命中由 SOURCES 的 cadres 负责）。
    // 点结果落到该职务行（focus 同样走 cadre: 前缀）。
    const CADRE_MEMBER_SQL = `SELECT m.id, m.cadre_id, m.student_name, c.name AS cname
                              FROM cadre_members m LEFT JOIN cadres c ON c.id = m.cadre_id`
    try {
      const cw = buildWhere(terms, ['student_name'], 'm.')
      let rows = []
      if (cw) {
        try {
          rows = db.prepare(`${CADRE_MEMBER_SQL} WHERE ${cw.sql} ORDER BY m.id DESC LIMIT ?`)
            .all(...cw.params, PER_GROUP)
        } catch (_) { rows = [] }
      }
      const cadrePinyinOk = pm && cw && (!terms[0].cols || terms[0].cols.includes('student_name'))
      if (cadrePinyinOk && rows.length < PER_GROUP) {
        try {
          const vals = db.prepare(`SELECT DISTINCT student_name AS v FROM cadre_members WHERE student_name <> '' LIMIT ?`).all(PINYIN_VALUES)
          const hits = vals.map(r => r.v).filter(v => matchPinyin(pm, v, terms[0].text))
          if (hits.length) {
            const ph = hits.map(() => '?').join(',')
            rows = db.prepare(`${CADRE_MEMBER_SQL} WHERE (${cw.sql}) OR m.student_name IN (${ph}) ORDER BY m.id DESC LIMIT ?`)
              .all(...cw.params, ...hits, PER_GROUP)
          }
        } catch (_) {}
      }
      if (rows.length) {
        groups.push({
          table: 'cadre_members',
          group: '班干部任职',
          emoji: '🎖️',
          route: '/students',
          items: rows.map(r => ({
            id: r.id,
            label: r.student_name || ('任职#' + r.id),
            sub: r.cname || '',
            focus: 'cadre:' + r.cadre_id,
          })),
        })
      }
    } catch (_) {}

    // 照片文件名：命中后落到该照片所属相册（相册页只支持定位到相册，不支持定位到单张图）。
    // 排序用 id 倒序而不是 photo_date：按拍摄日期排会把所有命中行都排序一遍（几万张时 p90 明显变差），
    // 而 id 倒序能沿主键反向扫描、凑够 PER_GROUP 条就停。代价是同一相册内按「入库先后」而不是拍摄时间，
    // 对「搜到就跳过去」的用途没有实际差别。文件名多为字母数字，LIKE 已足够，不做拼音补充。
    try {
      // 同样走 buildWhere：`文件:IMG_1` 能限定到文件名列，限定到本表没有的字段则整组跳过
      const pw = buildWhere(terms, ['file_name'])
      const rows = pw ? db.prepare(
        `SELECT p.id, p.album_id, p.file_name, p.photo_date, a.name AS album_name
         FROM album_photos p LEFT JOIN albums a ON a.id = p.album_id
         WHERE ${pw.sql}
         ORDER BY p.id DESC LIMIT ?`
      ).all(...pw.params, PER_GROUP) : []
      if (rows.length) {
        groups.push({
          table: 'album_photos',
          group: '照片',
          emoji: '📷',
          route: '/album',
          items: rows.slice(0, PER_GROUP).map(r => ({
            id: r.id,
            label: r.file_name || ('照片#' + r.id),
            sub: [r.album_name, String(r.photo_date || '').slice(0, 10)].filter(Boolean).join(' · '),
            focus: String(r.album_id),
          })),
        })
      }
    } catch (_) {}

    res.json({ groups })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
