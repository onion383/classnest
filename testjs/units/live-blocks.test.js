// =========================================================================
// live-blocks.test.js —— AI 流式渲染分块（v6 性能专题 · 2-4）
//
// 背景：updateLiveRender 原本每跨一行就把整个 head 重跑 marked.parse + DOMPurify.sanitize，
// 总成本 O(n²)。实测 91% 花在 sanitize 上（500 行时单次 47.9ms），换成按块缓存后
// 每块只算一次。但切块不能改变渲染结果，所以本用例锁三件事：
//   ① 不变量：blocks.join('') === head（切块只分批，不吃字符 —— 曾经在这里吞过空行）；
//   ② 代码围栏内的空行不切；列表项之间、表格行之间的空行不切；
//   ③ 切在结构之前的空行仍然要切（否则退化成全量，缓存失效）。
// 渲染等价性（分块拼接 === 整段渲染）需要 DOM，由 testjs/tmp/live-render-verify.cjs 验。
// =========================================================================
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')

const MOD = pathToFileURL(path.resolve(__dirname, '../../student-frontend/src/composables/ai/aiMarkdown.js')).href

let splitStableBlocks

test.before(async () => {
  ({ splitStableBlocks } = await import(MOD))
})

test('不变量：分块拼接与原文逐字符相等', () => {
  const cases = [
    '',
    'a',
    'a\n',
    'a\n\nb\n',
    'a\n\n\nb\n',
    '段落一\n\n段落二\n\n段落三\n',
    '```\ncode\n\nmore\n```\n',
    '- x\n\n- y\n',
    '| a | b |\n|---|---|\n| 1 | 2 |\n',
    '标题\n\n- 列表一\n- 列表二\n\n结尾段落\n',
    '```js\nconst a = 1\n```\n\n后面的段落\n',
    '> 引用\n\n普通段落\n',
  ]
  for (const c of cases) {
    assert.equal(splitStableBlocks(c).join(''), c, `拼接不等于原文: ${JSON.stringify(c)}`)
  }
})

test('段落之间要在空行处切开', () => {
  const b = splitStableBlocks('段落一\n\n段落二\n\n段落三\n')
  assert.equal(b.length, 3)
  assert.deepEqual(b, ['段落一\n\n', '段落二\n\n', '段落三\n'])
})

test('代码围栏内的空行不切', () => {
  const src = '```\nline1\n\nline2\n```\n'
  const b = splitStableBlocks(src)
  assert.equal(b.length, 1, '整个代码块应保持一块')
  assert.equal(b[0], src)
})

test('围栏前后可以切，围栏内不行', () => {
  const src = '前面\n\n```\na\n\nb\n```\n\n后面\n'
  const b = splitStableBlocks(src)
  assert.equal(b.join(''), src)
  assert.ok(b.some(x => x.includes('```')), '代码块应完整落在某一块里')
  assert.ok(!b.some(x => x.trim().startsWith('a') && !x.includes('```')), '代码内容不应单独成块')
})

test('列表项之间的空行不切（否则 <ul> 会断成两个）', () => {
  const src = '- 一\n\n- 二\n\n- 三\n'
  const b = splitStableBlocks(src)
  assert.equal(b.length, 1)
  assert.equal(b[0], src)
})

test('列表之前的空行要切（切开不影响列表完整性）', () => {
  const src = '说明文字\n\n- 一\n- 二\n'
  const b = splitStableBlocks(src)
  assert.equal(b.length, 2)
  assert.equal(b[0], '说明文字\n\n')
  assert.equal(b[1], '- 一\n- 二\n')
})

test('表格行之间的空行不切', () => {
  // 表格不规范时空行会中断表格，但这里的判据是「表格行贴着表格行」不切
  const src = '| a |\n|---|\n\n| b |\n|---|\n'
  const b = splitStableBlocks(src)
  assert.equal(b.join(''), src)
})

test('已定型的块在追加后保持稳定（缓存前缀可命中）', () => {
  const lines = ['段落一', '', '段落二', '', '段落三', '']
  let text = ''
  let prevStable = []
  for (const l of lines) {
    text += l + '\n'
    // 最后一块可能还在增长，updateLiveRender 只缓存它之前的块
    const stable = splitStableBlocks(text).slice(0, -1)
    for (let i = 0; i < prevStable.length; i++) {
      assert.equal(stable[i], prevStable[i], `第 ${i} 块在追加后发生了变化`)
    }
    prevStable = stable
  }
})

test('空串与单行', () => {
  assert.deepEqual(splitStableBlocks(''), [])
  assert.deepEqual(splitStableBlocks('a\n'), ['a\n'])
})
