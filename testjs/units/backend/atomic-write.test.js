// =========================================================================
// atomic-write.test.js —— 配置/状态文件原子写（v8 审查 E01-05 / E02-01 / N3-15）
//
// 验收点：
//   ① 正常写入：内容完整、不残留临时文件；
//   ② 中途失败（写一半 / rename 失败）：目标文件保持旧内容（不能截断）；
//   ③ 异步版语义一致。
//
// 变异反证：把 atomicWriteFileSync 改回 fs.writeFileSync 直写，
// 「失败后旧内容完整」用例会因为目标被截断而红。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MODULE = abs('electron/main/main.atomic-write.js')
const {
  atomicWriteFileSync, atomicWriteFile, atomicWriteJsonSync,
} = require(MODULE)

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cn-atomic-'))
}

function tmpResidue(dir) {
  return fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))
}

test('同步：写入完整且不残留 tmp', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'app-config.json')
  fs.writeFileSync(file, '{"dataDir":"old"}')

  assert.equal(atomicWriteJsonSync(file, { dataDir: 'new' }, 2), true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { dataDir: 'new' })
  assert.deepEqual(tmpResidue(dir), [], '成功路径不能留下临时文件')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('同步：写一半失败时目标文件保持旧内容', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'usb-auto-open.json')
  fs.writeFileSync(file, '{"enabled":false}')

  const halfBroken = {
    ...fs,
    // 模拟「临时文件写了一半就抛错」：绝不能碰目标文件
    writeFileSync(fd, data) {
      fs.writeSync(fd, String(data).slice(0, 5))
      throw new Error('EIO: disk error')
    },
  }
  assert.throws(() => atomicWriteFileSync(file, '{"enabled":true}', { fs: halfBroken }), /EIO/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"enabled":false}', '失败后必须是完整的旧 JSON')
  assert.deepEqual(tmpResidue(dir), [], '失败也要清掉临时文件')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('同步：rename 失败时目标文件保持旧内容', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'desktop-widget-pos.json')
  fs.writeFileSync(file, '{"x":1,"y":2}')

  const renameBroken = { ...fs, renameSync() { throw new Error('EPERM: rename denied') } }
  assert.throws(() => atomicWriteFileSync(file, '{"x":9,"y":9}', { fs: renameBroken }), /EPERM/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"x":1,"y":2}')
  assert.deepEqual(tmpResidue(dir), [])

  fs.rmSync(dir, { recursive: true, force: true })
})

test('异步：写入完整且不残留 tmp；失败同样保留旧内容', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'runtime-port.json')
  fs.writeFileSync(file, '{"port":1}')

  await atomicWriteFile(file, '{"port":2}')
  assert.equal(fs.readFileSync(file, 'utf8'), '{"port":2}')
  assert.deepEqual(tmpResidue(dir), [])

  const renameBroken = { ...fs.promises, rename: async () => { throw new Error('EBUSY') } }
  await assert.rejects(atomicWriteFile(file, '{"port":3}', { fs: renameBroken }), /EBUSY/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"port":2}')
  assert.deepEqual(tmpResidue(dir), [])

  fs.rmSync(dir, { recursive: true, force: true })
})
