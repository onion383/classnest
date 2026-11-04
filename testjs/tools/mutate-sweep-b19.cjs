// =========================================================================
// mutate-sweep-b19.cjs —— 批 19 的反向验证（变异测试）
//
// 目的：证明 testjs/units/sweep-fixes-b19.test.js 的判据**真的能抓到回归**。
// ⚠️ 还原挂在 process.on('exit') 上（只靠循环末尾还原，中途异常退出就把坏代码留在工作区）。
// ⚠️ 锚点自动适配 CRLF 行尾（源码可能是 CRLF，用 LF 写的锚点会永远匹配不上）。
//
// 用法：node testjs/tools/mutate-sweep-b19.cjs
// 退出码：0 = 全部变异都被抓到；1 = 有漏网。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..')
const TEST = path.join(ROOT, 'testjs', 'units', 'sweep-fixes-b19.test.js')

const FILES = {
  httpclient: 'student-frontend/src/utils/httpClient.js',
  apiurl: 'student-frontend/src/utils/apiUrl.js',
  pdffont: 'student-frontend/src/utils/pdfFont.js',
  serialsaver: 'student-frontend/src/utils/serialSaver.js',
  tablesearch: 'student-frontend/src/utils/tableSearch.js',
  icon: 'student-frontend/src/components/base/IconGlyph.vue',
  appselect: 'student-frontend/src/components/base/AppSelect.vue',
  timeline: 'student-frontend/src/components/base/LeaveTimeline.vue',
  dt: 'student-frontend/src/components/tables/DynamicTable/DynamicTable.vue',
  leave: 'student-frontend/src/components/dialogs/AddLeaveDialog.vue',
  undo: 'student-backend/schema/schema.undo.js',
  album: 'student-backend/schema/schema.album.js',
}

const orig = {}
for (const [k, rel] of Object.entries(FILES)) {
  orig[k] = fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

const MUTANTS = [
  {
    name: 'M1 默认写请求守卫改回放行一切（子窗口又会重发 6 次）',
    file: 'httpclient',
    from: '  writeRetryGuard = defaultWriteRetryGuard,',
    to: '  writeRetryGuard = () => true,',
  },
  {
    name: 'M2 默认守卫把 POST 也放行（写请求会重复落库）',
    file: 'httpclient',
    from: "  return m === 'get' || m === 'head'",
    to: "  return true",
  },
  {
    name: 'M3 明文模式又把 JWT 拼进 URL（凭据泄露到日志/历史）',
    file: 'apiurl',
    from: '  if (!safe()) return url',
    to: '  // 变异：明文模式也拼 token',
  },
  {
    name: 'M4 字体改回裸路径（无 content hash → 缓存旧字体）',
    file: 'pdffont',
    from: "const FONT_GZ_URL = new URL('../assets/fonts/NotoSansSC-6.ttf.gz', import.meta.url).href",
    to: "const FONT_GZ_URL = '/NotoSansSC-6.ttf.gz'",
  },
  {
    name: 'M5 serialSaver 去掉静默期（连打 10 字又变 2 次整表 PUT）',
    file: 'serialsaver',
    from: '        if (quietMs) await waitQuiet()',
    to: '        // 变异：去掉静默期',
  },
  {
    name: 'M6 serialSaver 静默期默认改回 0（不防抖）',
    file: 'serialsaver',
    from: 'const DEFAULT_QUIET_MS = 300',
    to: 'const DEFAULT_QUIET_MS = 0',
  },
  {
    name: 'M7 serialSaver dirty 清理挪到 waitQuiet 之前（多存一轮）',
    file: 'serialsaver',
    // ⚠️ 锚点必须把 waitQuiet **之后**那句 `dirty = false` 一起纳入替换范围。
    //   第一版只往前加了一行、保留了后面那句 → 两个 `dirty = false` 互相抵消，
    //   行为与原实现完全一致（等价变异）→ 单测当然全绿，报「漏网」是脚本自己写错了。
    //   已实测：正确挪走之后，合并存与「只存一轮」两条用例同时变红。
    from: '        if (quietMs) await waitQuiet()\n        // 清 dirty 要放在 waitQuiet 之后：此刻起 saveFn 读到的是最新状态，\n        // 这一轮存完就没有待存的了（除非 saveFn 执行期间又有新输入）。\n        dirty = false',
    to: '        dirty = false\n        if (quietMs) await waitQuiet()',
  },
  {
    name: 'M8 tableSearch 去掉缓存（每次全表 toLowerCase）',
    file: 'tablesearch',
    from: '  if (hit && hit.raw === raw) return hit.lower',
    to: '  // 变异：去掉缓存命中',
  },
  {
    name: 'M9 tableSearch 缓存不按原值失效（值改了仍用旧的小写）',
    file: 'tablesearch',
    from: '  if (hit && hit.raw === raw) return hit.lower',
    to: '  if (hit) return hit.lower',
  },
  {
    name: 'M10 IconGlyph 的 MAP 挪回 script setup（每实例重建）',
    file: 'icon',
    from: '<script>\n// 模块级常量',
    to: '<script setup vapor>\n// 变异：MAP 挪进 setup\n<script>\n// 模块级常量',
  },
  {
    name: 'M11 AppSelect 键盘打开不初始化 hoverIdx（第二次 Enter 静默无效）',
    file: 'appselect',
    from: '@keydown.enter.prevent="open ? commit(hoverIdx) : openMenu()"',
    to: '@keydown.enter.prevent="open ? commit(hoverIdx) : (open = true)"',
  },
  {
    name: 'M12 rowHeights 不清理失效键（无界增长）',
    file: 'dt',
    from: '      if (!keys.has(k)) ctx.rowHeights.value.delete(k);',
    to: '      // 变异：不删',
  },
  {
    name: 'M13 请假编辑模式不再校验 studentId（PUT 到 undefined）',
    file: 'leave',
    from: "      if (studentId == null || studentId === '') {",
    to: '      if (false) {',
  },
  {
    name: 'M14 undo_history 索引改回不覆盖 (dir, origin)',
    file: 'undo',
    from: 'conn.exec(`CREATE INDEX IF NOT EXISTS idx_undo_dir_origin ON undo_history (dir, origin);`);',
    to: '// 变异：删掉索引',
  },
  {
    name: 'M15 album_photos 索引改回不覆盖 (album_id, id)',
    file: 'album',
    from: 'conn.exec(`CREATE INDEX IF NOT EXISTS idx_album_photos_album_id ON album_photos (album_id, id);`);',
    to: '// 变异：删掉索引',
  },
  {
    name: 'M16 LeaveTimeline 改回每击键重建 haystack',
    file: 'timeline',
    from: '        if (!haystackOf(n).includes(kw)) return false;',
    to: "        const haystack = Object.values(n).map(v => String(v || '')).join(' ').toLowerCase();\n        if (!haystack.includes(kw)) return false;",
  },
  {
    name: 'M17 LeaveTimeline 改回线性 find nodeTypes',
    file: 'timeline',
    from: '  const t = nodeTypeIndex.value.get(node.type);',
    to: '  const t = props.nodeTypes.find(n => n.value === node.type);',
  },
]

// ---------------------------------------------------------------------------
function restoreAll() {
  for (const [k, rel] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(ROOT, rel), orig[k])
  }
}
process.on('exit', restoreAll)

function applyMutant(m) {
  const p = path.join(ROOT, FILES[m.file])
  const src = fs.readFileSync(p, 'utf8')
  let from = m.from
  let to = m.to
  if (src.includes('\r\n') && !from.includes('\r\n')) {
    from = from.replace(/\n/g, '\r\n')
    to = to.replace(/\n/g, '\r\n')
  }
  if (!src.includes(from)) return false
  fs.writeFileSync(p, src.replace(from, to))
  return true
}

function runTests() {
  const r = spawnSync(process.execPath, ['--test', TEST], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env },
  })
  const out = (r.stdout || '') + (r.stderr || '')
  return { failed: /^not ok/m.test(out), out }
}

// ---------------------------------------------------------------------------
let missed = 0
let skipped = 0
console.log('== 批 19 反向验证：' + MUTANTS.length + ' 处变异 ==\n')

for (const m of MUTANTS) {
  restoreAll()
  if (!applyMutant(m)) {
    console.log('  SKIP  ' + m.name + ' —— 锚点未找到（源码已变？）')
    skipped++
    missed++
    continue
  }
  const { failed, out } = runTests()
  const mNotOk = (out.match(/^not ok/gm) || []).length
  if (failed) {
    console.log('  ✓ 抓到  ' + m.name + '（' + mNotOk + ' 条变红）')
  } else {
    console.log('  ✗ 漏网  ' + m.name + ' —— 单测仍然全绿（判据太松！）')
    missed++
  }
}

restoreAll()
console.log('')
if (missed) {
  console.error('失败 ' + missed + ' 处（漏网 ' + (missed - skipped) + ' / 锚点未找到 ' + skipped + '）')
  process.exit(1)
}
console.log('全部变异都被精确捕获，0 漏网')
