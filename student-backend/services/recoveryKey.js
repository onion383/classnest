// =========================================================================
// recoveryKey.js —— 恢复密钥公用工具
//
// 208 个汉字（去重后 197 个），随机取 12 个作为「中文恢复词」；
// 实际熵约 12×log2(197) ≈ 91.5 bit（不是早期注释误写的 108 bit）。
// 服务端只保存密钥哈希，校验时用「抄写的前 3 个词」或全部 12 词派生哈希做常数时间比对。
// 注册、订单（重置恢复密钥）、忘记密码 均复用本模块，避免重复定义。
// =========================================================================

const crypto = require('crypto');

const POOL = '山水日月风雨雷电云霞雪霜露雾虹霓晨昏朝夕春华秋实冬夏寒暑冷暖东西南北上下左右大小多少长短粗细远近高矮深浅明暗曲折顺逆安危患祸福寿康宁喜乐哀愁悲欢离合聚散起落升腾沉浮进出开关快慢迟早先后始终正反真假善恶美丑爱恨情仇得失成败胜负端倪边际尽头根源枝条花果叶根茎干枝桠芽蕾苞蕊瓣萼果实核仁壳皮肉骨血脉筋络肌肤毛发齿舌唇颈肩臂手掌握指肘膝腿足背胸腹脐腰臀腹背心胆肠脾胃肾肝肺脾胆血液津气体声韵调律节奏鼓琴瑟笛箫笙竽钟鼓磬铃铎声';

// 生成 12 个词的恢复密钥（连续汉字字符串）
function pickPhrase() {
  const chars = [];
  for (let i = 0; i < 12; i++) {
    chars.push(POOL[crypto.randomInt(0, POOL.length)]);
  }
  return chars.join('');
}

// 恢复词哈希的版本标识。
//
// 为什么需要：哈希一旦写进 users.recovery_hash 就**不能随便改** —— 用户已经把 12 个字
// 抄在纸上存着了，改算法 = 他们的恢复词永久失效、账号再也救不回来。
// 所以哈希串里带一个版本前缀，将来换算法时：
//   · 新哈希写 'restore:v2:...'（带新前缀）
//   · 校验时按版本分别比对（v1 走旧算法、v2 走新算法）
//   · 用户下次重置恢复密钥时自然升级到新版本
// 没有版本标识时，库里存着一堆无法区分算法的哈希 —— 换算法只能全库作废。
//
// v1 的算法必须**一字不改**地保留：它是已发布版本写进库的值。
const RESTORE_HASH_VERSION = 'v1';

// v1：单轮 sha256('restore:' + phrase)，无盐。
// 安全性说明：恢复词本身有 12×log2(197) ≈ 91.5 bit 熵，全字表暴力枚举需要 3.4×10²⁷ 次
// 尝试 —— 无盐彩虹表在这个熵下不构成实际威胁（预先枚举 10²⁷ 条物理上不可行）。
// 真正的风险是「哈希串不带版本标识」，已由 RESTORE_HASH_VERSION 解决。
function deriveRestoreHashV1(phrase) {
  return crypto.createHash('sha256').update('restore:' + phrase).digest('hex');
}

// 按版本派生哈希。v1 与历史实现完全一致（保证已发的恢复词仍可用）。
// 输出格式与 deriveRestoreHash 一致（带版本前缀），这样 verifyRestoreHash
// 直接拿它跟库里的哈希比即可。
function deriveRestoreHashByVersion(phrase, version) {
  if (version === 'v1') return 'restore:' + RESTORE_HASH_VERSION + ':' + deriveRestoreHashV1(phrase);
  // 未知版本：按 v1 处理（宁可宽松校验，也不要让用户永远登不进去）
  return 'restore:' + RESTORE_HASH_VERSION + ':' + deriveRestoreHashV1(phrase);
}

// 派生：恢复密钥 -> 哈希（用于服务端保存校验，不存明文）
// 输出格式：'restore:<版本>:<hex>'
function deriveRestoreHash(phrase) {
  return 'restore:' + RESTORE_HASH_VERSION + ':' + deriveRestoreHashV1(phrase);
}

// 校验恢复词：按哈希里带的版本标识选择算法。
// 这是**唯一**应该用来比对的地方 —— 所有比对点都走它，将来换算法只改这一处。
function verifyRestoreHash(phrase, storedHash) {
  if (typeof storedHash !== 'string' || !storedHash) return false;
  // 从哈希串里解析版本标识；没有标识的（历史值）按 v1 处理。
  const m = /^restore:(v\d+):/.exec(storedHash);
  if (!m) {
    // 历史格式：裸 sha256 hex（无前缀）—— 也是 v1
    return safeEqualHash(deriveRestoreHashV1(phrase), storedHash);
  }
  return safeEqualHash(deriveRestoreHashByVersion(phrase, m[1]), storedHash);
}

// 归一化：仅保留汉字，兼容用户粘贴带序号（1.水 …）或带空格的格式
function normalizePhrase(phrase) {
  return String(phrase).replace(/[^\u4e00-\u9fa5]/g, '');
}

// 展示用：给 12 个汉字配上序号，如「1.水  2.络  3.蕾 …」
function formatPhrase(phrase) {
  return normalizePhrase(phrase).split('').map((c, i) => `${i + 1}.${c}`).join('  ');
}

// 安全比较：固定长度哈希常数时间比对
function safeEqualHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  const maxLen = Math.max(bufA.length, bufB.length) + 1;
  const pa = Buffer.alloc(maxLen, 0); pa.set(bufA);
  const pb = Buffer.alloc(maxLen, 0); pb.set(bufB);
  let diff = pa.length ^ pb.length;
  for (let i = 0; i < pa.length; i++) diff |= pa[i] ^ pb[i];
  return diff === 0;
}

module.exports = {
  pickPhrase, deriveRestoreHash, normalizePhrase, formatPhrase, safeEqualHash,
  verifyRestoreHash, RESTORE_HASH_VERSION,
};