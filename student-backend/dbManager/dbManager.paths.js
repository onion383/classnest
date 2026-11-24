// =========================================================================
// dbManager.paths.js —— 数据目录分层布局的唯一来源（v2）
//
// 目录模型：用户可配置的「数据目录」只有一个根 root，根下固定四层：
//   core/     index.db、@slug.db(+wal/shm)、db-master.key、.jwt-secret、.sessions.json、.auth-policy.json、.last-db
//   content/  uploads/ snapshots/ album-trash/ receipt-trash/ ai-memory/ ai-skills/
//   cache/    album-thumbs/ ffmpeg/          （可再生）
//   logs/     backend.log startup.log inp.log
//
// 这是后端所有磁盘路径的唯一定义处：其它模块一律通过本模块或 dbManager 门面取常量，
// 不允许再 path.join(dataDir, ...)。好处是以后调整分层只改这一个文件。
//
// 数据目录从一开始就按此布局创建：后端模块加载时由 ensureDir 建好四层，主进程在
// app.whenReady 早期也会先建一次（见 main.config.js 的 ensureDataDirs）。
// 产品尚无旧版数据需要升级，因此不存在迁移脚本、布局标记或任何 v1 回退逻辑。
//
// 叶子模块：只依赖 fs / path / BACKEND_ROOT，不反向依赖其它业务模块。
// =========================================================================

const path = require('path');
const fs = require('fs');
const { BACKEND_ROOT } = require('../utils/backendRoot');

// 数据根目录：打包后由 Electron 主进程经 DATA_DIR 指向 userData，兜底用 student-backend/data
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(BACKEND_ROOT, 'data');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
ensureDir(dataDir);

// ---- 四层 ----
const coreDir = ensureDir(path.join(dataDir, 'core'));
const contentDir = ensureDir(path.join(dataDir, 'content'));
const cacheDir = ensureDir(path.join(dataDir, 'cache'));
const logsDir = ensureDir(path.join(dataDir, 'logs'));

// ---- core：库文件与本机密钥（不可再生，随整目录搬迁） ----
const indexPath = path.join(coreDir, 'index.db');
const dbMasterKeyPath = path.join(coreDir, 'db-master.key');
const jwtSecretPath = path.join(coreDir, '.jwt-secret');
const sessionsPath = path.join(coreDir, '.sessions.json');
// 登录保持天数（按账号分桶）。与 .sessions.json 同层同性质：本机凭据，不进备份包。
const authPolicyPath = path.join(coreDir, '.auth-policy.json');
const lastDbPath = path.join(coreDir, '.last-db');
function dbFilePath(slug) {
  // 第二道闸（K01-16）：路径安全不能只依赖 registry 查得到 —— slug 会从包 meta / token
  // 等外部输入一路传进来。与 snapshotsDir / skillsDir 同一白名单，非法直接拒绝，
  // 绝不落到 path.join 里（否则 `../` 可拼出 core 之外的路径）。
  const s = String(slug == null ? '' : slug);
  if (!/^[A-Za-z0-9_@-]+$/.test(s)) throw new Error('非法的库标识');
  return path.join(coreDir, `${s}.db`);
}

// ---- content：用户内容（随备份包走） ----
const uploadsDir = ensureDir(path.join(contentDir, 'uploads'));
const backgroundDir = ensureDir(path.join(uploadsDir, 'background'));
const trashDir = ensureDir(path.join(contentDir, 'album-trash'));
const receiptTrashDir = ensureDir(path.join(contentDir, 'receipt-trash'));
const snapshotsDirRoot = ensureDir(path.join(contentDir, 'snapshots'));
const memoryDir = ensureDir(path.join(contentDir, 'ai-memory'));
const skillsDirRoot = ensureDir(path.join(contentDir, 'ai-skills'));
function snapshotsDir(slug) {
  const safe = /^[A-Za-z0-9_@-]+$/.test(String(slug || '')) ? String(slug) : 'default';
  return ensureDir(path.join(snapshotsDirRoot, safe));
}
function skillsDir(slug) {
  const safe = /^[A-Za-z0-9_@-]+$/.test(String(slug || '')) ? String(slug) : 'default';
  return ensureDir(path.join(skillsDirRoot, safe));
}

// ---- cache：可再生的缓存（不进备份包） ----
const thumbsDir = ensureDir(path.join(cacheDir, 'album-thumbs'));
const ffmpegCacheDir = ensureDir(path.join(cacheDir, 'ffmpeg'));

// ---- logs：运行日志 ----
const backendLogPath = path.join(logsDir, 'backend.log');
const startupLogPath = path.join(logsDir, 'startup.log');
const inpLogPath = path.join(logsDir, 'inp.log');

module.exports = {
  dataDir,
  ensureDir,
  coreDir,
  contentDir,
  cacheDir,
  logsDir,
  indexPath,
  dbMasterKeyPath,
  jwtSecretPath,
  sessionsPath,
  authPolicyPath,
  lastDbPath,
  dbFilePath,
  uploadsDir,
  backgroundDir,
  trashDir,
  receiptTrashDir,
  snapshotsDirRoot,
  snapshotsDir,
  memoryDir,
  skillsDirRoot,
  skillsDir,
  thumbsDir,
  ffmpegCacheDir,
  backendLogPath,
  startupLogPath,
  inpLogPath,
};
