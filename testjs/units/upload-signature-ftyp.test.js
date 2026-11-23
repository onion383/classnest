// =========================================================================
// upload-signature-ftyp.test.js —— 带前置盒的 MP4 不该被判「内容不是有效 mp4」
//
// `sniff` 原来只认 offset 4 的 `ftyp`：标准 MP4 的第一个盒就是它，但带前置
// `free`/`skip`/`wide` 盒的文件（部分手机直出视频、QuickTime 封装）会把 `ftyp`
// 推到后面，于是上传被 `sniffed !== kind` 拒掉（复核 A1-13 判定成立）。
// 这里用真实临时文件跑 checkUpload，不是复刻一份 sniff。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const { checkUpload } = require(path.join(ROOT, 'student-backend/services/uploadSignatures'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sniff-'))
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) { /* 忽略 */ } })

let seq = 0
function writeBytes(bytes) {
  const p = path.join(tmp, `f${seq++}.bin`)
  fs.writeFileSync(p, Buffer.from(bytes))
  return p
}

// 一个盒：4 字节 size + 4 字节 type（+ 可选内容）
const box = (type, size = 8, content = []) => [
  (size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff,
  ...Buffer.from(type, 'latin1'),
  ...content,
]
const FTYP = (brand = 'isom') => box('ftyp', 16, [...Buffer.from(brand, 'latin1'), 0, 0, 0, 0])

const up = (bytes, name) => checkUpload(writeBytes(bytes), name, bytes.length)

test('标准 MP4（ftyp 在 offset 4）照旧通过', () => {
  const r = up([...FTYP(), ...box('moov', 8)], 'a.mp4')
  assert.equal(r.ok, true, r.error)
  assert.equal(r.kind, 'video')
})

test('前置 free 盒的 MP4（ftyp 在 offset 12）必须通过', () => {
  const r = up([...box('free', 8), ...FTYP(), ...box('moov', 8)], 'b.mp4')
  assert.equal(r.ok, true, `被误判成「内容不是有效的 mp4 文件」：${r.error}`)
})

test('前置 skip + wide 两个盒（ftyp 在 offset 20）也必须通过', () => {
  // 注意 .mov 不在白名单里（video 只收 mp4/webm），这里测的是 mp4 的盒布局
  const r = up([...box('skip', 8), ...box('wide', 8), ...FTYP(), ...box('moov', 8)], 'c.mp4')
  assert.equal(r.ok, true, r.error)
})

test('内容根本不是 MP4 时仍然拒绝（放宽不等于不检）', () => {
  const r = up([...Buffer.from('this is plain text, no boxes here at all', 'latin1')], 'd.mp4')
  assert.equal(r.ok, false)
  assert.match(r.error, /内容不是有效的 mp4/)
})

test('把 zip 改名成 mp4 仍被拒（按内容判，不看后缀）', () => {
  const r = up([0x50, 0x4b, 0x03, 0x04, ...Buffer.alloc(40, 0)], 'e.mp4')
  assert.equal(r.ok, false)
})

test('ftyp 出现在 32 字节之后不算（别把文件中间的内容当魔数）', () => {
  const r = up([...Buffer.alloc(40, 0x11), ...FTYP()], 'f.mp4')
  assert.equal(r.ok, false, '前 32 字节内没有 ftyp 就不该认')
})

test('jpg / png 仍按图片识别（前置盒放宽没污染其他类型）', () => {
  assert.equal(up([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46], 'g.jpg').kind, 'image')
  assert.equal(up([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'h.png').kind, 'image')
})
