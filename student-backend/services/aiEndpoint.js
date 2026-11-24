// =========================================================================
// aiEndpoint.js —— AI 出站地址的唯一校验入口（v8 审查 N3-08 · RC-EGRESS）
//
// base_url 由用户在 AI 设置里填写，后端会拿它发真实请求（模型发现 / 连通测试 /
// 对话 / 记忆）。此前只做字符串拼接，连 `file:`、空主机、云元数据地址都能进入
// fetch，构成自指 SSRF 面。
//
// 这里统一收口「能出到哪」：
//   · 只允许 http / https（Node fetch 本来也不支持 file:，但先显式拒绝更清楚）；
//   · 必须有主机名；
//   · 拒绝云厂商元数据地址（169.254.169.254 / metadata.google.internal）。
//
// 刻意**不**封禁 127.0.0.1 / 局域网网段：本应用的核心用法之一就是接本地或
// 局域网 LLM（Ollama / LM Studio / vLLM），一封就会把合法用户挡在门外。
// 「是否允许出到内网」属产品策略，登记待决策；这里先堵住协议与元数据两类。
// =========================================================================

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal'])

function normalizeAiBaseUrl(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/\/+$/, '')
  if (!s) return ''
  let u
  try {
    u = new URL(s)
  } catch (_) {
    throw new Error('模型地址不是合法 URL')
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
    throw new Error('模型地址只支持 http / https')
  }
  if (!u.hostname) throw new Error('模型地址缺少主机名')
  if (BLOCKED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error('不允许把模型地址指向云主机元数据服务')
  }
  return s
}

module.exports = { normalizeAiBaseUrl, ALLOWED_PROTOCOLS, BLOCKED_HOSTS }
