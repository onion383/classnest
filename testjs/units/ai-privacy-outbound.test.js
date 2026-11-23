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
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const HELPERS = 'student-backend/routes/ai/ai.helpers.js'
const MCP = 'student-backend/services/mcpTools.js'
const LLM = 'student-backend/routes/ai/ai.llm.js'

// 去掉注释后的源码，避免注释里提到「原文」造成假匹配
const clean = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

// ————————————————————————— ① 接线层：catch 不返回原文 —————————————————————————

test('工具结果出站：substitute 失败的 catch 不返回 text 原文', () => {
  const src = clean(HELPERS)
  const fn = src.slice(src.indexOf('function toolResultContent'), src.indexOf('function toolResultContent') + 900)
  const m = fn.match(/catch \(_\) \{([^}]*)\}/)
  assert.ok(m, '未找到 substitute 的 catch 块')
  assert.ok(!/return text/.test(m[1]), 'catch 里 return text = 脱敏失败仍发原文')
  assert.match(m[1], /暂不可用|无法/, 'catch 应返回不含真实数据的占位')
})

test('MCP 出站：maskResult 失败的 catch 不返回 result 原文', () => {
  const src = clean(MCP)
  const fn = src.slice(src.indexOf('function maskResult'), src.indexOf('function maskResult') + 400)
  const m = fn.match(/catch \(_\) \{([^}]*)\}/)
  assert.ok(m, '未找到 maskResult 的 catch 块')
  assert.ok(!/return result/.test(m[1]), 'catch 里 return result = 脱敏失败仍把真实数据交外部 AI')
  assert.match(m[1], /暂不可用|失败/, 'catch 应返回不含真实数据的占位')
})

// ————————————————————————— ② 接线层：文件名过 out() —————————————————————————

test('system prompt：附件文件名在拼入 prompt 前过 out()', () => {
  const src = clean(LLM)
  const fn = src.slice(src.indexOf('function buildSystemPrompt'), src.indexOf('function buildSystemPrompt') + 2500)
  const namesBlock = fn.slice(fn.indexOf('const names'), fn.indexOf('【可用文件】'))
  assert.ok(/\.map\(\s*\(name\)\s*=>\s*out\(name\)\s*\)/.test(namesBlock),
    '附件名未过 out(name) —— 含学生姓名的文件名会随每轮提示发给外部模型')
  assert.ok(!/names\.join/.test(namesBlock.slice(0, namesBlock.indexOf('.map((name)')))
    || /out\(name\)/.test(namesBlock), 'join 前必须先替换')
})

test('prompt 里用的 names 是替换后的变量（不是原始 a.name）', () => {
  const src = clean(LLM)
  const fn = src.slice(src.indexOf('function buildSystemPrompt'), src.indexOf('function buildSystemPrompt') + 2500)
  assert.match(fn, /out\(String\(summary\)/, 'summary 仍应过 out（原有行为不被破坏）')
  assert.match(fn, /\$\{names\.join\('、'\)\}/, 'prompt 用的是 names 变量')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：把 catch 改回 return text/result、文件名去掉 out，判据必须失败', () => {
  const h = clean(HELPERS).replace(/catch \(_\) \{ text = JSON\.stringify\(\{ error: '数据保护脱敏失败[^}]*\}\); \}/,
    'catch (_) { return text; }')
  assert.ok(/catch \(_\) \{ return text; \}/.test(h), 'helpers 变异失败')

  const m = clean(MCP).replace(/catch \(_\) \{ return \{ ok: false, error: '数据保护脱敏失败[^}]*\}; \}/,
    'catch (_) { return result; }')
  assert.ok(/catch \(_\) \{ return result; \}/.test(m), 'mcp 变异失败')

  const l = clean(LLM).replace(/\n\s*\.map\(\(name\) => out\(name\)\)/, '')
  assert.ok(!/\.map\(\(name\) => out\(name\)\)/.test(l.slice(l.indexOf('const names'), l.indexOf('【可用文件】'))),
    'llm 变异失败：文件名 out 去掉后判据应判失败')
})
