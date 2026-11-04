// =========================================================================
// ipc-policy-probe.cjs —— IPC 授权表回归探针
//
// 断言（全部失败即退出码 1）：
//   1) ipc-channels.json（通道名单）与 ipc-policy.json（授权表）**一一对应**：
//      名单里有的通道必须有授权，授权表里有的通道必须在名单里。
//   2) 每条通道的授权角色**必须覆盖**静态 import 图算出的真实调用方
//      （漏授权 = 功能被拦；多授权 = 权限过宽）。
//   3) 敏感通道（能改数据目录 / 加密 / 拿密钥 / 装更新 / 退应用）必须**只**授权给主窗口。
//   4) 表外通道必须被判定为拒绝（fail-closed），而不是默认放行。
//   5) 角色裁剪后的 preload 白名单必须真的不含越权通道。
//
// 为什么要有这个探针：授权表是「谁能调哪条通道」的唯一判据。
// 有了它，「新增通道忘了登记」「角色写宽了」这两类错误会在 CI 里立刻暴露，
// 而不是等到用户点一下发现功能没反应。
//
// 运行：node testjs/probe/ipc-policy-probe.cjs
// =========================================================================

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const auth = require(path.join(ROOT, 'electron/main/main.ipc-auth.js'))
const channels = require(path.join(ROOT, 'electron/ipc-channels.json'))
const policy = require(path.join(ROOT, 'electron/ipc-policy.json'))

let failed = 0
const failures = []
function assert(cond, msg) {
  if (!cond) { failed++; failures.push(msg) }
}

// ---------- 1) 名单与授权表一一对应 ----------
const listed = new Set([...(channels.send || []), ...(channels.invoke || [])])
const authorized = Object.keys(policy).filter((k) => !k.startsWith('_'))
for (const c of listed) {
  assert(authorized.includes(c), `通道「${c}」在 ipc-channels.json 里但没有授权记录（会被 fail-closed 拦掉，调用方拿不到结果）`)
}
for (const c of authorized) {
  assert(listed.has(c), `通道「${c}」有授权记录但不在 ipc-channels.json 里（授权表与名单脱节）`)
}
for (const c of authorized) {
  const roles = policy[c]
  assert(Array.isArray(roles) && roles.length > 0, `通道「${c}」的授权角色为空（等于对所有窗口关闭）`)
  for (const r of roles) {
    assert(auth.ALL_ROLES.includes(r), `通道「${c}」的授权角色「${r}」不是已知角色`)
  }
}

// ---------- 2) 授权必须覆盖真实调用方（用生成器同源的判定逻辑重算） ----------
// 这里不重跑整个静态图（慢且依赖前端源码树），而是用「保守并集」校验：
// 凡是在 ipc-channels.json 里、且前端任何文件里出现过调用痕迹的通道，
// 其授权不得为空。真正的「精确到角色」的核对由 ipc-policy-gen.mjs 负责，
// 它在生成时就会把偏差暴露出来（生成结果与手改不一致 = 有问题）。
const FRONTEND = path.join(ROOT, 'student-frontend/src')
function walk(dir, out = []) {
  let es
  try { es = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return out }
  for (const e of es) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(js|vue|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}
const frontendFiles = walk(FRONTEND)
const toKey = (n) => n.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()
for (const c of listed) {
  const tk = toKey(c)
  const re1 = new RegExp('\\b(SEND|INVOKE)\\.(' + tk + ')\\b')
  const re2 = new RegExp("(invoke|send)\\(\\s*['\"]" + c.replace(/[-]/g, '\\-') + "['\"]")
  let called = false
  for (const f of frontendFiles) {
    if (path.basename(f) === 'electronChannels.js') continue // 常量表，不是调用点
    let src
    try { src = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    if (!src.includes(tk) && !src.includes(c)) continue
    if (re1.test(src) || re2.test(src)) { called = true; break }
  }
  if (called) {
    assert((policy[c] || []).length > 0, `通道「${c}」前端有调用痕迹但授权为空 → 会被拦截，功能将失效`)
  }
}

// ---------- 3) 敏感通道只能给主窗口 ----------
// 例外通道单独处理（下面有专属断言），不放进 MAIN_ONLY 列表 ——
// 否则「既要求仅主窗口、又要求包含其它角色」两条断言会互相打脸。
const MAIN_ONLY = [
  'set-data-dir', 'set-thumbs-dir', 'set-skills-dir', 'set-db-encryption',
  'copy-sensitive-text', 'set-content-protection',
  'update-install', 'update-check', 'get-app-version',
  'shutdown-action', 'quit-app',
  'win-minimize', 'win-maximize-toggle', 'win-close',
  'restart-backend', 'backend-failure', 'probe-backend',
  'perf-snapshot', 'perf-restart-frontend', 'perf-restart-widget', 'perf-relaunch-app', 'perf-gc', 'perf-startup',
  'get-pending-notification',
  'open-external', 'save-file', 'open-file', 'save-background-image',
]
for (const c of MAIN_ONLY) {
  const roles = policy[c]
  if (!roles) continue
  assert(
    roles.length === 1 && roles[0] === auth.ROLE.MAIN,
    `敏感通道「${c}」的授权不是仅主窗口，而是 [${roles.join(', ')}]`
  )
}
// set-initial-data-dir 是引导窗口专用（首次安装时选数据目录），不是主窗口的
assert(
  (policy['set-initial-data-dir'] || []).length === 1 && policy['set-initial-data-dir'][0] === auth.ROLE.SETUP,
  `set-initial-data-dir 应仅授权给引导窗口，实际 [${(policy['set-initial-data-dir'] || []).join(', ')}]`
)
// get-master-key 是安全通道的认证锚点：**凡是装了 apiClient 的窗口都要**。
//   setup/main.js 调了 setupApiClient → 内部 setupSecureAxios → 请求时会握手 → 要 master key。
//   widget / desktop-widget / migration 同理（都装 apiClient 且走安全通道）。
//   所以它不能只给主窗口，但也不该给「没装 apiClient 的窗口」——目前 5 个角色都装了。
assert(
  (policy['get-master-key'] || []).includes(auth.ROLE.MAIN),
  'get-master-key 必须授权给主窗口'
)
for (const role of [auth.ROLE.WIDGET, auth.ROLE.DESKTOP_WIDGET, auth.ROLE.SETUP, auth.ROLE.MIGRATION]) {
  assert(
    (policy['get-master-key'] || []).includes(role),
    `get-master-key 应授权给 ${role}（该窗口装了 apiClient，会建安全通道）`
  )
}

// ---------- 4) fail-closed：表外通道一律拒绝 ----------
const fakeEvent = (role) => ({ sender: { __ipcRole: role } })
assert(auth.isAllowed('不存在的通道-xyz', fakeEvent(auth.ROLE.MAIN)) === false,
  '表外通道必须被拒绝（fail-closed），实际放行了')
assert(auth.isAllowed('set-data-dir', fakeEvent(auth.ROLE.WIDGET)) === false,
  'set-data-dir 被 widget 窗口调用时必须拒绝')
assert(auth.isAllowed('set-data-dir', fakeEvent(auth.ROLE.MAIN)) === true,
  'set-data-dir 被主窗口调用时必须放行')
assert(auth.isAllowed('set-data-dir', { sender: {} }) === false,
  '未登记角色的窗口必须被拒绝')

// ---------- 5) 裁剪后的 preload 白名单确实不含越权通道 ----------
const mainChans = auth.channelsForRole(auth.ROLE.MAIN, channels)
const widgetChans = auth.channelsForRole(auth.ROLE.WIDGET, channels)
assert(!mainChans.send.includes('widget-resize'), '主窗口的 preload 白名单不该含 widget-resize')
assert(widgetChans.invoke.includes('set-data-dir') === false,
  '工具箱浮窗的 preload 白名单不该含 set-data-dir')
assert(widgetChans.send.includes('widget-resize'), '工具箱浮窗的 preload 白名单应含 widget-resize')
assert(mainChans.invoke.includes('set-data-dir'), '主窗口的 preload 白名单应含 set-data-dir')
assert(mainChans.send.includes('shutdown-action'), '主窗口的 preload 白名单应含 shutdown-action')
assert(widgetChans.send.includes('shutdown-action') === false,
  '工具箱浮窗的 preload 白名单不该含 shutdown-action')
// receive 方向不按角色裁剪（主进程推给渲染层，不涉及发起资格）
assert(mainChans.receive.includes('from-main') && widgetChans.receive.includes('from-main'),
  'from-main 应对所有角色可见')

// ---------- 6) 每个窗口实际调用的通道，都在该窗口的白名单里 ----------
// 这是「不会误伤功能」的正向保证：授权表按目录归属推导，若某个调用点所在的窗口
// 不在授权角色里，preload 就会拒掉它 → 表现为「点一下没反应」。
// 归属规则：src/subwindows/<role>/** → 该 role；src/** 其余 → main；setup.html → setup。
const ROLE_DIRS = {
  widget: 'src/subwindows/widget',
  'desktop-widget': 'src/subwindows/desktop-widget',
  setup: 'src/subwindows/setup',
  migration: 'src/subwindows/migration',
}
function roleOfRel(rel) {
  for (const [role, dir] of Object.entries(ROLE_DIRS)) if (rel.startsWith(dir + '/')) return role
  if (rel === 'setup.html') return 'setup'
  if (rel.startsWith('src/')) return 'main'
  return null
}
for (const c of listed) {
  const tk = toKey(c)
  const re1 = new RegExp('\\b(SEND|INVOKE)\\.(' + tk + ')\\b')
  const re2 = new RegExp("(invoke|send)\\(\\s*['\"]" + c.replace(/[-]/g, '\\-') + "['\"]")
  for (const f of frontendFiles) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/')
    if (path.basename(f) === 'electronChannels.js') continue // 常量表，不是调用点
    let src
    try { src = fs.readFileSync(f, 'utf8') } catch (_) { continue }
    if (!src.includes(tk) && !src.includes(c)) continue
    if (!re1.test(src) && !re2.test(src)) continue
    const role = roleOfRel(rel)
    if (!role) continue
    assert(
      (policy[c] || []).includes(role),
      `${rel}（${role} 窗口）调用了未授权通道「${c}」→ 该窗口 preload 白名单里没有 → 调用会静默失效`
    )
  }
}

// ---------- 输出 ----------
if (failed) {
  console.error(`\n✗ ipc-policy-probe：${failed} 条断言失败\n`)
  for (const f of failures) console.error('  · ' + f)
  process.exit(1)
}
console.log(`✓ ipc-policy-probe：${authorized.length} 条通道、${auth.ALL_ROLES.length} 个角色，断言全过`)
