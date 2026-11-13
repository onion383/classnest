// =========================================================================
// album-scan-two-phase-test.cjs —— 全量扫描「先建索引，再补缩略图」的真实验证
//
// 用户原话：「能不能先全部生成索引排序，再慢慢生成微缩图呢」。
//
// 断言的是**时间线**，不是源码结构：
//   ① 存在一个时刻：album_photos 行数已经 = N，但缩略图文件还 < N
//      —— 这就是「网格已经完整、图还在补」，也正是用户要的观感
//   ② 最终行数 = N 且缩略图文件 = N
//   ③ onProgress 报过 phase='index' 与 'thumb'
//   ④ 第一次报 'thumb' 时，索引行数**已经**等于 N（阶段 2 不许边索引边出图）
//
// 图必须是 1600×1200 噪点：纯色小图两张都瞬间完成，时间线上分不出先后。
// 跑法：node testjs/smoke/album-scan-two-phase-test.cjs
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

const { makeTempDir, removeDirWithRetry } = require('./_tmpdir.cjs')

const ROOT = path.join(__dirname, '..', '..')
const BACKEND = path.join(ROOT, 'student-backend')
const BM = path.join(BACKEND, 'node_modules')

const DATA_DIR = makeTempDir('album-two-phase')
process.env.DB_MASTER_KEY = 'album-two-phase-smoke-master-key'
process.env.DATA_DIR = DATA_DIR
// 缩略图目录也放进临时目录：否则会写进真实的 userData，跑一次测试污染用户相册缓存
process.env.ALBUM_THUMBS_DIR = path.join(DATA_DIR, 'album-thumbs')

const express = require(path.join(BM, 'express'))   // eslint-disable-line no-unused-vars
const sharp = require(path.join(BM, 'sharp'))
const dbManager = require(path.join(BACKEND, 'dbManager', 'dbManager'))
const albumThumbs = require(path.join(BACKEND, 'albumThumbs'))
const albumScan = require(path.join(BACKEND, 'albumScan'))

const N = 20
const USERNAME = 'two-phase-smoke'

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) {
    console.log('    →', typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300))
  }
}

const thumbDirOf = (slug) => path.join(dbManager.thumbsDir, albumThumbs.safeSlug(slug))
function countThumbs(slug) {
  try {
    return fs.readdirSync(thumbDirOf(slug)).filter((f) => f.endsWith('.jpg')).length
  } catch (_) { return 0 }
}

async function main() {
  const srcDir = path.join(DATA_DIR, 'src')
  fs.mkdirSync(srcDir, { recursive: true })

  const { slug } = dbManager.createTeacher(USERNAME, 'not-a-real-hash', 'teacher')
  let conn = null
  dbManager.withDb(slug, () => {
    conn = dbManager.current()
    conn.prepare('INSERT INTO albums (id, name, folder_path, kind) VALUES (1, ?, ?, ?)').run('两阶段', DATA_DIR, 'folder')
  })

  // 1600×1200 噪点：索引 ~5ms/张，缩略图 ~15ms/张，时间轴能拉开
  for (let i = 1; i <= N; i++) {
    const w = 1600
    const h = 1200
    const raw = Buffer.alloc(w * h * 3)
    for (let k = 0; k < raw.length; k += 3) {
      const v = (Math.random() * 255) | 0
      raw[k] = v
      raw[k + 1] = v
      raw[k + 2] = v
    }
    await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .withExif({ IFD0: { DateTime: '2024:06:01 10:00:00' } })
      .jpeg({ quality: 82 })
      .toFile(path.join(srcDir, `p${i}.jpg`))
  }

  const rows = () => conn.prepare('SELECT COUNT(*) AS c FROM album_photos WHERE album_id = 1').get().c

  // ---------- 采样：索引行数 vs 缩略图文件数 ----------
  const samples = []
  const sample = () => samples.push({ rows: rows(), thumbs: countThumbs(slug) })
  sample()
  const sampler = setInterval(sample, 8)

  // onProgress 也要采一份带 phase 的快照
  const progress = []
  const onProgress = (t) => {
    progress.push({ phase: t.phase, scanned: t.scanned, total: t.total, rows: rows(), thumbs: countThumbs(slug) })
  }

  const t0 = Date.now()
  // 必须先「认领」任务：waitWhilePaused 把「库里没有属于本次 token 的记录」
  // 判定为「任务被放弃」（albumScan.js 的 else 分支），不认领的话扫描一启动就中止。
  // 真实链路由主进程的 claimScanTask 做这件事，这里模拟它。
  albumScan.claimScanTask(conn, 1, 'full', 1, '')
  await albumScan.fullScan(conn, 1, '', slug, onProgress, 1)
  const ms = Date.now() - t0
  clearInterval(sampler)
  sample()

  console.log(`扫描完成：${N} 张，耗时 ${ms} ms`)
  console.log(`  采样点 ${samples.length} 个；阶段序列 ${progress.map((p) => p.phase).join(' → ')}`)

  // ---------- ① 索引写满时，缩略图还没开始 ----------
  // 判据必须用「第一次 rows 达到 N 的那一刻」，而不是「存在某个 rows=N 且 thumbs<N 的采样点」：
  // 退回交替写法时，最后一张是「插索引 → 再花 15ms 生成缩略图」，
  // 那 15ms 里 rows=N 且 thumbs=N-1，弱判据照样绿（变异反证实测过）。
  const firstFull = samples.find((s) => s.rows === N)
  check('索引写满时缩略图还基本没开始（两阶段真的分开了）',
    !!firstFull && firstFull.thumbs <= Math.floor(N / 2), firstFull)
  // 辅助判据：确实存在「索引已满、图还没齐」的时间窗
  check('存在「索引已满、图还没齐」的采样点（网格先完整，图后到）',
    samples.some((s) => s.rows === N && s.thumbs < N), {
      rowsAtFirstFull: firstFull,
      tail: samples.slice(-4),
    })

  // ---------- ② 最终都齐 ----------
  check(`最终索引 ${N} 行`, rows() === N, rows())
  check(`最终缩略图 ${N} 个`, countThumbs(slug) === N, countThumbs(slug))

  // ---------- ③ 两个阶段都报过 ----------
  const phases = [...new Set(progress.map((p) => p.phase))]
  check("进度报过 phase='index'", phases.includes('index'), phases)
  check("进度报过 phase='thumb'", phases.includes('thumb'), phases)

  // ---------- ④ 进阶段 2 时索引必须已经完整 ----------
  const firstThumb = progress.find((p) => p.phase === 'thumb')
  check("第一次报 phase='thumb' 时索引行数已经 = N（不是边索引边出图）",
    !!firstThumb && firstThumb.rows === N, firstThumb)

  await removeDirWithRetry(DATA_DIR).catch(() => {})
}

main()
  .then(() => {
    console.log(failed ? `\n失败 ${failed} 条` : '\n全部通过')
    process.exit(failed ? 1 : 0)
  })
  .catch((e) => {
    console.error(e && e.stack ? e.stack : e)
    process.exit(1)
  })
