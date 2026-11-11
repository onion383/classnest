// =========================================================================
// docs-counts.test.js —— 文档计数「唯一来源」的可写性与正确性（v6 · 5-3）
//
// 5-1 修掉的是「只检查有没有写」的假绿；这张卡要修「校验算一遍、人手抄一遍」的
// 二次漂移。判据落在 docs-counts.mjs 上：
//   ① 9 项计数都能从源码现算，且文档里确实有可替换的数字位置；
//   ② replaceCount 只替换捕获到的数字，前后缀原样保留、幂等；
//   ③ 文档结构变了（匹配不到）要返回 null，让 sync 报错而不是静默跳过。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '../..')
const urlOf = (rel) => pathToFileURL(path.join(ROOT, rel)).href

test('9 项计数全部能从源码现算，且每份文档都有可替换的计数位置', async () => {
  const { countExpectations, replaceCount } = await import(urlOf('testjs/tools/docs-counts.mjs'))
  const list = countExpectations(228)
  assert.equal(list.length, 9, '计数项数量变了就同步更新测试与文档')
  for (const e of list) {
    assert.ok(fs.existsSync(e.file), `${e.name} 的文档不存在：${e.file}`)
    assert.equal(typeof e.actual, 'number', `${e.name} 必须现算出数字`)
    const text = fs.readFileSync(e.file, 'utf8')
    // 结构检查：文档里能定位到数字，sync 才能改写（数值是否一致交给 docs:verify）
    assert.notEqual(replaceCount(text, e.re, e.actual), null, `${e.name} 找不到计数位置（文档结构变了吗）`)
  }
  assert.equal(list.find((e) => e.name === '后端路由数').actual, 228, '路由数必须用调用方现算的值')
})

test('replaceCount 只替换捕获到的数字，前后缀原样保留且幂等', async () => {
  const { replaceCount } = await import(urlOf('testjs/tools/docs-counts.mjs'))
  const text = '工具（`src/utils/`，48 个）与其它说明 48 处'
  const re = /工具（`src\/utils\/`，(\d+)\s*个）/
  const next = replaceCount(text, re, 49)
  assert.equal(next, '工具（`src/utils/`，49 个）与其它说明 48 处', '不能动到句子里其它同名数字')
  assert.equal(replaceCount(next, re, 49), next, '同值重复执行必须不变（幂等）')
})

test('匹配不到计数位置时返回 null（禁止静默跳过）', async () => {
  const { replaceCount } = await import(urlOf('testjs/tools/docs-counts.mjs'))
  assert.equal(replaceCount('文档结构变了', /共\s*(\d+)\s*个/, 3), null)
  assert.equal(replaceCount('', /共\s*(\d+)\s*个/, 3), null)
})
