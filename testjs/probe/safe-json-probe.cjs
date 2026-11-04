// =========================================================================
// safe-json-probe.cjs —— 「读库 JSON 列必须走统一兜底」回归探针
//
// 背景（v4 审查 P2）：
//   座位表 / 课表 / 值日表 / 撤销记录这些「整块 JSON」列，读取时各自裸调 JSON.parse。
//   只要有一条记录畸形（历史 bug、外部工具改库、AI 写坏），裸解析就抛 →
//   整条 GET/POST 500 → 用户看到白板，而不是「这张表暂时读不出来」。
//   项目已有 `student-backend/utils/json.js` 的 safeJson / readDocJson 作为统一入口，
//   但仍有若干处绕过它 —— 其中还有一处**注释自称「安全包裹」实则裸解析**。
//
// 这个探针做什么：
//   ① 列出「读路径必须走 safeJson / readDocJson」的调用点，静态断言已统一；
//   ② 反向豁免清单：写路径**刻意不兜底**（解析失败必须显式抛错，否则空值会覆盖用户数据），
//      断言它们仍是裸 JSON.parse —— 防止有人把它们"顺手改成 safeJson"造成数据丢失；
//   ③ safeJson 自身的语义不被改歪（已解析对象原样返回、失败给 fallback）。
//
// ⚠️ 判据说明：只做「静态形态」检查，不跑数据库。
//   兜底逻辑本身由 student-backend 的单测覆盖，这里守的是「有没有绕开统一入口」。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const BE = path.join(ROOT, 'student-backend')

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
  const p = path.join(BE, rel)
  if (!fs.existsSync(p)) {
    failures++
    console.error(`  ✗ 文件不存在：${rel}`)
    return ''
  }
  return fs.readFileSync(p, 'utf8')
}

// ---------------------------------------------------------------------------
// 1) 读路径必须走统一入口
// ---------------------------------------------------------------------------
console.log('== 1) 读库 JSON 列走 safeJson / readDocJson ==')
const READ_PATHS = [
  {
    file: 'routes/seats.js',
    id: 'V4-C03-05',
    what: 'snapshot/backfill 与 history/week 的 layout.seats / layout.settings',
    expect: /readDocJson\(layout,\s*\{\s*seats:\s*\[\],\s*settings:\s*\{\}\s*\}\)/,
  },
  {
    file: 'routes/undo/undo.records.js',
    id: 'V4-C03-02',
    what: 'getRecord 的 payload（注释自称「安全包裹」，实现却是裸解析）',
    expect: /safeJson\(rec\.payload/,
  },
  {
    file: 'routes/search.js',
    id: 'V4-C03-04',
    what: 'cells / settings / seats / days 四处读库 JSON 列',
    expect: /safeJson\(/,
  },
]
for (const r of READ_PATHS) {
  const src = read(r.file)
  if (!src) continue
  assert(r.expect.test(src),
    `${r.id} ${r.file}：读路径没走统一兜底（${r.what}）`,
    `${r.id} ${r.file}：读路径已统一`)
}

// ---------------------------------------------------------------------------
// 2) 反向豁免：写路径刻意不兜底，必须保持裸解析
// ---------------------------------------------------------------------------
console.log('== 2) 写路径豁免（刻意裸解析，防止被"顺手改成 safeJson"造成数据覆盖） ==')
const WRITE_EXEMPT = [
  {
    file: 'routes/seats.js',
    id: 'V4-C03-05-exempt',
    what: 'updateSingleCell：写路径若降级成空座位，会把整张座位表覆盖成只剩一格',
    expect: /const seats = rec \? JSON\.parse\(rec\.seats\) : \[\]/,
  },
]
for (const r of WRITE_EXEMPT) {
  const src = read(r.file)
  if (!src) continue
  assert(r.expect.test(src),
    `${r.id} ${r.file}：写路径被改成了兜底解析 —— 畸形数据会被降级成空值并覆盖原数据（${r.what}）`,
    `${r.id} ${r.file}：写路径仍是显式抛错`)
}

// ---------------------------------------------------------------------------
// 3) 全库扫描：除豁免清单外，不该再有「读库 JSON 列的裸 JSON.parse」
// ---------------------------------------------------------------------------
console.log('== 3) 全库无遗留的裸解析（豁免清单除外） ==')
{
  // 写路径豁免（第 2 组）：这些位置**必须**保持裸 JSON.parse。
  // 扫描时按「文件 + 该行内容」精确排除，避免把豁免项自己报出来。
  const EXEMPT_LINES = [
    { file: 'routes/seats.js', match: /const seats = rec \? JSON\.parse\(rec\.seats\) : \[\]/ },
  ]
  const isExempt = (rel, ln) =>
    EXEMPT_LINES.some((e) => e.file === rel && e.match.test(ln))

  // 允许裸 JSON.parse 的场景：
  //   · 已有 try/catch 兜底且不涉及库列（如解析 HTTP 响应体、AI 工具入参）
  //   · 写路径（见第 2 组豁免）
  // 这里只抓「完全没有 try/catch 保护、且明显在读库列」的裸解析。
  const suspects = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.endsWith('.js')) continue
      const rel = path.relative(BE, p).split(path.sep).join('/')
      const lines = fs.readFileSync(p, 'utf8').split('\n')
      lines.forEach((ln, i) => {
        if (!/JSON\.parse\(/.test(ln)) return
        if (ln.trim().startsWith('//') || ln.trim().startsWith('*')) return
        if (isExempt(rel, ln)) return
        // 该行或上一行有 try/catch → 已兜底
        const ctx = lines.slice(Math.max(0, i - 2), i + 2).join('\n')
        if (/try\s*\{|catch\s*[({]/.test(ctx)) return
        // 涉及库列读取的关键词
        if (!/\b(row|rec|record|layout|settings|cells|seats|payload|doc|g)\b\.[a-z_]+/i.test(ln)) return
        suspects.push(`${rel}:${i + 1}  ${ln.trim().slice(0, 70)}`)
      })
    }
  }
  walk(path.join(BE, 'routes'))
  walk(path.join(BE, 'services'))
  walk(path.join(BE, 'dbManager'))
  assert(suspects.length === 0,
    `以下位置疑似「读库列的裸 JSON.parse 且无兜底」：\n     ${suspects.join('\n     ')}`,
    '未发现遗留的裸解析')
}

// ---------------------------------------------------------------------------
// 4) safeJson 自身语义不被改歪
// ---------------------------------------------------------------------------
console.log('== 4) safeJson 语义不被改歪 ==')
{
  const src = read('utils/json.js')
  assert(/function safeJson/.test(src), 'utils/json.js 不再导出 safeJson')
  assert(/catch\s*\(err\)/.test(src) && /return fallback/.test(src),
    'safeJson 解析失败时必须返回 fallback（不能抛）',
    'safeJson 失败返回 fallback')
  assert(/typeof value === 'object'/.test(src),
    'safeJson 必须原样返回已解析的对象/数组（部分调用方传的字段可能已解析过）',
    'safeJson 原样返回已解析对象')
  assert(/readDocJson/.test(src), 'utils/json.js 不再提供 readDocJson')
}

console.log('')
if (failures) {
  console.error(`✗ safe-json-probe：${failures} 项未通过`)
  process.exit(1)
}
console.log('✓ safe-json-probe 全部通过')
