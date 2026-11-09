// =========================================================================
// config.js —— 应用配置 / 路径 / 密钥
//
// 统一管理 userData 下的配置与密钥，供主进程各模块复用：
//   - app-config.json   —— 数据目录 / 缓存目录等可配置项（独立于业务数据目录，启动即读）
//   - node-compile-cache —— Node 侧模块字节码编译缓存目录
//   - 安全通道主密钥     —— 运行期随机，参与前后端 HKDF 派生态
//   - DB 静态加密主密钥  —— safeStorage/DPAPI 持久化（首启现场生成）
//
// 叶子模块：仅依赖 electron(app, safeStorage) 与 path/fs/crypto，不反向依赖其它业务模块。
// =========================================================================

const { app, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

// Node 编译缓存（code cache）：把主进程启动过程中加载的模块字节码缓存到磁盘，
// 下一次启动直接复用、跳过解析 + 编译（仅对 Node 侧模块生效，收益在后续启动）。
// 目录固定放 userData 下，随版本/源码变更自动失效重建。
function resolveCompileCacheDir() {
  return path.join(app.getPath('userData'), 'node-compile-cache')
}

// 安全通道主密钥（方案 A 的认证锚点 K_master）：本次运行周期内生成一次并复用于
// 「后端 fork env 注入」+「preload IPC 提供渲染层」。只参与前后端 HKDF 派生态，
// 不进线上传输。后端崩溃自动重启时复用同一值，保证已建立会话/前端持有的密钥仍一致。
let channelMasterKey = null
function getMasterKey() {
  if (!channelMasterKey) channelMasterKey = crypto.randomBytes(32).toString('hex')
  return channelMasterKey
}

// 数据目录/缓存目录解析（app-config.json，存于 userData，独立于业务数据目录以便启动即读）
function getAppConfigPath() {
  return path.join(app.getPath('userData'), 'app-config.json')
}
// 内存缓存：启动阶段 resolveDataDir / resolveThumbsDir / getDbMasterKey 会反复调用，
// 原先每次都同步 readFileSync 一次。同一进程内配置的唯一写入点是 saveAppConfig，保存后刷新缓存。
let appConfigCache = null
function resolveAppConfig() {
  if (appConfigCache) return appConfigCache
  try { appConfigCache = JSON.parse(fs.readFileSync(getAppConfigPath(), 'utf8')) || {} } catch (_) { appConfigCache = {} }
  return appConfigCache
}
function saveAppConfig(patch) {
  const next = { ...resolveAppConfig(), ...patch }
  if (!next.dataDir) delete next.dataDir
  if (!next.thumbsDir) delete next.thumbsDir
  if (!next.skillsDir) delete next.skillsDir
  // 写失败必须抛错：否则「切配置」这一步会静默失败，而调用方（如数据目录搬迁）
  // 会继续删掉旧目录，导致数据在新目录、配置却指向已删除的旧目录。
  try {
    fs.writeFileSync(getAppConfigPath(), JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('[main] 写入 app-config 失败:', err?.message || err)
    throw new Error('配置文件写入失败：' + (err?.message || err))
  }
  appConfigCache = next
  return next
}
// 数据库主目录：默认 userData/data，可被用户配置覆盖
function resolveDataDir() {
  const cfg = resolveAppConfig()
  return cfg.dataDir ? path.resolve(cfg.dataDir) : path.join(app.getPath('userData'), 'data')
}
// 相册缩略图缓存目录：默认位于数据目录下 album-thumbs，可单独配置为独立缓存位置
function resolveThumbsDir() {
  const cfg = resolveAppConfig()
  if (cfg.thumbsDir) return path.resolve(cfg.thumbsDir)
  return path.join(resolveDataDir(), 'album-thumbs')
}
// AI 技能 md 目录：默认位于数据目录下 ai-skills，可单独配置为独立目录
function resolveSkillsDir() {
  const cfg = resolveAppConfig()
  if (cfg.skillsDir) return path.resolve(cfg.skillsDir)
  return path.join(resolveDataDir(), 'ai-skills')
}

// DB 静态加密主密钥（方案 A：首启现场随机生成 + safeStorage/DPAPI 持久化）：
// 取代原先明文写在 student-backend/.env、随安装包分发的 DB_MASTER_KEY。
// - Windows 上 safeStorage 底层走 DPAPI，密文绑定当前系统用户，解开安装包拿不到明文。
// - 首启：文件不存在 → 生成随机 32 字节 → 加密写 userData/data/db-master.key。
// - 之后：解密文件复用同一把钥匙，保证持久库可连续打开。
// - 兜底：safeStorage 不可用（非 Windows 等）时仅返回运行期随机值，不落明文文件。
// - 46 适配：同步的 isEncryptionAvailable / encryptString / decryptString 在 Electron 46
//   移除，这里只用 isAsyncEncryptionAvailable / encryptStringAsync / decryptStringAsync。
//   官方保证 encryptString 的旧密文可被 decryptStringAsync 解开，故本次迁移不换钥匙、旧库照常打开。
//   异步加密器在 app ready 之后惰性初始化，所以调用点仍必须留在 whenReady 内（fork 不能提前）。

let dbMasterKey = null
// 单个在途 Promise：启动 fork、后端自动重连、数据目录搬迁重启都可能并发来取钥匙。
// 同步版靠「先查缓存再赋值」天然幂等；异步化后不锁这一步，两个调用会各生成一把新钥匙，
// 后者写回文件后旧库就再也打不开了。
let dbMasterKeyPromise = null

async function resolveDbMasterKey() {
  // 主密钥文件与数据库同目录存放，随数据目录一起迁移；解析用配置后的 dataDir，保证两者一致
  const keyFile = path.join(resolveDataDir(), 'db-master.key')
  const randomKey = () => crypto.randomBytes(32).toString('hex')
  try {
    const available = await safeStorage.isAsyncEncryptionAvailable()
    if (fs.existsSync(keyFile) && available) {
      const blob = fs.readFileSync(keyFile)
      try {
        const { result, shouldReEncrypt } = (await safeStorage.decryptStringAsync(blob)) || {}
        // 异步版返回对象而不是字符串。拿到空值必须当失败处理，否则会用空密钥 fork 后端，
        // 表现成「加密库打不开」，比解密抛错难查得多。这里只验非空，不改变原有明文格式口径。
        if (typeof result !== 'string' || !result) throw new Error('解密结果为空')
        if (shouldReEncrypt) {
          // 密钥轮换或出现更高安全级别的密钥：明文不变，只把密文用新密钥重新加密写回。
          // 覆盖前先备份；任一步失败都保留原密文，本次照常用解出的明文。
          try {
            const fresh = await safeStorage.encryptStringAsync(result)
            const backupFile = `${keyFile}.bak-${Date.now()}`
            fs.copyFileSync(keyFile, backupFile)
            fs.writeFileSync(keyFile, fresh)
            console.log('[main] DB 主密钥密文已按新安全级别重新加密，旧密文备份:', backupFile)
          } catch (reErr) {
            console.error('[main] DB 主密钥重加密失败，保留原密文:', reErr?.message || reErr)
          }
        }
        return result
      } catch (err) {
        // 解密失败可能只是瞬时故障（DPAPI 异常/文件损坏）。覆盖旧文件会让原密钥永久丢失，
        // 因此先留一份带时间戳的备份；备份失败则宁可本次用运行期随机值也不覆盖。
        const backupFile = `${keyFile}.bak-${Date.now()}`
        try {
          fs.copyFileSync(keyFile, backupFile)
          console.error('[main] DB 主密钥解密失败，已备份旧密钥文件后重新生成:', err?.message || err, '→', backupFile)
        } catch (backupErr) {
          console.error('[main] DB 主密钥解密失败且备份失败，为避免覆盖原密钥，本次使用运行期随机值:', backupErr?.message || backupErr)
          return randomKey()
        }
      }
    }
    const key = randomKey()
    if (available) {
      try {
        fs.mkdirSync(path.dirname(keyFile), { recursive: true })
        fs.writeFileSync(keyFile, await safeStorage.encryptStringAsync(key))
      } catch (err) {
        console.error('[main] DB 主密钥持久化失败，将仅本次运行有效:', err?.message || err)
      }
    }
    return key
  } catch (err) {
    console.error('[main] DB 主密钥初始化失败，使用运行期随机值:', err?.message || err)
    return randomKey()
  }
}

async function getDbMasterKey() {
  if (dbMasterKey) return dbMasterKey
  if (!dbMasterKeyPromise) {
    // resolveDbMasterKey 内部已兜住所有已知失败，这里再兜一层意外 reject：
    // 关键是所有等待者拿到同一把钥匙，且失败后不要把 Promise 清掉重新解析出第二把。
    dbMasterKeyPromise = resolveDbMasterKey()
      .then((key) => { dbMasterKey = key; return key })
      .catch((err) => {
        console.error('[main] DB 主密钥解析异常，使用运行期随机值:', err?.message || err)
        dbMasterKey = crypto.randomBytes(32).toString('hex')
        return dbMasterKey
      })
  }
  return dbMasterKeyPromise
}

module.exports = {
  resolveCompileCacheDir,
  getMasterKey,
  getAppConfigPath,
  resolveAppConfig,
  saveAppConfig,
  resolveDataDir,
  resolveThumbsDir,
  resolveSkillsDir,
  getDbMasterKey,
}