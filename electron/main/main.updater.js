// =========================================================================
// updater.js —— 版本更新（自建：GitHub Releases + 用户手动安装）
//
// 已移除 electron-updater，改为自建三段式流程：
//   1) 检查：请求 GitHub releases/latest，比较 tag 与当前版本；
//   2) 下载：把 release 里的 Inno 安装包资产下到 userData 临时目录（边下边报进度）；
//   3) 安装：update-install 只做安装前复核，再用 shell.openPath 打开安装包，
//      交给 Windows 正常安装向导（UAC / SmartScreen 由用户确认），程序不静默执行、不退出。
//      这样安装包即使未签名，也不会在后台绕过用户提示直接运行（V8 C-6 的中间态）。
// 主进程是更新状态的唯一权威来源，渲染层通过 from-main{type:'update-state'} 订阅。
//
// dev 无发布包时：设 CLASSNEST_UPDATE_MOCK_BASE=http://127.0.0.1:18499 可让本地 mock
// Release 服务替代 GitHub（仅 dev 生效，且只认回环地址）；此时「安装」改为在文件管理器
// 里定位安装包——绝不执行下载的假 exe，流程仍可完整触发。见 testjs/tools/dev-update-mock.cjs。
//
// 依赖注入：状态广播只发给主窗口，用 sendToMain(payload) 由 main.js 提供
// （内部自带 mainWindow 空判与 isDestroyed 判空，本模块不直接持有窗口引用）。
// =========================================================================

const { app, shell } = require('electron')
const { CH, IPC } = require('./channels')
const path = require('path')
const fs = require('fs')
const { isDev, isPackaged } = require('./main.env')
const {
  assertAllowedDownloadUrl, verifyDownloadedFile, sha256File, pickSetupAssetName, isLocalMockUrl,
  digestFromTrustManifest, resolveDigestTrust,
} = require('./main.update-integrity')
const { safeReject } = require('./main.ipc-contract')

// GitHub 仓库信息（原先在 electron-builder.json 的 publish 里，现仅保留在代码常量中）
const UPDATE_REPO = { owner: 'onion383', repo: 'classnest' }
const GITHUB_RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/latest`
// 独立 digest 清单：走 raw 域名 + 仓库文件，与 Release 资产不是同一个权限边界。
const GITHUB_TRUST_URL = `https://raw.githubusercontent.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/main/release-trust.json`

// 纯函数：解析更新源。dev + 显式配置 + 回环 http → 用本地 mock，否则恒用 GitHub。
// 打包环境无视 env —— 避免通过环境变量把正式用户的更新源换掉（那等于换信任根）。
function resolveUpdateEndpoints(env = process.env, dev = isDev) {
  const raw = dev ? String(env.CLASSNEST_UPDATE_MOCK_BASE || '') : ''
  const mockBase = raw && isLocalMockUrl(raw) ? new URL(raw).origin : ''
  return {
    apiUrl: mockBase ? `${mockBase}/releases/latest` : GITHUB_RELEASES_API,
    trustUrl: mockBase ? `${mockBase}/release-trust.json` : GITHUB_TRUST_URL,
    allowLocalMock: !!mockBase,
    mockBase,
  }
}

// 读独立摘要清单；拿不到就返回 null 让上层降级并提示，绝不挡住检查流程。
async function fetchTrustDigest(endpoints, version) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT)
  try {
    const res = await fetch(endpoints.trustUrl, {
      headers: { 'User-Agent': 'ClassNest', 'Cache-Control': 'no-cache' },
      signal: controller.signal,
    })
    if (!res.ok) return null
    return digestFromTrustManifest(await res.text(), version)
  } catch (_) {
    return null
  } finally {
    clearTimeout(timer)
  }
}
// 检查超时沿用既有 10s 风格；下载体积较大，整体超时放宽到 5 分钟
const UPDATE_CHECK_TIMEOUT = 10000
const UPDATE_DOWNLOAD_TIMEOUT = 300000

// 更新状态快照：主进程是唯一权威来源，渲染层通过 from-main{type:'update-state'} 订阅
let updateState = {
  status: 'idle', // idle | checking | available | downloading | downloaded | opened | not-available | error
  currentVersion: app.getVersion(),
  latestVersion: null,
  percent: 0,
  error: null,
  digestSource: null, // manifest | asset-only | size-only | conflict
  digestWarning: '',  // 非 manifest 来源时给用户看的提示
}

// 已下载到本地的安装包绝对路径（供 update-install 使用）
let downloadedInstallerPath = null
// 该安装包的**校验凭据**（下载时算出的 sha256 与字节数）。
// 为什么要留着：下载时校验过 ≠ 安装时文件还是那个文件。
// 两次之间存在可利用的时间窗 —— 同一台机器上的另一个进程可以替换 update-cache 里的 exe，
// 而安装动作是「以 /SILENT 静默参数直接执行它」。原先 update-install 只查 existsSync 就 spawn，
// 等于把「下载时验证过」当成了「运行时仍然可信」（TOCTOU）。
// 所以安装前必须拿同一份凭据**再算一遍哈希**，对不上就拒绝安装。
let downloadedInstallerDigest = null
let downloadedInstallerSize = 0
// 流程互斥：避免重复检查 / 并发下载
let updateFlowRunning = false

// 状态广播出口：由 registerUpdateIpc 注入（main.js 提供，内部判空 mainWindow）
let sendToMain = () => {}

function broadcastUpdateState() {
  const payload = { type: 'update-state', state: { ...updateState } }
  sendToMain(payload)
}

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch }
  broadcastUpdateState()
}

// 版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
// 按 SemVer 口径处理预发布段（E02-03）：`1.0.0-beta.2` 过去被 parseInt 吞成 0.0.0，
// 与正式版比较失真。规则：
//   · 主版本段按数字比（缺失补 0）；
//   · 主版本相等时，有预发布段 < 无预发布段（1.0.0-rc < 1.0.0）；
//   · 预发布段逐项比：数字项按数值、数字项 < 字母项、字母项按字典序，前缀相同则短的小。
function splitVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '')
  const dash = s.indexOf('-')
  const core = dash >= 0 ? s.slice(0, dash) : s
  const pre = dash >= 0 ? s.slice(dash + 1) : ''
  return {
    core: core.split('.').map((n) => {
      const m = /^\d+/.exec(n)
      return m ? Number(m[0]) : 0
    }),
    pre: pre ? pre.split('.') : [],
  }
}
function comparePre(a, b) {
  if (!a.length && !b.length) return 0
  if (!a.length) return 1   // 无预发布 > 有预发布
  if (!b.length) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    const na = /^\d+$/.test(a[i])
    const nb = /^\d+$/.test(b[i])
    if (na && nb) {
      const d = Number(a[i]) - Number(b[i])
      if (d !== 0) return d > 0 ? 1 : -1
    } else if (na !== nb) {
      return na ? -1 : 1   // 数字项 < 字母项
    } else if (a[i] !== b[i]) {
      return a[i] > b[i] ? 1 : -1
    }
  }
  return 0
}
function compareVersions(a, b) {
  const pa = splitVersion(a)
  const pb = splitVersion(b)
  const len = Math.max(pa.core.length, pb.core.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa.core[i] || 0) - (pb.core[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return comparePre(pa.pre, pb.pre)
}

// 把底层报错转成对用户友好的提示
function friendlyUpdateError(err) {
  const msg = (err && err.message) || String(err || '')
  console.log('[update] 检查失败：', msg)
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|fetch failed|network|socket hang up|aborted/i.test(msg)) {
    return '网络连接失败，请检查网络后重试'
  }
  if (/404|not found|no published|cannot find/i.test(msg)) {
    return '未找到可用更新（仓库中暂无发布版本）'
  }
  return msg || '未知错误'
}

// 请求 GitHub Releases 最新发布（带超时中断，失败抛错交由上层映射为友好文案）
async function fetchLatestRelease(endpoints = resolveUpdateEndpoints()) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT)
  try {
    const url = endpoints.apiUrl
    const res = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClassNest' },
      signal: controller.signal,
    })
    if (!res.ok) {
      const err = new Error(res.status === 404 ? '仓库中暂无发布版本' : `请求失败（HTTP ${res.status}）`)
      err.status = res.status
      throw err
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// 从 release 资产中挑选 Inno 安装包（文件名形如「*-Setup-*.exe」）。
// 选择逻辑（含「排除 Vue 3.6 预览包」）放在 update-integrity 里做成纯函数，便于单测：
// 预览包同样含 -Setup-，选错会把正式版用户升级到写着「仅供体验」的版本。
function pickSetupAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : []
  const name = pickSetupAssetName(assets.map((a) => (a && a.name) || ''))
  if (!name) return null
  return assets.find((a) => String((a && a.name) || '') === name) || null
}

// 开发/调试路径：仅直连探测 GitHub Releases，不下载、不安装
async function checkUpdateViaGitHub(endpoints = resolveUpdateEndpoints()) {
  setUpdateState({ status: 'checking', error: null, percent: 0 })
  try {
    const data = await fetchLatestRelease(endpoints)
    const latest = String((data && data.tag_name) || '').replace(/^v/i, '')
    const current = app.getVersion()
    if (latest && compareVersions(latest, current) > 0) {
      setUpdateState({ status: 'available', latestVersion: latest, error: null })
    } else {
      setUpdateState({ status: 'not-available', latestVersion: latest || current, percent: 0, error: null })
    }
  } catch (err) {
    setUpdateState({ status: 'error', error: friendlyUpdateError(err) })
  }
}

// 把发布资产的原始文件名归一化成「可安全落盘的文件名」（审查 v4 · B01-11）
//
// 资产名来自 GitHub API（外部输入），必须归一化：
//   原先直接 path.join(dir, asset.name)，而 asset.name 里若带 '../' 或 'a/b'，
//   path.join 会**归一化出 update-cache 之外的路径** → 安装包写到缓存目录外，
//   随后 update-install 又以 /SILENT 参数执行那个路径。
//   即便下载侧有 HTTPS + sha256 校验（main.update-integrity.js），
//   那校验的是**内容**不是**落盘位置** —— 位置逃逸是另一条独立的缺口。
//
// 两个坑（都踩过）：
//   1. path.basename('..') 返回 '..'（**不是空串**）→ 只用 `|| 兜底名` 拦不住，
//      path.join(dir, '..') 会指向缓存目录的**父目录**。
//   2. Windows 路径分隔符是 '\'，basename 不认 → 先统一成 '/' 再取 basename。
//
// 抽成独立函数是为了能单测（原先这段逻辑埋在 downloadInstaller 里，测不到）。
function normalizeAssetFileName(rawName, fallback) {
  let fileName = path.basename(String(rawName || '').replace(/\\/g, '/'))
  if (!fileName || fileName === '.' || fileName === '..' || fileName.includes('/')) {
    fileName = fallback
  }
  return fileName
}

// 下载安装包到 userData/update-cache 并推送 downloading 进度；失败时清理半成品并抛出
async function downloadInstaller(asset, version, endpoints = resolveUpdateEndpoints()) {
  const { Readable } = require('stream')
  const { pipeline } = require('stream/promises')
  const dir = path.join(app.getPath('userData'), 'update-cache')
  fs.mkdirSync(dir, { recursive: true })
  const fileName = normalizeAssetFileName((asset && asset.name) || '', `ClassNest-Setup-${version}.exe`)
  const target = path.join(dir, fileName)
  // 兜底再确认一次：归一化后的路径必须仍在缓存目录内（纵深防御，双保险）
  const cacheRoot = path.resolve(dir) + path.sep
  if (!path.resolve(target).startsWith(cacheRoot)) {
    throw new Error('更新包文件名非法')
  }
  try { fs.rmSync(target, { force: true }) } catch (_) { /* 清理旧文件失败忽略 */ }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPDATE_DOWNLOAD_TIMEOUT)
  try {
    // 下载地址必须是 HTTPS（dev mock 时额外放行本地回环）；
    // 否则 release 资产可被替换成明文/本地地址。
    const downloadUrl = String(asset.browser_download_url || '')
    assertAllowedDownloadUrl(downloadUrl, { allowLocalMock: endpoints.allowLocalMock })
    // 独立清单优先：与资产摘要冲突就是同源攻击信号，直接拒装。
    // 清单拿不到不挡流程，降级为资产摘要并把告警带到界面上。
    const manifestDigest = await fetchTrustDigest(endpoints, version)
    const trust = resolveDigestTrust({ manifestDigest, assetDigest: asset.digest })
    if (trust.decision === 'reject') throw new Error(trust.reason + '，已取消更新')
    const res = await fetch(downloadUrl, {
      headers: { 'User-Agent': 'ClassNest' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
    // 重定向后的最终地址同样受协议约束（GitHub 会跳到 objects.githubusercontent.com）
    if (res.url) assertAllowedDownloadUrl(res.url, { allowLocalMock: endpoints.allowLocalMock })
    const expectedSize = Number(asset.size) || Number(res.headers.get('content-length')) || 0
    let received = 0
    // Node fetch 返回 web ReadableStream，转成 Node 流后边写边算百分比
    const nodeStream = Readable.fromWeb(res.body)
    // 只在百分比**变化**时才广播：chunk 通常 64KB，50MB 包约 800 个 chunk，
    // 而真正改变的百分比只有 100 个。原来每个 chunk 都 setUpdateState →
    // 每次都「拼快照 + IPC 发送 + 渲染层重渲染」，其中七分之六是无用功。
    let lastPercent = -1
    nodeStream.on('data', (chunk) => {
      received += chunk.length
      if (expectedSize <= 0) return
      const percent = Math.round((received / expectedSize) * 100)
      if (percent === lastPercent) return
      lastPercent = percent
      setUpdateState({ status: 'downloading', percent })
    })
    await pipeline(nodeStream, fs.createWriteStream(target))
    // 完整性校验：大小 + 权威 digest（独立清单优先，资产摘要次之）。
    const verified = await verifyDownloadedFile({ filePath: target, expectedSize, digest: trust.digest })
    if (!verified.ok) throw new Error(verified.error)
    if (trust.decision === 'warn') console.warn('[update]', trust.reason, '：', fileName)
    downloadedInstallerPath = target
    // 记下本次算出的哈希：安装前要拿它再算一遍，防止「下载后本地被替换」的 TOCTOU。
    downloadedInstallerDigest = verified.sha256 || null
    downloadedInstallerSize = expectedSize
    setUpdateState({ digestSource: trust.source, digestWarning: trust.reason })
  } catch (err) {
    try { fs.rmSync(target, { force: true }) } catch (_) { /* 忽略 */ }
    downloadedInstallerPath = null
    downloadedInstallerDigest = null
    downloadedInstallerSize = 0
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// 完整流程：checking → （无更新）not-available / （有更新）available → downloading → downloaded。
// 打包环境恒跑；dev 仅配置的 mock 源可跑（否则保持原来的「只探测不下载」）。
async function runUpdateFlow(endpoints = resolveUpdateEndpoints()) {
  if ((!isPackaged && !endpoints.allowLocalMock) || updateFlowRunning) return
  updateFlowRunning = true
  // 同步先推 checking（在首个 await 之前，保证 update-check 返回的快照即 checking）
  setUpdateState({ status: 'checking', error: null, percent: 0 })
  try {
    const release = await fetchLatestRelease(endpoints)
    const latest = String((release && release.tag_name) || '').replace(/^v/i, '')
    const current = app.getVersion()
    if (!latest || compareVersions(latest, current) <= 0) {
      setUpdateState({ status: 'not-available', latestVersion: latest || current, percent: 0, error: null })
      return
    }
    setUpdateState({ status: 'available', latestVersion: latest, error: null, percent: 0 })
    const asset = pickSetupAsset(release)
    if (!asset) {
      setUpdateState({ status: 'error', error: '未找到安装包（发布资产中缺少 Setup 安装程序）' })
      return
    }
    await downloadInstaller(asset, latest, endpoints)
    setUpdateState({ status: 'downloaded', latestVersion: latest, percent: 100, error: null })
  } catch (err) {
    setUpdateState({ status: 'error', error: friendlyUpdateError(err) })
  } finally {
    updateFlowRunning = false
  }
}

// 启动时清理 update-cache：安装包下载完就交给 Inno 安装器并退出本进程，退出前没机会删它，
// 于是每次更新都会在 userData 里留下一个上百 MB 的安装包（文件名带版本号，会逐版本累积）。
// 更新状态只存在内存里（重启后必然重新检查并按需重下），故启动时清空整个目录是安全的。
function pruneUpdateCache() {
  try {
    const dir = path.join(app.getPath('userData'), 'update-cache')
    if (!fs.existsSync(dir)) return
    let freed = 0
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      try {
        const st = fs.statSync(p)
        if (st.isFile()) freed += st.size
        fs.rmSync(p, { recursive: true, force: true })
      } catch (_) { /* 单个条目失败忽略 */ }
    }
    if (freed > 0) console.log(`[updater] 已清理上次遗留的更新安装包，释放 ${(freed / 1048576).toFixed(1)} MB`)
  } catch (_) { /* 清理失败不影响更新功能 */ }
}

// 安装动作纯函数：打包环境恒「打开」；只有 dev + 显式 mock 才「定位」假包（绝不执行）。
function resolveInstallAction({ dev = isDev, allowLocalMock = false } = {}) {
  return dev && allowLocalMock ? 'reveal' : 'open'
}

// 注册版本更新相关的 IPC 通道。send(payload) 由 main.js 提供，用于向主窗口推 update-state。
function registerUpdateIpc(send) {
  if (typeof send === 'function') sendToMain = send

  pruneUpdateCache()

  IPC.handle(CH.GET_APP_VERSION, () => app.getVersion())

  // 检查更新：进入「关于」页 / 手动点击触发；立即返回当前状态快照，后续变化走 from-main 广播
  IPC.handle(CH.UPDATE_CHECK, safeReject(async () => {
    const endpoints = resolveUpdateEndpoints()
    if (isPackaged || endpoints.allowLocalMock) {
      // 打包 / dev mock：后台走完整「检查 + 下载」流程（立即返回，结果靠事件推送）
      runUpdateFlow(endpoints)
      return { ...updateState }
    }
    // dev 未配置 mock：仅直连探测，不下载、不安装
    await checkUpdateViaGitHub(endpoints)
    return { ...updateState }
  }))

  // 用户点「打开安装包」后：复核 → 打开安装包交用户手动装。
  // 不静默 spawn、不停后端、不退出应用：未签名包也绕不过 Windows 的 UAC / SmartScreen。
  // 复核仍保留：下载时校验过 ≠ 此刻文件还是那个文件（TOCTOU）；对不上就清掉并要求重下。
  // 互斥锁仍保留：哈希复核是异步的，双击会在窗口期重复触发两次打开。
  let installBusy = false
  IPC.on(CH.UPDATE_INSTALL, async () => {
    const endpoints = resolveUpdateEndpoints()
    if (!isPackaged && !endpoints.allowLocalMock) return
    if (installBusy) return
    installBusy = true
    try {
    if (!downloadedInstallerPath || !fs.existsSync(downloadedInstallerPath)) {
      setUpdateState({ status: 'error', error: '安装包尚未下载完成' })
      return
    }
    // 路径必须仍在本次的 update-cache 目录里
    const cacheDir = path.join(app.getPath('userData'), 'update-cache')
    const resolved = path.resolve(downloadedInstallerPath)
    if (!resolved.startsWith(path.resolve(cacheDir) + path.sep)) {
      setUpdateState({ status: 'error', error: '安装包路径异常，已取消安装' })
      return
    }
    // 复核哈希（安装包上百 MB，这里流式算，不整file读进内存）
    try {
      const actual = await sha256File(resolved)
      if (!downloadedInstallerDigest || actual !== downloadedInstallerDigest) {
        // 顺手清掉可疑文件，避免下次还拿它去装
        try { fs.rmSync(resolved, { force: true }) } catch (_) { /* 忽略 */ }
        downloadedInstallerPath = null
        downloadedInstallerDigest = null
        setUpdateState({ status: 'error', error: '安装包校验失败（文件已改变），请重新下载' })
        return
      }
      if (downloadedInstallerSize > 0 && fs.statSync(resolved).size !== downloadedInstallerSize) {
        try { fs.rmSync(resolved, { force: true }) } catch (_) { /* 忽略 */ }
        downloadedInstallerPath = null
        downloadedInstallerDigest = null
        setUpdateState({ status: 'error', error: '安装包校验失败（大小不符），请重新下载' })
        return
      }
    } catch (err) {
      setUpdateState({ status: 'error', error: '安装包校验失败：' + (err?.message || String(err)) })
      return
    }
      if (resolveInstallAction({ allowLocalMock: endpoints.allowLocalMock }) === 'reveal') {
        // dev mock：假 exe 绝不执行，只在文件管理器里定位，让流程可见且零执行风险
        try { shell.showItemInFolder(resolved) } catch (_) { /* 定位失败不影响状态 */ }
      } else {
        // 交给 Windows 正常安装向导；openPath 返回非空字符串表示失败
        const openError = await shell.openPath(resolved)
        if (openError) {
          setUpdateState({ status: 'error', error: '打开安装包失败，请手动运行：' + resolved })
          return
        }
      }
      setUpdateState({ status: 'opened', percent: 100, error: null })
    } finally {
      installBusy = false
    }
  })
}

module.exports = {
  registerUpdateIpc, runUpdateFlow, normalizeAssetFileName,
  resolveUpdateEndpoints, resolveInstallAction,
}