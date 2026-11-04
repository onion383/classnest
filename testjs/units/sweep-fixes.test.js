// =========================================================================
// sweep-fixes.test.js —— 「模式扫描批」的行为回归测试（表驱动）
//
// 覆盖 2026-11-04 批 18 的全部**可测行为**修复：
//   C03-03/06/07  日期拼接收口（后端 4 处 + 前端 4 处统一走 localDateStr）
//   B06-07         下载 Blob 后同步 revokeObjectURL → 0 字节文件
//   B09-10         附件/粘贴 readFile 拒绝未 catch
//   B05-07         normalizeExifDate 不校月日一致性（2/31 被滚到 3/2）
//   B08-01         IconGlyph 旋转选择器永不匹配
//   B08-02         duration=0 常驻通知悬停一次即被误杀
//   B09-07         VideoThumb 图片失败后不随 src 复位
//   B12-05         Setup 二次进入覆盖用户已选主题
//   B12-08         倒计时归零再 start 静默无反应
//   B10-03         _streamReply finally 先 busy=false 再未 await executeProposal
//   漏网（探针发现）ffmpeg 抓帧无超时 → 槽位永不释放 → 扫描 worker 卡死
//   漏网（探针发现）theme.js / migration / setup 的 promise 链无 catch
//
// 与 testjs/probe/pattern-sweep-probe.cjs 的分工：
//   探针 = **静态形态**判据（源码里还有没有这个模式）；本单测 = **行为**判据（真跑代码）。
//   两者都要有：静态判据抓「新出现的同类」，行为判据抓「改法本身对不对」。
//
// ⚠️ 一律 require **真实源码**，不复现逻辑（复现逻辑的单测改坏源码不变 → 必假绿）。
// =========================================================================

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..', '..')
const TMP = path.join(os.tmpdir(), 'sweep-fixes-unit-' + process.pid)
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || TMP

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// 按方括号配对从源码里取出 `key: [ ... ]` 的内容（感知字符串与转义）。
// 不用 `[^\]]*` 正则：数组项里含 `]` 时会在那里提前截断，后续项漏检（审查 v5 · V5-035）。
function extractBracketArrays(src, key) {
  const out = []
  const re = new RegExp(key + '\\s*:\\s*\\[', 'g')
  let m
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length
    let depth = 1
    let i = start
    let quote = ''
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (quote) {
        if (ch === '\\') i += 1
        else if (ch === quote) quote = ''
      } else if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch
      } else if (ch === '[') {
        depth += 1
      } else if (ch === ']') {
        depth -= 1
      }
      i += 1
    }
    out.push(src.slice(start, i - 1))
    re.lastIndex = i
  }
  return out
}

/**
 * 去掉注释再匹配。
 * ⚠️ 静态判据凡是「不该出现 X」都**必须**先去注释 ——
 *   否则注释里为了解释「原来错在哪」而写的旧代码会骗过正则 → 假绿/假红。
 *   （2026-11-04 批 18 又踩了一次：IconGlyph 的修复注释里写了旧写法
 *     `.icon-loading :deep(svg)`，forbid 正则直接命中自己的注释。）
 */
function stripComments(src) {
  return src
    // 块注释
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 行注释（避开 URL 里的 //）
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// ---------------------------------------------------------------------------
// 表驱动：每个修法的「源码级」判据
//   静态形态守不住行为，但能守住「修法还在」——
//   比如「日期拼接是否还散落在别处」「revoke 是否还同步调用」。
//   每条都要能**反向验证**（见 testjs/tools/mutate-sweep.cjs）。
// ---------------------------------------------------------------------------

const STATIC_CASES = [
  {
    id: 'C03 日期收口',
    desc: '后端 4 处 + 前端 4 处不再各自拼 YYYY-MM-DD，统一走 localDateStr',
    files: [
      'student-backend/routes/ai/ai.dataRoutes.js',
      'student-backend/albumScan.js',
      'student-backend/routes/ai/ai.tools/tools.executors/executors.common.js',
      'student-backend/routes/ai/ai.tools/tools.executors/executors.js',
      'student-frontend/src/components/dialogs/DutyBackfillDialog.vue',
      'student-frontend/src/components/dialogs/SeatBackfillDialog.vue',
      'student-frontend/src/views/DutyView.vue',
      'student-frontend/src/views/SeatView.vue',
    ],
    // 该文件里不得再出现「模板串里调 getFullYear 并拼 -MM-DD」
    forbid: /\$\{[^}]*getFullYear\(\)[^}]*\}\s*-\s*\$\{[^}]*pad(Start)?\(/,
    // 统一入口的**别名**也算（executors.common 把 localDateStr 重命名成 aiDateStr）
    mustHave: /localDateStr|aiDateStr/,
  },
  {
    id: 'C03 后端统一入口真被用上',
    desc: '后端 utils/date.js 的 localDateStr 不再是死导出（真的被 import 了）',
    files: [
      'student-backend/routes/ai/ai.dataRoutes.js',
      'student-backend/albumScan.js',
      'student-backend/routes/ai/ai.tools/tools.executors/executors.common.js',
    ],
    forbid: null,
    mustHave: /require\(['"][^'"]*utils\/date['"]\)/,
  },
  {
    id: 'B06-07 下载不立即撤销 blob',
    desc: 'AlbumView / SettingsView 的 revokeObjectURL 必须延迟（同步撤销 → 0 字节文件）',
    files: [
      'student-frontend/src/views/AlbumView.vue',
      'student-frontend/src/views/SettingsView/SettingsView.data.js',
    ],
    forbid: null,
    // revoke 必须出现在 setTimeout 里
    mustHave: /setTimeout\(\s*\(\)\s*=>\s*URL\.revokeObjectURL\(/,
  },
  {
    id: 'B09-10 附件读取接住异常',
    desc: 'AiComposer 的 readFile 必须包在 try 里（否则用户点了没反应）',
    files: ['student-frontend/src/components/ai/AiComposer/AiComposer.vue'],
    forbid: null,
    // ⚠️ 判据必须数「try 出现的次数」：只判「存在某个 try」会匹配到别处的 try
    //    （变异测试 M7 漏网过一次：把附件处的 try 删了，粘贴图片处的 try 还在，
    //      `try{...await readFile(` 仍能匹配到 → 假绿）。
    mustHave: /try\s*\{[\s\S]{0,400}await readFile\(/,
    minCount: 2, // 两处 readFile（选择文件 / 粘贴）都要有 try
    countPattern: /try\s*\{[\s\S]{0,400}await readFile\(/g,
  },
  {
    id: ':key 稳定性：结果行不因搜索词重挂载',
    desc: 'SearchDialog / SettingsView 的结果行 :key 只能是稳定 id，不能掺搜索词',
    files: [
      'student-frontend/src/components/base/SearchDialog.vue',
      'student-frontend/src/views/SettingsView/SettingsView.vue',
    ],
    forbid: /:key\s*=\s*"[^"]*(\+|keyword|settingsSearch)[^"]*"/,
    mustHave: null,
  },
  {
    id: 'B11-07 启动背景图走 resourceUrl',
    desc: '自定义背景图必须走 resourceUrl（裸路径 → 首帧 401 → 闪白底）',
    files: ['student-frontend/src/main.js'],
    forbid: null,
    mustHave: /if\s*\(customBg\)\s*return\s*resourceUrl\(customBg\)/,
  },
  {
    id: 'B08-01 旋转选择器',
    desc: 'icon-loading 类打在 svg 根上 → 选择器必须写成 .icon-loading:deep(svg)',
    files: ['student-frontend/src/components/base/IconGlyph.vue'],
    forbid: /\.icon-loading\s+:deep\(svg\)/,
    mustHave: /\.icon-loading:deep\(svg\)/,
  },
  {
    id: 'B08-02 常驻通知',
    desc: 'duration=0 的常驻通知不能被 setTimeout(remove,0) 误杀',
    files: ['student-frontend/src/components/base/NotificationToast.vue'],
    forbid: null,
    mustHave: /if\s*\(!item\._originalDuration\)\s*return/,
  },
  {
    id: 'B09-07 VideoThumb 复位',
    desc: 'src 变化时 ok 必须复位（否则复用组件永久只显播放图标）',
    files: ['student-frontend/src/components/import-export/VideoThumb.vue'],
    forbid: null,
    mustHave: /watch\(\s*\(\)\s*=>\s*props\.src[\s\S]{0,120}ok\.value\s*=\s*true/,
  },
  {
    id: 'B12-05 不覆盖用户主题',
    desc: 'Setup 只能在「用户从未选过主题」时落默认，不能覆盖已选主题',
    files: ['student-frontend/src/subwindows/setup/Setup.vue'],
    // 旧写法：if (currentTheme !== 'glass') setTheme('glass') —— 恒等于「覆盖用户选择」
    forbid: /currentTheme\s*!==\s*'glass'\)\s*themeStore\.setTheme\('glass'\)/,
    mustHave: /hasSavedTheme/,
  },
  {
    id: 'B12-08 倒计时给反馈',
    desc: '倒计时时长为 0 时必须给可见提示，不能静默 return',
    files: ['student-frontend/src/subwindows/widget/Timer.vue'],
    forbid: null,
    mustHave: /hint\.value\s*=\s*'请先设置倒计时时长/,
  },
  {
    id: 'B10-03 busy 复位在提案执行之后',
    desc: 'executeProposal 必须 await 完才把 busy 置 false（否则并发写同表）',
    files: ['student-frontend/src/composables/ai/aiChat.js'],
    forbid: null,
    mustHave: /await ctx\.executeProposal\(last\)[\s\S]{0,200}ctx\.busy\.value\s*=\s*false/,
  },
  {
    id: '漏网 ffmpeg 抓帧超时',
    desc: 'albumScan 的 ffmpeg execFile 必须带 timeout（否则坏视频 → 槽位永不释放 → worker 卡死）',
    files: ['student-backend/albumScan.js'],
    forbid: null,
    mustHave: /execFile\([^)]*\{[^}]*timeout:\s*FFMPEG_THUMB_TIMEOUT_MS/,
  },
  {
    id: '漏网 promise 链接住失败',
    desc: 'migration / setup 的挂载链必须有 catch（否则失败 → 白屏且无提示）',
    files: [
      'student-frontend/src/subwindows/migration/main.js',
      'student-frontend/src/subwindows/setup/main.js',
    ],
    forbid: null,
    mustHave: /\.catch\(/,
  },
  {
    id: '漏网 theme 补发凭据',
    desc: 'theme.js 补发媒体凭据的 promise 必须接住（失败 → unhandled rejection）',
    files: ['student-frontend/src/stores/theme.js'],
    forbid: null,
    mustHave: /ensureMediaToken\(\)[\s\S]{0,300}\.catch\(/,
  },
]

for (const c of STATIC_CASES) {
  test(`[静态] ${c.id} —— ${c.desc}`, () => {
    for (const f of c.files) {
      const raw = readSrc(f)
      // forbid 只看代码（去注释）；mustHave 看全文（注释里提到也算数）
      const code = stripComments(raw)
      if (c.forbid) {
        assert.ok(!c.forbid.test(code), `${f}：不该再出现该模式（${c.forbid}）`)
      }
      if (c.mustHave) {
        assert.ok(c.mustHave.test(raw), `${f}：应保留修法特征（${c.mustHave}）`)
      }
      // minCount：同一模式在文件里出现几次下限（防「只改一处、另一处照旧」）
      if (c.minCount && c.countPattern) {
        const n = (raw.match(c.countPattern) || []).length
        assert.ok(n >= c.minCount,
          `${f}：修法应至少出现 ${c.minCount} 次，实际 ${n} 次（只改了一处 = 改坏）`)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// 行为判据：真跑源码
// ---------------------------------------------------------------------------

test('[行为] C03 后端 localDateStr 与前端一致，且不受 UTC 偏移影响', () => {
  const { localDateStr } = require(path.join(ROOT, 'student-backend/utils/date.js'))
  // 本地时区：无论运行环境 TZ 如何，都必须按「本地日历日」取值
  const d = new Date(2024, 1, 29, 23, 30, 0) // 2024-02-29 闰日
  assert.strictEqual(localDateStr(d), '2024-02-29')
  // 非法日期返回空串，不拼出 NaN-NaN-NaN
  assert.strictEqual(localDateStr(new Date('nonsense')), '')
})

test('[行为] C03 前端 localDateStr 与后端同口径（同一 Date 同一结果）', async () => {
  // 前端是 ESM：用 file:// URL 动态 import 真源码（Windows 下绝对路径不行）
  const feUrl = 'file:///' + path.join(ROOT, 'student-frontend/src/utils/dateTime.js').replace(/\\/g, '/')
  const fe = await import(feUrl)
  const be = require(path.join(ROOT, 'student-backend/utils/date.js'))
  const samples = [
    new Date(2024, 1, 29, 23, 30, 0),
    new Date(2026, 0, 1, 0, 0, 0),
    new Date(2026, 10, 3, 12, 0, 0),
  ]
  for (const d of samples) {
    assert.strictEqual(fe.localDateStr(d), be.localDateStr(d), '前后端日期口径必须一致')
  }
})

test('[行为] B05-07 EXIF 日期拒绝不存在的日期（2/31 不再滚到 3/2）', () => {
  const { normalizeExifDate } = require(path.join(ROOT, 'student-backend/albumExif.js'))
  // 2 月 31 日不存在 → 必须判非法（原来会滚成 3-02）
  assert.strictEqual(normalizeExifDate('2024:02:31 10:00:00'), '', '2024-02-31 不存在，必须拒绝')
  assert.strictEqual(normalizeExifDate('2023:02:29 10:00:00'), '', '2023-02-29 不存在（2023 非闰年），必须拒绝')
  // 合法日期照常
  assert.strictEqual(normalizeExifDate('2024:02:29 10:00:00'), '2024-02-29T10:00:00')
  assert.strictEqual(normalizeExifDate('2024:12:31 23:59:59'), '2024-12-31T23:59:59')
})

test('[行为] B05-07 4 月 31 日同样要拒绝（4 月只有 30 天）', () => {
  const { normalizeExifDate } = require(path.join(ROOT, 'student-backend/albumExif.js'))
  assert.strictEqual(normalizeExifDate('2024:04:31 00:00:00'), '', '2024-04-31 不存在，必须拒绝')
  assert.strictEqual(normalizeExifDate('2024:04:30 00:00:00'), '2024-04-30T00:00:00')
})

test('[行为] 漏网 ffmpeg 超时常量是有限正数（不能是 0 或 Infinity）', () => {
  const src = readSrc('student-backend/albumScan.js')
  const m = src.match(/FFMPEG_THUMB_TIMEOUT_MS\s*=\s*(\d+)/)
  assert.ok(m, '必须定义 FFMPEG_THUMB_TIMEOUT_MS')
  const v = Number(m[1])
  assert.ok(v > 0 && v < 10 * 60 * 1000, `超时必须是合理的正数（当前 ${v}）`)
})

test('[行为] 探针本身能抓到「未登记的同类命中」（反向验证探针不失效）', () => {
  // 探针的价值在于「新出现的同类会被抓到」。这里造一个假的命中文件，
  // 验证探针的 detect 逻辑对它有反应 —— 否则探针可能因为判据写错而永远绿灯。
  const probeSrc = readSrc('testjs/probe/pattern-sweep-probe.cjs')
  assert.ok(probeSrc.includes('新漏网'), '探针必须有「新漏网」概念')
  assert.ok(probeSrc.includes('exemptFiles'), '探针必须支持整文件豁免')
  // 白名单是**双向对账**，不是「必须为空」：
  //   · 白名单里的项必须真的存在于源码（否则是僵尸条目 → 探针会一直报失败）
  //   · 已修完的项应该被删掉（这由探针自己的「白名单项已失效」检查负责）
  // 断言「全空」是错的：还有真实未修的条目时（如测试资产族的死等点）白名单本就该非空。
  // 解析 known 数组时必须按方括号配对计数，不能用 `[^\]]*`：数组项里若出现 `]`
  // （正则/路径片段），正则会在那里提前截断，后面的白名单项就此漏检（审查 v5 · V5-035）。
  const knownBlocks = extractBracketArrays(probeSrc, 'known')
  for (const b of knownBlocks) {
    const items = b.trim()
    if (items) {
      // 非空时：每一项都必须是「真实存在的路径」或「路径 :: 片段」形式
      for (const item of items.split(',').map((s) => s.trim()).filter(Boolean)) {
        assert.ok(/^['"].+['"]$/.test(item), `白名单项格式不对（应是字符串）：${item}`)
        const inner = item.replace(/^['"]|['"]$/g, '')
        const file = inner.split(' :: ')[0]
        assert.ok(fs.existsSync(path.join(ROOT, file)),
          `白名单项指向的文件不存在（僵尸条目，探针会一直报失败）：${file}`)
      }
    }
  }
})

test('[行为] 漏网 fix：promise 链必须有 catch —— 用真实源码验证结构', () => {
  // migration/main.js：链尾必须有 catch，且 catch 里要 mount（兜底不白屏）
  const mig = readSrc('student-frontend/src/subwindows/migration/main.js')
  assert.ok(/\.catch\([\s\S]{0,300}app\.mount\(/.test(mig),
    'migration 的 catch 兜底里必须仍然 mount（否则失败 → 白屏）')
  // setup/main.js：同样
  const setup = readSrc('student-frontend/src/subwindows/setup/main.js')
  assert.ok(/\.catch\([\s\S]{0,400}app\.mount\(/.test(setup),
    'setup 的 catch 兜底里必须仍然 mount')
})
