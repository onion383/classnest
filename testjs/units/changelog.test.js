// =========================================================================
// changelog.test.js —— 更新历史解析器（CHANGELOG.md -> 关于页列表）
// 运行：npm run test:units
//
// 覆盖：
//   1) 版本标题的多种写法（v 前缀 / · 分隔 / 括号日期）；
//   2) 条目清理（加粗、行内代码、链接取文字、多余空白）；
//   3) 非版本二级标题不污染上一个版本；
//   4) 空输入 / 无版本条目；
//   5) 仓库真实 CHANGELOG.md 的格式与内容契约。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loadParser = () =>
  import(pathToFileURL(path.join(__dirname, '../../student-frontend/src/utils/changelog.js')).href)

const CHANGELOG_PATH = path.join(__dirname, '../../CHANGELOG.md')

test('解析版本标题与条目，并按日期倒序输出', async () => {
  const { parseChangelog } = await loadParser()
  const markdown = [
    '# 更新历史',
    '<!-- 说明里放的示例条目不应被解析：',
    '## 9.9.9 · 2099-01-01',
    '- 示例条目',
    '-->',
    '> 文件里的说明行不影响解析。',
    '',
    '## 0.9.0 (2026-10-01)',
    '### 新增',
    '- **新增**：班级相册',
    '- 修复了 [导出问题](https://example.com)',
    '',
    '## v1.2.3 · 2026-11-02',
    '* `README` 更新',
    '  - 子条目也会被收集',
    '',
    '## 维护说明',
    '- 这一条不在任何版本下，应被忽略',
  ].join('\n')

  const entries = parseChangelog(markdown)
  assert.equal(entries.length, 2)

  // 文件里旧版本在前，解析后仍按日期倒序（最新在上）
  assert.deepEqual(entries[0], {
    version: '1.2.3',
    date: '2026-11-02',
    notes: ['README 更新', '子条目也会被收集'],
  })
  assert.deepEqual(entries[1], {
    version: '0.9.0',
    date: '2026-10-01',
    notes: ['新增：班级相册', '修复了 导出问题'],
  })
})

test('HTML 注释里的示例版本不会被解析', async () => {
  const { parseChangelog } = await loadParser()
  const markdown = [
    '<!--',
    '## 9.9.9 · 2099-01-01',
    '- 示例条目',
    '-->',
    '## 1.0.0 · 2026-01-01',
    '- 真实条目',
  ].join('\n')
  const entries = parseChangelog(markdown)
  assert.deepEqual(entries, [{ version: '1.0.0', date: '2026-01-01', notes: ['真实条目'] }])
})

test('CRLF 换行与多余空白也能解析', async () => {
  const { parseChangelog } = await loadParser()
  const markdown = '## 2.0.0 · 2026-12-01\r\n\r\n-   第一条   \r\n- 第二条\r\n'
  const entries = parseChangelog(markdown)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].version, '2.0.0')
  assert.deepEqual(entries[0].notes, ['第一条', '第二条'])
})

test('空输入与非版本标题返回空列表', async () => {
  const { parseChangelog } = await loadParser()
  assert.deepEqual(parseChangelog(''), [])
  assert.deepEqual(parseChangelog('   \n\n'), [])
  assert.deepEqual(parseChangelog('# 更新历史\n\n- 没有版本标题'), [])
  assert.deepEqual(parseChangelog('## 维护说明\n- 说明项'), [])
})

test('仓库 CHANGELOG.md 符合解析契约', async () => {
  const { parseChangelog } = await loadParser()
  const source = fs.readFileSync(CHANGELOG_PATH, 'utf8')
  const entries = parseChangelog(source)

  assert.ok(entries.length > 0, 'CHANGELOG.md 至少应有一个版本条目')

  const seen = new Set()
  for (const entry of entries) {
    assert.match(entry.version, /^\d+(?:\.\d+)*$/, `版本号格式不正确：${entry.version}`)
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/, `日期格式不正确：${entry.date}`)
    assert.ok(entry.notes.length > 0, `版本 ${entry.version} 没有更新条目`)
    assert.ok(!seen.has(entry.version), `版本号重复：${entry.version}`)
    seen.add(entry.version)
  }

  // 日期倒序：相邻两项的前一项日期不能早于后一项
  for (let i = 1; i < entries.length; i++) {
    assert.ok(entries[i - 1].date >= entries[i].date, '更新历史应保持日期倒序')
  }

  // 首个版本与当前首个发布内容对齐，避免迁移后数据悄悄改变
  assert.equal(entries[0].version, '0.1.0')
  assert.equal(entries[0].date, '2026-10-10')
  assert.equal(entries[0].notes[0], '第一个预览版')
})
