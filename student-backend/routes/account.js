const express = require('express');
const router = express.Router();
// jsonwebtoken 只在改用户名/改密码等「重新签发 Token」时用到，不需要在后端就绪前加载：
// 改为首次调用时才 require，避免把它（连带 semver / side-channel 等）的冷加载成本
// 压在启动关键路径上（行为完全不变）。
let _jwt = null;
const useJwt = () => (_jwt || (_jwt = require('jsonwebtoken')));
const { db } = require('../db');
const userStore = require('../services/userStore');
const dbManager = require('../dbManager/dbManager');
const { resolveSecurityLevel } = require('../utils/securityLevel');
// bcryptjs 只在改用户名/改密码/删除账号等「用户操作」里用到，不需要在后端就绪前加载：
// 改为首次调用时才 require，避免把它的冷加载成本压在启动关键路径上（行为完全不变）。
// 惰性加载逻辑已下沉到 services/bcryptAsync.js，本文件只引用它的异步接口。
const { hash: bcryptHash, compare: bcryptCompare } = require('../services/bcryptAsync');
const { SECRET, auth, TOKEN_SIGN_OPTS, TOKEN_COOKIE_MAX_AGE, signMediaToken } = require('../middleware/auth');
const secureChannel = require('../services/secureChannel');
const { pickPhrase, deriveRestoreHash, formatPhrase } = require('../services/recoveryKey');
const { normalizeUsername, usernameError } = require('../services/usernameRules');
const sessions = require('../services/sessions');
// 凭证变更（改密 / 删账号）后「全账号会话失效」的唯一动作层，规则不在路由里各写一遍
const { revokeAccountSessions, rotateAccountSessions } = require('../services/credentialChange');
const { renameUsernameWithCompensation } = require('../services/accountRename');
// 备份包 v3（ZIP）：库 + 用户文件 + 清单，流式写 / 解包校验
const { writeBundle } = require('../services/backupArchive');
// v3 包的落盘（写库 + 替换目录 + 清列缓存）只有一份，两个恢复入口共用
const { receiveAndVerify, applyVerifiedBundle, dropTmp } = require('../services/bundleRestore');

// v3 备份包上传：multer 惰性加载（只在「还原」时用，不压在启动路径上）
let _backupUpload = null;
function backupUploadMw() {
  if (!_backupUpload) {
    const multer = require('multer');
    const os = require('os');
    const path = require('path');
    const dir = path.join(os.tmpdir(), 'classnest-restore');
    require('fs').mkdirSync(dir, { recursive: true });
    _backupUpload = multer({ dest: dir, limits: { fileSize: 8 * 1024 * 1024 * 1024 } });
  }
  return _backupUpload.single('file');
}

// 重置恢复密钥：为当前登录账号生成一组新的 12 词恢复密钥并保存哈希。
// 生成的密钥只在本次响应返回一次（前端提示先保存再确认）。
router.get('/recovery-key', auth(), (req, res) => {
    const phrase = pickPhrase();
  const hash = deriveRestoreHash(phrase);
  userStore.updateRecoveryHash(req.user.userId, hash);
  res.json({ phrase: formatPhrase(phrase), recoveryKey: phrase });
});

// 导出密码校验 + 「库钥匙怎么随包带回」的唯一实现（v2 JSON 包与 v3 ZIP 包共用）。
// 安全相关的东西不能有两个版本：任何一处放宽，另一处就是漏洞。
// 返回 { error, status?, bundle, wantEncrypt, keyFields }
async function resolveExportKeying({ slug, user, password, encrypt, dbPassword }) {
  const hasPassword = !!user.password;
  // 有密码账号：必须提供并校验正确的登录密码（只有本人能导出）
  if (hasPassword) {
    if (!password) return { error: '请输入登录密码以导出数据库', status: 400 };
    if (!await bcryptCompare(password, user.password)) {
      return { error: '密码错误，只有本人能导出数据库', status: 401 };
    }
  }

  const bundle = dbManager.exportBundle(slug);
  const wantEncrypt = encrypt === '1';

  // 解析用于包裹库钥匙的「导出密码」：
  //   - 勾选加密且源库本身是加密库：
  //       有密码账号：dbPassword 留空则默认用账号密码；填了则以输入框为准。
  //       无密码账号：必须提供 dbPassword（否则没有口令可供派生包裹钥匙）。
  //   - 不勾选加密、或源库是明文库：库钥匙明文随包带回（明文库无钥匙，无需任何口令）。
  let wrapPwd = null;
  if (bundle.encrypted && wantEncrypt) {
    if (hasPassword) {
      wrapPwd = dbPassword && dbPassword.length ? dbPassword : password;
    } else {
      if (!dbPassword || !dbPassword.length) {
        return { error: '该账号未设置密码，请设置一个导出密码以加密备份', status: 400 };
      }
      wrapPwd = dbPassword;
    }
  }

  const keyFields = {};
  if (!bundle.encrypted) {
    // 明文库数据本身不加密，「用导出密码加密」对该库无意义，包内不携带库钥匙
    keyFields.key = null;
  } else if (wantEncrypt) {
    // 库钥匙用导出密码派生钥匙包裹，换机后可用该密码解包恢复
    keyFields.wrappedByPassword = dbManager.wrapKeyBySecret(bundle.key, wrapPwd);
  } else {
    // 未加密：库钥匙明文随包带回，换机免密恢复
    keyFields.key = bundle.key;
  }
  return { bundle, wantEncrypt, keyFields };
}

// 备份导出 v3（ZIP）：库 + 用户文件 + 清单，流式写、不驻留内存。
// 密码校验与库钥匙包裹走 resolveExportKeying（与恢复侧同一份实现）。
router.post('/export-zip', auth(), async (req, res) => {
  const slug = req.user && req.user.dbSlug ? req.user.dbSlug : 'default';
  const { password, encrypt = '1', dbPassword } = req.body || {};
  const user = userStore.findById(req.user.userId);
  if (!user) return res.status(401).json({ error: '账号不存在' });

  const keying = await resolveExportKeying({ slug, user, password, encrypt, dbPassword });
  if (keying.error) return res.status(keying.status || 400).json({ error: keying.error });
  const bundle = keying.bundle;

  // WAL 模式下只拷 .db 会丢掉最近一次提交（-wal 里还没 checkpoint）—— 三个文件一起带，
  // 还原端按同一组文件名放回去，SQLite 自己会重放 WAL。
  const dbFiles = [bundle.filePath, `${bundle.filePath}-wal`, `${bundle.filePath}-shm`]
    .filter((f) => { try { return require('fs').statSync(f).isFile() } catch (_) { return false } })
    .map((f) => ({ name: `db/${require('path').basename(f)}`, path: f }));

  const meta = {
    version: 3,
    slug: bundle.slug,
    username: bundle.username,
    encrypted: bundle.encrypted,
    exportedAt: new Date().toISOString(),
    ...keying.keyFields,
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const asciiName = `classnest-backup-${String(slug).replace(/^@/, '')}-${stamp}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`班集备份-${stamp}.zip`)}`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    await writeBundle({
      meta,
      files: dbFiles,
      texts: (() => {
        const memory = dbManager.readMemory(slug) || '';
        return memory ? [{ name: 'memory.md', data: memory }] : [];
      })(),
      dirs: [
        { prefix: 'uploads', dir: dbManager.uploadsDir },
        { prefix: 'ai-skills', dir: dbManager.skillsDir(slug) },
        { prefix: 'album-trash', dir: dbManager.trashDir },
        { prefix: 'receipt-trash', dir: dbManager.receiptTrashDir },
        { prefix: 'snapshots', dir: dbManager.snapshotsDir(slug) },
      ],
    }, res);
    res.end();
  } catch (err) {
    // 已经开始写响应体了：只能中断连接，让客户端看到「下载不完整」而不是一个坏包
    console.error('[backup] 导出 v3 失败:', err && err.message);
    try { res.destroy(); } catch (_) { /* 已断开 */ }
  }
});

// 备份恢复（v3 ZIP）：上传整包 → 解到临时目录 → 逐项校验清单 → 才动现有文件。
//
// 顺序是这个 handler 的全部重点：
//   ① 解包 + 校验（此时**一个现有文件都没动**，包坏/缺项/名字不安全都在这步失败）
//   ② 校验通过才恢复库（复用 v2 的 restoreBundle：evict 连接 + 写库 + 改 registry）
//   ③ 最后替换各文件目录，旧目录改名成 .bak-<时间戳>，不删
// 中途失败最坏情况是「库换了、目录还没换」，此时 .bak 目录还在，用户能手动拿回。
// —— v3 包落盘的公共部分已下沉到 services/bundleRestore.js ——
// 这里只做「入口差异」：slug 从哪来、要不要确认覆盖、要不要签发登录态。
// 落盘（写库 + 替换目录 + 清列缓存）只有一份实现 —— 它动的是用户的整库和全部文件。

router.post('/restore-zip', auth(), (req, res, next) => backupUploadMw()(req, res, next), async (req, res) => {
  const curSlug = req.user && req.user.dbSlug ? req.user.dbSlug : 'default';
  if (dbManager.isProtected(req.user.username)) {
    return res.status(400).json({ error: '请先在系统设置中关闭超级隐私模式，再恢复备份' });
  }
  if (!req.file) return res.status(400).json({ error: '没有收到备份文件' });

  let recv;
  try {
    recv = await receiveAndVerify(req.file);
  } catch (err) {
    dropTmp(null, req.file.path);
    return res.status(400).json({ error: err.message || '备份包无法读取' });
  }

  const { tmpDir, meta, manifest } = recv;
  if (meta.slug !== curSlug) {
    dropTmp(tmpDir, req.file.path);
    return res.status(400).json({ error: '备份包不属于当前账号，不能用它恢复' });
  }

  try {
    const out = await applyVerifiedBundle({
      tmpDir, meta, manifest, slug: curSlug, username: req.user.username, body: req.body,
    });
    res.json({ message: '恢复成功', ...out });
  } catch (err) {
    res.status(400).json({ error: err.message || '恢复失败' });
  } finally {
    dropTmp(tmpDir, req.file.path);
  }
});

// 备份恢复（v3 ZIP · 离线引导，无需登录）：
// 「新电脑只装了软件、本机一个账号都没有」时唯一能走的路径 —— 没有 JWT 可依，
// 所以库身份（slug / 账号名）只能取自包内的 bundle.json。
//
// 与 /restore-zip 的关键差异只有「slug 从哪来」和「要不要确认覆盖」：
//   · 本机已有同一 slug 且未确认 → 409 needConfirm，绝不静默覆盖现有数据
//   · 已有且是超级隐私模式 → 拒绝（离线恢复会用主密钥重新包裹库钥匙，等于绕过隐私保护）
router.post('/restore-zip-offline', (req, res, next) => backupUploadMw()(req, res, next), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '没有收到备份文件' });

  let recv;
  try {
    recv = await receiveAndVerify(req.file);
  } catch (err) {
    dropTmp(null, req.file.path);
    return res.status(400).json({ error: err.message || '备份包无法读取' });
  }

  const { tmpDir, meta, manifest } = recv;
  const slug = meta.slug;
  // 账号名先归一（去首尾空白）再校验：registry 用它做登录定位，带空格的名字会「登不进去」
  const username = normalizeUsername(meta.username || '');
  const finish = (status, body) => { dropTmp(tmpDir, req.file.path); return res.status(status).json(body) };

  // 备份包是用户手里的普通 ZIP —— `bundle.json` 可以被人手改。
  // slug 会被拼进 ai-skills/<slug>、snapshots/<slug> 这类路径，所以**先按内部格式卡死**，
  // 不能指望下游 `restoreBundle` 的校验来兜（那是最后一道，不是第一道）。
  if (typeof slug !== 'string' || !/^@[0-9a-f]{12}$/.test(slug)) {
    return finish(400, { error: '备份包里的库标识无效，无法恢复' });
  }
  const nameErr = usernameError(username);
  if (nameErr) return finish(400, { error: `备份包里的账号名无效：${nameErr}` });

  const existing = dbManager.registryFindBySlug(slug);
  if (existing && existing.protect === 1) {
    return finish(400, { error: '该账号已开启超级隐私模式，请先登录并在系统设置中关闭后再恢复备份' });
  }
  if (existing && !(req.body && req.body.confirm)) {
    return finish(409, {
      needConfirm: true,
      message: `本机已存在账号「${existing.username}」，恢复将覆盖其现有数据，是否确认？`,
    });
  }

  let out;
  try {
    out = await applyVerifiedBundle({ tmpDir, meta, manifest, slug, username, body: req.body });
  } catch (err) {
    return finish(400, { error: err.message || '恢复失败' });
  }

  // 恢复成功后直接签发登录态，前端据此跳首页，不必再手动登录一次
  const sid = sessions.create(1, out.slug);
  const payload = { userId: 1, username: out.username, role: 'teacher', dbSlug: out.slug, sid };
  const token = useJwt().sign(payload, SECRET, TOKEN_SIGN_OPTS);
  secureChannel.bindAuth(req.sessionId, token);
  const mediaToken = signMediaToken(payload);
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: TOKEN_COOKIE_MAX_AGE });
  finish(200, {
    message: '恢复成功',
    ...out,
    token,
    mediaToken,
    user: { id: 1, username: out.username, role: 'teacher', dbSlug: out.slug },
  });
});

// 当前登录账号数据库的落盘加密状态（供设置页展示）。
router.get('/db-encryption', auth(), (req, res) => {
    const slug = req.user && req.user.dbSlug ? req.user.dbSlug : 'default';
  const rec = dbManager.registryFindBySlug(slug);
  res.json({ encrypted: !rec || rec.encrypted !== 0 });
});

// 就地切换当前登录账号数据库的加密方式（加密 <-> 明文）。
// 安全约束：slug 只从 JWT 取，绝不接受客户端传入的 slug，保证只改本人库、绝不波及其它账号。
// 以 NDJSON 流逐步上报进度（校验文件 / 转换数据库 / 校验文件），最后一行为最终结果。
router.post('/db-encryption', auth(), async (req, res) => {
  const slug = req.user && req.user.dbSlug ? req.user.dbSlug : 'default';
  const e = (req.body || {}).encrypt;
  const targetEncrypted = e === true || e === 1 || e === '1';
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const write = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) { /* 连接已断，忽略 */ } };
  try {
    // 超级隐私模式：明文/加密转换会重写 wrapped_key（主密钥包裹），等于关闭保护
    if (dbManager.isProtected(req.user.username)) {
      write({ type: 'done', ok: false, message: '超级隐私模式下不支持切换落盘加密，请先关闭超级隐私模式' });
      return res.end();
    }
    const result = await dbManager.convertDbEncryption(slug, targetEncrypted, (p) => {
      write({ type: 'progress', phase: p.phase, detail: p.detail, percent: p.percent });
    });
    write({ type: 'done', ok: true, changed: result.changed, encrypted: result.encrypted });
  } catch (err) {
    write({ type: 'done', ok: false, message: err.message || String(err) });
  } finally {
    res.end();
  }
});

// 修改用户名
//
// 账号名存在**两处**：业务库（<班主任>.db）的 users 表、以及 index.db 的 registry 登记表。
// registry.username 才是登录的唯一定位依据（见 dbManager.resolveByUsername），
// 两处必须同步改，否则会出现「改完名字登不进去 / 旧名字仍能登」的错乱。
router.put('/username', auth(), async (req, res) => {
    const { newUsername, password } = req.body || {};
  if (!newUsername) {
    return res.status(400).json({ error: '请输入新用户名' });
  }
  // 与注册共用同一套账号名规则：原实现只 trim，空白/超长/带路径分隔符的名字都能改成，
  // registry 与 users 表会一起变脏；这里补上长度与字符白名单校验。
  const newName = normalizeUsername(newUsername);
  const nameErr = usernameError(newName);
  if (nameErr) {
    return res.status(400).json({ error: nameErr });
  }

  const user = userStore.findById(req.user.userId);
  if (!user) return res.status(401).json({ error: '账号不存在' });
  // 免密账号（user.password 为空）没有密码可比对：与 PUT /password 保持同一短路语义，
  // 否则 nopass 用户改名时 bcryptCompare('', null) 恒为 false，永远卡在「密码错误」。
  // 有密码的账号（含隐私库）仍然必须校验，不能因为「没传 password」就跳过。
  if (user.password) {
    if (!password) return res.status(400).json({ error: '请输入当前密码' });
    if (!await bcryptCompare(password, user.password)) {
      return res.status(400).json({ error: '密码错误' });
    }
  }

  // 重名检查要跨全部账号：registry 是跨库的账号登记表，只查本库 users 会漏掉别的库。
  const occupied = dbManager.registryFindByUsername(newName);
  if (occupied && occupied.slug !== req.user.dbSlug) {
    return res.status(400).json({ error: '该用户名已被占用' });
  }
  // 同库内另有同名用户（registry 与业务库不同步的兜底）
  const existing = userStore.findIdByUsername(newName);
  if (existing && existing.id !== req.user.userId) {
    return res.status(400).json({ error: '该用户名已被占用' });
  }

  // 先更新 registry（登录定位的真源），再更新业务库 users。
  // 顺序理由：registry 决定「能不能用这个名字登录」，是权威侧；
  // 万一业务库更新失败，registry 已改而 users 未改的状态下一致性由下次改名修正，
  // 反过来（先改 users）则会出现「库里是新名、登记表是旧名」→ 新名永远登不进去。
  //
  // ⚠️ 但「由下次改名修正」并不成立：registry 已改而 users 未改时，
  // **新旧两个名字都登不进去**（registry 里的新名对不上 users 的旧名，
  // registry 里的旧名又已被覆盖）→ 用户被锁在门外，只能靠恢复密钥重置。
  // 所以这里显式做补偿：业务库写失败就把 registry 改回旧名，让「旧名仍可登录」重新成立。
  // 补偿实现见 services/accountRename.js（跨库无法用事务，只能显式回滚）。
  const renameResult = renameUsernameWithCompensation({
    registry: {
      findBySlug: (s) => dbManager.registryFindBySlug(s),
      rename: (s, name) => dbManager.registryRename(s, name),
    },
    slug: req.user.dbSlug,
    newName,
    fallbackOldName: user.username,
    applyUsersUpdate: () => userStore.updateUsername(req.user.userId, newName),
  });
  if (!renameResult.ok) {
    if (renameResult.reason === 'registry-update-failed') {
      return res.status(500).json({ error: '账号登记表更新失败，请重试' });
    }
    // 业务库写失败：已尽力把 registry 改回旧名（补偿成功与否见 compensated）。
    const msg = renameResult.compensated
      ? '用户名修改失败，已还原为原用户名，请重试'
      : '用户名修改失败且未能还原，请用恢复密钥重置用户名';
    console.error('[account] 改用户名失败:', renameResult.error && renameResult.error.message);
    return res.status(500).json({ error: msg });
  }

  // 多班级：账号名是**账号维度**的属性，不止当前这个库。
  // 上面只改名了「当前 slug 的 registry 行 + 当前库 users 表」，同账号的其它班还留着旧名；
  // 不同步的话，切到另一个班后按新名在登记表里一条都对不上，等于把自己锁在门外。
  // 这一步放在主流程成功之后，失败只记日志：改名已经生效，回滚反而会造成更割裂的状态。
  try {
    const oldName = user.username;
    for (const rec of dbManager.registryFindAllByUsername(oldName)) {
      if (rec.slug !== req.user.dbSlug) dbManager.registryRename(rec.slug, newName);
    }
    const acc = dbManager.accountFindByUsername(oldName);
    if (acc) dbManager.accountRename(acc.id, newName);
  } catch (err) {
    console.warn('[account] 同步账号名到其它班级失败:', err.message);
  }

  // 登录态里带的是旧用户名：重新签发一份含新用户名的 token，并同步换发媒体凭据。
  // （sid 沿用原会话，登出/会话名单机制不受影响）
  const payload = {
    userId: req.user.userId, username: newName, role: req.user.role,
    dbSlug: req.user.dbSlug, sid: req.user.sid,
  };
  const token = useJwt().sign(payload, SECRET, TOKEN_SIGN_OPTS);
  if (req.sessionId) secureChannel.bindAuth(req.sessionId, token);
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: TOKEN_COOKIE_MAX_AGE,
  });
  res.json({ message: '用户名修改成功', username: newName, token, mediaToken: signMediaToken(payload) });
});

// 多班级：吊销范围要覆盖该账号名下**所有**班级，而不只是当前这个。
// 一个账号多个班时，各班窗口签发的 token 带着各自的 dbSlug；只吊销当前班那一个，
// 另一个班窗口的旧 token 在改密后照样能用 —— 等于密码没改。
// 返回数组，当前班排首位（rotateAccountSessions 用第一个作为新会话的归属）。
function accountSlugsForRevoke(user) {
  const cur = user && user.dbSlug;
  let list = [];
  try {
    list = dbManager.listClasses(user.username).map((c) => c.slug);
  } catch (_) { /* 登记表读不到就退回单班，不影响改密本身 */ }
  const rest = list.filter((s) => s !== cur);
  const all = [cur, ...rest].filter(Boolean);
  return all.length ? all : cur;
}

// 凭证变更后「全量吊销旧会话 + 换发当前窗口登录态」的唯一实现。
// 改密（PUT /password）与切换安全等级（POST /security-level，会写入或清空密码）
// 都是凭证变更：既不能留着其它窗口的旧 token，也不能把当前窗口踢回登录页。
// 返回新 payload / token，供需要显式回传 token 的分支（本机恢复）使用。
function rotateLoginAfterCredentialChange(req, res) {
  const u = req.user;
  const { sid } = rotateAccountSessions(u.userId, accountSlugsForRevoke(u));
  const payload = {
    userId: u.userId, username: u.username, role: u.role, dbSlug: u.dbSlug, sid,
  };
  const token = useJwt().sign(payload, SECRET, TOKEN_SIGN_OPTS);
  if (req.sessionId) secureChannel.bindAuth(req.sessionId, token);
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: TOKEN_COOKIE_MAX_AGE,
  });
  // 全量吊销顺带作废了媒体凭据（<img> 的 token 绑同一个 sid）。沿用滑动续期的
  // 响应头协议下发新凭据：前端成功拦截器统一走 absorbRenewalTokens 落盘，
  // 改密 / 切安全等级的所有调用点一行都不用改，也不会出现「改完密码图片全裂」。
  res.set('X-Renewed-Token', token);
  res.set('X-Renewed-Media', signMediaToken(payload));
  return { payload, token };
}

// 当前账号名下的班级列表（设置弹窗打开时拉一次）
router.get('/classes', auth(), (req, res) => {
  const u = req.user;
  let classes = [];
  try {
    classes = dbManager.listClasses(u.username);
  } catch (err) {
    return res.status(500).json({ error: '读取班级列表失败：' + err.message });
  }
  res.json({ classes, current: u.dbSlug || '' });
});

// 新增班级：给当前账号再建一个独立的班（新建一个库，不是复制 —— 复制会把学生、
// 班费记录一起带过去，两个班共用同一批人会立刻产生脏数据）。
// 加密方式跟随当前班：明文账号建的还是明文库，避免同一账号下混着两种保存方式。
//
// 超级隐私模式暂不支持：隐私库的钥匙由「登录密码 + 恢复词」各包裹一份，每个班都是
// 一把独立的新钥匙 + 一套新恢复词。要做对得让用户当场抄写新恢复词，这一轮先明确拒绝，
// 不做半吊子（否则新班建出来却没有口令包裹，等于绕过隐私模式）。
router.post('/class', auth(), async (req, res) => {
  const u = req.user;
  const raw = req.body && typeof req.body.className === 'string' ? req.body.className : '';
  const className = raw.trim().slice(0, 50);

  if (dbManager.isProtected(u.username)) {
    return res.status(400).json({ error: '超级隐私模式下暂不支持新增班级' });
  }

  // 班名在同一账号内唯一。为什么必须有：
  //   · 班级切换器里两个同名项只差 slug（用户看不见），根本没法区分点哪个
  //   · 创建后会自动切进新班，重名会让用户以为「没切过去」，回头再点一次又建一个
  // 空名会落成默认的「我的班级」（见 createTeacher），所以比较的是最终写入的名字。
  const wanted = className || '我的班级';
  const dup = dbManager.listClasses(u.username)
    .some((c) => (c.className || '').trim() === wanted);
  if (dup) {
    return res.status(409).json({ error: `已有同名班级「${wanted}」，请换个名字` });
  }

  const cur = u.dbSlug ? dbManager.registryFindBySlug(u.dbSlug) : null;
  const encrypted = cur ? cur.encrypted !== 0 : true;
  const acc = dbManager.accountFindByUsername(u.username);
  // 新库的 users 表要写一份密码哈希（保持库内自洽）；登录校验走 accounts，两者此时一致
  const passwordHash = acc ? acc.password_hash : '';

  try {
    const { slug } = dbManager.createTeacher(u.username, passwordHash, u.role, encrypted, className);
    console.log('[account] 新增班级:', u.username, 'slug:', slug, 'name:', className || '(默认)');
    res.json({
      message: '班级已创建',
      slug,
      classes: dbManager.listClasses(u.username),
    });
  } catch (err) {
    console.warn('[account] 新增班级失败:', err.message);
    res.status(500).json({ error: '创建班级失败：' + err.message });
  }
});

// 切换班级：把当前会话的 dbSlug 换到该账号名下的另一个班，并重签 token。
// 为什么必须重签：middleware/auth.js 直接用 JWT 里的 dbSlug 去 withDb(slug) 选库，
// 会话名单只是旁路校验 ——「换了班」这件事只能通过新 token 表达，改服务端状态不够。
// 为什么不吊销会话：切班不是凭证变更，吊销会连带作废媒体凭据（<img> 的 token 绑同一个 sid），
// 表现就是切完班图片全裂。
router.post('/switch-class', auth(), (req, res) => {
  const target = req.body && typeof req.body.slug === 'string' ? req.body.slug.trim() : '';
  if (!target) return res.status(400).json({ error: '缺少班级标识' });
  const u = req.user;

  const rec = dbManager.registryFindBySlug(target);
  // 不区分「不存在」与「不是你的」：否则可以拿这个接口探测别人的 slug 是否存在
  if (!rec || rec.username !== u.username) {
    return res.status(404).json({ error: '班级不存在' });
  }

  // 目标库必须真的能打开才换 token，否则切过去之后每个请求都会 500。
  // 隐私模式的班若本次会话还没解锁过库钥匙，这里会抛 PRIVACY_UNLOCK → 让前端要密码。
  try {
    dbManager.resolveClass(u.username, target);
  } catch (err) {
    if (err.code === 'PRIVACY_UNLOCK') {
      return res.status(403).json({
        error: '该班级已开启超级隐私模式，请重新输入密码后切换',
        code: 'CLASS_NEEDS_PASSWORD',
      });
    }
    return res.status(409).json({ error: '该班级暂时无法打开：' + err.message });
  }

  // 会话里的 dbSlug 同步改掉：改密吊销是按 (userId, dbSlug) 匹配的，
  // 两边不一致会让这个 sid 在吊销时被漏掉（改完密码旧 token 还能用）。
  if (!sessions.setSlug(u.sid, target)) {
    return res.status(401).json({ error: '登录状态已失效，请重新登录' });
  }

  const payload = { userId: u.userId, username: u.username, role: u.role, dbSlug: target, sid: u.sid };
  const token = useJwt().sign(payload, SECRET, TOKEN_SIGN_OPTS);
  if (req.sessionId) secureChannel.bindAuth(req.sessionId, token);
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: TOKEN_COOKIE_MAX_AGE,
  });
  // 沿用滑动续期的响应头协议：前端成功拦截器统一走 absorbRenewalTokens 落盘，
  // 调用点不用自己处理 token 替换，也不会出现「切完班图片全裂」。
  res.set('X-Renewed-Token', token);
  res.set('X-Renewed-Media', signMediaToken(payload));

  res.json({
    message: '已切换班级',
    token,
    mediaToken: signMediaToken(payload),
    classes: dbManager.listClasses(u.username),
    user: { id: u.userId, username: u.username, role: u.role, dbSlug: target },
  });
});

// 修改密码
router.put('/password', auth(), async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!newPassword) {
      return res.status(400).json({ error: '请输入新密码' });
    }
    // 与注册（auth.js）、切换安全等级（account.js 下方）、本机恢复改密保持一致：
    // 少于 6 位直接拒。原先这条路径漏了这一句，等于从这里可以设一个 1 位密码。
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: '新密码长度至少 6 位' });
    }

    const user = userStore.findById(req.user.userId);
    if (!user) return res.status(401).json({ error: '账号不存在' });

    // 本次是用恢复词登录的隐私库：旧密码已忘记，内存里的库钥匙就是所有者证明，免输旧密码
    const isPrivacy = dbManager.isProtected(req.user.username);
    const byMnemonic = isPrivacy && dbManager.getUnlockSource(req.user.dbSlug) === 'mnemonic';
    // 「本机信息恢复」签发的 token 带 recover 标记：本机文件即凭证，允许免旧密码直接设置新密码
    const byLocalRecover = req.user.recover === true && !isPrivacy;
    // 只有「既不是恢复词解锁、也不是本机恢复」时才需要校验旧密码。
    // 保持原短路语义：这两种情况下完全不比对密码（既省一次 bcrypt 计算，行为也与原来一致）。
    if (!byMnemonic && !byLocalRecover) {
      // 免密账号（user.password 为空）没有旧密码可比对，直接允许设置首个密码；
      // 隐私库即使 password 为空也必须校验，避免绕过库钥匙包裹。
      if (isPrivacy || user.password) {
        const oldOk = oldPassword ? await bcryptCompare(oldPassword, user.password) : false;
        if (!oldOk) {
          return res.status(400).json({ error: '原密码错误' });
        }
      }
    }

    // 先换密码包裹：包裹更新失败就不改 users 里的密码，避免新旧密码都解不开库
    if (isPrivacy) {
      dbManager.rewrapPassword(req.user.username, {
        oldPassword,
        newPassword,
        useMemoryKey: byMnemonic,
      });
    }

    const hashed = await bcryptHash(newPassword, 10);
    userStore.updatePassword(req.user.userId, hashed);
    // 多班级：登录校验以 accounts.password_hash 为权威，改密必须同步写过去。
    // 否则切到同账号的另一个班时，登录用的还是旧密码哈希 —— 改密看起来「没生效」。
    // 各库 users.password 仍写当前这个（保持库内自洽），其余班下次登录不受影响。
    try {
      const acc = dbManager.accountFindByUsername(req.user.username);
      if (acc) dbManager.accountSetPassword(acc.id, hashed);
    } catch (err) {
      console.warn('[account] 同步账号密码失败:', err.message);
    }
    // 密码已变 → 该账号在**所有窗口**签发的旧 token 立即失效（含本机恢复 token）。
    // 以前只有「本机恢复」分支 revoke 当前 sid + create 新 sid：普通改密不吊销任何会话，
    // 兄弟窗口的 token 还能用满 30 天；而只吊销兄弟会话、放过当前 token 也不行 ——
    // 当前 token 若已泄露，改密码就失去意义。统一走动作层：全量吊销后换发新 sid，
    // 让当前窗口继续在线（沿用旧 sid 会把自己也一起吊销）。
    const { payload, token } = rotateLoginAfterCredentialChange(req, res);
    // 「本机信息恢复」的 recover token 只授权这一次改密：换发的新 token 不带 recover，
    // 旧 recover token 已被全量吊销，无法再免旧密码反复改密。
    if (byLocalRecover) {
      return res.json({ message: '密码修改成功', token, mediaToken: signMediaToken(payload) });
    }
    res.json({ message: '密码修改成功' });
  } catch (err) {
    res.status(err.code === 'PRIVACY_UNLOCK' ? 400 : 500).json({ error: err.message });
  }
});

// 删除当前班级：只删这一个库，不动账号本身、也不碰其它班级。
// 与「删除账号」（下面的 DELETE /）是两件事，语义必须分清：
//   · 删班级：销毁一套数据，账号还在，会自动切到剩下的某个班
//   · 删账号：销毁全部班级 + 凭证，回到登录页
router.delete('/class', auth(), (req, res) => {
  const u = req.user;
  const current = u.dbSlug;
  const rec = current ? dbManager.registryFindBySlug(current) : null;
  if (!rec) return res.status(404).json({ error: '班级不存在或已被删除' });

  const classes = dbManager.listClasses(u.username);
  // 唯一一个班不能删：删完这个账号就没有任何库可用，而那件事的入口叫「删除账号」。
  // 这里拒绝而不是顺手把账号也删掉 —— 用户点的是「删除该班级」，不该产生更大的后果。
  if (classes.length <= 1) {
    return res.status(400).json({ error: '这是唯一的班级。如需销毁全部数据，请使用「删除账号」' });
  }
  const target = classes.find((c) => c.slug !== current);
  if (!target) return res.status(400).json({ error: '找不到可切换的班级' });

  try {
    dbManager.deleteTeacher(current);
  } catch (err) {
    console.warn('[account] 删除班级失败:', err.message);
    return res.status(500).json({ error: '删除班级失败：' + err.message });
  }

  // 会话跟着挪到剩下的班。不挪的话当前窗口的 token 还指着已删的库，下一个请求就是 500。
  // 顺序必须是「先 setSlug 再吊销旧 slug」：setSlug 之后这个 sid 的 dbSlug 已经是 target，
  // 才不会在下面那步被自己的吊销逻辑顺手删掉。
  if (!sessions.setSlug(u.sid, target.slug)) {
    revokeAccountSessions(u.userId, current);
    return res.status(401).json({ error: '登录状态已失效，请重新登录' });
  }
  // 同一个已删班上的其它窗口：token 必须立即作废，否则它们会持续请求一个不存在的库
  revokeAccountSessions(u.userId, current);

  const payload = { userId: u.userId, username: u.username, role: u.role, dbSlug: target.slug, sid: u.sid };
  const token = useJwt().sign(payload, SECRET, TOKEN_SIGN_OPTS);
  if (req.sessionId) secureChannel.bindAuth(req.sessionId, token);
  res.cookie('token', token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: TOKEN_COOKIE_MAX_AGE,
  });
  // 与 switch-class 同一套续期协议：前端拦截器统一落盘，调用点不用自己换 token
  res.set('X-Renewed-Token', token);
  res.set('X-Renewed-Media', signMediaToken(payload));

  console.log('[account] 删除班级:', u.username, 'slug:', current, '→ 已切到:', target.slug);
  res.json({
    message: '班级已删除',
    token,
    mediaToken: signMediaToken(payload),
    current: target.slug,
    classes: dbManager.listClasses(u.username),
  });
});

// 删除当前登录账号：关闭并删除该账号的库文件、清除 index 登记，不可恢复。
// 仅删本账号自身的数据；uploads 等为多账号共享资源，不做清理。
router.delete('/', auth(), (req, res) => {
    const slug = (req.user && req.user.dbSlug) || 'default';
  const rec = dbManager.registryFindBySlug(slug);
  if (!rec) return res.status(404).json({ error: '账号不存在或已被删除' });
  dbManager.deleteTeacher(slug);
  // 账号都没了，其它窗口残留的 token 不能继续按旧 sid 通过鉴权
  revokeAccountSessions(req.user.userId, req.user.dbSlug);
  res.clearCookie('token');
  res.json({ message: '账号已删除' });
});

// 当前账号的安全等级：plain 明文 / nopass 免密加密 / password 普通密码 / privacy 超级隐私
// 判定口径在 utils/securityLevel.js 单源维护 —— 本机恢复（routes/auth.js）也用同一份，
// 两处各写一遍会分叉成「设置页显示免密、登录却要密码」这类矛盾。
function currentSecurityLevel(req) {
  return resolveSecurityLevel(db, {
    dbSlug: req.user.dbSlug, username: req.user.username, userId: req.user.userId,
  });
}

router.get('/security-level', auth(), (req, res) => {
    res.json({ level: currentSecurityLevel(req) });
});

// 切换安全等级：明文 / 免密 / 普通密码 / 超级隐私。
// 只动当前登录账号；明文可再升级为任意加密等级。
router.post('/security-level', auth(), async (req, res) => {
  try {
    const target = ['plain', 'nopass', 'password', 'privacy'].includes((req.body || {}).level)
      ? req.body.level
      : '';
    if (!target) return res.status(400).json({ error: '未知的安全等级' });

    const from = currentSecurityLevel(req);
    if (from === target) return res.json({ level: from, changed: false });

    const { password = '', newPassword = '' } = req.body || {};
    const username = req.user.username;
    const user = userStore.findCredentials(req.user.userId);
    if (!user) return res.status(401).json({ error: '账号不存在' });

    // 当前有登录密码（含隐私模式）时，任何变更都要先验证当前密码
    const needsCurrent = from === 'password' || from === 'privacy';
    if (needsCurrent) {
      if (!password) return res.status(400).json({ error: '请输入当前登录密码' });
      if (!await bcryptCompare(password, user.password)) return res.status(400).json({ error: '密码错误' });
    }

    // 目标需要登录密码但当前没有：先写入新密码（必须在库连接还可用时改）
    let effectivePwd = password;
    if (!needsCurrent && (target === 'password' || target === 'privacy')) {
      if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码长度至少 6 位' });
      effectivePwd = String(newPassword);
      // 先算出哈希再写库：哈希是异步的，必须 await 拿到结果才能入库
      const newHash = await bcryptHash(effectivePwd, 10);
      userStore.updatePassword(user.id, newHash);
    } else if (target === 'plain' || target === 'nopass') {
      // 明文库与免密登录都不能保留密码
      userStore.updatePassword(user.id, '');
    }

    // 退出隐私：先把库钥匙改回主密钥包裹，再处理免密/明文
    if (from === 'privacy' && target !== 'privacy') {
      dbManager.disablePrivacy(username, { password });
    }

    // 加密 -> 明文：转换会驱逐本次请求的连接，必须放在所有库读写之后
    if (target === 'plain') {
      await dbManager.convertDbEncryption(req.user.dbSlug, false);
    }
    // 明文 -> 加密：先转成加密库，下面开启隐私才有库钥匙可包裹
    if (from === 'plain') {
      await dbManager.convertDbEncryption(req.user.dbSlug, true);
    }

    // 开启隐私：库钥匙只由登录密码 + 恢复词包裹
    let phrase = '';
    if (target === 'privacy') {
      phrase = pickPhrase();
      dbManager.enablePrivacy(username, { password: effectivePwd, mnemonic: phrase });
    }

    // 上面写入或清空了登录密码 = 凭证变更：其它窗口的旧 token 立即失效，
    // 当前窗口换发新 sid 继续在线（前端切换完还留在设置页，不能被踢回登录页）。
    rotateLoginAfterCredentialChange(req, res);
    res.json({
      level: target,
      changed: true,
      phrase: phrase ? formatPhrase(phrase) : '',
      recoveryKey: phrase,
    });
  } catch (err) {
    res.status(err.code === 'PRIVACY_UNLOCK' ? 400 : 500).json({ error: err.message });
  }
});

// 超级隐私模式状态（供系统设置展示）
router.get('/privacy', auth(), (req, res) => {
    res.json({ enabled: dbManager.isProtected(req.user.username) });
});

// 开启超级隐私模式：用当前登录密码确认身份，并生成一份 12 词恢复词（仅此次返回）。
// 开启后库钥匙只由「登录密码 / 恢复词」包裹，主密钥再也解不开；忘记两者即不可恢复。
router.post('/privacy/enable', auth(), async (req, res) => {
    const { password } = req.body || {};
  const user = userStore.findById(req.user.userId);
  if (!user) return res.status(401).json({ error: '账号不存在' });
  if (!user.password) return res.status(400).json({ error: '当前账号未设置登录密码，请先设置密码' });
  if (!password || !await bcryptCompare(password, user.password)) {
    return res.status(400).json({ error: '密码错误' });
  }

  const phrase = pickPhrase();
  dbManager.enablePrivacy(req.user.username, { password, mnemonic: phrase });
  res.json({
    enabled: true,
    recoveryKey: phrase,
    phrase: formatPhrase(phrase),
  });
});

// 关闭超级隐私模式：需要再次输入登录密码解出库钥匙，改回主密钥自动解锁。
router.post('/privacy/disable', auth(), (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: '请输入登录密码' });
    dbManager.disablePrivacy(req.user.username, { password });
    res.json({ enabled: false });
  } catch (err) {
    res.status(err.code === 'PRIVACY_UNLOCK' ? 400 : 500).json({ error: err.message });
  }
});

module.exports = router;