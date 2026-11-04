// =========================================================================
// upload-signature-probe.cjs —— 收据上传的类型校验（扩展名 + 魔数）
//
// 背景：收据从「只能传图片」扩到 pdf / doc(x) / xls(x) / ppt(x) / 视频，
// 光看扩展名等于没有校验（改个后缀就能塞任意文件），所以必须有字节签名。
// 这个探针跑的是真实 services/uploadSignatures.js，判据是「真文件通过、假文件被拒」。
//
// 运行：node testjs/probe/upload-signature-probe.cjs
// =========================================================================
const fs = require('fs')
const os = require('os')
const path = require('path')
const { checkUpload, sniff, decodeFileName } = require('../../student-backend/services/uploadSignatures')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-sig-'))
let failed = 0
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg)
  else { failed++; console.log('  ✗ ' + msg) }
}

// 造一个指定头部 + 指定大小的文件
function make(name, head, size = 0) {
  const p = path.join(tmp, name)
  const body = Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, size - head.length))])
  fs.writeFileSync(p, body)
  return { path: p, name, size: body.length }
}

const cases = {
  jpg: make('a.jpg', [0xff, 0xd8, 0xff, 0xe0], 1000),
  png: make('b.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 1000),
  webp: make('c.webp', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 1000),
  pdf: make('d.pdf', [0x25, 0x50, 0x44, 0x46, 0x2d], 1000),
  docx: make('e.docx', [0x50, 0x4b, 0x03, 0x04], 1000),
  xlsx: make('f.xlsx', [0x50, 0x4b, 0x03, 0x04], 1000),
  pptx: make('g.pptx', [0x50, 0x4b, 0x03, 0x04], 1000),
  doc: make('h.doc', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 1000),
  mp4: make('i.mp4', [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 1000),
  webm: make('j.webm', [0x1a, 0x45, 0xdf, 0xa3], 1000),
  // 纯文本没有魔数，判据是「前 512 字节里没有 NUL」
  md: make('k.md', Buffer.from('# 运动会支出明细\n\n- 物资 320 元\n', 'utf8'), 0),
}

// 伪装：exe 的内容（MZ 头）改名成 .pdf
const fakePdf = make('fake.pdf', [0x4d, 0x5a, 0x90, 0x00], 1000)
// 伪装：随便一段文本改名成 .docx
const fakeDocx = make('fake.docx', [0x68, 0x65, 0x6c, 0x6c, 0x6f], 1000)
// 伪装：RIFF 但不是 WEBP（比如 wav），扩展名给 .webp
const fakeWebp = make('fake.webp', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], 1000)
// 伪装：png 二进制改名 .md（文本类靠 NUL 判定拦下）
const fakeMd = make('fake.md', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00], 1000)
const emptyMd = make('empty.md', [], 0)
// 不在白名单的扩展名
const exe = make('evil.exe', [0x4d, 0x5a], 1000)
// 超过 pdf 的 30MB 上限（用稀疏文件，别真写 31MB）
const huge = path.join(tmp, 'huge.pdf')
fs.writeFileSync(huge, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]))
fs.truncateSync(huge, 31 * 1024 * 1024)

console.log('真实文件应当通过：')
for (const [label, f] of Object.entries(cases)) {
  const r = checkUpload(f.path, f.name, f.size)
  ok(r.ok, `${label} 通过（识别为 ${r.kind || r.error}）`)
}

console.log('\n伪装 / 越界文件应当被拒：')
ok(!checkUpload(fakePdf.path, fakePdf.name, fakePdf.size).ok, 'exe 内容改名 .pdf 被拒')
ok(!checkUpload(fakeDocx.path, fakeDocx.name, fakeDocx.size).ok, '纯文本改名 .docx 被拒')
ok(!checkUpload(fakeWebp.path, fakeWebp.name, fakeWebp.size).ok, 'RIFF 但不是 WEBP 被拒')
ok(!checkUpload(fakeMd.path, fakeMd.name, fakeMd.size).ok, 'png 内容改名 .md 被拒（前 512 字节含 NUL）')
ok(!checkUpload(emptyMd.path, emptyMd.name, emptyMd.size).ok, '空 .md 被拒')
ok(!checkUpload(exe.path, exe.name, exe.size).ok, '.exe 不在白名单被拒')
const hugeRes = checkUpload(huge, 'huge.pdf', fs.statSync(huge).size)
ok(!hugeRes.ok && /30MB/.test(hugeRes.error), '超过 30MB 被拒（提示里带上了上限）')

console.log('\n细节：')
ok(sniff(Buffer.from([0x25, 0x50, 0x44, 0x46])) === 'pdf', 'sniff 认得 PDF 头')
ok(sniff(Buffer.from([0x4d, 0x5a])) === null, 'sniff 对 exe 头返回 null')

console.log('\n文件名解码（busboy 按 latin1 解析，中文会乱码）：')
// 模拟 multer 的产物：UTF-8 字节被当成 latin1 字符串
const broken = Buffer.from('运动会发票.pdf', 'utf8').toString('latin1')
ok(decodeFileName(broken) === '运动会发票.pdf', `中文名解码正确（${decodeFileName(broken)}）`)
ok(decodeFileName('report.pdf') === 'report.pdf', '纯 ASCII 名不受影响')
ok(decodeFileName('') === '', '空名返回空串')
// 已经是正常 UTF-8 字符串时不能被二次转换破坏
ok(decodeFileName('发票.pdf') === '发票.pdf', '正常中文名不会被二次转换破坏')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
