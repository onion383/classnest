// =========================================================================
// slug-scope-probe.cjs —— 「跨库状态用裸 id / 全局攒批」静态回归探针
//
// 背景（v4 审查 P2 · C05-01 / B05-08，以及复核时发现的同类）：
//   album_photos.id 各库独立自增，但进程内状态有两处没带库标识：
//     · routes/album.js   pendingInChild 用裸 photoId 做键；
//     · worker.scan.js    thumbReport 是一份全局数组，flush 时用「调用那一刻的 slug」
//                         上报整批 → A 库的条目被挂到 B 库名下（串图）。
//   两者同一个病根：**IPC 协议每条消息本来就带 slug，是转发/攒批时把它丢了**
//   （scanWorker.js:143 把 thumbs 报文转给监听者时只传 ids）。
//   修法不是逐条补 if，而是 utils/slugScopes.js 一个底座 + 三个接线点。
//
// 这个探针钉住「接线」：底座本身的行为契约由 units/slug-scopes.test.js 守。
//
// 反向验证：`node testjs/probe/slug-scope-probe.cjs --self-test`
//   把新写法逐条改回旧写法，要求对应判据**必须报警**。判据太松 = 假绿。
//
// 跑法：node testjs/probe/slug-scope-probe.cjs
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const BE = path.join(ROOT, 'student-backend')

const FILES = {
  'scanWorker.js': 'scanWorker.js',
  'worker.scan.js': 'worker.scan.js',
  'routes/album.js': 'routes/album.js',
  'routes/auth.js': 'routes/auth.js',
  'albumThumbs.js': 'albumThumbs.js',
  'utils/slugScopes.js': 'utils/slugScopes.js',
}

let failures = 0
// 失败/成功分开传文案：只传一个 msg 时，失败行看着像「通过」的描述
function assert(cond, failMsg, okMsg) {
  if (!cond) { failures++; console.error('  ✗ ' + failMsg) }
  else console.log('  ✓ ' + (okMsg || failMsg))
}

function loadSources(mut) {
  const src = {}
  for (const [key, rel] of Object.entries(FILES)) {
    let text = fs.readFileSync(path.join(BE, rel), 'utf8')
    if (mut && mut.file === key) {
      if (!text.includes(mut.from)) throw new Error('变异锚点失效，探针需要同步更新：' + mut.name)
      text = text.replace(mut.from, mut.to)
    }
    src[key] = text
  }
  return src
}

const count = (text, re) => (text.match(re) || []).length

// ---------------------------------------------------------------------------
// 判据（正向与反向共用同一份）
// ---------------------------------------------------------------------------
const CHECKS = [
  {
    id: 'C1',
    name: 'thumbs 回报转发必须把 msg.slug 一起传下去（根因就在这一行）',
    pass: (s) => /thumbGeneratedListener\(\s*msg\.slug\s*,\s*msg\.entries\.map/.test(s['scanWorker.js']),
  },
  {
    id: 'C2',
    name: 'pendingInChild 必须由 createSlugBuckets 创建，不许退回裸 Map',
    pass: (s) => /const pendingInChild = slugScopes\.createSlugBuckets\(\(\) => new Map\(\)\)/.test(s['routes/album.js'])
      && !/const pendingInChild = new Map\(\)/.test(s['routes/album.js']),
  },
  {
    id: 'C3',
    name: '回报处理函数按 slug 取桶（只删该库，不误删同号它库）',
    pass: (s) => /function onChildThumbsGenerated\(slug, ids\)/.test(s['routes/album.js'])
      && /pendingInChild\.peek\(slug\)/.test(s['routes/album.js']),
  },
  {
    id: 'C4',
    name: '转交补图需求时按 slug 入桶',
    pass: (s) => /const bucket = pendingInChild\.forSlug\(slug\)/.test(s['routes/album.js'])
      && /bucket\.set\(id, nowTs\)/.test(s['routes/album.js']),
  },
  {
    id: 'C5',
    name: '预览额度与 pending 解耦（pending 只记账，不再从额度里减）',
    // 2026-11-13 改：pendingInChild 曾参与配额减法，导致「子进程没干完的活把浏览者挡在门外」
    // （滚几屏攒够额度，所有缩略图请求恒 404）。现在它只做去重记账。
    pass: (s) => /const PREVIEW_LIMIT = \d+/.test(s['routes/album.js'])
      && !/pendingInChild\.totalSize\(\)/.test(s['routes/album.js']),
  },
  {
    id: 'C6',
    name: 'thumbReport 必须由 createSlugBatch 创建，不许退回全局数组',
    pass: (s) => /const thumbReport = slugScopes\.createSlugBatch\(\{/.test(s['worker.scan.js'])
      && !/let thumbReport = \[\]/.test(s['worker.scan.js']),
  },
  {
    id: 'C7',
    name: 'flushThumbs(slug) 只发自己库的桶（不整批挂到调用时的 slug）',
    pass: (s) => /function flushThumbs\(slug\) \{\s*thumbReport\.flush\(slug\);\s*\}/.test(s['worker.scan.js'])
      && !/send\(\{ type: 'thumbs', slug, entries: thumbReport \}\)/.test(s['worker.scan.js']),
  },
  {
    id: 'C8',
    name: '异常 / lock / shutdown 三处都要 flushAll（残留不许等下一次别的库 flush）',
    pass: (s) => count(s['worker.scan.js'], /thumbReport\.flushAll\(\)/g) >= 3
      && /slugScopes\.clearAllForSlug\(msg\.slug\)/.test(s['worker.scan.js']),
  },
  {
    id: 'C9',
    name: '登出统一清桶 + 清缩略图内存索引（清理由状态自己登记，登出不点名）',
    pass: (s) => /slugScopes\.clearAllForSlug\(slug\)/.test(s['routes/auth.js'])
      && /albumThumbs\.forgetAlbum\(slug\)/.test(s['routes/auth.js']),
  },
  {
    id: 'C10',
    name: '底座 safeSlug 与 albumThumbs.safeSlug 同口径（不漂移）',
    pass: (s) => {
      const grab = (t) => {
        const m = t.match(/return\s+(\/[^/\n]+\/)\.test\(s\)/)
        return m ? m[1] : ''
      }
      const a = grab(s['utils/slugScopes.js'])
      const b = grab(s['albumThumbs.js'])
      return !!a && a === b
    },
  },
  {
    id: 'C11',
    name: '同类裸 id 状态清单：已收口的必须走底座，待办项必须仍可见（防悄悄漏掉）',
    pass: (s) => {
      // 逐条判定过的模块级状态。新增同类状态若不在此表 → 报警要求显式判定。
      const KNOWN = {
        // 已收口：pendingInChild 由底座创建（C2）；其余 4 个是函数内局部 Map，
        // 按请求内构造、请求结束即回收，不构成跨库状态。
        'routes/album.js': ['pendingInChild', 'names', 'byDate', 'touched', 'byId'],
        // openConns/keyCache 已按 slug 分桶；demandQueue 条目带 slug；
        // running/pendingStops 仍是裸 albumId → P1-4，需真机扫描验证，留到下一批。
        'worker.scan.js': ['openConns', 'keyCache', 'running', 'pendingStops', 'demandQueue'],
        'scanWorker.js': ['dispatched', 'active'],                  // P1-4，待真机扫描验证
        'albumThumbs.js': ['dirCache', 'indexBySlug', 'bufCache'],  // 已按 slug 分桶 / 路径键
      }
      for (const [file, names] of Object.entries(KNOWN)) {
        for (const name of names) {
          if (!new RegExp('(?:const|let)\\s+' + name + '\\s*=').test(s[file] || '')) return false
        }
      }
      // 扫描「看起来像跨库状态」的新名字：不在清单里就要人工判定
      const declRe = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:Map|Set)\s*\(/g
      for (const file of Object.keys(KNOWN)) {
        const text = s[file] || ''
        let m
        while ((m = declRe.exec(text))) {
          if (!KNOWN[file].includes(m[1])) return false
        }
      }
      return true
    },
  },
]

// ---------------------------------------------------------------------------
// 反向验证：把新写法改回旧写法，对应判据必须报警
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    name: '转发 thumbs 时丢掉 slug', expect: 'C1', file: 'scanWorker.js',
    from: 'thumbGeneratedListener(msg.slug, msg.entries.map(e => e[0]))',
    to: 'thumbGeneratedListener(msg.entries.map(e => e[0]))',
  },
  {
    name: 'pendingInChild 退回裸 Map', expect: 'C2', file: 'routes/album.js',
    from: 'const pendingInChild = slugScopes.createSlugBuckets(() => new Map());',
    to: 'const pendingInChild = new Map();',
  },
  {
    name: '回报不按库删', expect: 'C3', file: 'routes/album.js',
    from: 'function onChildThumbsGenerated(slug, ids) {',
    to: 'function onChildThumbsGenerated(ids) {',
  },
  {
    name: '转交时不入桶', expect: 'C4', file: 'routes/album.js',
    from: 'const bucket = pendingInChild.forSlug(slug);',
    to: 'const bucket = pendingInChild;',
  },
  {
    name: '配额改回单桶 size', expect: 'C5', file: 'routes/album.js',
    from: 'pendingInChild.totalSize() + n',
    to: 'pendingInChild.size + n',
  },
  {
    name: 'thumbReport 退回全局数组', expect: 'C6', file: 'worker.scan.js',
    from: 'const thumbReport = slugScopes.createSlugBatch({',
    to: 'let thumbReport = []; const _dead = ({',
  },
  {
    name: 'flush 又用调用时的 slug 整批上报', expect: 'C7', file: 'worker.scan.js',
    from: 'function flushThumbs(slug) {\n  thumbReport.flush(slug);\n}',
    to: "function flushThumbs(slug) {\n  if (!thumbReport.length) return;\n  send({ type: 'thumbs', slug, entries: thumbReport });\n  thumbReport = [];\n}",
  },
  {
    name: 'shutdown 前不 flushAll', expect: 'C8', file: 'worker.scan.js',
    from: '      thumbReport.flushAll();\n      process.exit(0);',
    to: '      process.exit(0);',
  },
  {
    name: '登出不清分桶状态', expect: 'C9', file: 'routes/auth.js',
    from: '  slugScopes.clearAllForSlug(slug);\n',
    to: '',
  },
  {
    name: '底座 safeSlug 口径漂移', expect: 'C10', file: 'utils/slugScopes.js',
    from: "return /^[A-Za-z0-9_@-]{1,64}$/.test(s) ? s : 'default';",
    to: "return /^[A-Za-z0-9_@-]{1,32}$/.test(s) ? s : 'default';",
  },
  {
    name: '新增一个未经判定的模块级裸 Map', expect: 'C11', file: 'worker.scan.js',
    from: 'const demandQueue = [];',
    to: 'const demandQueue = [];\nconst rogueState = new Map();',
  },
]

function main() {
  if (process.argv.includes('--self-test')) {
    let caught = 0
    for (const mut of MUTATIONS) {
      const src = loadSources(mut)
      const failed = CHECKS.filter((c) => !c.pass(src)).map((c) => c.id)
      const ok = failed.includes(mut.expect)
      console.log(`  ${ok ? '✓' : '✗'} 变异「${mut.name}」→ 报警 ${failed.join(',') || '（无，判据太松）'}（期望 ${mut.expect}）`)
      if (ok) caught++
      else process.exitCode = 1
    }
    console.log(`反向验证：${caught}/${MUTATIONS.length} 条变异被精确抓到`)
    return
  }

  const src = loadSources()
  console.log('slug-scope-probe：跨库状态分桶接线检查')
  for (const c of CHECKS) assert(!!c.pass(src), `${c.id} ${c.name}`, `${c.id} ${c.name}`)
  console.log(failures ? `\n失败 ${failures} 条` : '\n全部通过')
  process.exitCode = failures ? 1 : 0
}

main()
