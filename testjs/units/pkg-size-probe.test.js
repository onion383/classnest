// =========================================================================
// pkg-size-probe.test.js —— 打包体积探针（v6 性能专题 · 1-12）
//
// 验收点：
//   ① 字节格式化：B / KB / MB 边界；
//   ② 分桶：app.asar、根依赖、作用域依赖、后端依赖、语言包、根目录二进制各归其位，
//      且 resources 下的 ffmpeg 不会被混进主程序 exe；
//   ③ 汇总按体积降序且同桶累加；
//   ④ 生产依赖全部可解析（漏装会在打包后表现为启动即 require 失败）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const { fmtBytes, bucketOf, summarize, checkProdDeps } = require(path.join(ROOT, 'testjs/probe/pkg-size-probe.cjs'))

test('字节格式化：B / KB / MB 边界', () => {
  assert.equal(fmtBytes(0), '0 B')
  assert.equal(fmtBytes(1023), '1023 B')
  assert.equal(fmtBytes(1024), '1.0 KB')
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(fmtBytes(-1), '0 B', '异常值不能输出 NaN')
})

test('分桶：各类文件归到正确的体积桶', () => {
  assert.equal(bucketOf('resources/app.asar'), 'resources/app.asar')
  assert.equal(bucketOf('resources/app.asar.unpacked/node_modules/koffi/build/koffi.node'), 'dep koffi')
  assert.equal(bucketOf('resources/app.asar.unpacked/node_modules/@scope/pkg/a.js'), 'dep @scope/pkg')
  assert.equal(bucketOf('resources/app.asar.unpacked/student-backend/node_modules/sharp/a.js'), 'backend-dep sharp')
  assert.equal(bucketOf('locales/zh-CN.pak'), 'locales')
  assert.equal(bucketOf('ClassNest.exe'), 'exe')
  // resources 里的 ffmpeg 归 resources/other，由「大文件」那一节单独列出
  assert.equal(bucketOf('resources/app.asar.unpacked/resources/ffmpeg/ffmpeg.exe'), 'resources/unpacked-other')
})

test('汇总：同桶累加、按体积降序', () => {
  const rows = summarize([
    { rel: 'resources/app.asar', size: 100 },
    { rel: 'resources/app.asar', size: 50 },
    { rel: 'locales/a.pak', size: 10 },
  ])
  assert.equal(rows.length, 2, '同桶必须合并')
  assert.deepEqual(rows[0], { bucket: 'resources/app.asar', bytes: 150 })
  assert.equal(rows[1].bucket, 'locales')
})

test('生产依赖全部可解析', () => {
  const deps = checkProdDeps()
  assert.ok(deps.length > 0, '至少要读到一条生产依赖')
  const missing = deps.filter((d) => !d.ok).map((d) => d.name)
  assert.deepEqual(missing, [], `生产依赖无法解析：${missing.join(', ')}`)
})
