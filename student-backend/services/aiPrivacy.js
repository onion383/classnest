// =========================================================================
// aiPrivacy.js —— 发给第三方模型前的学生身份替换（第 1 批：纯模块，零接线）
//
// 核心判据是「这个值要不要回写」，不是「敏感度」：
//   - 姓名 → 可逆别名 S-xxxxxx（HMAC 派生，确定性、跨轮稳定）
//   - 电话 → 可逆令牌 P-xxxxxx（同上，令牌→真号只能查表）
//   - 本地路径 → 不可逆归一化（抹掉盘符/用户名，保留层级末段与扩展名）
// 存储层永远是真值；替换只发生在「发出去之前 / 收回来之后」。
// 本批不依赖数据库上下文，也不被任何路由引用（判据见单测）。
// =========================================================================
const crypto = require('node:crypto');

const ALIAS_PREFIX = 'S-';
const TOKEN_PREFIX = 'P-';
//  collide 时会加长一位，故上限留到 10（'S-' + 8 hex）
// 守卫要比生成器更宽：P-zzzzzz 这种「形状像代号但库里没有」也必须被拒，
// 不能因为里面不是 hex 就放过去写库。
const TOKEN_RE = /\b[SP]-[0-9a-z]{6,10}\b/gi;
const PARTIAL_TOKEN_TAIL_RE = /[SP](?:-[0-9a-f]{0,9})?$/;
// 库里存在把 '1' 当联系电话的脏数据。只收真正的号码形态，
// 否则「家长联系电话=1」会把正文里每个 1 都换成令牌。
const PHONE_LIKE_RE = /^\d{7,20}$/;

function hmacHex(seed, payload) {
  return crypto.createHmac('sha256', String(seed == null ? '' : seed)).update(String(payload)).digest('hex');
}

function aliasForStudent(id, seed, len = 6) {
  return ALIAS_PREFIX + hmacHex(seed, `stu:${id}`).slice(0, Math.max(6, Math.min(16, Number(len) || 6)));
}

function tokenForPhone(phone, seed, len = 6) {
  return TOKEN_PREFIX + hmacHex(seed, `tel:${phone}`).slice(0, Math.max(6, Math.min(16, Number(len) || 6)));
}

function isPhoneLike(value) {
  return PHONE_LIKE_RE.test(String(value == null ? '' : value).trim());
}

// 按替换目标长度倒序：先替长的，避免「张三」先吃掉「张三丰」的前两字。
const rulesCache = new WeakMap();
function rulesFor(map) {
  let rules = rulesCache.get(map);
  if (!rules) {
    rules = [...map.keys()].filter((k) => typeof k === 'string' && k.length).sort((a, b) => b.length - a.length);
    rulesCache.set(map, rules);
  }
  return rules;
}

function replaceKnown(text, maps, direction) {
  let out = text;
  // 出站只走「真值→代号」；入站只走「代号→真值」。
  // 出站绝不能把上一轮用户复制回来的代号反查成真号（那等于自己把真值发出去）。
  const mapsToApply = direction === 'out'
    ? [maps.phoneToToken, maps.nameToAlias]
    : [maps.tokenToPhone, maps.aliasToName];
  for (const from of mapsToApply) {
    if (!from) continue;
    for (const key of rulesFor(from)) {
      const rep = from.get(key);
      if (rep == null) continue;
      // 中文姓名按整串替（名单里同时有「张三」「张三丰」时长名先替，已由 rulesFor 排序保证）。
      // 不能给中文加 \b 式边界：「张三请假了」里「张三」后面就是汉字，加了边界反而漏真名。
      // 数字例外：必须从长号码里切一段出来替，故加数字边界。
      if (/^\d+$/.test(key)) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`(?<!\\d)${escaped}(?!\\d)`, 'g'), String(rep));
      } else {
        out = out.split(key).join(String(rep));
      }
    }
  }
  return out;
}

// 从「行数组」构造四张方向表：姓名⇄别名、电话⇄令牌。不碰数据库，便于纯函数单测。
function buildMaps({
  students = [], leaves = [], seed = '', aliasLen = 6, tokenLen = 6,
  deriveAlias = aliasForStudent, deriveToken = tokenForPhone,
} = {}) {
  const idAlias = new Map();       // student_id（字符串）→ 别名，便于查映射长什么样
  const nameToAlias = new Map();   // 真名 → 别名
  const sourceOfName = new Map();  // 真名 → student_id，撞码时用
  const phones = new Set();

  for (const s of students || []) {
    if (!s || s.id == null) continue;
    const name = String(s['姓名'] || '').trim();
    if (!name) continue;
    idAlias.set(String(s.id), deriveAlias(s.id, seed, aliasLen));
    if (!nameToAlias.has(name)) {
      nameToAlias.set(name, deriveAlias(s.id, seed, aliasLen));
      sourceOfName.set(name, s.id);
    }
  }
  // 同名两人共用一个别名是**正确**的（同一身份），不算撞码；
  // 只有「不同的姓名得到同一个别名」才需要加长。
  const byAlias = new Map();
  for (const [name, alias] of nameToAlias) {
    if (!byAlias.has(alias)) byAlias.set(alias, []);
    byAlias.get(alias).push(name);
  }
  for (const names of byAlias.values()) {
    if (names.length < 2) continue;
    let solved = false;
    for (let len = aliasLen + 1; len <= 12; len++) {
      const next = names.map((n) => deriveAlias(sourceOfName.get(n), seed, len));
      if (new Set(next).size !== next.length) continue;
      names.forEach((n, i) => nameToAlias.set(n, next[i]));
      solved = true;
      break;
    }
    if (!solved) names.forEach((n) => nameToAlias.delete(n));
  }

  for (const row of [...(students || []), ...(leaves || [])]) {
    if (!row) continue;
    for (const key of ['家长联系电话', '学生联系电话']) {
      const v = row[key];
      if (v == null) continue;
      const phone = String(v).trim();
      if (isPhoneLike(phone)) phones.add(phone);
    }
  }
  const phoneToToken = new Map();
  for (const phone of phones) phoneToToken.set(phone, deriveToken(phone, seed, tokenLen));
  // 令牌同样可能撞（6 位 hex 只有 24 bit）：撞了就整组加长，仍撞就丢弃，绝不把两个号码解成同一个。
  const byToken = new Map();
  for (const [phone, token] of phoneToToken) {
    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(phone);
  }
  for (const tokens of byToken.values()) {
    if (tokens.length < 2) continue;
    let solved = false;
    for (let len = tokenLen + 1; len <= 12; len++) {
      const next = tokens.map((p) => deriveToken(p, seed, len));
      if (new Set(next).size !== next.length) continue;
      tokens.forEach((p, i) => phoneToToken.set(p, next[i]));
      solved = true;
      break;
    }
    if (!solved) tokens.forEach((p) => phoneToToken.delete(p));
  }

  const aliasToName = new Map();
  for (const [name, alias] of nameToAlias) aliasToName.set(alias, name);
  const tokenToPhone = new Map();
  for (const [phone, token] of phoneToToken) tokenToPhone.set(token, phone);

  return { seed, idAlias, nameToAlias, aliasToName, phoneToToken, tokenToPhone };
}

// 递归替换：只动字符串；数字原样保留（id / 分值 / 金额不能变成代号）。
// direction='out' 真值→代号，'in' 代号→真值；认不出的原样透传。
function walk(value, maps, direction, dataDir) {
  if (value == null) return value;
  if (typeof value === 'string') {
    let out = direction === 'out' ? replaceKnown(value, maps, 'out') : replaceKnown(value, maps, 'in');
    if (direction === 'out' && dataDir) out = normalizePaths(out, dataDir);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, maps, direction, dataDir));
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = walk(value[k], maps, direction, dataDir);
    return out;
  }
  return value;
}

function substituteOut(value, maps, dataDir = '') {
  return walk(value, maps || {}, 'out', dataDir);
}

function restoreIn(value, maps) {
  return walk(value, maps || {}, 'in', '');
}

// 路径归一化：库内路径 → <数据目录>/相对路径；盘符/用户名 → 占位符；统一成正斜杠。
function normalizePaths(value, dataDir = '') {
  if (typeof value !== 'string' || !value) return value;
  let s = value;
  const dir = String(dataDir || '').replace(/[\\/]+$/, '');
  if (dir) {
    const lower = s.toLowerCase();
    const needle = dir.toLowerCase();
    let from = 0;
    while (true) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      if (/[\\/]/.test(s[end] || '')) {
        s = s.slice(0, at) + '<数据目录>' + s.slice(end);
        break;
      }
      from = end;
    }
  }
  s = s.replace(/[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]/gi, '<用户目录>/');
  s = s.replace(/[A-Za-z]:[\\/]/g, '<盘符>/');
  s = s.replace(/(?:^|\/)(?:home|Users)\/[^/]+\//g, '<用户目录>/');
  return s.replace(/\\/g, '/');
}

// 写库前最后一道守卫：还剩代号说明 restoreIn 没认出来，绝不能把代号写进库。
function hasUnrestoredToken(value) {
  let s = value;
  if (typeof s !== 'string') {
    try { s = JSON.stringify(value); } catch (_) { return false; }
  }
  return typeof s === 'string' && new RegExp(TOKEN_RE.source).test(s);
}

// 流式反查：分片可能把 S-a3f1c9 切成两半，尾部留最多 maxTokenLen-1 个字符等下一片。
// done 时必须 flush()，否则最后那个代号会永远留在缓冲区。
function createStreamUnmasker(maps, maxTokenLen = 10) {
  let buf = '';
  const translate = (s) => restoreIn(s, maps);
  return {
    push(chunk) {
      buf += chunk == null ? '' : String(chunk);
      const tail = PARTIAL_TOKEN_TAIL_RE.exec(buf);
      const cut = tail && tail[0].length <= maxTokenLen - 1 ? tail.index : buf.length;
      const safe = buf.slice(0, cut);
      buf = buf.slice(cut);
      return translate(safe);
    },
    flush() {
      const out = translate(buf);
      buf = '';
      return out;
    },
  };
}

// 按 slug 分桶的门面：真正的 DB 读写由调用方注入，本批不提供（也就不会碰库）。
// enabled 关闭时 substitute/restore 必须零拷贝直接返回，不建映射表。
function createAiPrivacy({ readSeed, writeSeed, listStudents, listLeaves, readEnabled, dataDir = '' } = {}) {
  const cache = new Map();
  // 开关读取失败（如纯函数测试未绑定 DB、或设置表暂时不可用）时当作关闭：
  // 保护模块绝不能因为读不到开关就阻断主对话。真实请求里 DB 已绑定，正常读到 true/false。
  const enabledOf = (slug) => {
    try { return typeof readEnabled === 'function' ? readEnabled(slug) !== false : true; }
    catch (_) { return false; }
  };
  function stateOf(slug) {
    const key = slug || 'default';
    if (cache.has(key)) return cache.get(key);
    let seed = typeof readSeed === 'function' ? readSeed(key) : '';
    if (!seed) {
      seed = crypto.randomBytes(16).toString('hex');
      if (typeof writeSeed === 'function') writeSeed(key, seed);
    }
    const state = {
      seed,
      maps: buildMaps({
        seed,
        students: typeof listStudents === 'function' ? listStudents(key) : [],
        leaves: typeof listLeaves === 'function' ? listLeaves(key) : [],
      }),
      dataDir,
    };
    cache.set(key, state);
    return state;
  }
  return {
    enabled: (slug) => enabledOf(slug),
    buildMap: (slug) => stateOf(slug).maps,
    substitute(value, slug) {
      if (!enabledOf(slug)) return value;
      const st = stateOf(slug);
      return substituteOut(value, st.maps, st.dataDir);
    },
    restore(value, slug) {
      if (!enabledOf(slug)) return value;
      return restoreIn(value, stateOf(slug).maps);
    },
    stream(slug) {
      if (!enabledOf(slug)) return { push: (c) => c, flush: () => '' };
      return createStreamUnmasker(stateOf(slug).maps);
    },
    invalidate(slug) {
      if (slug) cache.delete(slug);
      else cache.clear();
    },
  };
}

// 运行期单例：DB 读写全部经 aiConfigStore / aiStore，本模块自身没有裸 SQL。
// 开关关闭时 createAiPrivacy 会零拷贝返回，连种子和名册都不会读。
const aiConfigStore = require('./aiConfigStore')
const aiStore = require('./aiStore')
const dbManager = require('../dbManager/dbManager')

const privacy = createAiPrivacy({
  readSeed: () => aiConfigStore.ensureSeed(),
  writeSeed: (_slug, seed) => aiConfigStore.writeSeed(seed),
  listStudents: () => aiStore.listPrivacyStudents(),
  listLeaves: () => aiStore.listPrivacyLeaves(),
  readEnabled: () => aiConfigStore.readPrivacy().enabled === true,
  dataDir: dbManager.dataDir,
})

module.exports = {
  aliasForStudent, tokenForPhone, isPhoneLike, buildMaps,
  substituteOut, restoreIn, normalizePaths, hasUnrestoredToken, createStreamUnmasker, createAiPrivacy,
  privacy,
};
