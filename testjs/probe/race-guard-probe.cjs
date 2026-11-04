// =========================================================================
// race-guard-probe.cjs —— 「异步响应序号守卫」静态回归探针
//
// 背景（v4 审查 P2）：
//   同一类 bug 在仓库里反复出现——「发请求 → await → 直接写 ref」。
//   请求乱序返回时，旧响应会覆盖新状态，界面上表现为「切了但没切」「快速连点结果错乱」。
//   项目已有统一封装 `student-frontend/src/utils/latestOnly.js` 的 `createLatest()`，
//   但只有 2 处（DutyView / AlbumPhotoPickerDialog）在用，其余各处各写各的、多数干脆没写。
//
// 这个探针做什么：
//   把「哪些文件必须用守卫」列成清单，逐个静态断言该文件里
//   ① import 了 createLatest（或注入了等价守卫）；
//   ② 在「await 之后写 ref」的位置前面调了 `guard.isCurrent(token)`。
//   旧实现（没守卫）在这两条上必挂 → 探针是有断言的回归资产，不是结论型脚手架。
//
// 判据说明：
//   · 只断言「该文件出现 createLatest 且出现 isCurrent」，不解析完整 AST：
//     断言太严会把合法的写法（守卫放在别处、透传 token）判死，反而逼出绕过式改写。
//   · 清单里的每一项都对应台账里的一条编号，改动请同步台账。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'student-frontend', 'src')

let failures = 0
function assert(cond, msg, okMsg) {
  if (!cond) {
    failures++
    console.error('  ✗ ' + msg)
  } else {
    console.log('  ✓ ' + (okMsg || msg))
  }
}

function read(rel) {
  const p = path.join(SRC, rel)
  if (!fs.existsSync(p)) {
    failures++
    console.error(`  ✗ 文件不存在：${rel}`)
    return ''
  }
  return fs.readFileSync(p, 'utf8')
}

// ---------------------------------------------------------------------------
// 必须有守卫的调用点：文件 → 台账编号 + 该文件里守卫的标识
// ---------------------------------------------------------------------------
const GUARDED = [
  {
    file: 'views/ScheduleView/ScheduleView.history.js',
    id: 'V4-B06-06',
    what: 'loadHistorySnapshot：快速切周，旧响应覆盖新快照',
    // 该文件是 ctx 注入式模块，守卫由 .vue 侧创建 → 允许通过 ctx 传进来
    allow: [/createLatest/, /isCurrent/, /Guard/, /guard/],
  },
  {
    file: 'components/dialogs/AddModelDialog.vue',
    id: 'V4-B07-07',
    what: 'discover 连点：慢响应后到覆盖手填的模型名',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'components/dialogs/AddScoreDialog.vue',
    id: 'V4-B07-08',
    what: 'loadDims / onDimChange：切维度时旧响应覆盖小组列表',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'components/dialogs/DutyBackfillDialog.vue',
    id: 'V4-B07-11',
    what: 'loadDaily：快速切周，旧响应覆盖每日记录',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'components/dialogs/SeatBackfillDialog.vue',
    id: 'V4-B07-11',
    what: 'loadDaily：快速切周，旧响应覆盖每日记录',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'components/tables/AiRecordTable.vue',
    id: 'V4-B09-08',
    what: 'load()：连续打开不同记录，旧响应覆盖新记录',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'composables/useTableCRUD.js',
    id: 'V4-B10-10',
    what: 'fetchRows：连续刷新，旧响应覆盖新表',
    allow: [/createLatest/, /isCurrent/],
  },
  // 早期用 useSeq.js 的调用点：2026-11-04 已统一迁移到 utils/latestOnly.js，
  // 这里一并守住，防止回退成第二份实现或旧 API 名。
  {
    file: 'components/base/SearchDialog.vue',
    id: 'V4-B08-04',
    what: '远程搜索：快速输入，旧结果覆盖新关键词',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'components/tables/AiGridPreview.vue',
    id: 'V4-B09-09',
    what: '网格预览取数：连续切换，旧数据覆盖新数据',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'components/import-export/ImportExcel.vue',
    id: 'V4-B09-0x',
    what: '导入解析：换文件时旧解析结果覆盖新文件',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'components/import-export/ExportAlbumIndex.vue',
    id: 'V4-B09-0x',
    what: '重建索引：连续触发，旧进度覆盖新进度',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'views/AlbumView.vue',
    id: 'V4-B09-0x',
    what: '相册照片列表：连续加载，旧列表覆盖新列表',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'views/DashboardView.vue',
    id: 'V4-B09-0x',
    what: '仪表盘相册照片：换相册时旧图覆盖新图',
    allow: [/createLatest/, /isCurrent/],
  },
  {
    file: 'components/dialogs/AiSettingsDialog.vue',
    id: 'V4-B07-06',
    what: 'AI 配置刷新：旧响应覆盖新配置',
    allow: [/createLatest/, /isCurrent/],
  },
]

console.log('== 1) 竞态调用点必须有守卫 ==')
for (const g of GUARDED) {
  const src = read(g.file)
  if (!src) continue
  const hasImport = g.allow.some((re) => re.test(src))
  const hasCheck = /isCurrent\s*\(/.test(src)
  assert(hasImport, `${g.id} ${g.file}：缺少守卫标识（${g.what}）`, `${g.id} ${g.file}：守卫标识在位`)
  assert(hasCheck, `${g.id} ${g.file}：守卫没有在 await 之后做 isCurrent 判定（${g.what}）`, `${g.id} ${g.file}：await 后有 isCurrent 判定`)
}

// ---------------------------------------------------------------------------
// 2) 反向检查：守卫的语义不能被改歪
// ---------------------------------------------------------------------------
console.log('== 2) createLatest 语义不被改歪 ==')
{
  const src = read('utils/latestOnly.js')
  assert(/export function createLatest/.test(src), 'latestOnly.js 不再导出 createLatest')
  assert(/begin\s*\(\)/.test(src), 'createLatest 不再提供 begin()')
  assert(/isCurrent\s*\(/.test(src), 'createLatest 不再提供 isCurrent()')
  assert(/invalidate\s*\(\)/.test(src), 'createLatest 不再提供 invalidate()')
  assert(/current\s*\(\)/.test(src), 'createLatest 不再提供 current()（同一次操作的两阶段要读当前号）')
  // isCurrent 必须是严格相等（写成 >= 会让旧令牌在某些序号下重新变「当前」）
  assert(/token\s*===\s*seq/.test(src), 'isCurrent 必须是严格相等（token === seq），否则旧令牌可能重新生效')
  // 全库唯一实现：早期还有一份 composables/useSeq.js（take/isLatest），
  // 两份近似封装并存 → 新代码挑哪个全凭记忆，漏守卫无从察觉。
  assert(!fs.existsSync(path.join(SRC, 'composables/useSeq.js')),
    'composables/useSeq.js 不应存在：守卫的唯一实现是 utils/latestOnly.js')
  // 残留调用点：任何地方还在用 take()/isLatest() 说明迁移没做完
  const stale = []
  const walkDir = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walkDir(p)
      else if (/\.(js|vue)$/.test(e.name)) {
        const t = fs.readFileSync(p, 'utf8')
        if (/useSeq\s*\(|\.take\(\)|\.isLatest\(/.test(t)) stale.push(path.relative(SRC, p))
      }
    }
  }
  walkDir(SRC)
  assert(stale.length === 0,
    `以下文件还在用旧守卫 API（useSeq/take/isLatest），应统一到 createLatest/begin/isCurrent：${stale.join(', ')}`,
    '全库无残留的旧守卫 API')}

// ---------------------------------------------------------------------------
// 3) 守卫必须真的落在「写 ref」之前 —— 找出「await 之后的状态写入」，
//    断言它前面有 isCurrent 判定。
//    按函数作用域判定：写操作归属「最近一个缩进更浅的函数定义」，
//    同步清空（在 await 之前发生的写入）不算竞态，不要求守卫。
// ---------------------------------------------------------------------------
console.log('== 3) 守卫不是摆设（await 之后的写入必须有 isCurrent） ==')
const WRITE_TARGETS = [
  { file: 'components/dialogs/AddModelDialog.vue', id: 'V4-B07-07', write: /discovered\.value\s*=/ },
  { file: 'components/dialogs/AddScoreDialog.vue', id: 'V4-B07-08', write: /activeDimGroups\.value\s*=/ },
  { file: 'components/dialogs/DutyBackfillDialog.vue', id: 'V4-B07-11', write: /dailyRows\.value\s*=/ },
  { file: 'components/dialogs/SeatBackfillDialog.vue', id: 'V4-B07-11', write: /dailyRows\.value\s*=/ },
  { file: 'components/tables/AiRecordTable.vue', id: 'V4-B09-08', write: /rows\.value\s*=/ },
  { file: 'composables/useTableCRUD.js', id: 'V4-B10-10', write: /rows\.value\s*=/ },
]

// 找出每一行所属的函数：向上找最近一个「缩进更浅且形如函数定义」的���
function functionScopeOf(lines, idx) {
  let indent = lines[idx].match(/^\s*/)[0].length
  for (let i = idx - 1; i >= 0; i--) {
    const ln = lines[i]
    if (!ln.trim()) continue
    const ind = ln.match(/^\s*/)[0].length
    if (ind >= indent) continue
    if (/^(export\s+)?(async\s+)?function\s/.test(ln.trim()) || /^(export\s+)?const\s+\w+\s*=\s*(async\s*)?\(/.test(ln.trim())) {
      return i
    }
    indent = ind // 再往上按更浅的缩进继续找
  }
  return 0
}

for (const w of WRITE_TARGETS) {
  const src = read(w.file)
  if (!src) continue
  const lines = src.split('\n')
  const problems = []
  lines.forEach((ln, i) => {
    if (!w.write.test(ln)) return
    const scopeStart = functionScopeOf(lines, i)
    // 本函数作用域内、该写入之前是否出现过 await
    let sawAwait = false
    for (let j = scopeStart; j < i; j++) {
      if (/\bawait\b/.test(lines[j])) { sawAwait = true; break }
    }
    if (!sawAwait) return // 同步写入，不涉及竞态
    // await 之后、写入之前，是否有 isCurrent 判定
    let guarded = false
    for (let j = scopeStart; j < i; j++) {
      if (/\bawait\b/.test(lines[j])) {
        // 重新从最后一个 await 起算
        guarded = false
      }
      if (/isCurrent\s*\(/.test(lines[j])) guarded = true
    }
    if (!guarded) problems.push(i + 1)
  })
  assert(problems.length === 0,
    `${w.id} ${w.file}：第 ${problems.map((n) => n).join(', ') || '（未定位）'} 行的状态写入在 await 之后却没有 isCurrent 判定（旧响应会直接覆盖新状态）`,
    `${w.id} ${w.file}：await 后的写入前均有 isCurrent 判定`)
}

// ---------------------------------------------------------------------------
// 4) import 路径必须真的指向存在的文件
//    迁移守卫封装时手改路径很容易算错层级（components/base/ 与 components/dialogs/
//    要 ../../utils/，views/ 只要 ../utils/）—— 而静态探针查不出这种错，
//    只有构建才会报。这里提前把它变成可检测的失败。
// ---------------------------------------------------------------------------
console.log('== 4) import 路径指向真实文件 ==')
{
  const bad = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(js|vue)$/.test(e.name)) continue
      const t = fs.readFileSync(p, 'utf8')
      const re = /from\s+['"](\.[^'"]*latestOnly\.js)['"]/g
      let m
      while ((m = re.exec(t))) {
        const target = path.resolve(path.dirname(p), m[1])
        if (!fs.existsSync(target)) {
          bad.push(`${path.relative(SRC, p)} → ${m[1]}`)
        }
      }
    }
  }
  walk(SRC)
  assert(bad.length === 0,
    `以下 import 路径指向的文件不存在（构建会失败）：${bad.join('; ')}`,
    '所有 latestOnly.js 的 import 路径都指向真实文件')
}

console.log('')
if (failures) {
  console.error(`✗ race-guard-probe：${failures} 项未通过`)
  process.exit(1)
}
console.log('✓ race-guard-probe 全部通过')