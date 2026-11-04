// =========================================================================
// ipc-usage-probe.cjs —— 「通道有、但没人调用」的真实清单
//
// 为什么需要它：
//   审查 v4 · C01-08 记了「6 条死通道」，实际只有 1 条真的没调用方，另外几条
//   （widget-move-to / widget-set-ignore-mouse / select-image-file）早就删干净了，
//   set-db-encryption 是「能力已备好、入口未接」的有意保留。
//   误判的根源是判据太糙：只要通道名在**任何**文件里出现过就算「有人用」，
//   而 `student-frontend/src/electronChannels.js` 本身就是从 json 生成常量表的，
//   于是「出现在常量表里」被当成了「有人在调用」。
//
// 正确判据：
//   调用点 = 渲染层里的 `INVOKE.KEY` / `SEND.KEY` / `RECEIVE.KEY`（KEY 由通道名按
//   与 electronChannels.js 相同的规则推导），或直接写字符串的调用。
//   **必须排除 electronChannels.js 自己**（那里只是常量表，不是调用）。
//
// 输出：
//   退出码 0 = 没有未登记的「无人调用」通道
//   退出码 1 = 有，列出来（新出现 → 要么补调用方，要么删通道，要么写进 KEEP 说明理由）
//
// 用法：node testjs/probe/ipc-usage-probe.cjs
// =========================================================================
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '../..')
const CHANNELS = path.join(ROOT, 'electron/ipc-channels.json')
const RENDERER = path.join(ROOT, 'student-frontend/src')
const CHANNEL_MAP_FILE = path.join(RENDERER, 'electronChannels.js')

// 有意保留、但当前没有调用方的通道。键 = 通道名，值 = 为什么留着（必须写清楚，
// 否则下一个人只会再把它当死代码报一遍）。
const KEEP = {
  'set-db-encryption':
    '能力已备好、入口未接：后端 POST /api/account/db-encryption 与迁移窗 crypt 分支都已就绪，'
    + '只差设置页一个开关。删它要连后端接口与迁移窗分支一起删，且会丢掉已完成的功能。',
}

const toKey = (name) => name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!/node_modules|dist|\.git/.test(p)) walk(p, out)
    } else if (/\.(js|mjs|cjs|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

const channels = JSON.parse(fs.readFileSync(CHANNELS, 'utf8'))
// main.dev-loader.js 虽然住在 electron/ 下，但它是**注入到页面的渲染层脚本**
// （启动加载页里 `window.electron.invoke('boot-status')`）。不算进来的话，
// boot-status 会被误判成死通道 —— C01-08 当初就是这么错的。
const EXTRA_RENDERER = [path.join(ROOT, 'electron/main/main.dev-loader.js')]
const files = [...walk(RENDERER), ...EXTRA_RENDERER]
  .filter((f) => path.resolve(f) !== path.resolve(CHANNEL_MAP_FILE))
  .filter((f) => fs.existsSync(f))
const sources = files.map((f) => ({ f: path.relative(ROOT, f), s: fs.readFileSync(f, 'utf8') }))

const rows = []
for (const kind of ['send', 'invoke', 'receive']) {
  for (const name of channels[kind] || []) {
    const key = toKey(name)
    const constRef = new RegExp(`\\b${kind.toUpperCase()}\\.${key}\\b`)
    const hits = []
    for (const { f, s } of sources) {
      if (constRef.test(s) || s.includes(`'${name}'`) || s.includes(`"${name}"`)) hits.push(f)
    }
    rows.push({ kind, name, hits })
  }
}

const unused = rows.filter((r) => r.hits.length === 0 && !KEEP[r.name])
const kept = rows.filter((r) => r.hits.length === 0 && KEEP[r.name])

console.log(`通道总数 ${rows.length}（send ${channels.send.length} / invoke ${channels.invoke.length} / receive ${channels.receive.length}）`)
console.log(`有调用点 ${rows.length - unused.length - kept.length} 条`)
if (kept.length) {
  console.log(`\n有意保留、暂无调用方（${kept.length} 条）：`)
  for (const r of kept) console.log(`  · ${r.kind}  ${r.name}\n      ${KEEP[r.name]}`)
}
if (unused.length) {
  console.log(`\n✗ 无人调用且未登记（${unused.length} 条）：`)
  for (const r of unused) console.log(`  · ${r.kind}  ${r.name}`)
  console.log('\n处理方式：补调用方 / 删通道（同时删 handler + ipc-channels.json + 重新生成 policy）/ 或写进本文件 KEEP 并说明理由。')
  process.exit(1)
}
console.log('\n✓ 没有未登记的「无人调用」通道')
