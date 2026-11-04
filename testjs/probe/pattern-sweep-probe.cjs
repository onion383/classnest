// =========================================================================
// pattern-sweep-probe.cjs —— 「同一模式的所有出现点」全仓扫描探针
//
// 为什么需要它（v4 审查 P2 的效率教训）：
//   台账是**按条目编号**组织的（V4-B03-06、V4-B11-05…），逐条读代码改，
//   成本高、而且必然漏网 —— 同一个模式在第 7 个文件里出现时，没人会记得。
//   本探针把台账条目**反过来**按「代码模式」组织：
//   一个模式 → 全仓所有出现点 → 一次改完一类。
//
// 它做什么：
//   对每个模式做全仓文本扫描，输出所有命中点，并与「已知未修白名单」对账：
//     · 命中点不在白名单 → **报失败**（= 新出现的漏网，必须解释或修）
//     · 白名单里的点已不存在 → **报失败**（= 白名单该清理了，说明已修）
//   这样探针既当下可用（白名单兜底），修完后自动变成纯回归资产（白名单空）。
//
// 判据说明：
//   ⚠️ 本探针是**静态形态**检查，只看文本形态，不跑运行时。
//   「文本形态命中」不等于「真有问题」—— 每个模式的豁免清单里都写了理由。
//   反之「文本形态没命中」也不等于「真没问题」—— 动态问题（如 :key 全量重挂载
//   造成的性能退化）只能靠单测/探针守，静态扫描抓不到。
//
// 退出码：0 = 全部对账通过；1 = 有失败。
// 用法：
//   node testjs/probe/pattern-sweep-probe.cjs            # 对账（有失败则退出码 1）
//   node testjs/probe/pattern-sweep-probe.cjs --report   # 只出报告，不判成败
//   node testjs/probe/pattern-sweep-probe.cjs --mode=date  # 只看某个模式
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const FE = path.join(ROOT, 'student-frontend', 'src')
const BE = path.join(ROOT, 'student-backend')

const args = process.argv.slice(2)
const REPORT_ONLY = args.includes('--report')
const ONLY_MODE = (args.find((a) => a.startsWith('--mode=')) || '').split('=')[1]

// ---------------------------------------------------------------------------
// 目录白名单：node_modules / .trash / 产物 / 快照等一律不扫
// ---------------------------------------------------------------------------
const SKIP_DIR = new Set([
  'node_modules', '.trash', 'dist', 'build', '.git', '.vite', 'coverage',
  '__snapshots__', 'tmp', '.workbuddy',
])
const SKIP_FILE_RE = /\.(min\.|map$)|\.db$|\.png$|\.jpg$|\.webp$|\.woff2?$|\.ttf$|\.gz$/

function walk(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return out }
  for (const ent of ents) {
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(ent.name)) continue
      walk(path.join(dir, ent.name), out)
    } else if (/\.(js|mjs|cjs|vue|ts)$/.test(ent.name) && !SKIP_FILE_RE.test(ent.name)) {
      out.push(path.join(dir, ent.name))
    }
  }
  return out
}

const FILES = [
  ...walk(FE).map((p) => ({ abs: p, rel: path.relative(ROOT, p).replace(/\\/g, '/') })),
  ...walk(BE).map((p) => ({ abs: p, rel: path.relative(ROOT, p).replace(/\\/g, '/') })),
  // 测试目录也要扫：测试资产自身的问题（临时目录泄漏、固定死等、进程不退出…）
  // 是「审查 v4」里占比最大的一族，只扫业务代码等于漏掉一半。
  ...walk(path.join(ROOT, 'testjs')).map((p) => ({ abs: p, rel: path.relative(ROOT, p).replace(/\\/g, '/') })),
]

// 逐文件读入并按行拆开
const FILE_LINES = FILES.map((f) => {
  let text = ''
  try { text = fs.readFileSync(f.abs, 'utf8') } catch (_) { /* 读不了就当空 */ }
  return { ...f, lines: text.split(/\r?\n/) }
})

/** 判断某行是否只是注释（含块注释中间行）——注释里的函数名会骗过正则 */
function isCommentLine(line, inBlock) {
  const t = line.trim()
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return true
  return inBlock
}

/**
 * 逐行扫描。fn 返回 true 表示命中。
 * 支持块注释跨越：进入块注释时置 inBlock，出块注释时清。
 *
 * scope 过滤（关键）：模式分「只扫业务代码」与「只扫测试代码」两类。
 *   · 业务模式扫 testjs/ 会全是误报 —— 测试代码里出现「模板串拼 getFullYear」
 *     多半是**判据本身**（探针的正则字面量、变异脚本的变异体）；
 *   · 测试模式只扫 testjs/ —— 业务代码里没有「临时目录泄漏」这回事。
 */
// 探针自身要豁免：判据的字面量里就写着 `mkdtemp`、`server.close()` 等模式，
// 自己扫自己 = 每次都报一堆假命中。
// 变异脚本与表驱动单测同理 —— 它们的**判据/变异体**里全是这些模式。
const SELF_EXEMPT = [
  'testjs/probe/pattern-sweep-probe.cjs',
  'testjs/tools/mutate-sweep.cjs',
  'testjs/units/sweep-fixes.test.js',
]

function scanLines(fn, scope) {
  const hits = []
  for (const f of FILE_LINES) {
    if (SELF_EXEMPT.includes(f.rel)) continue
    const isTest = f.rel.startsWith('testjs/')
    if (scope === 'biz' && isTest) continue
    if (scope === 'test' && !isTest) continue
    let inBlock = false
    for (let i = 0; i < f.lines.length; i++) {
      const line = f.lines[i]
      const before = inBlock
      // 更新块注释状态
      const openCount = (line.match(/\/\*/g) || []).length
      const closeCount = (line.match(/\*\//g) || []).length
      if (openCount > closeCount) inBlock = true
      else if (closeCount > openCount) inBlock = false
      if (before) continue // 块注释内部行直接跳过
      if (isCommentLine(line, false)) continue
      if (fn(line, f, i)) hits.push({ rel: f.rel, line: i + 1, text: line.trim() })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// 模式定义
//   key      模式标识（用于 --mode= 与白名单）
//   desc     一句话说明这类问题是什么
//   detect   (line, file) => boolean
//   known    已知未修点：`文件相对路径 :: 命中片段（必须是命中行里真实出现的子串）`
//   exempt   整文件豁免（该文件命中即视为合理，不需修）
//
// ⚠️ 豁免有两种粒度：
//   · exemptFiles —— 整个文件豁免（该文件里的命中都是合理的）
//   · exempt      —— 单点豁免：`路径 :: 命中行里真实出现的子串`
//   两者都用**真实代码子串**匹配，不用中文说明当片段（第一版踩过：中文说明
//   永远匹配不上 → 豁免形同虚设 → 噪声爆炸）。
// ---------------------------------------------------------------------------

// 公共：把日期拼成 YYYY-MM-DD 的模板串（内联 pad / padStart 两种写法）
const DATE_BUILD_RE = /\$\{[^}]*getFullYear\(\)[^}]*\}\s*-\s*\$\{[^}]*pad(Start)?\(/

const PATTERNS = [
  {
    key: 'date',
    desc: '内联拼 YYYY-MM-DD（应走 utils/date.js 的 localDateStr / utils/dateTime.js 的 localDateStr）',
    detect: (line) => DATE_BUILD_RE.test(line),
    known: [
    ],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'revoke',
    desc: 'URL.revokeObjectURL 同步立即调用（下载 Blob 后立刻撤销 → 可能 0 字节）',
    detect: (line, file) => {
      if (!/URL\.revokeObjectURL\(/.test(line)) return false
      if (/setTimeout|setInterval|requestAnimationFrame/.test(line)) return false
      // 只在「有下载/导出语义」的文件里查：缩略图批量回收、背景图替换不是下载场景
      const hasDownload = file.lines.some((l) => /\bdownload\b|saveBlob|a\.click\(\)|createElement\('a'\)/.test(l))
      return hasDownload
    },
    known: [
    ],
    exemptFiles: [],
    exempt: [
      'student-frontend/src/views/SettingsView/SettingsView.data.js :: URL.revokeObjectURL(url)',
    ],
  },
  {
    key: 'await-nocatch',
    desc: 'await 一个已知会 reject 的 I/O 调用且结果被丢弃（失败时用户无反馈）',
    detect: (line, file, idx) => {
      if (!/await\s+(readFile|readAsDataURL)\s*\(/.test(line)) return false
      // 结果被丢弃：整行只有这一个 await 调用（不是 const x = await ...）
      if (/=\s*await/.test(line)) return false
      // 关键：看外层有没有 try/catch。
      // 写成 `emit('attach', await readFile(file))` 时，await 嵌在参数里，
      // 只看本行看不出它被 try 包着 —— 必须往上回溯到最近的 try。
      const indent = line.match(/^\s*/)[0].length
      for (let k = idx - 1; k >= 0 && k >= idx - 12; k--) {
        const l = file.lines[k]
        const ind = l.match(/^\s*/)[0].length
        if (ind >= indent) continue
        // 遇到同缩进或更浅的 try → 被包住了
        if (/^\s*try\s*\{/.test(l) && ind < indent) return false
        // 遇到同缩进或更浅的函数边界 → 出了 try 作用域
        if (/^\s*\}/.test(l) && ind < indent) break
      }
      return true
    },
    known: [
    ],
    exemptFiles: [],
    exempt: [
      'student-frontend/src/components/ai/AiComposer/AiComposer.vue :: await readAsDataURL(file)',
    ],
  },
  {
    key: 'then-nocatch',
    desc: 'promise 链的**结果被丢弃**且链上无 catch（真 unhandled rejection）',
    detect: (line, file, idx) => {
      if (!/\.then\(/.test(line)) return false
      if (/\.catch\(/.test(line)) return false
      // 关键区分：promise 的结果有没有被消费。
      //   · 被 return / await / 赋值给变量 → 失败会传播给调用方，**不是** unhandled rejection
      //   · 结果直接丢弃（链式调用没有接收者）→ 失败无人接 → 真 unhandled rejection
      //
      // 链的「起始行」可能不在命中行本身：
      //   inflight = axios.get(url)
      //     .then(...)        ← 命中的是这行，赋值在上一行
      // 所以要连着往上回溯最多 2 行一起看。
      const window = []
      for (let k = Math.max(0, idx - 2); k <= idx; k++) window.push(file.lines[k])
      const consumed = window.some((l) =>
        /^\s*(return|await|const|let|var)\b/.test(l)
        || /=\s*[\w.]+\.(get|post|put|delete|request)\(/.test(l)
        || /=\s*[\w.]+\.then\(/.test(l)
        || /\breturn\s+[\w.]+\.then\(/.test(l))
      if (consumed) return false
      // 文件里一处 catch 都没有 → 链上任何一段失败都是 unhandled rejection
      return !file.lines.some((l) => /\.catch\(/.test(l))
    },
    known: [
    ],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'map-nobound',
    desc: '挂在组件状态上的 new Map() 且同文件看不到 delete/clear（无界增长）',
    detect: (line, file, idx) => {
      if (!/=\s*ref\(new (Map|Set)\(\)\)/.test(line)) return false
      // 同文件里除本行外看不到 delete/clear → 无界增长
      const hasCleanup = file.lines.some((l, i) => i !== idx && /\.delete\(|\.clear\(\)/.test(l))
      return !hasCleanup
    },
    known: [
    ],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'key-dynamic',
    desc: ':key 里含动态表达式（每次变化会让整行 DOM 重挂载）',
    detect: (line) => /:key\s*=/.test(line) && /[a-zA-Z_$][\w$]*\s*\+|\+\s*['"`]/.test(line),
    known: [
    ],
    exemptFiles: [],
    exempt: [
      'student-frontend/src/components/dialogs/SmartGroupDialog/SmartGroupDialog.vue :: :key="gi + \'-\' + i"',
      'student-frontend/src/subwindows/desktop-widget/DesktopWidget.vue :: :key="\'c\'+gi+\'-\'+idx"',
    ],
  },
  {
    key: 'no-timeout',
    desc: 'spawn / exec 起子进程但同文件没有 timeout / kill / unref（子进程 hang → 整体挂起）',
    detect: (line, file) => {
      if (!/spawn\(|execFile\(|fork\(/.test(line)) return false
      return !file.lines.some((l) => /timeout|unref|\.kill\(/.test(l))
    },
    known: [],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'tmp-leak',
    scope: 'test',
    desc: '测试里建临时目录的次数多于清理次数（部分用例的 tempDir 泄漏到仓库外）',
    detect: (line, file, idx) => {
      // 只在「创建临时目录」的那一行报（避免同一文件报 N 次）
      if (!/mkdtemp|mkdtempSync/.test(line)) return false
      // 只在该文件**第一处**创建点报（避免同文件重复命中）
      const firstCreate = file.lines.findIndex((l) => /mkdtemp|mkdtempSync/.test(l))
      if (firstCreate !== idx) return false
      // 文件级计数：创建点数 vs 清理点数
      const creates = file.lines.filter((l) => /mkdtemp|mkdtempSync/.test(l)).length
      const cleans = file.lines.filter((l) =>
        /rmSync|rmdirSync|fs\.rm\(|fsp\.rm\(|unlinkSync|fsp\.unlink|removeSync/.test(l)).length
      // 清理次数 ≥ 创建次数 → 没有泄漏
      return cleans < creates
    },
    known: [],
    exemptFiles: [],
    exempt: [],
  },

  // ===== 批 19 新增模式（覆盖剩余族）=====

  {
    key: 'write-retry-default',
    desc: '写请求重发守卫的默认值放行（子窗口未传守卫 → 写请求也自动重发 → 重复落库）',
    detect: (line) => /writeRetryGuard\s*=\s*\(\s*\)\s*=>\s*true/.test(line),
    known: [],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'token-in-url',
    desc: '把登录凭据拼进 URL 查询串（明文模式下 JWT 出现在图片 URL / 日志 / referrer 里）',
    detect: (line) => {
      // URL 里出现 token= 查询参数（分隔符可能是变量 sep，不能只匹配字面 ?/&）
      if (!/token=/.test(line)) return false
      // 必须是「拼进 URL」的形态：模板串里有 token 参数，或字符串字面里带 token=
      return /`[^`]*token=/.test(line) || /['"][^'"]*[?&]token=/.test(line)
    },
    known: [],
    exemptFiles: [],
    exempt: [
      // 安全模式下必须带**受限媒体凭据**（mediaToken，只能读静态资源，不能调业务 API），
      // 这是唯一允许把凭据放进 URL 的地方 —— 因为 <img>/CSS url() 无法带 Authorization 头。
      // ⚠️ 登录 JWT **不允许**进 URL：查询参数会进浏览器历史 / 访问日志 / Referer。
      //   明文模式改走 httpOnly Cookie（后端 middleware/auth.js 的 plainToken 认 Cookie）。
      'student-frontend/src/utils/apiUrl.js :: token=${encodeURIComponent(token)}',
    ],
  },
  {
    key: 'static-asset-nohash',
    desc: '静态资源用裸路径（无 content hash）→ 内容变了文件名不变 → 缓存住旧版本',
    detect: (line, file) => {
      // 只对「JS 里 import 的资源路径」报警。
      // 模板里的 /logo.webp 这类 **public 目录**资源是 Vite 原样拷贝的（public/ 不加工 hash），
      // 那是既有约定不是漏网 —— 真要版本化得改 public 资源的管理方式，不属本模式。
      if (file.rel.endsWith('.vue')) return false
      if (!/=\s*['"]\/[^'"]*\.(ttf|otf|woff2?|ttf\.gz|wasm)['"]/.test(line)) return false
      return true
    },
    known: [],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'fixed-wait',
    scope: 'test',
    desc: '测试里固定死等 N 秒等页面就绪（无轮询早退出 → 慢时白等、快时 flaky）',
    detect: (line, file, idx) => {
      if (!file.rel.startsWith('testjs/')) return false
      // 固定死等：await 一个 setTimeout(r, 常数)
      if (!/await\s+new Promise\(\s*\(\s*r\s*\)\s*=>\s*setTimeout\(\s*r\s*,\s*\d{3,}\s*\)/.test(line)) return false
      // 排除「在循环/重试里的等待」：往上回溯，若本行处于 for/while 或 catch 重试块内，
      // 它是「轮询重试」而不是「死等页面就绪」（否则误报一堆）。
      // ⚠️ 循环体与循环头**可能同缩进**（`for (;;) {` 里的语句常与 for 齐平），
      //   所以不能只看「缩进更浅」，还要看「往上最近的一个 for/while/catch 是不是它」。
      const indent = line.match(/^\s*/)[0].length
      for (let k = idx - 1; k >= 0 && k >= idx - 12; k--) {
        const l = file.lines[k]
        const trimmed = l.trim()
        if (/^(for|while)\s*\(/.test(trimmed) || /^catch\b/.test(trimmed)) {
          // 循环/重试头：若它与本行同缩进或更深，说明本行在它的体内 → 是轮询间隔
          const ind = l.match(/^\s*/)[0].length
          if (ind <= indent) return false
        }
        // 出了函数体（缩进更浅且是函数结束）
        if (/^\s*\}\s*\$/.test(l) && l.match(/^\s*/)[0].length < indent) break
      }
      // 同文件里有轮询（for + 条件 + sleep/间隔）→ 已是早退写法
      const hasPoll = file.lines.some((l) => /for\s*\(.*;.*;.*\)/.test(l) && /await/.test(l))
      return !hasPoll
    },
    known: [
      'testjs/probe/gdi-shot-bench.cjs',
    ],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'server-close-nowait',
    scope: 'test',
    desc: 'server.close() 不 await 也不 process.exit（Node 事件循环被挂住 → 脚本不退出）',
    detect: (line, file) => {
      if (!file.rel.startsWith('testjs/')) return false
      if (!/^\s*server\.close\(\)\s*;?\s*$/.test(line)) return false
      // 同文件里有 await server.close() 或 closeAllConnections/process.exit → 已处理
      return !file.lines.some((l) => /await\s+server\.close\(\)|closeAllConnections\(\)|process\.exit\(/.test(l))
    },
    known: [],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'child-kill-notree',
    scope: 'test',
    desc: '只 child.kill() 不杀子进程树（Windows 上 dev server 的孙进程会残留 → 端口占用 / 进程泄漏）',
    detect: (line, file) => {
      if (!file.rel.startsWith('testjs/')) return false
      if (!/\w+\.kill\(\)/.test(line)) return false
      // 同文件里有 taskkill /T、killProcessTree 或用了 killTree 工具 → 已处理
      return !file.lines.some((l) => /taskkill.*\/T|killProcessTree|treeKill|killTree\(/.test(l))
    },
    known: [],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'swallow-uncaught',
    scope: 'test',
    desc: 'uncaughtException 处理器只记日志不退出（脚本带着未捕获异常继续跑 → 结果不可信）',
    detect: (line) => /on\(\s*['"]uncaughtException['"]/.test(line),
    known: ['testjs/probe/toplevel-bottom-probe.cjs :: uncaughtException'],
    exemptFiles: [],
    exempt: [],
  },
  {
    key: 'comment-path-drift',
    scope: 'test',
    desc: '头部注释里写的跑法路径与文件实际位置不符（照着注释跑会「文件不存在」）',
    detect: (line, file) => {
      // 只看头部 20 行（路径说明都在头部）
      const lineNo = file.lines.indexOf(line)
      if (lineNo >= 20) return false
      // 抓「node testjs/xxx」形态的路径
      const m = line.match(/node\s+(testjs\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js))/)
      if (!m) return false
      // 该路径对应的文件必须真的存在
      const target = path.join(ROOT, m[1].replace(/\//g, path.sep))
      return !fs.existsSync(target)
    },
    known: [],
    exemptFiles: [],
    exempt: [],
  },
]

// ---------------------------------------------------------------------------
// 对账（可复用）：CLI 与 testjs/behavior/ 的行为测试共用同一份判据
// ---------------------------------------------------------------------------

/**
 * 跑一遍对账，返回结构化结果。
 * @param {object} [opts]
 * @param {string} [opts.only] 只跑某个模式
 * @param {boolean} [opts.silent] 不打印（供测试用）
 * @returns {{failures:number, totalHits:number, perPattern:Array}}
 */
function runSweep(opts = {}) {
  const only = opts.only || ''
  const silent = !!opts.silent
  let failures = 0
  let totalHits = 0
  const perPattern = []

  if (!silent) console.log('== 模式扫描对账（全仓 ' + FILES.length + ' 个源文件）==\n')

  for (const p of PATTERNS) {
    if (only && p.key !== only) continue
    if (!silent) console.log('--- [' + p.key + '] ' + p.desc)

    const hits = scanLines(p.detect, p.scope || 'biz')
    totalHits += hits.length

    // 命中 → 归类：整文件豁免 / 单点豁免 / 已知未修 / 新漏网
    const newHits = []
    const knownHits = []
    const exemptCount = { files: 0, points: 0 }
    for (const h of hits) {
      if ((p.exemptFiles || []).includes(h.rel)) { exemptCount.points++; continue }
      const byExempt = (p.exempt || []).some((e) => {
        const [f, frag] = e.split(' :: ')
        return h.rel === f && (!frag || h.text.includes(frag))
      })
    const byKnown = p.known.some((k) => {
      const [f, frag] = k.split(' :: ')
      if (h.rel !== f) return false
      // 无片段 = 整文件登记（该文件里这一模式的命中全部视为已知）
      if (!frag) return true
      return h.text.includes(frag)
    })
      if (byExempt) { exemptCount.points++; continue }
      if (byKnown) knownHits.push(h)
      else newHits.push(h)
    }

    if (!silent) {
      console.log('  命中 ' + hits.length + ' 处：已知未修 ' + knownHits.length
        + ' / 豁免 ' + exemptCount.points + ' / 新漏网 ' + newHits.length)
    }

    if (newHits.length) {
      // 按文件聚合输出：同一文件多处命中只列一次行号，省得刷屏
      const byFile = new Map()
      for (const h of newHits) {
        if (!byFile.has(h.rel)) byFile.set(h.rel, [])
        byFile.get(h.rel).push(h.line)
      }
      if (!silent) {
        let shown = 0
        for (const [rel, lines] of byFile) {
          if (shown >= 25) { console.log('      … 另有 ' + (byFile.size - shown) + ' 个文件'); break }
          shown++
          console.log('      · ' + rel + '  行 ' + lines.join(', '))
        }
      }
      failures++
      if (!silent) {
        console.error('  ✗ [' + p.key + '] 有 ' + newHits.length + ' 处未登记命中（'
          + byFile.size + ' 个文件）—— 需解释或修复')
      }
    }

    // 白名单里的点如果已经不存在（已修）→ 提示清理白名单
    const staleKnown = []
    for (const k of p.known) {
      const f = k.split(' :: ')[0]
      const frag = k.split(' :: ')[1] || ''
      const stillThere = knownHits.some((h) => h.rel === f && (!frag || h.text.includes(frag)))
      if (!stillThere) {
        staleKnown.push(k)
        failures++
        if (!silent) {
          console.log('      ○ 白名单项已失效（应已修，请从 known 里删掉）：' + k)
          console.error('  ✗ [' + p.key + '] 白名单项已失效：' + k)
        }
      }
    }
    if (!newHits.length && !silent) console.log('  ✓ [' + p.key + '] 无未登记命中')
    if (!silent) console.log('')
    perPattern.push({ key: p.key, desc: p.desc, hits: hits.length, newHits, staleKnown })
  }

  if (!silent) {
    console.log('== 合计命中 ' + totalHits + ' 处 ==')
    if (failures) {
      console.error('\n失败 ' + failures + ' 项')
    } else {
      console.log('\n全部通过')
    }
  }

  return { failures, totalHits, perPattern }
}

module.exports = { runSweep, PATTERNS }

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------
if (require.main === module) {
  const r = runSweep({ only: ONLY_MODE })
  process.exit(r.failures ? 1 : 0)
}
