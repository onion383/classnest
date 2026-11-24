// =========================================================================
// main.atomic-write.js —— 配置/状态文件的原子写（v8 审查 E01-05 / E02-01 / N3-15）
//
// 为什么需要：主进程里有十来处 `fs.writeFileSync(目标, JSON.stringify(...))`。
// writeFileSync 会先截断目标再写，掉电/强杀正好卡在中间就留下半截 JSON；下次
// 启动解析失败 → 静默回退默认值（自定义数据目录、USB 开关、窗口位置全丢），
// 用户看不到任何报错。
//
// 做法：写同目录临时文件 → fsync → rename 覆盖目标。同目录 rename 在 Windows /
// Linux / macOS 上都是原子替换；写临时文件失败时目标文件一个字节都不动。
//
// 叶子模块：只依赖 node:fs，不反向依赖任何业务模块。
// =========================================================================

const fs = require('node:fs')

function tmpPathFor(file) {
  // 同目录：跨设备 rename 会 EXDEV，tmp 必须与目标同盘同目录
  return `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// 同步版：写成功后返回 true；失败抛错（调用方按原语义处理），并尽力清掉临时文件。
// impl 可注入（单测用）：默认真实 fs。注入对象至少需要 openSync / writeFileSync /
// closeSync / renameSync / unlinkSync；fsyncSync 缺失时跳过。
function atomicWriteFileSync(file, data, { fs: impl = fs } = {}) {
  const tmp = tmpPathFor(file)
  let fd
  try {
    fd = impl.openSync(tmp, 'w')
    impl.writeFileSync(fd, data)
    if (typeof impl.fsyncSync === 'function') {
      try { impl.fsyncSync(fd) } catch (_) { /* 部分文件系统不支持 fsync，不影响原子替换 */ }
    }
    impl.closeSync(fd)
    fd = undefined
    impl.renameSync(tmp, file)
    return true
  } catch (err) {
    if (fd !== undefined) { try { impl.closeSync(fd) } catch (_) { /* 已关闭 */ } }
    try { impl.unlinkSync(tmp) } catch (_) { /* tmp 可能没建出来 */ }
    throw err
  }
}

// 异步版：给启动期/日志轮转等异步路径用，语义与同步版一致。
// impl 可注入，默认 fsp（fs.promises）；注入对象需要 open / rename / unlink，
// 其中 open 返回带 writeFile / sync / close 的句柄。
async function atomicWriteFile(file, data, { fs: impl = fs.promises } = {}) {
  const tmp = tmpPathFor(file)
  let fh
  try {
    fh = await impl.open(tmp, 'w')
    await fh.writeFile(data)
    if (typeof fh.sync === 'function') {
      try { await fh.sync() } catch (_) { /* 同上 */ }
    }
    await fh.close()
    fh = null
    await impl.rename(tmp, file)
    return true
  } catch (err) {
    if (fh) { try { await fh.close() } catch (_) { /* 已关闭 */ } }
    try { await impl.unlink(tmp) } catch (_) { /* tmp 可能没建出来 */ }
    throw err
  }
}

function atomicWriteJsonSync(file, obj, indent = 0, opts = {}) {
  return atomicWriteFileSync(file, JSON.stringify(obj, null, indent), opts)
}

async function atomicWriteJson(file, obj, indent = 0, opts = {}) {
  return atomicWriteFile(file, JSON.stringify(obj, null, indent), opts)
}

module.exports = {
  atomicWriteFileSync,
  atomicWriteFile,
  atomicWriteJsonSync,
  atomicWriteJson,
  tmpPathFor,
}
