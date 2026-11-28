const express = require('express');
const { sendError } = require('../utils/sendError')
const router = express.Router();
// jsonwebtoken 只在登录/注册/重置密码等「签发 Token」时用到，不需要在后端就绪前加载：
// 改为首次调用时才 require，避免把它（连带 semver / side-channel 等）的冷加载成本
// 压在启动关键路径上（行为完全不变）。
let _jwt = null;
const useJwt = () => (_jwt || (_jwt = require('jsonwebtoken')));
// bcryptjs 只在登录/注册/重置密码等「用户操作」里用到，不需要在后端就绪前加载：
// 改为首次调用时才 require，避免把它的冷加载成本压在启动关键路径上（行为完全不变）。
// 惰性加载逻辑已下沉到 services/bcryptAsync.js，本文件只引用它的异步接口。
const { hash: bcryptHash, compare: bcryptCompare } = require('../services/bcryptAsync');
const { SECRET, auth, TOKEN_COOKIE_MAX_AGE, signMediaToken } = require('../middleware/auth');
// 登录保持天数按账号配置：签发点一律现取，不再共享模块级常量
const authPolicy = require('../services/authPolicy');
const tokenStore = require('../services/mcpTokenStore');
const secureChannel = require('../services/secureChannel');
const sessions = require('../services/sessions');
// 恢复词重置密码 = 凭证变更，必须走统一动作层吊销该账号全部会话
const { revokeAccountSessions, hashSource: credentialHashSource } = require('../services/credentialChange');
const { pickPhrase, deriveRestoreHash, normalizePhrase, formatPhrase, verifyRestoreHash } = require('../services/recoveryKey');
const { normalizeUsername, usernameError } = require('../services/usernameRules');
// 待确认注册草稿：有密码账号先生成恢复密钥，用户「抄写前 3 词」通过后才真正建库。
// 未确认的草稿不会占用账号，TTL 后自动失效；容量与淘汰策略见 services/pendingRegs.js。
const pendingRegs = require('../services/pendingRegs');
const dbManager = require('../dbManager/dbManager');
// users 表的唯一 SQL 出口。登录前没有登录态（ALS 里没有 slug），所以这里用的是
// userStore 的「显式传 conn」那组函数，连接由 dbManager.resolveByUsername() 解析后传入。
const userStore = require('../services/userStore');
const { resolveSecurityLevel } = require('../utils/securityLevel');
const slugScopes = require('../utils/slugScopes');
const albumThumbs = require('../albumThumbs');
const loginThrottle = require('../services/loginThrottle');

// 签发登录态：登录 token + 媒体凭据，并把 token 绑定到本次加密信道会话。
// 绑定后前端后续请求只需发送不含 token 的信道凭据，登录 token 不再随每次请求上线；
// mediaToken 只用于 <img>/CSS 这类无法携带自定义头的静态资源，且不能调用业务 API。
function issueSession(req, user, extra = {}) {
  // 登录成功即恢复该账号被登出挂起的 MCP 凭据（V9-I-22）：四个登录出口都过这里，
  // 不用在每个入口各写一遍。外部客户端无需重新配置 token。
  try { tokenStore.setSuspendedByAccount(user.username, false); } catch (_) { /* best-effort: 挂起恢复失败不影响登录 */ }
  const sid = sessions.create(user.userId, user.dbSlug);
  const payload = { userId: user.userId, username: user.username, role: user.role, dbSlug: user.dbSlug, sid, ...extra };
  // 登录保持天数按账号名存（authPolicy 的键是 username，不是 dbSlug）。
  // 传 dbSlug 会查不到键 → 一律退回默认 30 天，用户设的 180 天静默失效。
  // 其余 7 处签发点全用 username，这里不能是例外。
  const token = useJwt().sign(payload, SECRET, authPolicy.signOptsFor(user.username));
  if (req.sessionId) secureChannel.bindAuth(req.sessionId, token);
  return { token, mediaToken: signMediaToken(payload) };
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: TOKEN_COOKIE_MAX_AGE
  });
}


// 账号列表：登录页「从数据库注册」加载已登记的班主任账号（无需登录）。
// 仅返回数据库有效的账号——解不开/打不开/账号行缺失的无效库直接隐藏。
router.get('/accounts', (req, res) => {
    // 登录页需要它列出已保存账号，故不能要求登录；按 IP 限频，抬高批量枚举成本（N3-02）
    const gate = loginThrottle.checkAccounts(req.ip);
    if (!gate.ok) {
      res.set('Retry-After', String(gate.retryAfter));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试', retry_after: gate.retryAfter });
    }
    res.json({ accounts: dbManager.registryListValid() });
});

// 轻量登录态校验：前端在进入内部页前调用，确认本地 token 仍被后端接受。
// 无效即返回 401，前端据此直接回登录页，避免「先渲染内部页再被踢回」的闪烁。
router.get('/me', auth(), (req, res) => {
  res.json({ username: req.user.username, role: req.user.role, dbSlug: req.user.dbSlug });
});

// 刷新媒体凭据：媒体凭据过期或换号后，前端用普通 API 调用取一份新的，
// 不必让用户重新登录（登录 token 仍有效即可）。
router.get('/media-token', auth(), (req, res) => {
    res.json({ mediaToken: signMediaToken(req.user) });
});

// ---------------------------------------------------------------------------
// POST /logout  —— 主动退出登录
// 把当前 token 的会话（sid）从名单里移除，原 token 立即失效：即使旧 token 被留用也验不过。
// 只吊销本次登录的这一条会话，同账号在其它设备上的登录态不受影响。
// 这是「窗口退出」而不是「凭证变更」：改密 / 恢复词重置 / 删账号才走
// credentialChange 的统一动作层全量吊销。此处刻意保持单点，别改成 revokeAccountSessions ——
// 否则关掉一个窗口会把同一账号的其它窗口一起踢下线（既有产品取舍）。
router.post('/logout', auth(), (req, res) => {
  sessions.revoke(req.user && req.user.sid);
  // MCP 凭据跟着账号一起「暂时失效」：不是永久撤销，下次登录由 issueSession 自动恢复。
  // 超级隐私模式 lockDb 会让班级库钥匙失效，但挂起只写 core 索引，不依赖班级库。
  try { tokenStore.setSuspendedByAccount(req.user && req.user.username, true); } catch (_) { /* best-effort: 不影响登出主流程 */ }
  // 解绑信道会话：换号登录后同一信道不会继续沿用上一个账号的 token
  const channelSid = req.sessionId;
  secureChannel.unbindAuth(channelSid);
  // 登出即销毁当前信道会话，不再等 15 分钟空闲清扫（X3-15）。
  // 必须等响应写完再销毁：响应本身还要用该会话密钥加密。
  if (channelSid) {
    res.on('finish', () => {
      try { secureChannel.destroySession(channelSid); } catch (_) { /* best-effort: 已销毁 */ }
    });
  }
  // 超级隐私模式：登出即关闭库连接并丢弃内存里的库钥匙，下次使用必须重新输入密码/恢复词
  const slug = req.user && req.user.dbSlug;
  dbManager.lockDb(slug);
  // 清掉该库所有按 slug 分桶的进程内状态（待生成缩略图集合等）与缩略图内存索引：
  // 不清的话，上一个人的待生成条目会继续占着现场生成配额闸（最长 60s TTL），
  // 而缩略图索引虽已有界，换号后仍带着上一库的内容。清理项由各状态自己登记，
  // 这里不点名（见 utils/slugScopes.js）。子进程那半由 lock 消息自己处理。
  slugScopes.clearAllForSlug(slug);
  albumThumbs.forgetAlbum(slug);
  // 扫描子进程也可能持有该库连接，一并关闭
  try { require('../scanWorker').lockDb(slug); } catch (_) { /* best-effort: 子进程未启动 */ }
  res.clearCookie('token', { path: '/' });
  res.json({ ok: true });
});

// 「从数据库文件登录」：前端用文件选择器选中一个 .db 文件后把文件名传上来，
// 后端定位本机登记库、解包钥匙并返回该库内的账号。解不开(外来/无登记)时返回 400，
// 前端据此引导到「从备份恢复」。
router.post('/db-login', (req, res) => {
  const file = req.body && typeof req.body.file === 'string' ? req.body.file.split(/[\\/]/).pop() : '';
  if (!file) return res.status(400).json({ error: '缺少数据库文件' });
  try {
    const r = dbManager.resolveByDbFile(file);
    res.json({ slug: r.slug, username: r.username });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 「本机信息恢复」：忘记密码时选中本机 .db 文件，凭本机登记表 + 主密钥直接签发登录态。
// 是否「强制改密」按安全等级分流，不能一刀切：
//   · password —— 忘了密码，本机文件是身份凭证，签 recover token；该 token 只允许改密
//     （见 middleware/auth.js 的 RECOVER_ALLOWED），改完换发常规 token。
//   · plain / nopass —— 本来就没有登录密码。本机文件即凭证，直接签发常规 token 进系统。
//     对这两档强制设密码换不到任何额外安全性（能解库的人本来就能再走一次本机恢复），
//     却会制造状态分裂：nopass 会被静默升级成 password（等级判定看 users.password 有没有值），
//     plain 则会被写进注册和切换等级都明令禁止的 password 哈希 —— 设置页仍显示「明文」，
//     登录却开始要密码。
//   · privacy —— 没有主密钥包裹，resolveByDbFile 直接抛错，引导改用恢复词，走不到这里。
router.post('/db-recover', (req, res) => {
  const file = req.body && typeof req.body.file === 'string' ? req.body.file.split(/[\\/]/).pop() : '';
  if (!file) return res.status(400).json({ error: '缺少数据库文件' });
  // 已登录场景（设置页「修改密码 → 忘记密码」）会带上当前账号名：库里不止一个账号时，
  // 只凭文件名会恢复成库里第一个账号。传了就必须对得上，宁可直接报错也不能签错号。
  const wantedUsername = req.body && typeof req.body.username === 'string' ? req.body.username.trim() : '';
  try {
    const r = dbManager.resolveByDbFile(file);
    // 改名只同步 registry + accounts，各库 users.username 故意留旧名（见登录分支）。
    // r.username 来自库内 users 表，可能已是旧名 —— 拿它 resolveByUsername 会查不到
    // 登记表（现名）而返回 null → 本机恢复在改名班里失效。改用可靠的文件名 slug：
    // registry 行的 username 始终是当前账号名，按它定位与登录同口径。
    const rec = dbManager.registryFindBySlug(r.slug);
    const registryName = (rec && rec.username) || r.username;
    const resolved = dbManager.resolveByUsername(registryName);
    if (!resolved) return res.status(400).json({ error: '数据库内没有可用账号' });
    // 库内按当前名查不到（旧名未同步）时退回第一条 —— 一个库只有一个班主任账号，
    // 与登录的 pickUser 兜底同口径。
    const user = userStore.findByUsername(resolved.conn, r.username)
      || userStore.findFirstUser(resolved.conn);
    if (!user) return res.status(400).json({ error: '数据库内没有可用账号' });
    // 前端传的 username 来自 /api/accounts（registry 的当前名），库内用户行可能还是旧名，
    // 所以要拿账号维度名比对，不能用 user.username —— 否则改名后恢复被误判「没有这个账号」。
    if (wantedUsername && registryName !== wantedUsername) {
      return res.status(400).json({ error: '该数据库中没有这个账号' });
    }
    const dbSlug = user.db_slug || r.slug;
    const securityLevel = resolveSecurityLevel(resolved.conn, {
      dbSlug, username: registryName, userId: user.id,
    });
    // 只有「本来就有登录密码」的档位需要先改密；其余直接是完整登录态
    const mustChangePassword = securityLevel === 'password';
    // token 里的 username 必须是账号维度名：用库内旧名会让切班的归属校验
    // （rec.username === u.username）把用户自己的另一个班判成「不存在」。与登录分支同口径。
    const { token, mediaToken } = issueSession(req, {
      userId: user.id, username: registryName, role: user.role, dbSlug,
    }, mustChangePassword ? { recover: true } : {});
    setAuthCookie(res, token);
    res.json({
      securityLevel,
      mustChangePassword,
      token,
      mediaToken,
      user: {
        id: user.id, username: registryName, role: user.role, dbSlug,
        hasPassword: !!user.password,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { username, password, mnemonic } = req.body;
  // 多班级：可选指定从哪个班进入；不传则进默认班（该账号最早创建的那个）
  const classSlug = req.body && typeof req.body.classSlug === 'string' ? req.body.classSlug : '';
  if (!username) return res.status(400).json({ error: '请输入账号' });

  // 登录失败节流：同一「账号名 + IP」连续失败会进入软/硬锁定（A-2 · F06-01）。
  // 放在任何开库/KDF/bcrypt 之前，避免暴力尝试把 CPU 打满。
  const gate = loginThrottle.checkLogin(String(username), req.ip);
  if (!gate.ok) {
    res.set('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: gate.error, retry_after: gate.retryAfter });
  }
  const failOnce = () => loginThrottle.failLogin(String(username), req.ip);

  // 用 index.db 定位账号对应的班主任库，打开它并校验密码（账号存于各库内的 users）
  let resolved;
  try {
    resolved = dbManager.resolveClass(String(username), classSlug, { password, mnemonic });
  } catch (err) {
    if (err.code === 'PRIVACY_UNLOCK') {
      // 超级隐私模式：库钥匙解不开就到此为止，不泄露账号是否存在
      failOnce();
      return res.status(401).json({ error: err.message, code: 'PRIVACY_UNLOCK' });
    }
    if (err.code === 'CLASS_NOT_OWNED') {
      // 参数错误（不是凭证错误），不计数
      return res.status(400).json({ error: err.message });
    }
    console.warn('[login] 打开账号库失败:', err.message);
    failOnce();
    return res.status(401).json({ error: '账号或密码错误' });
  }
  if (!resolved) {
    console.warn('[login] 账号不在登记表:', username);
    failOnce();
    return res.status(401).json({ error: '账号或密码错误' });
  }

  // 多班级：改用户名只同步 registry 与 accounts —— 各库内 users 表的名字可能还是旧的
  // （挨个开库改名要 N 次 KDF，代价与收益不匹配）。所以按新名查不到时退回「库里第一条」：
  // 能打开这个库本身就说明密钥正确，身份本来也不是靠 users.username 建立的
  // （一个库里只有一个班主任账号，id 恒为 1）。
  const pickUser = () => userStore.findByUsername(resolved.conn, username)
    || userStore.findFirstUser(resolved.conn);
  const user = pickUser();
  if (!user) {
    console.warn('[login] 库内查无此账号:', username, 'slug:', resolved.slug);
    failOnce();
    return res.status(401).json({ error: '账号或密码错误' });
  }
  // 恢复词解锁本身就是所有者证明：不再校验登录密码（可用于忘记密码时登录后重设）
  const unlockedByMnemonic = resolved.unlockedBy === 'mnemonic';
  // 多班级：密码校验以 accounts.password_hash 为权威（一个账号多个班共用一份凭证，
  // 不必每个库各存一份）。老数据还没迁到 accounts 时退回库内 users.password，
  // 登录成功后立刻回填 —— 迁移只发生在「真正用到的账号」上，不占启动时间，
  // 也不需要一次性把本机所有库打开一遍。
  const acc = dbManager.accountFindByUsername(String(username));
  // 权威哈希口径统一在 services/credentialChange.js（T07-03），登录与单测共用同一份
  const hashSource = credentialHashSource(acc, user);
  // 保持原短路语义：不需要校验时完全不算 bcrypt
  if (!unlockedByMnemonic && hashSource) {
    const pwOk = await bcryptCompare(password, hashSource);
    if (!pwOk) {
      console.warn('[login] 密码校验失败:', username);
      failOnce();
      return res.status(401).json({ error: '账号或密码错误' });
    }
  }
  // 登录成功：清掉该账号 + IP 的失败计数
  loginThrottle.resetLogin(String(username), req.ip);
  // 懒迁移：补 accounts 行 + 把同用户名的各库归属到该账号 + 回填密码哈希（三者都幂等）
  const accountId = dbManager.linkAccount(String(username), user.password || '');
  dbManager.backfillPasswordHash(accountId, user.password || '');

  const dbSlug = user.db_slug || resolved.slug;
  // token 里的 username 必须取**账号维度**的名字，不能用库内 users.username：
  // 改名只同步 registry / accounts，各库内 users 表刻意不同步（挨个开库改名要 N 次 KDF）。
  // 用过期的名字签 token，switch-class 的归属校验（rec.username === u.username）
  // 会把用户自己名下的另一个班判成「班级不存在」—— 改名后切班直接 404。
  const authName = (acc && acc.username) || String(username);
  const { token, mediaToken } = issueSession(req, {
    userId: user.id, username: authName, role: user.role, dbSlug,
  });
  setAuthCookie(res, token);
  res.json({
    token,
    mediaToken,
    protect: resolved.protect === true,
    unlockedBy: resolved.unlockedBy || 'password',
    // 多班级：前端据此渲染班级切换列表。单班账号也会返回（长度 1），前端不必分叉。
    classes: dbManager.listClasses(authName),
    user: { id: user.id, username: authName, role: user.role, dbSlug, hasPassword: !!user.password }
  });
});

// ---------------------------------------------------------------------------
// POST /register  —— 班主任注册
// 仅班主任可用；科任老师 / 学生 返回「正在开发中」。
// 注册即新建一个独立的班主任库；仅超级隐私模式会先生成 12 词恢复词并要求抄写确认。
// ---------------------------------------------------------------------------
router.post('/register', async (req, res) => {
  const { username, password, role, encrypted, privacy, level } = req.body || {};
  // 多班级：注册时可以顺手给第一个班起名；不传就由 createTeacher 落默认值「我的班级」
  const className = typeof req.body?.className === 'string' ? req.body.className.trim().slice(0, 50) : '';

  // 仅班主任开放
  if (role !== 'teacher') {
    console.warn('[register] 非班主任角色被拒绝: role=', role);
    return res.status(403).json({ error: '该角色正在开发中，请先使用「班主任」注册' });
  }

  // 安全等级（新）：plain / nopass / password / privacy；未传时回退旧的 encrypted / privacy 参数
  const lvl = ['plain', 'nopass', 'password', 'privacy'].includes(level) ? level : '';
  // 保存方式：缺省加密（兼容现有调用）；显式 false/0/'0' 视为明文保存
  const wantEncrypted = lvl ? lvl !== 'plain' : !(encrypted === false || encrypted === 0 || encrypted === '0');

  const uname = normalizeUsername(username);
  const nameErr = usernameError(uname);
  if (nameErr) {
    console.warn('[register] 账号名非法:', uname);
    return res.status(400).json({ error: nameErr });
  }

  // 明文保存不允许设置密码（明文库没有库钥匙，无法承载密码保护）
  if (!wantEncrypted && password) {
    console.warn('[register] 明文保存模式禁止设置密码:', uname);
    return res.status(400).json({ error: '明文保存模式下不允许设置密码' });
  }
  // 超级隐私模式：必须加密且必须设置登录密码（密码参与库钥匙派生）
  const wantPrivacy = privacy === true || privacy === 1 || privacy === '1' || lvl === 'privacy';
  if (wantPrivacy) {
    if (!wantEncrypted) return res.status(400).json({ error: '明文模式无法开启超级隐私模式' });
    if (!password) return res.status(400).json({ error: '超级隐私模式需要设置登录密码' });
  }

  // 密码为空视为无密码登录，不加密；有密码则校验长度并加密存储
  // （原实现用三元表达式把 res.json(...) 塞进变量、再靠 res.headersSent 判断，
  //   改异步后 await 会打断连续执行，故改为显式提前返回，行为一致。）
  let passwordHash = '';
  if (password) {
    if (String(password).length < 6) {
      res.status(400).json({ error: '密码长度至少 6 位' });
      return;
    }
    passwordHash = await bcryptHash(String(password), 10);
  }

  // 检查账号唯一。多班级后账号的权威表是 accounts（一个账号可对应多个库），
  // 但老数据还没迁过去，registry 里也可能有存量 —— 两处都查才不会漏判。
  if (dbManager.accountFindByUsername(uname) || dbManager.registryFindByUsername(uname)) {
    console.warn('[register] 账号重复:', uname);
    return res.status(409).json({ error: '该账号已被注册' });
  }

  // defer=1：只存草稿、不建库（首次引导用）。引导里要到点「完成」才真正注册 ——
  // 否则中途关窗会在库里留下一个半成品账号，而那个账号的用户名在引导里已经改不了。
  const defer = req.body.defer === true || req.body.defer === 1 || req.body.defer === '1';

  // 只有超级隐私模式需要恢复词：它是库钥匙的第二把钥匙。
  // 其余等级（明文 / 无密码 / 普通密码）不必等确认，直接建库并签发登录态；
  // 但 defer 时所有等级都只存草稿，由 /register/confirm 统一收尾。
  if (!wantPrivacy && !defer) {
    try {
      const { slug } = dbManager.createTeacher(uname, passwordHash, 'teacher', wantEncrypted, className);
      console.log('[register] 注册成功:', uname, 'slug:', slug, 'encrypted:', wantEncrypted, 'hasPassword:', !!passwordHash);
      const { token, mediaToken } = issueSession(req, {
        userId: 1, username: uname, role: 'teacher', dbSlug: slug,
      });
      setAuthCookie(res, token);
      return res.json({
        message: '注册成功',
        token,
        mediaToken,
        user: { id: 1, username: uname, role: 'teacher', dbSlug: slug, hasPassword: !!passwordHash },
      });
    } catch (err) {
      console.error('[register] 注册抛异常:', uname, err.stack || err.message);
      // 注册失败细节仅进日志，对外固定文案（V10-SE-01）。
      if (!res.headersSent) return sendError(res, Object.assign(err, { expose: true, message: '注册失败，请稍后重试' }), req);
      return;
    }
  }

  // 草稿路径（超级隐私模式，或 defer 的其它等级）：恢复词只有隐私模式需要 ——
  // 它是库钥匙的第二把钥匙；其余等级 defer 时只等一个「完成」信号，不需要抄写。
  const phrase = wantPrivacy ? pickPhrase() : '';
  const restoreHash = wantPrivacy ? deriveRestoreHash(phrase) : '';
  const draftId = pendingRegs.put({
    username: uname,
    passwordHash,
    role: 'teacher',
    restoreHash,
    privacy: wantPrivacy,
    // 建库时要按用户选的方式落盘：confirm 里不传就会默认加密，
    // 明文模式的草稿若丢了这一项，会被建成一个需要钥匙的加密库，用户下次登不进去
    encrypted: wantEncrypted,
    // 多班级：班名随草稿一起留着，confirm 建库时才会用到（那时拿不到原始请求体）
    className,
  });
  console.log('[register] 生成待确认草稿:', uname, 'draftId:', draftId, 'defer:', defer, 'privacy:', wantPrivacy, 'encrypted:', wantEncrypted);
  res.json({
    message: wantPrivacy ? '注册进行中，请抄写前 3 个恢复词完成确认' : '注册信息已暂存，完成引导时创建账号',
    draftId,
    recovery: wantPrivacy ? { phrase: formatPhrase(phrase), hash: restoreHash } : null,
    user: { username: uname, role: 'teacher', dbSlug: null },
  });
});

// ---------------------------------------------------------------------------
// 完成确认注册：前端在「抄写前 3 词」校验通过后调用，此时才真正创建账号库。
// ---------------------------------------------------------------------------
router.post('/register/confirm', async (req, res) => {
  const { draftId, password, phrase } = req.body || {};
  const draft = draftId && pendingRegs.get(draftId);
  if (!draft) {
    return res.status(400).json({ error: '确认已过期，请重新注册' });
  }

  // 超级隐私模式：复用注册时展示的恢复词作为隐私恢复词。
  // 确认时必须提交同一密码与恢复词，否则账号建出来却解不开。
  if (draft.privacy) {
    // 保持原短路语义：密码为空时不做比对，直接判失败
    let pwOk = false;
    if (password) {
      pwOk = await bcryptCompare(String(password), draft.passwordHash);
    }
    if (!pwOk) {
      return res.status(400).json({ error: '密码不正确' });
    }
    if (!phrase || !verifyRestoreHash(normalizePhrase(phrase), draft.restoreHash)) {
      return res.status(400).json({ error: '恢复词不正确' });
    }
  }

  // 确认前再次校验唯一（防止等待期间被他人注册占用）
  if (dbManager.accountFindByUsername(draft.username) || dbManager.registryFindByUsername(draft.username)) {
    pendingRegs.remove(draftId);
    console.warn('[register/confirm] 确认时账号已被注册:', draft.username);
    return res.status(409).json({ error: '该账号已被注册' });
  }

  try {
    // encrypted 必须从草稿带过来：不给第四参就默认 true，
    // 明文模式的草稿会被建成加密库（下次登录直接进不去）。
    // 兼容旧草稿（没有该字段）：`!== false` 落回「加密」，与原行为一致。
    const { slug } = dbManager.createTeacher(draft.username, draft.passwordHash, draft.role, draft.encrypted !== false, draft.className || '');
    const resolved = dbManager.resolveByUsername(draft.username);
    if (resolved && draft.restoreHash) {
      userStore.setRecoveryHashByName(resolved.conn, draft.username, draft.restoreHash);
    }
    // 建库后立刻开启超级隐私模式：主密钥包裹被抹掉，钥匙只留给密码与恢复词
    if (draft.privacy) {
      try {
        dbManager.enablePrivacy(draft.username, { password: String(password), mnemonic: normalizePhrase(phrase) });
      } catch (err) {
        // 开启失败则回滚这次建库，避免留下一个“半隐私”的账号
        dbManager.deleteTeacher(slug);
        throw err;
      }
    }
    pendingRegs.remove(draftId);
    console.log('[register/confirm] 确认注册成功:', draft.username, 'slug:', slug, 'privacy:', !!draft.privacy, 'encrypted:', draft.encrypted !== false);
    // 签发登录态，注册成功即自动进入系统，无需再回登录页手动登录
    const userRow = userStore.findByUsername(resolved.conn, draft.username);
    const { token, mediaToken } = issueSession(req, {
      userId: userRow.id, username: userRow.username, role: userRow.role, dbSlug: slug,
    });
    setAuthCookie(res, token);
    res.json({
      message: '注册成功',
      token,
      mediaToken,
      protect: !!draft.privacy,
      user: { id: userRow.id, username: draft.username, role: draft.role, dbSlug: slug, hasPassword: !!draft.passwordHash },
    });
  } catch (err) {
    console.error('[register/confirm] 注册抛异常:', draft.username, err.stack || err.message);
    if (!res.headersSent) {
      pendingRegs.remove(draftId);
      sendError(res, Object.assign(err, { expose: true, message: '注册失败，请稍后重试' }), req);
    }
  }
});

// ---------------------------------------------------------------------------
// POST /recover-password  —— 用恢复密钥重置密码
// ---------------------------------------------------------------------------
// 按恢复词在本机已登记账号中定位：恢复词本身就是凭证，所以忘记账号时可以只凭恢复词恢复。
// 隐私库用恢复词直接试解锁（词不对会抛错）；非隐私库打开后比对 users.recovery_hash。
function findAccountsByPhrase(phrase) {
  const normalized = normalizePhrase(phrase);
  const hits = [];
  for (const rec of dbManager.registryList()) {
    try {
      if (rec.protect === 1) {
        if (dbManager.resolveByUsername(rec.username, { mnemonic: phrase })) hits.push(rec.username);
        continue;
      }
      const resolved = dbManager.resolveByUsername(rec.username);
      if (!resolved) continue;
      const row = userStore.findByUsername(resolved.conn, rec.username);
      if (row && row.recovery_hash && verifyRestoreHash(normalized, row.recovery_hash)) hits.push(rec.username);
    } catch (_) { /* best-effort: 打不开 / 词不匹配：跳过 */ }
  }
  return hits;
}

// 恢复改密后要吊销该账号名下**所有**班级的会话：一个账号多个班时，
// 各班窗口签发的 token 带各自的 dbSlug，只吊销当前班那一个，另一班旧 token
// 在 JWT 有效期内仍可读写 —— 等于密码没改。口径与 account.js 的
// accountSlugsForRevoke 一致（当前班排首位），复用到 revokeAccountSessions 的数组入参。
function accountSlugsForRevoke(username, currentSlug) {
  let list = [];
  try {
    list = dbManager.listClasses(username).map((c) => c.slug);
  } catch (_) { /* best-effort: 登记表读不到就退回单班，不影响改密本身 */ }
  const rest = list.filter((s) => s !== currentSlug);
  const all = [currentSlug, ...rest].filter(Boolean);
  return all.length ? all : currentSlug;
}

router.post('/recover-password', async (req, res) => {
  const { username, phrase, newPassword } = req.body || {};
  if (!phrase || !newPassword) {
    return res.status(400).json({ error: '请提供恢复密钥和新密码' });
  }
  if (String(newPassword).length < 6) return res.status(400).json({ error: '新密码长度至少 6 位' });

  let name = username ? String(username).trim() : '';
  if (!name) {
    const hits = findAccountsByPhrase(phrase);
    if (hits.length === 0) return res.status(404).json({ error: '本机没有与该恢复词匹配的账号，请填写账号后重试' });
    if (hits.length > 1) return res.status(400).json({ error: '恢复词匹配到多个账号，请填写账号' });
    name = hits[0];
  }

  // 超级隐私模式：恢复词就是第二把解锁钥匙。用它解出库钥匙 → 换密码包裹 → 更新密码哈希。
  if (dbManager.isProtected(name)) {
    let resolved;
    try {
      resolved = dbManager.resolveByUsername(name, { mnemonic: phrase });
    } catch (_) {
      return res.status(403).json({ error: '恢复词不正确' });
    }
    if (!resolved) return res.status(404).json({ error: '账号不存在' });
    try {
      // 先换密码包裹，再改 users 里的密码；顺序反了会出现新旧密码都解不开库
      dbManager.rewrapPassword(name, { newPassword: String(newPassword), useMemoryKey: true });
      // 哈希是异步的：先算完再写库，避免把 Promise 对象写进 password 列
      const newHash = await bcryptHash(String(newPassword), 10);
      userStore.setPasswordByName(resolved.conn, name, newHash);
      // 多班级：登录以 accounts.password_hash 为权威（见登录分支 hashSource），
      // 恢复改密必须同步写过去，否则新密码登录仍被旧哈希判 401 → 账号锁死。
      // 口径与普通改密一致：库内 users.password 保持自洽，账号表另写一份。
      try {
        const acc = dbManager.accountFindByUsername(name);
        if (acc) dbManager.accountSetPassword(acc.id, newHash);
      } catch (err) {
        console.warn('[auth] 恢复改密同步账号密码失败:', err.message);
      }
    } catch (err) {
      return sendError(res, err);
    }
    // 密码已重置：该账号在其它班级/窗口的旧 token 立即失效，要求重新登录。
    const row = userStore.findByUsername(resolved.conn, name);
    revokeAccountSessions(row && row.id, accountSlugsForRevoke(name, resolved.slug));
    return res.json({ message: '密码已重置，可用新密码登录', username: name });
  }

  let resolved;
  try {
    resolved = dbManager.resolveByUsername(name);
  } catch (err) {
    return sendError(res, err);
  }
  if (!resolved) return res.status(404).json({ error: '账号不存在' });

  const user = userStore.findByUsername(resolved.conn, name);
  if (!user || !user.recovery_hash) return res.status(404).json({ error: '该账号未设置恢复密钥' });

  // 归一化输入：仅保留汉字，兼容用户粘贴带序号（1.水 …）或带空格的格式
  if (!verifyRestoreHash(normalizePhrase(phrase), user.recovery_hash)) {
    return res.status(403).json({ error: '恢复密钥错误' });
  }

  const passwordHash = await bcryptHash(String(newPassword), 10);
  userStore.setPasswordByName(resolved.conn, user.username, passwordHash);
  // 同上：权威哈希在 accounts 表，不同步的话新密码在登录校验时会被旧哈希拒绝。
  try {
    const acc = dbManager.accountFindByUsername(user.username);
    if (acc) dbManager.accountSetPassword(acc.id, passwordHash);
  } catch (err) {
    console.warn('[auth] 恢复改密同步账号密码失败:', err.message);
  }
  // 「请重新登录」以前只是一句提示：改完密码旧 token 的 sid 仍在名单里，30 天内照用。
  // 这里真正吊销该账号**全部班级**的会话，提示才与服务端状态一致。
  revokeAccountSessions(user.id, accountSlugsForRevoke(user.username, resolved.slug));
  res.json({ message: '密码已重置，请重新登录', username: user.username });
});

module.exports = router;