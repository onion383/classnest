// =========================================================================
// failure-semantics.test.js —— 写操作失败语义约定（保存/删除链路必须可感知）
//
// 运行：npm run test:behavior
// 背景：catch 静默吞在「用户显式操作链路」上 = 点了没反应、刷新就丢（SeatView
// 的 saveWeight 曾只 console.error，权重改动静默丢失）。约定（见工作日志）：
//   · 空吞/仅 console 只允许出现在：偏好写入、预取/预热、可再生数据、探测类 I/O；
//   · 保存/删除/提交/改名等写操作的失败必须：UI 反馈（notify/showAlert/reportError）
//     或上抛或 return 兜底，或重新拉取回滚。
// 本测试按「函数名含写操作动词 + 体内有真 I/O」抽样钉住这条约定。
// 逃生口：catch 块里写 `behavior-ok` 注释并说明原因。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  analyze, walk, functionEntries, scriptBlocks,
} = require('../_source-scan.cjs')

const SRC = path.join(__dirname, '../../student-frontend/src')
// 只查前端行为层（views/composables/components）；utils 里纯函数不含 I/O 不受影响
const SCOPE = /student-frontend[\\/]+src[\\/]+(views|composables|components)[\\/]/

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, out)
    else if (/\.(js|vue)$/.test(e.name)) out.push(p)
  }
  return out
}

// 写操作动词：函数名命中 + 体内含真 I/O 才进入检查
const WRITE_VERB = /save|persist|delete|remove|submit|rename|restore|recover|write/i
const IO_MARK = /axios\.|fetch\(|apiFetch\(|\.request\(|window\.electron\??\.invoke\(/
// 失败可感知的标记：UI 反馈 / 上抛 / return 兜底 / 回滚重拉 / 写错误态
const FEEDBACK = /notify|showAlert|reportError|useNotification\b|\bthrow\b|\breturn\b|\bload[A-Z]\w*\(|\breload\w*\(|[A-Za-z_]*(error|Error|warn|Warn|fail|Fail|alert|Alert|message|Message)[A-Za-z_]*\.value\s*=/
// 设计性静默的注释豁免：带意图说明的注释吞（预览不阻断/回滚不叠加/持久化不阻塞对话等）
const DOCUMENTED = /behavior-ok|不阻断|不阻塞|不叠加|不影响|回滚|忽略|静默|无从排查|已[^*\\n]{0,15}处理/

// ---------------------------------------------------------------------------
// 为什么改成 AST：
//   · 旧 extractFunctions 用正则 + 裸花括号配平：字符串/模板串里出现 `{` 就会把配平带偏，
//     且对象方法只认 2+ 空格缩进。
//   · 旧判据在整段 catch 原文上查豁免/反馈关键词：注释里写「静默」、字符串里写「回滚失败」
//     都会误判成「已豁免 / 已有反馈」—— 真正的静默吞因此漏报。
// 现在：函数与 catch 用 AST 定位；豁免只读 catch 体里的**注释**，
//       反馈只在**去掉注释与字符串的代码**里判断（字符串文案不算失败反馈）。
// ---------------------------------------------------------------------------

function sourceCodeOf(file) {
  const s = fs.readFileSync(file, 'utf8')
  return file.endsWith('.vue') ? scriptBlocks(s) : s
}

// 收集写函数内的 catch 处理器：
//   · try/catch：TryStatement.handler.body
//   · 链式 .catch(fn)：只取块体（与旧判据覆盖范围一致）
function collectHandlers(fnNode) {
  const tryHandlers = []
  const catchCalls = []
  walk(fnNode, (node) => {
    if (node.type === 'TryStatement' && node.handler && node.handler.body) {
      tryHandlers.push(node.handler.body)
    }
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'MemberExpression'
      && node.callee.property && node.callee.property.type === 'Identifier'
      && node.callee.property.name === 'catch') {
      const arg = node.arguments[0]
      if (arg && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')
        && arg.body && arg.body.type === 'BlockStatement') {
        catchCalls.push(arg.body)
      }
    }
  })
  return { tryHandlers, catchCalls }
}

function judge(handlerBody, kind, ctx) {
  const { src, codeNoStrings, comments } = ctx
  // 只读 handler 体内部的注释作为豁免依据（带意图说明的设计性静默）
  const commentText = comments
    .filter((c) => c.start >= handlerBody.start && c.end <= handlerBody.end)
    .map((c) => src.slice(c.start, c.end))
    .join('\n')
  if (/behavior-ok/.test(commentText)) return null
  if (DOCUMENTED.test(commentText)) return null
  // 反馈判据只看代码，注释文案/字符串文案都不算
  const bodyCode = codeNoStrings.slice(handlerBody.start, handlerBody.end)
  if (FEEDBACK.test(bodyCode)) return null
  return kind
}

function scan() {
  const violations = []
  for (const f of walkFiles(SRC)) {
    if (!SCOPE.test(f)) continue
    const src = sourceCodeOf(f)
    if (!src.trim()) continue
    const { ast, codeNoStrings, comments } = analyze(src)
    const ctx = { src, codeNoStrings, comments }
    for (const fn of functionEntries(ast)) {
      if (!WRITE_VERB.test(fn.name)) continue
      // IO 判据用 codeNoStrings：字符串里写一句 "axios.get" 不算真 I/O
      if (!IO_MARK.test(codeNoStrings.slice(fn.start, fn.end))) continue
      const { tryHandlers, catchCalls } = collectHandlers(fn.node)
      // 嵌套在别的 catch 里的 catch 属于「回滚之回滚」，豁免（与旧 topLevelCatches 一致）
      const topTryHandlers = tryHandlers.filter((h) => !tryHandlers.some(
        (o) => o !== h && o.start < h.start && h.end < o.end,
      ))
      const line = src.slice(0, fn.start).split('\n').length
      for (const h of topTryHandlers) {
        if (judge(h, 'catch', ctx)) {
          violations.push(`${path.relative(SRC, f).replace(/\\/g, '/')}:${line} ${fn.name}() 的 catch 无失败反馈`)
        }
      }
      for (const h of catchCalls) {
        if (judge(h, '.catch', ctx)) {
          violations.push(`${path.relative(SRC, f).replace(/\\/g, '/')}:${line} ${fn.name}() 的 .catch() 无失败反馈`)
        }
      }
    }
  }
  return violations
}

test('失败语义：写操作链路的 catch 必须可感知（notify/报错/兜底/回滚）', () => {
  const v = scan()
  assert.deepEqual(v, [], '以下写操作失败被静默吞（用户会以为已保存）：\n' + v.join('\n'))
})

test('失败语义：扫描器自检——约定覆盖面非空（动词+I/O 命中若干函数）', () => {
  // 保证本测试不是"什么都没查所以通过"
  let hit = 0
  for (const f of walkFiles(SRC)) {
    if (!SCOPE.test(f)) continue
    const src = sourceCodeOf(f)
    if (!src.trim()) continue
    const { ast, codeNoStrings } = analyze(src)
    for (const fn of functionEntries(ast)) {
      if (WRITE_VERB.test(fn.name) && IO_MARK.test(codeNoStrings.slice(fn.start, fn.end))) hit++
    }
  }
  assert.ok(hit >= 10, `写操作函数样本量过少（${hit}），检查匹配规则是否失效`)
})
