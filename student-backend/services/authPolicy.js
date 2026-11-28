// 登录保持天数（按账号配置）：一份策略文件，决定这个账号的 token 活多久、
// 什么时候滑动续期、会话名单留多久、媒体凭据跟多久。
//
// 键是**账号名**（accounts 里的 username），不是 dbSlug。这是本次改动最容易搞错的一处：
// 一个账号可以拥有多个班，每个班是一个独立的库、各有自己的 slug（routes/account.js 的
// POST /class、POST /switch-class）。若按 dbSlug 存，用户在班级切换器里换个班，
// 登录保持天数就会跟着变成另一个班的设置 —— 界面上表现为「设置莫名其妙被重置」。
//
// 为什么落 core/.auth-policy.json，而不是塞进班级库的 settings 表：
//   1. 签发 token 时**不能**读库。登录发生在 withDb 作用域之外（routes/auth.js 的
//      issueSession），滑动续期更是在 middleware/auth.js 进 withDb 之前就要决定要不要签。
//      为了读一个配置把 slideSession 挪进 withDb 回调，等于给鉴权主路径加一层库依赖。
//   2. 形态与 .sessions.json 同构（全局一份、按账号分桶）。项目里已经有
//      「全局文件 + 账号维度」这个先例，不再引入第二种范式。
//   3. 超级隐私模式登出会 lockDb，库钥匙不在时读不到库；策略只放库里的话，
//      那一刻就没法判断该发多长的 token。
//
// 代价（已知并接受）：这个文件不进备份包，与 .jwt-secret / .sessions.json 一样属于
// 本机凭据。换机器恢复备份后，登录保持天数会退回默认值，需要重新选一次。
const fs = require('fs');
const dbManager = require('../dbManager/dbManager');

const DAY = 24 * 60 * 60 * 1000;

// 默认 30 天：与本次改动之前的行为完全一致，老用户升级后无感。
const DEFAULT_DAYS = 30;

// 合法区间：1 ~ 365 天。不提供「永久」—— 省掉 expiresIn 确实能签出永不过期的 token，
// 但那样会话名单清理、备份恢复、改密吊销全部失去兜底，出事时没有任何东西能让它过期。
// 要「不用反复登录」的正确做法是「活跃就续期」（配合 auth.js 的滑动续期已实现），
// 而不是把有效期设成无穷。
const MIN_DAYS = 1;
const MAX_DAYS = 365;

const FILE = () => dbManager.authPolicyPath;

// 缓存：{ [username]: { days, updatedAt } }。
// 文件很小，但这段代码跑在**每一个鉴权请求**的路径上，不能每个请求都 readFileSync
// （sessions.js 的名单缓存是同样的理由）。
let cache = null;

function load() {
  if (cache) return cache;
  try {
    const obj = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    // 文件不存在 / 内容损坏：一律当成「全是默认值」。
    // 不能因为一个配置读不出来就让所有人登不进去。
    cache = {};
  }
  return cache;
}

// 原子写：先写同目录临时文件、再 rename 替换。直接 writeFileSync 覆盖时，
// 写一半崩溃/掉电会留下半截 JSON，load() 解析失败就把所有账号的策略一起退回默认 30 天
// （V10-K04-01）。临时文件带 pid 避免并发写互相踩；rename 失败则清临时文件、保留原文件。
function save(impl = fs) {
  const file = FILE();
  if (!file || !cache) return;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    impl.writeFileSync(tmp, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 });
    impl.renameSync(tmp, file);
  } catch (err) {
    try { impl.unlinkSync(tmp) } catch (_) { /* best-effort: tmp 可能没建出来 */ }
    // best-effort: 写盘失败只影响重启记忆，内存已更新本次结果；
    // 原文件保持不动，下次重启读到的仍是上一次完整策略，不会整体回退默认。
    console.warn('[authPolicy] 策略写盘失败，本次改动仅存内存：' + (err && err.message));
  }
}

// 天数归一：非法值一律退回默认，而不是抛错。
// 这个函数在签发 token 的关键路径上，任何一个手改坏的 JSON 都不该让登录直接 500。
function normalizeDays(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  const int = Math.round(n);
  if (int < MIN_DAYS || int > MAX_DAYS) return DEFAULT_DAYS;
  return int;
}

// 账号键归一：与 usernameRules.normalizeUsername 同口径（仅 trim）。
// 空 / null 一律当成「未指定账号」→ 走默认策略；老 token 缺 username 的也会落到这里。
function key(account) {
  return account == null ? '' : String(account).trim();
}

// 读某账号的登录保持天数
function daysFor(account) {
  const k = key(account);
  if (!k) return DEFAULT_DAYS;
  const rec = load()[k];
  return normalizeDays(rec && rec.days != null ? rec.days : DEFAULT_DAYS);
}

// 写某账号的天数：先归一（越界值不落盘），返回真正生效的值。
// 调用方（routes/account.js）把返回值回给前端，界面显示的就是**实际生效**的天数，
// 不会出现「选了 999 天、实际 30 天、界面还显示 999」的错位。
function setDays(account, days) {
  const k = key(account);
  if (!k) return DEFAULT_DAYS;
  const value = normalizeDays(days);
  const list = load();
  list[k] = { days: value, updatedAt: Date.now() };
  save();
  return value;
}

// 账号改名时把设置跟着搬过去：不改名的话，用户改一次用户名，
// 「登录保持 180 天」会在没有任何提示的情况下退回 30 天。
function renameKey(oldName, newName) {
  const from = key(oldName);
  const to = key(newName);
  if (!from || !to || from === to) return false;
  const list = load();
  if (!Object.prototype.hasOwnProperty.call(list, from)) return false;
  // 目标键残留（旧账号删除后策略未清理 / 跨库不同步）时不能静默覆盖：
  // 记一条日志，并按「正在改名的这个账号」的策略覆盖过去（用户刚点的是这次改名）。
  if (Object.prototype.hasOwnProperty.call(list, to)) {
    console.warn(`[authPolicy] 改名目标键已有残留策略，按旧名策略覆盖：${to}`);
  }
  list[to] = list[from];
  delete list[from];
  save();
  return true;
}

// 由班级 slug 反查账号名，再取天数。
// 只给 sessions.js 的名单清理用：会话记录里只有 dbSlug，没有账号名。
// 走 index.db 的 registry（不碰班级库，不需要库钥匙），未知 slug 退回默认。
function daysForSlug(slug) {
  if (!slug) return DEFAULT_DAYS;
  try {
    const rec = dbManager.registryFindBySlug(String(slug));
    if (rec && rec.username) return daysFor(rec.username);
  } catch (_) { /* best-effort: index.db 不可用时按默认策略处理 */ }
  return DEFAULT_DAYS;
}

// —— 派生值：四个消费点必须从这里取，不要再各自写死数字 ——

// JWT 签发参数
function signOptsFor(account) {
  return { expiresIn: `${daysFor(account)}d` };
}

// 滑动续期窗口：剩余有效期少于这个阈值就续签。
// 取天数的 1/4（30 天 → 7.5 天，与改动前的固定 7 天基本一致），下限 1 小时。
//
// 这个比例是**必须**的，不是调参：窗口一旦 ≥ 天数，token 从签发那一刻起就永远处在
// 「该续签」区间里 —— 每个请求都签一次新 token、写一次 Cookie、重新绑定信道。
// 表现为接口变慢、日志暴涨，但没有任何报错，极难发现。
function slideWindowMs(account) {
  const w = Math.round((daysFor(account) * DAY) / 4);
  return Math.max(60 * 60 * 1000, w);
}

// 会话名单（.sessions.json）的清理期：比 token 多留 5 天余量。
// 必须严格大于 token 寿命，否则活跃用户会在名单被清掉的那天被强制登出 ——
// token 明明没过期，服务端名单里已经没有他（审查 v5 · V5-009 的同一类错误）。
function sessionTtlMs(account) {
  return (daysFor(account) + 5) * DAY;
}

// 同上，但入参是班级 slug（供 sessions.js 的名单清理用：会话记录里只有 dbSlug）。
function sessionTtlMsForSlug(slug) {
  return (daysForSlug(slug) + 5) * DAY;
}

// 最短的名单清理期（1 天配置 → 6 天）。sessions.prune 用它做一次廉价预筛：
// 比这还新的会话一定活着，不必为了查账号去碰 index.db。
const MIN_SESSION_TTL_MS = (MIN_DAYS + 5) * DAY;

// 媒体凭据（<img> / CSS url()）的寿命：与登录 token 同天数。
// 它不能调业务 API，登出时随 sid 一起吊销，单独给一个更短的值只会让图片在
// 会话还活着的时候突然全裂，没有安全收益。
function mediaTtlFor(account) {
  return `${daysFor(account)}d`;
}

module.exports = {
  DAY, DEFAULT_DAYS, MIN_DAYS, MAX_DAYS, MIN_SESSION_TTL_MS,
  daysFor, daysForSlug, setDays, renameKey, normalizeDays,
  signOptsFor, slideWindowMs, sessionTtlMs, sessionTtlMsForSlug, mediaTtlFor,
  // —— 仅供单元测试构造场景，生产代码不要用 ——
  __test_reload: () => { cache = null; return load(); },
  // 仅供单测注入假 fs 验证原子写（失败时原文件不动）
  __test_save: (impl) => save(impl),
};
