// =========================================================================
// ai-egress.test.js —— AI 出站地址白名单（v8 审查 N3-08 · RC-EGRESS）
//
// 判据：
//   ① 行为：只放行 http/https；拒绝 file:/ftp:/非 URL/云元数据地址；
//   ② 不误伤：localhost / 局域网地址必须仍然可用（本地 LLM 是核心用法）；
//   ③ 接线：模型发现、连通测试、对话、记忆四条出站路径都走同一校验入口。
// 变异反证：把 resolveEndpoint 改回字符串直拼 / 删掉 normalize 调用，本文件必须红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const { normalizeAiBaseUrl } = require('../../student-backend/services/aiEndpoint')

test('normalizeAiBaseUrl：放行 http/https 与本地/局域网地址', () => {
  assert.equal(normalizeAiBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1')
  assert.equal(normalizeAiBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1')
  assert.equal(normalizeAiBaseUrl('http://192.168.1.10:8000/v1'), 'http://192.168.1.10:8000/v1')
  assert.equal(normalizeAiBaseUrl(''), '', '空地址交给调用方报「尚未配置」')
})

test('normalizeAiBaseUrl：拒绝非 http(s)、非法 URL、云元数据地址', () => {
  assert.throws(() => normalizeAiBaseUrl('file:///etc/passwd'), /只支持 http/)
  assert.throws(() => normalizeAiBaseUrl('ftp://example.com/v1'), /只支持 http/)
  assert.throws(() => normalizeAiBaseUrl('not a url'), /不是合法 URL/)
  assert.throws(() => normalizeAiBaseUrl('http://169.254.169.254/latest/meta-data'), /元数据服务/)
  assert.throws(() => normalizeAiBaseUrl('http://metadata.google.internal/computeMetadata'), /元数据服务/)
})

test('接线：模型发现 / 对话 / 记忆四条出站路径都经过同一校验入口', () => {
  const cfg = read('student-backend/routes/ai/ai.config.js')
  assert.match(cfg, /require\('\.\.\/\.\.\/services\/aiEndpoint'\)/)
  const endpointFn = cfg.slice(cfg.indexOf('function resolveEndpoint'), cfg.indexOf('function reasoningParams'))
  assert.match(endpointFn, /normalizeAiBaseUrl\(/, 'resolveEndpoint 必须走校验')
  const discoverFn = cfg.slice(cfg.indexOf('async function discoverModels'), cfg.indexOf('// 通用连通性测试'))
  assert.match(discoverFn, /normalizeAiBaseUrl\(/, 'discoverModels 必须走校验')

  for (const rel of ['student-backend/routes/ai/ai.llm.js', 'student-backend/routes/ai/ai.memory.js']) {
    const src = read(rel)
    assert.match(src, /resolveEndpoint\(/, `${rel} 必须复用 resolveEndpoint（不要自己拼 base_url）`)
    assert.doesNotMatch(src, /\$\{base\}\/chat\/completions/, `${rel} 不能绕过校验直拼地址`)
  }
})
