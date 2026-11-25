// =========================================================================
// ai-privacy-outbound.test.js —— 脱敏异常不发原文 + 附件文件名出站替换（1-9 / #1）
//
// 原缺陷三处：
//   ① ai.helpers.js toolResultContent：privacy.substitute 抛错时 catch 返回原文 → 真名真号发给模型
//   ② mcpTools.js maskResult：同样 catch 返回原文 → 外部 AI 拿到真实数据
//   ③ ai.llm.js buildSystemPrompt：附件文件名 a.name 原样拼入 prompt，没过 out()
// 修法：①② catch 后返回不含真实数据的占位；③ 文件名过 out()。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')

const HELPERS = 'student-backend/routes/ai/ai.helpers.js'
const MCP = 'student-backend/services/mcpTools.js'
const LLM = 'student-backend/routes/ai/ai.llm.js'

// 去掉注释后的源码，避免注释里提到「原文」造成假匹配
const clean = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

// ————————————————————————— ① 接线层：catch 不返回原文 —————————————————————————

// 判据抽成可复用函数（T04-01）：主用例与变异反证共用同一份，变异后重跑才能证明判据有区分力
function helpersCatchGuard(src) {
  const i = src.indexOf('function toolResultContent')
  const fn = src.slice(i, i + 900)
  // 函数体里有多个 catch（序列化失败 / 脱敏失败），必须逐个检查，
  // 只取第一个会把「脱敏失败仍发原文」的漏洞漏掉（T04-01 反证暴露的判据过窄）。
  const catches = [...fn.matchAll(/catch \(_\) \{([^}]*)\}/g)].map((m) => m[1])
  if (!catches.length) return { ok: false, why: '未找到 substitute 的 catch 块' }
  for (const body of catches) {
    if (/return (text|result)\b/.test(body)) {
      return { ok: false, why: 'catch 里 return text = 脱敏失败仍发原文' }
    }
  }
  if (!catches.some((b) => /暂不可用|无法/.test(b))) {
    return { ok: false, why: 'catch 应返回不含真实数据的占位' }
  }
  return { ok: true }
}

function mcpCatchGuard(src) {
  const i = src.indexOf('function maskResult')
  const fn = src.slice(i, i + 400)
  const catches = [...fn.matchAll(/catch \(_\) \{([^}]*)\}/g)].map((m) => m[1])
  if (!catches.length) return { ok: false, why: '未找到 maskResult 的 catch 块' }
  for (const body of catches) {
    if (/return (text|result)\b/.test(body)) {
      return { ok: false, why: 'catch 里 return result = 脱敏失败仍把真实数据交外部 AI' }
    }
  }
  if (!catches.some((b) => /暂不可用|失败/.test(b))) {
    return { ok: false, why: 'catch 应返回不含真实数据的占位' }
  }
  return { ok: true }
}

function llmNamesGuard(src) {
  const i = src.indexOf('function buildSystemPrompt')
  const fn = src.slice(i, i + 2500)
  const namesBlock = fn.slice(fn.indexOf('const names'), fn.indexOf('【可用文件】'))
  if (!/\.map\(\s*\(name\)\s*=>\s*out\(name\)\s*\)/.test(namesBlock)) {
    return { ok: false, why: '附件名未过 out(name) —— 含学生姓名的文件名会随每轮提示发给外部模型' }
  }
  return { ok: true }
}

test('工具结果出站：substitute 失败的 catch 不返回 text 原文', () => {
  const r = helpersCatchGuard(clean(HELPERS))
  assert.ok(r.ok, r.why)
})

test('MCP 出站：maskResult 失败的 catch 不返回 result 原文', () => {
  const r = mcpCatchGuard(clean(MCP))
  assert.ok(r.ok, r.why)
})

// ————————————————————————— ② 接线层：文件名过 out() —————————————————————————

test('system prompt：附件文件名在拼入 prompt 前过 out()', () => {
  const r = llmNamesGuard(clean(LLM))
  assert.ok(r.ok, r.why)
})

test('prompt 里用的 names 是替换后的变量（不是原始 a.name）', () => {
  const src = clean(LLM)
  const fn = src.slice(src.indexOf('function buildSystemPrompt'), src.indexOf('function buildSystemPrompt') + 2500)
  assert.match(fn, /out\(String\(summary\)/, 'summary 仍应过 out（原有行为不被破坏）')
  assert.match(fn, /\$\{names\.join\('、'\)\}/, 'prompt 用的是 names 变量')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：把 catch 改回 return text/result、文件名去掉 out，原始判据必须失败', () => {
  const h0 = clean(HELPERS)
  assert.equal(helpersCatchGuard(h0).ok, true, '基线 helpers 判据应先通过')
  const h = h0.replace(/catch \(_\) \{ text = JSON\.stringify\(\{ error: '数据保护脱敏失败[^}]*\}\); \}/,
    'catch (_) { return text; }')
  assert.ok(h !== h0, 'helpers 变异正则没匹配到目标块')
  assert.equal(helpersCatchGuard(h).ok, false, '抹掉占位返回后判据仍 PASS —— 判据假绿')

  const m0 = clean(MCP)
  assert.equal(mcpCatchGuard(m0).ok, true, '基线 mcp 判据应先通过')
  const m = m0.replace(/catch \(_\) \{ return \{ ok: false, error: '数据保护脱敏失败[^}]*\}; \}/,
    'catch (_) { return result; }')
  assert.ok(m !== m0, 'mcp 变异正则没匹配到目标块')
  assert.equal(mcpCatchGuard(m).ok, false, 'mcp 抹掉占位返回后判据仍 PASS —— 判据假绿')

  const l0 = clean(LLM)
  assert.equal(llmNamesGuard(l0).ok, true, '基线 llm 判据应先通过')
  const l = l0.replace(/\n\s*\.map\(\(name\) => out\(name\)\)/, '')
  assert.ok(l !== l0, 'llm 变异正则没匹配到目标块')
  assert.equal(llmNamesGuard(l).ok, false, 'llm 去掉 out(name) 后判据仍 PASS —— 判据假绿')
})
