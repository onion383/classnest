// =========================================================================
// unzip-path-conflict.test.js —— 离线恢复 ZIP 路径冲突不崩进程（2-7 / #35）
//
// 原缺陷：extractZip 的 entry 回调里同步 fs.mkdirSync，若目标父路径与已存在文件冲突
// （ENOTDIR）会同步抛出。该回调由 yauzl 在事件循环里调用，异常不会进 Promise.reject，
// 变成 uncaughtException 直接崩掉后端进程。修法：entry 回调内同步操作就地 try/catch
// 转 reject，调用方拿到 400 而不是进程挂掉。
//
// 判据：① 行为：造一个条目 a/b.txt 的 zip、目标里预置 a 为文件 → extractZip 返回
//        rejected Promise（不抛 uncaughtException）；② 正常包仍能解压；③ 变异反证。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
backendRequire('yauzl') // 确保可用
const { extractZip } = require(path.join(ROOT, 'student-backend/services/backupArchive'))

// —— 最小 store 模式 ZIP 生成器（无压缩，条目内容 = content）——
function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function makeStoreZip(entries) {
  const locals = []; const central = []
  let offset = 0
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    offset += lh.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unzip-conflict-'))
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (_) {} })

test('行为：目标父路径是已存在文件时，extractZip 返回 rejection 而不是崩进程', async () => {
  const zipPath = path.join(tmp, 'conflict.zip')
  fs.writeFileSync(zipPath, makeStoreZip([{ name: 'a/b.txt', content: 'hello' }]))
  const dest = path.join(tmp, 'dest-conflict')
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'a'), '占住 a，使 mkdirSync(dest/a) 抛 ENOTDIR')

  // 修复前：同步抛在事件回调里 → uncaughtException（测试进程直接挂）；
  // 修复后：Promise reject，可被 await 捕获。
  let err = null
  try { await extractZip(zipPath, dest) } catch (e) { err = e }
  assert.ok(err, '路径冲突应以 rejected Promise 返回，不能吞掉')
  assert.ok(/ENOTDIR|EEXIST|not a directory/i.test(String(err && (err.code || err.message))),
    '应带出底层冲突原因：' + (err && err.message))
})

test('正常包仍能解压（补偿式 try/catch 不能误伤正常路径）', async () => {
  const zipPath = path.join(tmp, 'ok.zip')
  fs.writeFileSync(zipPath, makeStoreZip([{ name: 'sub/file.txt', content: 'ok-data' }]))
  const dest = path.join(tmp, 'dest-ok')
  const r = await extractZip(zipPath, dest)
  assert.equal(r.entries, 1)
  assert.equal(fs.readFileSync(path.join(dest, 'sub', 'file.txt'), 'utf8'), 'ok-data')
})

test('变异反证：把 entry 回调的兜底 catch 改成重新抛出后，同一场景会崩进程', () => {
  const zipPath = path.join(tmp, 'mutant-conflict.zip')
  fs.writeFileSync(zipPath, makeStoreZip([{ name: 'a/b.txt', content: 'hello' }]))
  const dest = path.join(tmp, 'dest-mutant')
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'a'), '占住 a，使 mkdirSync(dest/a) 抛 ENOTDIR')

  // 变异体：把 entry 回调外层 `} catch (err) { fail(err) }` 改成 `throw err`，
  // 等价于「没有就地兜底」。修复存在时同一场景返回 rejection；变异后同步抛错逃出
  // 事件回调 → uncaughtException 崩进程。用子进程跑，避免把测试进程本身打挂。
  const script = `
    const Module = require('node:module');
    const fs = require('node:fs');
    const path = require('node:path');
    const abs = ${JSON.stringify(path.join(ROOT, 'student-backend/services/backupArchive.js'))};
    const src = fs.readFileSync(abs, 'utf8');
    const marker = '        } catch (err) {\\n          fail(err)\\n        }';
    if (!src.includes(marker)) { console.error('MARKER_NOT_FOUND'); process.exit(7); }
    const mutated = src.replace(marker, '        } catch (err) {\\n          throw err\\n        }');
    const m = new Module(abs, null);
    m.filename = abs;
    m.paths = Module._nodeModulePaths(path.dirname(abs));
    m._compile(mutated, abs);
    setTimeout(() => { console.error('WATCHDOG'); process.exit(3); }, 8000);
    m.exports.extractZip(${JSON.stringify(zipPath)}, ${JSON.stringify(dest)})
      .then(() => { console.error('RESOLVED'); process.exit(0); })
      .catch((e) => { console.error('REJECTED:' + (e && (e.code || e.message))); process.exit(0); });
  `
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 })
  assert.notEqual(r.status, 0,
    '变异后同步抛错逃出 entry 回调 → uncaughtException 非零退出；正例判据「返回 rejection」必然失败')
  assert.match(String(r.stderr), /ENOTDIR|EEXIST|not a directory/i,
    '崩溃原因应是路径冲突：' + r.stderr)
})
