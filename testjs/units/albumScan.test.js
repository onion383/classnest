// 相册扫描的「索引被误删/清空」防护（albumScan.js 的 collectMediaFiles / deletePhotosNotIn）
//
// 回归的真实故障：文件夹里的照片一张没少，相册却是 0 张。
// 成因是全量扫描「先把索引删光、再收集磁盘清单」，收集阶段一被停止/暂停/进程被杀，
// 索引已经是空的而新索引一条没写；另一条路径是目录读不到被静默吞掉，
// 残缺清单让「清理已删除文件」把整片目录的索引误判成已删除。
//
// 运行：npm run test:units
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const fsp = fs.promises
const test = require('node:test')
const assert = require('node:assert/strict')

const tmpDir = path.join(os.tmpdir(), 'album-scan-unit-' + process.pid)
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || tmpDir

const {
  collectMediaFiles, deletePhotosNotIn, incrementalScan, fullScan,
} = require('../../student-backend/albumScan')
const { getDatabase } = require('../../student-backend/dbManager/dbManager.base')

function newTask(mode) {
  return { cancelled: false, paused: false, scanned: 0, total: 0, mode, token: 1, startedAt: '' }
}

// 等价的连接替身：只实现这几个函数用到的 prepare/all/get/run，
// 让测试不碰真实加密库（真实连接要主密钥 + 完整 schema）。
function makeConn() {
  const rows = []           // { id, album_id, file_path, thumb_path }
  let nextId = 1
  const log = { deleted: [] }
  const conn = {
    log,
    seed(albumId, paths) {
      for (const p of paths) rows.push({ id: nextId++, album_id: albumId, file_path: p, thumb_path: '' })
    },
    count(albumId) { return rows.filter(r => r.album_id === albumId).length },
    paths(albumId) { return rows.filter(r => r.album_id === albumId).map(r => r.file_path) },
    prepare(sql) {
      if (/FROM album_scan_tasks/.test(sql)) {
        // waitWhilePaused 每 300ms 读一次任务表；返回 running 才不会把扫描判成取消
        return { get: () => ({ state: 'running', token: 1, done_path: '', scanned: 0, total: 0 }) }
      }
      if (/SELECT id, file_path, thumb_path/.test(sql)) {
        return { all: (albumId, cursor, limit) => rows
          .filter(r => r.album_id === albumId && r.id > cursor)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map(r => ({ id: r.id, file_path: r.file_path, thumb_path: r.thumb_path })) }
      }
      if (/SELECT \* FROM albums/.test(sql)) {
        return { get: () => ({ id: 1, kind: 'folder', folder_path: '' }) }
      }
      if (/DELETE FROM album_photos WHERE id = \?$/.test(sql.trim())) {
        return { run: (id) => {
          const i = rows.findIndex(r => r.id === id)
          if (i >= 0) { log.deleted.push(rows[i].file_path); rows.splice(i, 1); return { changes: 1 } }
          return { changes: 0 }
        } }
      }
      if (/UPDATE albums SET updated_at/.test(sql)) return { run: () => ({ changes: 1 }) }
      return { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }
    },
  }
  return conn
}

test('collectMediaFiles：根目录读不到时 complete=false（不再静默吞掉）', async () => {
  // 用「不存在的路径」触发 readdir 抛错：确定性地覆盖「目录读不到」这条分支。
  // 早先这里用 icacls 造 deny 规则，但在有管理员权限的环境下 deny 可能被绕过，
  // 导致 complete 仍为 true 而断言偶发失败 —— 故改为不依赖权限的写法。
  const missing = path.join(tmpDir, 'no-such-dir-' + Date.now())
  const r = await collectMediaFiles(missing, newTask('incremental'), null, 1)
  assert.ok(r, '收集不应返回 null（null 只表示被停止/暂停）')
  assert.deepEqual(r.files, [], '读不到目录时清单为空')
  assert.equal(r.complete, false, '有目录读不到时 complete 必须是 false')
})

test('collectMediaFiles：目录全部可读时 complete=true', async () => {
  const root = path.join(tmpDir, 'readable')
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true })
  await fsp.writeFile(path.join(root, 'a.jpg'), 'x')
  await fsp.writeFile(path.join(root, 'sub', 'b.jpg'), 'x')
  await fsp.writeFile(path.join(root, 'note.txt'), 'x')   // 非媒体文件，应被跳过
  const r = await collectMediaFiles(root, newTask('incremental'), null, 1)
  assert.equal(r.complete, true)
  assert.deepEqual(r.files.map(f => f.name).sort(), ['a.jpg', 'b.jpg'])
  await fsp.rm(root, { recursive: true, force: true })
})

test('deletePhotosNotIn：只删磁盘清单外的行，文件还在的一律保留', async () => {
  const conn = makeConn()
  conn.seed(1, ['D:/p/a.jpg', 'D:/p/b.jpg', 'D:/p/gone.jpg'])
  const found = new Set(['D:/p/a.jpg', 'D:/p/b.jpg'])
  await deletePhotosNotIn(conn, 1, newTask('full'), found, 'testslug', true)
  assert.deepEqual(conn.paths(1).sort(), ['D:/p/a.jpg', 'D:/p/b.jpg'])
  assert.deepEqual(conn.log.deleted, ['D:/p/gone.jpg'])
})

test('deletePhotosNotIn：清单不可信（trust=false）时一行都不删', async () => {
  const conn = makeConn()
  conn.seed(1, ['D:/p/a.jpg', 'D:/p/b.jpg'])
  await deletePhotosNotIn(conn, 1, newTask('full'), new Set(['D:/p/a.jpg']), 'testslug', false)
  assert.equal(conn.count(1), 2, '残缺清单下必须保留全部索引，不能误删')
  assert.equal(conn.log.deleted.length, 0)
})

test('deletePhotosNotIn：清单为空且可信 → 全删（用户确实清空了文件夹）', async () => {
  const conn = makeConn()
  conn.seed(1, ['D:/p/a.jpg', 'D:/p/b.jpg'])
  await deletePhotosNotIn(conn, 1, newTask('full'), new Set(), 'testslug', true)
  assert.equal(conn.count(1), 0)
})

// 注：原先这里有两段「恒真断言」用例（收集返回 null 时不删索引 / scanned 不足时不清理），
// 它们只是把产品代码里的判断条件抄了一遍，从不调用被测函数，等于没有回归价值。
// 已替换为下面真正驱动 incrementalScan 的用例：用临时目录 + 连接替身验证
// 「未变文件也计入 scanned，磁盘已删文件的索引会被清理」。

test('incrementalScan：未变文件也计入遍历数，磁盘已删的照片索引会被清理', async () => {
  // 回归 B04-11：task.scanned 原先只在「mtime 变化 / 新插入」时自增，
  // 一次「什么都没变」的增量扫描永远满足不了 scanned >= files.length，
  // 于是「索引有、磁盘无」的行永远不会被清理。
  const dir = await fsp.mkdtemp(path.join(tmpDir, 'incremental-'))
  const keep = path.join(dir, 'keep.jpg')
  await fsp.writeFile(keep, 'x')
  const st = await fsp.stat(keep)
  const keptRow = {
    id: 1, file_path: keep, file_name: 'keep.jpg', file_size: st.size,
    mtime: st.mtime.toISOString(), thumb_path: '', thumb_v: 0, date_src: 'exif',
  }
  const goneRow = {
    id: 2, file_path: path.join(dir, 'gone.jpg'), file_name: 'gone.jpg', file_size: 1,
    mtime: '2000-01-01T00:00:00.000Z', thumb_path: '', thumb_v: 0, date_src: 'exif',
  }
  const rows = [keptRow, goneRow]

  const conn = {
    prepare(sql) {
      const s = sql.trim()
      if (/FROM album_scan_tasks/.test(s)) {
        return { get: () => ({ state: 'running', token: 1, done_path: '', scanned: 0, total: 0 }) }
      }
      if (/FROM albums/.test(s)) return { get: () => ({ id: 1, kind: 'folder', folder_path: dir }) }
      if (/FROM album_photos WHERE album_id = \?$/.test(s)) return { all: () => rows.map((r) => ({ ...r })) }
      if (/DELETE FROM album_photos WHERE id = \?/.test(s)) {
        return { run: (id) => {
          const i = rows.findIndex((r) => r.id === id)
          if (i < 0) return { changes: 0 }
          rows.splice(i, 1)
          return { changes: 1 }
        } }
      }
      return { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }
    },
    // 本用例不会产生缩略图写入（mtime 未变、date_src 已是 exif），事务兜底即可
    transaction(fn) { return fn },
  }

  await incrementalScan(conn, 1, '', 'testslug', null, 1)

  assert.equal(rows.length, 1, '磁盘上已不存在的照片索引必须被清理')
  assert.equal(rows[0].id, 1, '仍在磁盘上的照片索引必须保留')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('incrementalScan：单个文件 stat 失败不能卡死「已删文件」清理（B05-10）', async () => {
  // 回归 B05-10：清理门原来是 `task.scanned >= files.length`，而 scanned 只在
  // 处理成功时才 +1。只要有**一个**文件 stat 失败（刚被删 / 被占用 / 权限不足），
  // 清理门就永远不成立 → 整个「索引有、磁盘无」清理被跳过，
  // 用户删掉的照片索引行会一直残留在相册里。
  const dir = await fsp.mkdtemp(path.join(tmpDir, 'stat-fail-'))
  const okFile = path.join(dir, 'ok.jpg')
  const flaky = path.join(dir, 'flaky.jpg')
  await fsp.writeFile(okFile, 'x')
  await fsp.writeFile(flaky, 'y')
  const stOk = await fsp.stat(okFile)
  const stFlaky = await fsp.stat(flaky)
  const mkRow = (id, p, name, st) => ({
    id, file_path: p, file_name: name, file_size: st ? st.size : 1,
    mtime: st ? st.mtime.toISOString() : '2000-01-01T00:00:00.000Z',
    thumb_path: '', thumb_v: 0, date_src: 'exif',
  })
  const rows = [
    mkRow(1, okFile, 'ok.jpg', stOk),
    mkRow(2, flaky, 'flaky.jpg', stFlaky),
    mkRow(3, path.join(dir, 'gone.jpg'), 'gone.jpg', null),
  ]

  const conn = {
    prepare(sql) {
      const s = sql.trim()
      if (/FROM album_scan_tasks/.test(s)) {
        return { get: () => ({ state: 'running', token: 1, done_path: '', scanned: 0, total: 0 }) }
      }
      if (/FROM albums/.test(s)) return { get: () => ({ id: 1, kind: 'folder', folder_path: dir }) }
      if (/FROM album_photos WHERE album_id = \?$/.test(s)) return { all: () => rows.map((r) => ({ ...r })) }
      if (/DELETE FROM album_photos WHERE id = \?/.test(s)) {
        return { run: (id) => {
          const i = rows.findIndex((r) => r.id === id)
          if (i < 0) return { changes: 0 }
          rows.splice(i, 1)
          return { changes: 1 }
        } }
      }
      return { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }
    },
    transaction(fn) { return fn },
  }

  // 故障注入：只让 flaky.jpg 的 stat 抛错。fsp 就是 fs.promises 本体（albumScan 里
  // `const fsp = fs.promises`），改它的 stat 即可，不需要起子进程。
  const realStat = fs.promises.stat
  fs.promises.stat = async (p, ...rest) => {
    if (String(p) === flaky) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
    return realStat.apply(fs.promises, [p, ...rest])
  }
  try {
    await incrementalScan(conn, 1, '', 'testslug', null, 1)
  } finally {
    fs.promises.stat = realStat
  }

  assert.deepEqual(rows.map((r) => r.id).sort(), [1, 2],
    '磁盘上已删的 gone.jpg 必须被清理；stat 失败的 flaky.jpg 索引不能因此被删（无从判断它还在不在）')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('incrementalScan：扫描被取消时一行都不能删（完成标记的另一侧）', async () => {
  // 清理门的另一个前提：循环必须**完整跑完**。被取消/暂停时只处理了清单的一部分，
  // 拿部分清单判断「已删除」会把还没扫到的索引全删掉 —— 这就是「相册突然空了」。
  const dir = await fsp.mkdtemp(path.join(tmpDir, 'cancel-'))
  const okFile = path.join(dir, 'ok.jpg')
  await fsp.writeFile(okFile, 'x')
  const st = await fsp.stat(okFile)
  const rows = [
    { id: 1, file_path: okFile, file_name: 'ok.jpg', file_size: st.size, mtime: st.mtime.toISOString(), thumb_path: '', thumb_v: 0, date_src: 'exif' },
    { id: 2, file_path: path.join(dir, 'gone.jpg'), file_name: 'gone.jpg', file_size: 1, mtime: '2000-01-01T00:00:00.000Z', thumb_path: '', thumb_v: 0, date_src: 'exif' },
  ]
  const conn = {
    prepare(sql) {
      const s = sql.trim()
      if (/FROM album_scan_tasks/.test(s)) {
        // 第一次查状态就是 cancelled → waitWhilePaused 立刻返回 false，循环在第 0 个文件前中断
        return { get: () => ({ state: 'cancelled', token: 1, done_path: '', scanned: 0, total: 0 }) }
      }
      if (/FROM albums/.test(s)) return { get: () => ({ id: 1, kind: 'folder', folder_path: dir }) }
      if (/FROM album_photos WHERE album_id = \?$/.test(s)) return { all: () => rows.map((r) => ({ ...r })) }
      if (/DELETE FROM album_photos WHERE id = \?/.test(s)) {
        return { run: (id) => {
          const i = rows.findIndex((r) => r.id === id)
          if (i < 0) return { changes: 0 }
          rows.splice(i, 1)
          return { changes: 1 }
        } }
      }
      return { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }
    },
    transaction(fn) { return fn },
  }

  await incrementalScan(conn, 1, '', 'testslug', null, 1)
  assert.equal(rows.length, 2, '扫描被取消时绝不能做「已删除文件」清理')
  await fsp.rm(dir, { recursive: true, force: true })
})

test('清理门：两个扫描循环都用显式完成标记，不再拿进度计数推断（静态）', () => {
  // 全量 / 增量两个循环是同一段逻辑的两份拷贝 —— 「改一处不改另一处」在这里格外危险：
  // 一个循环修好了、另一个还在用 `scanned >= files.length` 当清理门，等于问题只修了一半。
  const src = fs.readFileSync(path.join(__dirname, '../../student-backend/albumScan.js'), 'utf8')
  // 去注释再匹配：本文件的修复注释里就写着旧写法，不去注释会命中自己的说明文字
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))

  assert.ok(!/task\.scanned\s*>=\s*files\.length/.test(code),
    '还有循环拿 task.scanned >= files.length 当清理门（一个 stat 失败就永远不清理）')
  const marks = code.match(/loopCompleted/g) || []
  assert.ok(marks.length >= 6,
    `loopCompleted 出现 ${marks.length} 次，两个循环各需 声明/中断/判断 三处（>=6）`)
  const incs = code.match(/task\.scanned\+\+/g) || []
  assert.equal(incs.length, 4,
    `task.scanned++ 出现 ${incs.length} 次（全量 1 + 增量 1 + 虚拟 2）。多了说明又有人在循环末尾重复计数`)
})

test.after(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})