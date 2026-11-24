// =========================================================================
// tmp-sweep.test.js —— 启动期回收崩溃遗留临时文件（v8 审查 P2-08 · RC-TMP）
//
// 判据：超龄孤儿被删、本次新件与正常业务文件保留；四类位置（AI 附件 / 还原上传 /
// OCR 中转 / .restore-* 解包目录）都覆盖。
// 变异反证：把 mtime 判断改反或删掉 .restore- 分支，本用例必须红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { sweepTempOrphans, DEFAULT_MAX_AGE_MS } = require('../../student-backend/services/tmpSweep')

function old(file) {
  const t = (Date.now() - DEFAULT_MAX_AGE_MS - 60_000) / 1000
  fs.utimesSync(file, t, t)
}

test('sweepTempOrphans：清超龄孤儿，保留新文件与非本应用的业务文件', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-sweep-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-sweep-data-'))

  // AI 附件：一个超龄、一个新写
  fs.mkdirSync(path.join(tmpRoot, 'ai-uploads'))
  const oldUpload = path.join(tmpRoot, 'ai-uploads', 'old.png')
  const newUpload = path.join(tmpRoot, 'ai-uploads', 'new.png')
  fs.writeFileSync(oldUpload, 'x'); old(oldUpload)
  fs.writeFileSync(newUpload, 'x')

  // 还原上传目录同样处理
  fs.mkdirSync(path.join(tmpRoot, 'classnest-restore'))
  const oldRestore = path.join(tmpRoot, 'classnest-restore', 'old.zip')
  fs.writeFileSync(oldRestore, 'x'); old(oldRestore)

  // OCR 中转（直接落在 tmpRoot）
  const oldOcr = path.join(tmpRoot, 'ocr-src-1.png')
  const outOcr = path.join(tmpRoot, 'ocr-out-1.txt')
  fs.writeFileSync(oldOcr, 'x'); old(oldOcr)
  fs.writeFileSync(outOcr, 'x')

  // 解包目录：超龄 .restore-* 目录要删；普通文件不能碰
  const oldDir = path.join(dataDir, '.restore-100')
  fs.mkdirSync(oldDir)
  fs.writeFileSync(path.join(oldDir, 'child'), 'x'); old(oldDir)
  const keepFile = path.join(dataDir, 'students.db')
  fs.writeFileSync(keepFile, 'x'); old(keepFile)

  const removed = sweepTempOrphans({ dataDir, tmpRoot })
  assert.equal(removed, 4, `应清 4 项（AI 旧件 / 还原旧件 / OCR 旧件 / .restore 目录），实际 ${removed}`)
  assert.equal(fs.existsSync(oldUpload), false)
  assert.equal(fs.existsSync(newUpload), true, '本次新写的附件必须保留')
  assert.equal(fs.existsSync(oldRestore), false)
  assert.equal(fs.existsSync(oldOcr), false)
  assert.equal(fs.existsSync(outOcr), true, '未超龄的 OCR 结果保留')
  assert.equal(fs.existsSync(oldDir), false)
  assert.equal(fs.existsSync(keepFile), true, '数据目录里的业务文件绝不能被当成临时件删掉')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('sweepTempOrphans：缩略图半成品按「多点文件名」识别并清理（K01-04）', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-sweep-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-sweep-data-'))
  const slugDir = path.join(dataDir, 'cache', 'album-thumbs', 'testslug')
  fs.mkdirSync(slugDir, { recursive: true })

  const tmpOld = path.join(slugDir, '12.1732000000abc.jpg') // rename 前被强杀留下的半成品
  const tmpNew = path.join(slugDir, '13.1732000000def.jpg')
  const normalOld = path.join(slugDir, '14.jpg')
  fs.writeFileSync(tmpOld, 'x'); old(tmpOld)
  fs.writeFileSync(tmpNew, 'x')
  fs.writeFileSync(normalOld, 'x'); old(normalOld)

  const removed = sweepTempOrphans({ dataDir, tmpRoot })
  assert.equal(removed, 1)
  assert.equal(fs.existsSync(tmpOld), false, '超龄半成品必须清掉')
  assert.equal(fs.existsSync(tmpNew), true, '本次新写的半成品不能误删')
  assert.equal(fs.existsSync(normalOld), true, '正常 {id}.jpg 是业务文件，不能动')

  fs.rmSync(tmpRoot, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('sweepTempOrphans：目录不存在时不抛错（全新机器）', () => {
  assert.equal(sweepTempOrphans({ dataDir: path.join(os.tmpdir(), 'cn-does-not-exist'), tmpRoot: path.join(os.tmpdir(), 'cn-does-not-exist') }), 0)
})
