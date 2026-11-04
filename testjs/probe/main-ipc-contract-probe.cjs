// =========================================================================
// main-ipc-contract-probe.cjs —— 主进程 IPC 契约 / 状态归属 回归探针
//
// 覆盖审查 v4 的 B01 族（electron/main）：
//   B01-05 截屏选区 regionState 模块级残留 → 主窗口永久卡全屏置顶
//   B01-06 save-file 写盘失败伪装成「用户取消」→ 界面静默无提示
//   B01-08 widgetIgnoreMouse 模块级变量在浮窗重建后不复位 → 截屏误设穿透
//   B01-09 webview-guard 的 loadURL 未 catch → unhandled rejection
//   B01-10 screenshot-capture try/finally 无 catch → 异常上抛 rejected
//   B01-11 updater asset.name 未 path.basename 归一化 → 可逃出 update-cache
//   B01-12 navigateMainWhenReady 的 did-finish-load 监听只清成功路径 → 堆积
//   B01-13 preload once() 的 wrapper 不登记 listenerMap → 常驻无法 off
//
// 三条根因判据：
//   A. 契约层存在且「失败 / 取消」是两个可区分的字段
//   B. 主进程 handler 走契约层，不出现「失败返回 canceled:true」这种混淆
//   C. 模块级可变状态有归属（挂在实例上）或必然的终点（看门狗 / 超时 / 销毁兜底）
//
// 运行：node testjs/probe/main-ipc-contract-probe.cjs
// =========================================================================

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

let failed = 0
const failures = []
function assert(cond, msg) {
  if (!cond) { failed++; failures.push(msg) }
}

// 取出某个 handler 的完整片段（从 handle( 开始到函数体结束）。
// ⚠️ 只取函数体 '{...}' 是不够的：contract.safe(...) 这类**包装在箭头函数之外**，
//    只看函数体就漏掉了「有没有包 safe」这个关键判据。
function handlerBody(src, channel) {
  const i = src.indexOf("handle('" + channel + "'")
  if (i < 0) return ''
  // 箭头函数的 '{'（不是参数解构的 '{'）
  const arrow = src.indexOf('=>', i)
  if (arrow < 0) return ''
  const open = src.indexOf('{', arrow)
  if (open < 0) return ''
  let d = 0
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++
    else if (src[k] === '}') {
      d--
      if (d === 0) {
        // 从 handle( 起，到函数体结束（再带上可能的 ')）' 收尾）
        const tail = src.slice(k + 1, k + 4)
        return src.slice(i, k + 1) + (/^\s*\)/.test(tail) ? ')' : '')
      }
    }
  }
  return ''
}

// 去掉注释后再判断（「不应出现某写法」的判据必须先去注释，否则注释里的函数名会骗过正则 → 假绿）
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}
function readCode(rel) { return stripComments(read(rel)) }

// ============================================================
// 判据 A：契约层存在，失败与取消可区分
// ============================================================
const contractPath = path.join(ROOT, 'electron/main/main.ipc-contract.js')
assert(fs.existsSync(contractPath), '缺少 electron/main/main.ipc-contract.js（IPC 结果契约层）')
const contract = require(contractPath)

assert(typeof contract.ok === 'function', '契约层缺少 ok()')
assert(typeof contract.fail === 'function', '契约层缺少 fail()')
assert(typeof contract.canceled === 'function', '契约层缺少 canceled()')
assert(typeof contract.safe === 'function', '契约层缺少 safe()')
assert(typeof contract.safeReject === 'function', '契约层缺少 safeReject()')
assert(typeof contract.isFailure === 'function', '契约层缺少 isFailure()')
assert(typeof contract.isCanceled === 'function', '契约层缺少 isCanceled()')

// 三种结局互斥（用行为断言，不靠源码正则）
{
  const ok = contract.ok({ filePath: 'x' })
  const fl = contract.fail('写盘失败')
  const cd = contract.canceled()
  assert(contract.isOk(ok) === true, 'ok() 应被判定为成功')
  assert(contract.isFailure(ok) === false, 'ok() 不应被判定为失败')
  assert(contract.isCanceled(ok) === false, 'ok() 不应被判定为取消')
  assert(contract.isFailure(fl) === true, 'fail() 应被判定为失败')
  assert(contract.isCanceled(fl) === false, 'fail() 不应被判定为取消')
  assert(contract.isCanceled(cd) === true, 'canceled() 应被判定为取消')
  assert(contract.isFailure(cd) === false, 'canceled() 不应被判定为失败')
  // **核心**：失败与取消必须能被区分 —— 这是 B01-06 的判据
  assert(contract.isFailure(fl) !== contract.isFailure(cd),
    'fail() 与 canceled() 的「是否失败」判定必须不同（B01-06：失败被当成取消）')
  assert(fl.canceled === false, 'fail() 的 canceled 字段必须是 false')
  assert(cd.canceled === true, 'canceled() 的 canceled 字段必须是 true')
  assert(typeof fl.error === 'string' && fl.error.length > 0, 'fail() 必须带可读的 error 字符串')
  assert(cd.error === null, 'canceled() 不该带 error（不是错误）')
}

// safe()：异常转成 fail() 返回值，不 reject
;(async () => {
  {
    const wrapped = contract.safe(async () => { throw new Error('磁盘满了') })
    const r = await wrapped()
    assert(contract.isFailure(r) === true, 'safe() 包装的函数抛异常时应返回 fail() 结果')
    assert(r.error === '磁盘满了', 'safe() 应保留原始错误信息（不能是 Electron 包装的 "Error invoking remote method"）')
  }
  // safeReject()：仍 reject，但错误信息可读
  {
    const wrapped = contract.safeReject(async () => { throw new Error('磁盘满了') })
    let caught = null
    try { await wrapped() } catch (e) { caught = e }
    assert(caught !== null, 'safeReject() 包装的函数抛异常时仍应 reject（前端靠 try/catch 捕获）')
    assert(caught && caught.message === '磁盘满了', 'safeReject() 应保留原始错误信息')
  }
  // 非 Error 的抛出物也要能转成字符串（跨 IPC 序列化）
  {
    const wrapped = contract.safe(async () => { throw '纯字符串' })
    const r = await wrapped()
    assert(typeof r.error === 'string' && r.error.length > 0, 'safe() 应把非 Error 抛出物转成字符串')
  }

  // ============================================================
  // 判据 B：主进程 handler 走契约层
  // ============================================================
  const dialogsSrc = readCode('electron/main/main.dialogs.js')

  assert(/require\(['"]\.\/main\.ipc-contract['"]\)/.test(dialogsSrc),
    'main.dialogs.js 没有引用契约层 main.ipc-contract')

  // B01-06 的核心判据：不能再出现「失败返回 canceled:true」
  // 匹配形如 { canceled: true, error: ... } 或 return { canceled: true } 的失败返回
  const mixedFailure = /\{\s*canceled:\s*true\s*,\s*error:/.test(dialogsSrc)
  assert(!mixedFailure,
    'main.dialogs.js 里仍有「canceled:true + error」的混合返回 —— 写盘失败又被当成用户取消（B01-06）')

  // save-file 必须走契约：失败走 fail()、取消走 canceled()
  const saveFileBody = handlerBody(dialogsSrc, 'save-file')
  assert(saveFileBody.length > 500, 'save-file 的 handler body 提取异常（长度 ' + saveFileBody.length + '）')
  assert(/contract\.safe\(/.test(saveFileBody),
    'save-file handler 未包 contract.safe（异常会直接 reject，真实原因丢失）')
  // ⚠️ 写盘失败那一步必须**精确**是 fail()：不能只看「handler 里有 fail()」，
  //    否则把 catch 里的 fail() 换成 canceled() 也照样通过（假绿）。
  assert(/catch\s*\([^)]*\)\s*\{[^}]*contract\.fail\(/.test(saveFileBody),
    'save-file 的写盘 catch 没有走 contract.fail()（失败被当成用户取消，B01-06）')
  assert(/if\s*\(\s*result\.canceled[^)]*\)\s*return\s+contract\.canceled\(/.test(saveFileBody),
    'save-file 的「用户取消」分支没有走 contract.canceled()（取消与失败无法区分）')
  assert(!/catch\s*\([^)]*\)\s*\{[^}]*contract\.canceled\(/.test(saveFileBody),
    'save-file 的 catch 里出现了 contract.canceled()（写盘失败绝不能走取消分支，B01-06）')

  // B01-10：screenshot-capture 必须有 catch（不能是裸 try/finally）
  const shotBody = handlerBody(dialogsSrc, 'screenshot-capture')
  assert(shotBody.length > 200, 'screenshot-capture 的 handler body 提取异常（长度 ' + shotBody.length + '）')
  assert(/contract\.safe\(/.test(shotBody),
    'screenshot-capture 未包 contract.safe（sources 为空时抛 TypeError 上抛，B01-10）')
  assert(/!primarySource/.test(shotBody),
    'screenshot-capture 未对 primarySource 为空做判空（读 undefined 的属性会抛，B01-10）')

  // B01-09：webview-guard 的 loadURL 必须接住 reject
  const guardSrc = readCode('electron/main/main.webview-guard.js')
  assert(/loadURL\(/.test(guardSrc), 'webview-guard 里找不到 loadURL 调用')
  assert(/\.catch\(/.test(guardSrc),
    'webview-guard 的 loadURL 未接 .catch（加载失败 → unhandled rejection，B01-09）')

  // ============================================================
  // 判据 C：模块级状态有归属 / 必然终点
  // ============================================================

  // B01-05：regionState → regionSession（一次会话），且有看门狗 + 窗口关闭兜底
  assert(!/let\s+regionState\s*=/.test(dialogsSrc),
    'main.dialogs.js 里仍有模块级 regionState（B01-05：跨会话残留，主窗口永久卡全屏置顶）')
  assert(/let\s+regionSession\s*=/.test(dialogsSrc),
    'main.dialogs.js 里找不到 regionSession（选区状态应是「一次会话」而不是模块全局）')
  assert(/REGION_SESSION_TIMEOUT_MS/.test(dialogsSrc),
    '选区会话没有超时看门狗（渲染层不走 region-end 时主进程无法自愈，B01-05）')
  // ⚠️ 光有常量不够：必须真的被 setTimeout 用上，
  // 否则把常量改成 0 / 删掉 armRegionWatchdog 的调用，判据照样通过（假绿）。
  assert(/setTimeout\([\s\S]{0,200}?REGION_SESSION_TIMEOUT_MS\s*\)/.test(dialogsSrc),
    '选区会话的看门狗定时器没有用 REGION_SESSION_TIMEOUT_MS（常量存在但没真正生效）')
  // 看门狗必须真的被调用（在 region-show 之后 arm）
  assert(/armRegionWatchdog\(st\)\s*\n/.test(dialogsSrc),
    'armRegionWatchdog 从未被调用（看门狗形同虚设，渲染层不走 region-end 时仍会永久卡死，B01-05）')
  assert(/once\(['"]closed['"]/.test(dialogsSrc),
    '选区会话缺窗口关闭兜底（主窗口销毁后会话残留）')
  // 残留会话必须「先还原再重新开始」，不能直接拒绝
  assert(/检测到残留的截屏选区会话[\s\S]{0,200}?restoreAfterRegion\(\)/.test(dialogsSrc),
    '选区会话遇到残留时应先还原再重新开始，而不是直接拒绝（B01-05：永久卡死）')
  assert(!/检测到残留的截屏选区会话[\s\S]{0,200}?return\s+contract\.fail\(['"]已有截屏进行中/.test(dialogsSrc),
    '选区会话遇到残留时直接拒绝了（用户会永久卡在「已有截屏进行中」，只能重启应用，B01-05）')

  // B01-08：穿透态挂在窗口实例上（WeakMap），不是模块级变量
  const widgetSrc = readCode('electron/main/main.widget.js')
  assert(!/let\s+widgetIgnoreMouse\s*=/.test(widgetSrc),
    'main.widget.js 里仍有模块级 widgetIgnoreMouse（B01-08：浮窗重建后残留，导致误设穿透）')
  assert(/WeakMap/.test(widgetSrc),
    '穿透态未挂在窗口实例上（WeakMap）—— 状态的生命周期不能比它描述的对象长（B01-08）')
  assert(/isWidgetIgnoreMouse/.test(widgetSrc) && /setWidgetIgnoreMouse/.test(widgetSrc),
    'main.widget.js 未同时提供穿透态的读取器与写入器（只读不写会让记录与实际不同步）')

  // 截屏恢复必须走写入器（不能直接调 setIgnoreMouseEvents）
  assert(/setWidgetIgnoreMouse\(widgetWindow/.test(dialogsSrc),
    '截屏恢复穿透态未走注入的写入器（记录状态与窗口实际会不一致）')
  assert(!/widgetWindow\.setIgnoreMouseEvents\(wasIgnoreMouse/.test(dialogsSrc),
    '截屏恢复仍在直接调 setIgnoreMouseEvents（绕过了状态记录）')

  // B01-12：navigateMainWhenReady 的监听要有必然终点
  assert(/NAVIGATE_WAIT_TIMEOUT_MS/.test(widgetSrc),
    'navigateMainWhenReady 没有超时兜底（B01-12：监听无限堆积）')
  const navIdx = widgetSrc.indexOf('function navigateMainWhenReady')
  assert(navIdx > 0, 'main.widget.js 里找不到 navigateMainWhenReady')
  // 精确取该函数体（到下一个顶层 function 为止）
  const navBody = (() => {
    const next = widgetSrc.indexOf('\nfunction ', navIdx + 10)
    return widgetSrc.slice(navIdx, next > 0 ? next : navIdx + 2500)
  })()
  // ⚠️ 常量存在 ≠ 真的用上：必须验证超时定时器确实按该常量排期
  assert(/setTimeout\([\s\S]{0,300}?NAVIGATE_WAIT_TIMEOUT_MS\s*\)/.test(navBody),
    'navigateMainWhenReady 的超时定时器没有用 NAVIGATE_WAIT_TIMEOUT_MS（常量存在但没生效）')
  assert(/removeListener\(['"]did-finish-load['"]/.test(navBody),
    'navigateMainWhenReady 没有 removeListener("did-finish-load")（监听只清成功路径，失败路径堆积，B01-12）')
  assert(/removeListener\(['"]destroyed['"]/.test(navBody),
    'navigateMainWhenReady 没有 removeListener("destroyed")（窗口销毁后监听残留，B01-12）')
  assert(/wc\.on\(['"]destroyed['"]/.test(navBody),
    'navigateMainWhenReady 没有监听 webContents destroyed（窗口销毁后监听残留，B01-12）')
  assert(/clearTimeout/.test(navBody),
    'navigateMainWhenReady 的超时定时器没有被清理（定时器泄漏）')

  // B01-11：asset.name 必须 basename 归一化 + 落在缓存目录内
  const updaterSrc = readCode('electron/main/main.updater.js')
  assert(/path\.basename\(/.test(updaterSrc),
    'main.updater.js 未用 path.basename 归一化资产名（B01-11：可逃出 update-cache 目录）')
  assert(/startsWith\(cacheRoot\)|startsWith\(cacheRoot\)/.test(updaterSrc),
    'main.updater.js 未校验归一化后的路径仍在 update-cache 内（B01-11 纵深防御）')

  // B01-13：preload once() 必须登记 listenerMap 并返回句柄
  const preloadSrc = readCode('electron/preload.js')
  const onceIdx = preloadSrc.indexOf('once:')
  assert(onceIdx > 0, 'preload.js 里找不到 once()')
  // 精确取 once 的函数体（到下一个顶层属性为止）
  const onceBody = (() => {
    const next = preloadSrc.indexOf('\n  // ', onceIdx)
    return preloadSrc.slice(onceIdx, next > 0 ? next : onceIdx + 1200)
  })()
  // ⚠️ 必须是「登记动作」本身在 once 体内，而不是别处也有 listenerMap
  assert(/m\.set\(\s*callback\s*,\s*wrapper\s*\)/.test(onceBody),
    'preload.once() 的 wrapper 未登记进 listenerMap（B01-13：事件不触发时常驻且无法 off）')
  assert(/ipcRenderer\.once\(\s*channel\s*,\s*wrapper\s*\)/.test(onceBody),
    'preload.once() 没有把登记好的 wrapper 交给 ipcRenderer.once（登记与注册不是同一个 wrapper）')
  assert(/removeListener\(\s*channel\s*,\s*wrapper\s*\)/.test(onceBody),
    'preload.once() 未在触发后摘掉登记（映射表里会留下指向已死监听的条目）')
  assert(/return\s+wrapper/.test(onceBody),
    'preload.once() 未返回句柄（上层拿不到句柄就无法 off）')

  // ============================================================
  // 判据 D：前端那一半 —— B01-06 是前后端闭环，只查主进程等于半个判据
  // ============================================================
  const saveFileSrc = readCode('student-frontend/src/utils/saveFile.js')
  assert(saveFileSrc.length > 0, '找不到 student-frontend/src/utils/saveFile.js')
  // 「失败」必须被抛出去（让调用方的 catch 弹提示），不能和「取消」一起被吞成空串
  assert(!/kind\s*===\s*'canceled'\s*\|\|\s*kind\s*===\s*'fail'/.test(saveFileSrc),
    '前端又把「失败」和「取消」一起吞成空串（B01-06：失败被静默，界面无提示）')
  assert(/throw\s+new\s+Error/.test(saveFileSrc),
    '前端没有把保存失败抛出去（B01-06：调用方的 catch 接不到，错误提示不出现）')
  // 三态判定要齐全
  for (const k of ['ok', 'fail', 'canceled']) {
    assert(new RegExp("'" + k + "'").test(saveFileSrc),
      `前端的结局判定缺少 '${k}' 分支（主进程返回的三种结果没被完整区分）`)
  }

  // ---- 输出 ----
  if (failed) {
    console.error('✗ main-ipc-contract-probe 失败：')
    for (const f of failures) console.error('   - ' + f)
    process.exit(1)
  }
  console.log('✓ main-ipc-contract-probe 通过')
  console.log('  判据 A 契约层：ok/fail/canceled 三态互斥，safe/safeReject 语义正确')
  console.log('  判据 B handler：dialogs 走契约层，webview-guard 接住 loadURL reject')
  console.log('  判据 C 状态归属：选区会话有看门狗+销毁兜底，穿透态挂实例，监听有终点，资产名归一化')
})().catch((e) => {
  console.error('✗ 探针自身异常：', e && e.stack)
  process.exit(1)
})
