// =========================================================================
// subagent-tool-dispatch.test.js —— v8 §5-4 / G9 子助手白名单无幽灵工具
//
// 用户后果：子助手白名单若写进一个 schema 不存在的工具名，下发时会被
// getSubagentTools() 的 filter 静默吞掉——模型看不到这个工具，但维护者
// 以为已下发。报告 Q4-02 C 类 G9 点名「白名单 ⊄ schema 工具全集」。
//
// 行为判据（不是集合对账）：真跑 getSubagentTools() 拿到实际下发的工具清单，
// 断言白名单每个名字都真的被下发（即有对应执行器）。幽灵名会被 filter 丢掉，
// 于是「白名单有 / 下发无」→ 行为失败。真跑真实函数，不读源码正则。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { abs } = require('#testjs/paths')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

// fixture 注入 DB_MASTER_KEY/DATA_DIR；ai.llm require 链依赖它
const fx = createBackendDb({ label: 'subagent-tool-dispatch' })
const llm = require(abs('student-backend/routes/ai/ai.llm.js'))
const { SUBAGENT_TOOL_NAMES, isSubagentToolAllowed } = require(abs('student-backend/routes/ai/ai.subagent-tools.js'))

test.after(() => fx.close())

test('G9 白名单里每个只读工具都真的下发给子助手（无幽灵工具名）', () => {
  const dispatched = new Set(llm.getSubagentTools().map((t) => t.function.name))
  assert.ok(dispatched.size >= 8, '子助手下发工具不应为空')
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.ok(dispatched.has(name),
      `白名单工具「${name}」未出现在下发清单——schema 无此执行器，模型看不到却以为已下发`)
  }
})

test('G9 下发给子助手的工具全部通过执行侧白名单校验', () => {
  // 反方向：下发清单里不能有执行侧 isSubagentToolAllowed 拒绝的工具
  // （防止下发一个模型能调用、执行器却拦掉的工具——用户看到「调用失败」）
  for (const t of llm.getSubagentTools()) {
    assert.equal(isSubagentToolAllowed(t.function.name), true,
      `下发的工具「${t.function.name}」会被执行侧拒绝`)
  }
})

test('Q4-01 缺口③：下发给模型的每个工具都有派发 case（含 schema 外的 run_subagent）', () => {
  // 真跑 getTools() 拿实际下发的全部工具名，而不是从 aiSchema 对象取——
  // run_subagent 不在 schema 里（子助手专用），旧守卫从 schema 取名字就漏了它。
  // 少了 case 时模型能看到工具、调用却落 "未知工具"。
  const names = llm.getTools().map((t) => t.function.name)
  assert.ok(names.length >= 30, `下发工具数异常：${names.length}`)
  assert.ok(names.includes('run_subagent'), 'run_subagent 应在下发清单里（schema 外的子助手工具）')
  // @pin student-backend/routes/ai/ai.tools/tools.js#runTool
  const cases = new Set([...require('node:fs').readFileSync(abs('student-backend/routes/ai/ai.tools/tools.js'), 'utf8')
    .matchAll(/case\s+'([a-z_]+)'\s*:/g)].map((m) => m[1]))
  const missing = names.filter((n) => !cases.has(n))
  assert.deepStrictEqual(missing, [], `下发了但无派发 case（模型调用会落空）：${missing.join(', ')}`)
})

test('V9-I-15 工具名双向集合相等：派发 case ↔ 下发清单不能有任一侧多出来', () => {
  // 上一轮只断言「下发 ⊆ case」；反向「case ⊆ 下发」缺失 —— 删掉一个工具的下发注册，
  // 派发 case 仍留着，守卫不会红（Q4-01 缺口③的反向）。这里改成双向集合相等。
  const names = new Set(llm.getTools().map((t) => t.function.name))
  // @pin student-backend/routes/ai/ai.tools/tools.js#runTool
  const cases = new Set([...require('node:fs').readFileSync(abs('student-backend/routes/ai/ai.tools/tools.js'), 'utf8')
    .matchAll(/case\s+'([a-z_]+)'\s*:/g)].map((m) => m[1]))
  // 两个合法例外（不是缺口）：
  //  · run_subagent 走独立派发分支，不在 tools.js 的 switch 里（上一条已断言它在下发清单）；
  //  · web_search 只在 DeepSeek 模式 + 用户开联网时条件下发（tools.schema.js:287 / ai.llm.js:103），
  //    默认 getTools() 不含它是设计如此，派发 case 保留是为了条件开启时能调用。
  const knownExceptions = new Set(['run_subagent', 'web_search'])
  const dispatched = [...names].filter((n) => !knownExceptions.has(n)).sort()
  const dispatchedCases = [...cases].filter((n) => !knownExceptions.has(n)).sort()
  assert.deepStrictEqual(dispatched, dispatchedCases,
    `下发与派发 case 必须双向相等：仅下发=${dispatched.filter(n => !cases.has(n))} 仅case=${dispatchedCases.filter(n => !names.has(n))}`)
})
