// =========================================================================
// dbManager.js —— 多库加密核心（聚合入口）
//
// 设计要点（对应需求「多库加密」）：
//   1. 每个班主任一个「自含加密库」：业务数据 + 应用设置 + 账号(含恢复密钥) 同库。
//   2. 服务端维护 index.db（主密钥加密），登记每个班主任库：
//        slug / 账号 / 库密钥(用主密钥包裹)。
//   3. 登录时用 index.db 定位账号 -> 解开库密钥 -> 打开对应班主任库 -> 校验密码。
//   4. 用 AsyncLocalStorage 把「当前请求所属的班主任库」绑定到请求上下文，
//      已有的 db.prepare(...) / tableService 等代码无需逐个改造即可命中正确库。
//
// 密钥约定：
//   - 主密钥 DB_MASTER_KEY：环境变量或 student-backend/.env，用于解密 index.db 与包裹库密钥。禁止硬编码。
//   - 库密钥：每个班主任库独立生成的随机密钥（32 字节 hex），用主密钥 AES-256-GCM 包裹后存入 index.db。
//
// 本文件为原 student-backend/dbManager.js 拆分后的主入口：实现按职责搬运到
// dbManager.<part>.js 子模块，本文件仅汇总导出，导出接口与原文件完全一致。
//   dbManager.base.js    主密钥 / 数据目录与资源目录 / 密钥包裹 / 上下文缓存 / 连接原语 / index 登记
//   dbManager.conn.js    连接管理（打开/驱逐/取库/暖机）
//   dbManager.account.js 班主任账号（新建/删除/定位）
//   dbManager.backup.js  备份恢复与就地加密转换
//   dbManager.memory.js  AI 长期记忆
//   dbManager.skills.js  AI 技能
// =========================================================================

const base = require('./dbManager.base');
const conn = require('./dbManager.conn');
const account = require('./dbManager.account');
const backup = require('./dbManager.backup');
const memory = require('./dbManager.memory');
const skills = require('./dbManager.skills');

module.exports = {
  ensureIndex: base.ensureIndex,
  createTeacher: account.createTeacher,
  deleteTeacher: account.deleteTeacher,
  resolveByUsername: account.resolveByUsername,
  // 多班级：按班打开 / 列班级 / 账号归属（懒迁移）
  resolveClass: account.resolveClass,
  listClasses: account.listClasses,
  linkAccount: account.linkAccount,
  backfillPasswordHash: account.backfillPasswordHash,
  registrySetClassName: base.registrySetClassName,
  accountFindByUsername: base.accountFindByUsername,
  // 多班级：改密/改账号名要同步账号表（各库 users 表不再作为校验依据）
  accountSetPassword: base.accountSetPassword,
  accountRename: base.accountRename,
  resolveByDbFile: account.resolveByDbFile,
  isProtected: account.isProtected,
  enablePrivacy: account.enablePrivacy,
  disablePrivacy: account.disablePrivacy,
  rewrapPassword: account.rewrapPassword,
  // 超级隐私模式：解锁后的库钥匙只在内存；锁库用于登出
  getUnlockedKey: base.getUnlockedKey,
  getUnlockSource: base.getUnlockSource,
  lockDb: conn.lockDb,
  registryFindByUsername: base.registryFindByUsername,
  registryFindBySlug: base.registryFindBySlug,
  // 多班级：同一用户名的所有班级（改用户名时要把每一行都改掉）
  registryFindAllByUsername: base.registryFindAllByUsername,
  // 改账号名用：只改 registry.username，不碰库钥匙包裹
  registryRename: base.registryRename,
  wrapKey: base.wrapKey,
  unwrapKey: base.unwrapKey,
  wrapKeyBySecret: base.wrapKeyBySecret,
  decryptBundleKey: base.decryptBundleKey,
  current: conn.current,
  currentSlug: conn.currentSlug,
  withDb: conn.withDb,
  // 异步路由：next() 立即返回，用响应结束事件兜住「在用」计数（B04-v3-1）
  holdConnUntilResponse: conn.holdConnUntilResponse,
  exportBundle: backup.exportBundle,
  restoreBundle: backup.restoreBundle,
  convertDbEncryption: backup.convertDbEncryption,
  registrySetEncrypted: base.registrySetEncrypted,
  registryDelete: base.registryDelete,
  evictConn: conn.evictConn,
  // 扫描子进程（worker.scan.js）要自己开一个独立连接开库 —— 它没有请求上下文 ALS，
  // 不能走 withDb，故需要 openFile 这个底层原语。
  openFile: base.openFile,
  // 快照/还原用：库文件路径（按 slug）与快照目录
  dbFilePath: backup.dbFilePath,
  snapshotsDir: base.snapshotsDir,
  registryList: base.registryList,
  registryListValid: account.registryListValid,
  warmup: conn.warmup,
  // 让路链 warmup 步骤用：提前打开「最近使用」的库，把首屏第一笔 KDF + openFile 挪出请求路径
  warmupMostRecent: conn.warmupMostRecent,
  // AI 长期记忆（md 文档，随备份/恢复一起带走）
  readMemory: memory.readMemory,
  writeMemory: memory.writeMemory,
  appendMemory: memory.appendMemory,
  // AI 技能（可编辑的 md 指令文件）
  normalizeSkillName: skills.normalizeSkillName,
  listSkills: skills.listSkills,
  skillExists: skills.skillExists,
  readSkill: skills.readSkill,
  writeSkill: skills.writeSkill,
  deleteSkill: skills.deleteSkill,
  readSkills: skills.readSkills,
  // 数据目录分层布局（v2）：root 下固定 core / content / cache / logs 四层。
  // 所有具体路径都从 dbManager.paths.js 经 base 转出，业务代码不要再自己拼 dataDir。
  dataDir: base.dataDir,
  coreDir: base.coreDir,
  contentDir: base.contentDir,
  cacheDir: base.cacheDir,
  logsDir: base.logsDir,
  indexPath: base.indexPath,
  dbMasterKeyPath: base.dbMasterKeyPath,
  jwtSecretPath: base.jwtSecretPath,
  sessionsPath: base.sessionsPath,
  lastDbPath: base.lastDbPath,
  // dbFilePath 已在上面从 backup 门面导出（backup 内部也取自 paths），不要重复声明
  uploadsDir: base.uploadsDir,
  backgroundDir: base.backgroundDir,
  thumbsDir: base.thumbsDir,
  trashDir: base.trashDir,
  receiptTrashDir: base.receiptTrashDir,
  memoryDir: base.memoryDir,
  skillsDirRoot: base.skillsDirRoot,
  ffmpegCacheDir: base.ffmpegCacheDir,
  backendLogPath: base.backendLogPath,
  startupLogPath: base.startupLogPath,
  inpLogPath: base.inpLogPath,
  // 备份包 v3 要按 slug 收集「这个账号自己的」文件：AI 技能目录是按 slug 分的
  // （snapshotsDir 本文件上面已经导出过，别再加一行）
  skillsDir: skills.skillsDir,
};
