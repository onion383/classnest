// =========================================================================
// receipt-kind.test.js —— 4-1（A1-01 / X2-03）：收据 Office 文件打不开
//
// 根因：校验层按魔数把 Office 分成 ooxml（zip：docx/xlsx/pptx）与
// ole（复合文档：doc/xls/ppt），app.js 又把 check.kind 原样落库；
// 前端 ReceiptDialog 的 viewMode 只认 'office' → 新上传的 Office 文件
// 被判成「无法预览」。
//
// 修法：校验细分保留（魔数判据需要），落库/展示前在 uploadSignatures 里
// 统一归一 ooxml|ole → office；前端 viewMode 兼容细分类型作为第二道防线。
// =========================================================================

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const { checkUpload, receiptKind } = require('../../student-backend/services/uploadSignatures')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-kind-'))
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// 造一个带指定魔数头的真文件（checkUpload 只看前 16 字节）
function make(name, head, size = 1000) {
  const p = path.join(tmp, name)
  const body = Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, size - head.length))])
  fs.writeFileSync(p, body)
  return { path: p, name, size: body.length }
}

const OOXML_HEAD = [0x50, 0x4b, 0x03, 0x04]
const OLE_HEAD = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

test('[行为] docx / xlsx / pptx 校验为 ooxml，落库归一为 office', () => {
  for (const ext of ['docx', 'xlsx', 'pptx']) {
    const f = make(`a.${ext}`, OOXML_HEAD)
    const r = checkUpload(f.path, f.name, f.size)
    assert.strictEqual(r.ok, true, `${ext} 应通过校验`)
    assert.strictEqual(r.kind, 'ooxml', `${ext} 的校验类型应是细分的 ooxml`)
    assert.strictEqual(receiptKind(r.kind), 'office', `${ext} 落库必须归成 office`)
  }
})

test('[行为] doc / xls / ppt 校验为 ole，落库归一为 office', () => {
  for (const ext of ['doc', 'xls', 'ppt']) {
    const f = make(`b.${ext}`, OLE_HEAD)
    const r = checkUpload(f.path, f.name, f.size)
    assert.strictEqual(r.ok, true, `${ext} 应通过校验`)
    assert.strictEqual(r.kind, 'ole', `${ext} 的校验类型应是细分的 ole`)
    assert.strictEqual(receiptKind(r.kind), 'office', `${ext} 落库必须归成 office`)
  }
})

test('[行为] 图片 / PDF / 文本 / 视频的 kind 原样保留', () => {
  const cases = [
    ['c.jpg', [0xff, 0xd8, 0xff, 0xe0], 'image'],
    ['d.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d], 'pdf'],
    // 文本类靠「前 512 字节没有 NUL」判定，不能补零
    ['e.md', [...Buffer.from('# 支出\n', 'utf8')], 'text', 0],
    ['f.webm', [0x1a, 0x45, 0xdf, 0xa3], 'video'],
  ]
  for (const [name, head, expected, size = 1000] of cases) {
    const f = make(name, head, size)
    const r = checkUpload(f.path, f.name, f.size)
    assert.strictEqual(r.ok, true, `${name} 应通过校验`)
    assert.strictEqual(r.kind, expected)
    assert.strictEqual(receiptKind(r.kind), expected, `${name} 不应被归一改掉`)
  }
})

test('[静态] 后端落库走 receiptKind，前端 viewMode 兼容细分类型', () => {
  assert.match(readSrc('student-backend/app.js'), /kind: receiptKind\(check\.kind\)/)
  const src = readSrc('student-frontend/src/components/dialogs/ReceiptDialog.vue')
  assert.match(
    src,
    /f\.kind === 'office' \|\| f\.kind === 'ooxml' \|\| f\.kind === 'ole'/,
    '前端必须兼容旧数据里的 ooxml / ole（第二道防线）',
  )
  assert.match(src, /return 'external'/)
})
