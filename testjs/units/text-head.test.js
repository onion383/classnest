// =========================================================================
// text-head.test.js —— AI 附件只读头部（v6 性能专题 · 2-12）
//
// 原实现先 fs.readFileSync 整份再 slice(0, 100000)：20MB 的 txt 会先变成约 40MB
// 的 V8 字符串，其中 99.5% 读完就丢。本用例锁四件事：
//   ① 大文件只读 maxChars*4 字节，不再整份读入（bytesRead 可证）；
//   ② 小文件仍整份读，结果与旧实现逐字符一致；
//   ③ 读取边界落在多字节序列中间时，末尾不产生 U+FFFD（中文 3 字节 / emoji 4 字节各一条）；
//   ④ truncated 口径：文件刚好等于上限不算截断，超了才算。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')

const { readTextHead, decodeHead, trimIncomplete } = require('../../student-backend/utils/textHead')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'text-head-'))
function write(name, content) {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, content)
  return p
}
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 清理失败不影响结论 */ } })

test('大文件只读 maxChars*4 字节，不整份读入', () => {
  const p = write('big.txt', 'a'.repeat(20 * 1024 * 1024)) // 20MB，与 multer 上限同量级
  const r = readTextHead(p, 100000)
  assert.equal(r.fileSize, 20 * 1024 * 1024)
  assert.equal(r.bytesRead, 400000, '只读 100000*4 字节')
  assert.equal(r.text.length, 100000)
  assert.equal(r.truncated, true)
  fs.unlinkSync(p)
})

test('小文件整份读，结果与旧实现一致', () => {
  const body = '姓名,学号\n张三,001\n李四,002\n'
  const p = write('small.csv', body)
  const r = readTextHead(p, 100000)
  assert.equal(r.text, body)
  assert.equal(r.truncated, false)
  assert.equal(r.bytesRead, fs.statSync(p).size)
  fs.unlinkSync(p)
})

test('中文边界：读取截断落在 3 字节字符中间时不产生 U+FFFD', () => {
  const p = write('cn.txt', '中'.repeat(50)) // 150 字节
  const r = readTextHead(p, 5)               // maxBytes=20 → 第 7 个字符被切成 2 字节
  assert.equal(r.bytesRead, 20)
  assert.equal(r.text, '中'.repeat(5))
  assert.ok(!r.text.includes('\uFFFD'), '不应出现替换字符')
  fs.unlinkSync(p)
})

test('emoji 边界：4 字节字符被切断时同样裁掉残字节，且不留孤立代理', () => {
  // emoji 在 JS 里占 2 个 UTF-16 code unit，所以 maxChars=3 时只能放下 1 个完整的，
  // 第 2 个会被切成「高代理 + 半个」—— 必须整只丢掉，不能留 \ud83c。
  const p = write('emoji.txt', '🎉'.repeat(10))
  const exact = readTextHead(p, 3)
  assert.equal(exact.text, '🎉', '半个 emoji 不能留在尾部')
  assert.equal(exact.truncated, true)

  // 字节层：10 字节 = 2 个完整 emoji + 2 字节残片 → 残片裁掉
  const buf = fs.readFileSync(p)
  const d = decodeHead(buf.subarray(0, 10), 100)
  assert.equal(d.text, '🎉🎉')
  // 注意不能用 /[\uD800-\uDFFF]/ 直接测：完整的代理对也会命中，那是误报
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(d.text), '不应出现孤立代理')
  fs.unlinkSync(p)
})

test('truncated 口径：刚好等于上限不算截断，超了才算', () => {
  const p1 = write('exact.txt', 'a'.repeat(10))
  assert.equal(readTextHead(p1, 10).truncated, false, '正好 10 字符不应算截断')

  const p2 = write('over.txt', 'a'.repeat(30)) // 30 字节 < maxBytes(40)，能读全，但字符超上限
  const r2 = readTextHead(p2, 10)
  assert.equal(r2.bytesRead, 30, '文件小则整份读')
  assert.equal(r2.text, 'a'.repeat(10))
  assert.equal(r2.truncated, true, '字符数超上限要算截断')

  fs.unlinkSync(p1)
  fs.unlinkSync(p2)
})

test('空文件与零上限', () => {
  const p = write('empty.txt', '')
  const r = readTextHead(p, 100000)
  assert.equal(r.text, '')
  assert.equal(r.truncated, false)
  assert.equal(readTextHead(p, 0).text, '', 'maxChars<=0 直接返回空')
  fs.unlinkSync(p)
})

test('trimIncomplete：只裁不完整尾字节，完整 Buffer 原样返回', () => {
  const full = Buffer.from('中文', 'utf8')
  assert.deepEqual(trimIncomplete(full), full, '完整序列不动')
  assert.deepEqual(trimIncomplete(full.subarray(0, 1)), Buffer.alloc(0), '只剩首字节 → 全裁')
  assert.deepEqual(trimIncomplete(full.subarray(0, 4)), full.subarray(0, 3), '留完整的第一字')
  assert.deepEqual(trimIncomplete(Buffer.from('abc')), Buffer.from('abc'), 'ASCII 原样')
})
