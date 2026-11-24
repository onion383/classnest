// =========================================================================
// main.update-integrity.js —— 更新包完整性校验（不依赖 electron，可单测）
//
// 更新链原先只校验 Content-Length：下载地址、重定向后的最终地址、发布资产的哈希
// 都没有验证。任何能改写 release 资产 / 中间劫持的一方都能塞入任意 exe，
// 而安装器会以静默参数直接运行它（B01-12）。
//
// 这里提供两道校验：
//   1) HTTPS：下载地址与重定向后的最终地址都必须是 https；
//   2) SHA-256：GitHub Releases API 会返回 asset.digest（形如 sha256:...），
//      有就强制比对文件哈希；缺失时至少按 asset.size 校验大小并留日志。
// =========================================================================

const crypto = require('crypto');
const fs = require('fs');

// 只接受 HTTPS 地址；非法 URL 或非 https 直接抛错
function assertHttpsUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl || ''));
  } catch (_) {
    throw new Error('更新包下载地址无效');
  }
  if (u.protocol !== 'https:') throw new Error('更新包下载地址必须是 HTTPS');
  return u;
}

// 本地回环 http 仅在 dev + 显式 mock 配置时放行，用于在没有发布包时走通整条流程。
// 两个约束缺一不可：① 只认 127.0.0.1 / localhost，不认局域网 IP；
//                    ② 由调用方传 allowLocalMock（仅 dev 环境为 true），生产恒为 HTTPS。
function isLocalMockUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch (_) {
    return false;
  }
}
function assertAllowedDownloadUrl(rawUrl, { allowLocalMock = false } = {}) {
  if (allowLocalMock && isLocalMockUrl(rawUrl)) return new URL(String(rawUrl));
  return assertHttpsUrl(rawUrl);
}

// =========================================================================
// 独立 digest 清单（release-trust.json）
//
// GitHub Releases 的 asset.digest 与下载地址同源：能改资产的人就能连 digest 一起改。
// 清单放在仓库里经 raw.githubusercontent.com 读取，与 Release 是不同的权限边界；
// 两者不一致时直接拒装 —— 这是「没有代码签名证书」前提下能拿到的最强免费信任锚。
// =========================================================================
const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i

function normalizeDigest(raw) {
  const d = String(raw || '').toLowerCase()
  return SHA256_DIGEST_RE.test(d) ? d : null
}

// 从清单 JSON 里取指定版本的 digest；格式不对/没这一版都返回 null（由上层降级并提示）
function digestFromTrustManifest(json, version) {
  try {
    const data = typeof json === 'string' ? JSON.parse(json) : json
    const entries = data && data.entries
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null
    const key = String(version || '').trim().replace(/^v/i, '')
    return normalizeDigest(entries[key] || entries['v' + key])
  } catch (_) {
    return null
  }
}

// 决策：清单优先、与资产摘要冲突则拒装；清单缺失时降级为资产来源并标记告警。
// 返回 { decision: 'ok' | 'warn' | 'reject', digest, source, reason }
function resolveDigestTrust({ manifestDigest, assetDigest } = {}) {
  const m = normalizeDigest(manifestDigest)
  const a = normalizeDigest(assetDigest)
  if (m && a && m !== a) {
    return { decision: 'reject', digest: m, source: 'conflict', reason: '发布清单与发布资产摘要不一致' }
  }
  if (m) return { decision: 'ok', digest: m, source: 'manifest', reason: '' }
  if (a) return { decision: 'warn', digest: a, source: 'asset-only', reason: '独立摘要清单不可用，仅按发布资产摘要校验' }
  return { decision: 'warn', digest: null, source: 'size-only', reason: '独立摘要清单与资产摘要均不可用，仅按大小校验' }
}

// 流式计算文件 sha256（安装包上百 MB，不能整个读进内存）
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });
}

// 校验已下载的安装包。
// 返回 { ok, error?, verified: 'sha256' | 'size-only', sha256?: string }
//   · 大小与 expectedSize（asset.size 或 Content-Length）不一致 → 失败；
//   · digest 形如 sha256:<64 hex> → 比对哈希；
//   · 没有 digest → 仅大小校验，标记 size-only（调用方负责 warn）。
//   · sha256：本次**实际算出的**文件哈希（无论发布方是否提供 digest 都算），
//     供调用方留作「安装前复核」的凭据 —— 见 updater.js 的 downloadedInstallerDigest。
async function verifyDownloadedFile({ filePath, expectedSize, digest }) {
  const size = fs.statSync(filePath).size;
  if (expectedSize > 0 && size !== expectedSize) {
    return { ok: false, error: '下载文件不完整' };
  }
  const d = String(digest || '').toLowerCase();
  // 无论发布方是否提供 digest，都把本地实际哈希算出来：
  //   有 digest 时用于比对（防止资产被替换/中间劫持）；
  //   无 digest 时留作安装前的复核凭据（防止下载后被本地替换）。
  const actual = await sha256File(filePath);
  if (/^sha256:[0-9a-f]{64}$/.test(d)) {
    if (actual !== d.slice('sha256:'.length)) {
      return { ok: false, error: '更新包校验失败（SHA-256 不一致）' };
    }
    return { ok: true, verified: 'sha256', sha256: actual };
  }
  return { ok: true, verified: 'size-only', sha256: actual };
}

// 从发布资产名列表里挑 Inno 安装包。
//
// 为什么必须排除 Vue 3.6 预览包：它的名字同样含「-Setup-」（ClassNest-Vue36-Setup-x.y.z.exe），
// 只按 /setup.*\.exe$/ 找再取第一个，正式版用户就可能被升级到预览版 —— 而这个包在安装页和
// 引导页都写着「不建议作为主力版本使用」。资产顺序由 GitHub 返回，不可依赖。
const SETUP_ASSET_RE = /setup.*\.exe$/i
const PREVIEW_ASSET_RE = /vue36/i
function pickSetupAssetName(names) {
  for (const name of Array.isArray(names) ? names : []) {
    const s = String(name || '')
    if (!s || PREVIEW_ASSET_RE.test(s)) continue
    if (SETUP_ASSET_RE.test(s)) return s
  }
  return null
}

module.exports = {
  assertHttpsUrl, assertAllowedDownloadUrl, isLocalMockUrl,
  digestFromTrustManifest, resolveDigestTrust,
  sha256File, verifyDownloadedFile, pickSetupAssetName,
}
