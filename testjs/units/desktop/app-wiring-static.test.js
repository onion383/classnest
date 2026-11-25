// =========================================================================
// app-wiring-static.test.js —— 后端 app.js 相关接线静态守卫（聚合父测试）
//
// WATCH: student-backend/app.js student-backend/routes/album.js student-backend/routes/dynamicTable.js student-frontend/src/views/DashboardView.vue student-frontend/src/views/AlbumView.vue student-frontend/src/components/dialogs/ReceiptDialog.vue
//
// 从 4 个「行为 + 静态」混合单测里抽出纯源码断言，行为用例仍留在各原文件。
// 这样改 app.js / 相关接线时，只需更新这一处的文本形态判据。
// 来源（断言原样保留）：
//   album-photo-focus.test.js   4 条：X-Photo-Id 暴露头 / 首页读头跳转 / 换图动画 / 相册页消费 query
//   keep-alive.test.js          1 条：keepAliveTimeout 与 headersTimeout 配置（整文件并入）
//   receipt-kind.test.js        1 条：落库归一与前端 viewMode 兼容
//   student-delete-guard.test.js 1 条：两条删除路径的放行参数
//
// 这里只做源码文本形态断言，不跑内存库、不 fetch。新增同类守卫按分节追加。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')


// ---------- album-photo-focus ----------
test('源码判据：CORS 真的放行了 X-Photo-Id，否则打包版跨域读不到头', () => {
  assert.match(read('student-backend/app.js'), /exposedHeaders:[^\]]*X-Photo-Id/)
  assert.match(read('student-backend/routes/album.js'), /res\.setHeader\('X-Photo-Id'/)
})

test('源码判据：首页真的读头并带 ?photo 跳转（卡片与按钮两处入口）', () => {
  const src = read('student-frontend/src/views/DashboardView.vue')
  assert.match(src, /h\.get\('X-Photo-Id'\)/, '必须从响应头读照片 id')
  assert.match(src, /query:\s*\{\s*photo:\s*String\(id\)\s*\}/, '跳转必须带 ?photo=<id>')
  assert.ok((src.match(/goToAlbumPhoto\(\)/g) || []).length >= 2, '整卡与按钮都要走带 id 的跳转')
})

test('源码判据：首页换一张按钮 + 磁贴式动画 + blob 释放时机', () => {
  const src = read('student-frontend/src/views/DashboardView.vue')
  // @pin student-frontend/src/views/DashboardView.vue#cycleAlbumPhoto
  assert.match(src, /@click\.stop="cycleAlbumPhoto\(\)"/, '按钮必须 stop，否则点一下就跳去相册页了')
  assert.match(src, /params:\s*exclude\s*\?\s*\{\s*exclude\s*\}/, '换图请求要排除当前这张')
  assert.match(src, /keepOnError:\s*true/, '换图失败不能把当前图清空')
  assert.match(src, /border:\s*1px solid transparent !important/, '循环按钮的边框要清掉')
  assert.match(src, /\.photo-cycle-btn::before\s*\{\s*display:\s*none !important/, '主题的荧光描边也要清掉')
  // @pin student-frontend/src/views/DashboardView.vue#finishPhotoAnim
  assert.match(src, /function finishPhotoAnim\(\)[\s\S]{0,400}spinPending[\s\S]{0,100}photoSwitching\.value = false/,
    '转圈的停止点必须放在换图动画收尾里')
  // @pin student-frontend/src/views/DashboardView.vue#replaceAlbumPhoto
  assert.match(src, /animated = replaceAlbumPhoto\(thumbRes\.data, !!exclude\)/,
    '按钮这一轮要用 replaceAlbumPhoto 的返回值登记「等动画」')
  assert.match(src, /if \(!\(albumPhotoSeq\.isCurrent\(my\) && animated && spinPending\)\)/,
    '关闭动画/失败/被接管时必须立刻停，别让按钮转个不停')
  assert.match(src, /photo-spin 560ms/, '一圈与换图动画总时长对齐')
  assert.match(src, /@keyframes photo-retreat/, '旧图后退的关键帧')
  assert.match(src, /@keyframes photo-float-in/, '新图浮入的关键帧')
  assert.match(src, /photoOutUrl/, '必须保留后层旧图')
  // @pin student-frontend/src/views/DashboardView.vue#finishPhotoAnim
  assert.match(src, /photoAnimFallback\(finishPhotoAnim, 700\)/, '动画不触发时要有兜底收尾')
  // @pin student-frontend/src/views/DashboardView.vue#revokeBlobUrl
  assert.match(src, /finishPhotoAnim[\s\S]{0,400}revokeBlobUrl\(old\)/, '旧图要等动画结束才释放')
})

test('源码判据：相册页消费 ?photo，且挂载 / 切回 / query 变化三个入口都接上', () => {
  const src = read('student-frontend/src/views/AlbumView.vue')
  assert.match(src, /route\.query\.photo/)
  assert.match(src, /photo\/\$\{id\}\/locate/)
  assert.match(src, /viewPhoto\(p\)/)
  // @pin student-frontend/src/views/AlbumView.vue#applyPhotoFocus
  assert.ok((src.match(/applyPhotoFocus\(\)/g) || []).length >= 3,
    '定义 + onMounted + onActivated 至少 3 处')
  // @pin student-frontend/src/views/AlbumView.vue#applyPhotoFocus
  assert.match(src, /watch\(\(\) => route\.query\.photo, applyPhotoFocus\)/,
    'KeepAlive 缓存后从首页再点进来，只会变 query，必须靠 watch 触发')
})

// ---------- keep-alive ----------
// 验收点：listen 之后显式设置超时；headersTimeout > keepAliveTimeout；两者都大于 Node 默认 5s。
// 真实复用靠 socket connect 计数，属于真机探针，本层只锁配置。
test('listen 之后显式设置保活与请求头超时', () => {
  const SRC = read('student-backend/app.js')
  const keep = /server\.keepAliveTimeout = (\d+)_?(\d*)\s*;/.exec(SRC)
  const headers = /server\.headersTimeout = (\d+)_?(\d*)\s*;/.exec(SRC)
  assert.ok(keep, 'app.js 必须显式设置 server.keepAliveTimeout')
  assert.ok(headers, 'app.js 必须显式设置 server.headersTimeout')

  const num = (m) => Number(m[1] + (m[2] || ''))
  const keepMs = num(keep)
  const headersMs = num(headers)

  assert.ok(headersMs > keepMs, `headersTimeout(${headersMs}) 必须大于 keepAliveTimeout(${keepMs})`)
  assert.ok(keepMs > 5000, `keepAliveTimeout(${keepMs}) 应大于 Node 默认 5s，否则等于没改`)
})

// ---------- receipt-kind ----------
test('[静态] 后端落库走 receiptKind，前端 viewMode 兼容细分类型', () => {
  assert.match(read('student-backend/app.js'), /kind: receiptKind\(check\.kind\)/)
  const src = read('student-frontend/src/components/dialogs/ReceiptDialog.vue')
  assert.match(
    src,
    /f\.kind === 'office' \|\| f\.kind === 'ooxml' \|\| f\.kind === 'ole'/,
    '前端必须兼容旧数据里的 ooxml / ole（第二道防线）',
  )
  assert.match(src, /return 'external'/)
})

// ---------- student-delete-guard ----------
test('接线：一并删除的调用点显式放行，通用入口不带', () => {
  const app = read('student-backend/app.js')
  assert.match(app, /deleteRow\('students', id, \{ allowStudentOrphans: true \}\)/, 'delete-with-relations 必须显式放行（否则 purge 完也删不掉）')
  const dyn = read('student-backend/routes/dynamicTable.js')
  assert.match(dyn, /deleteRow\(tableName, req\.params\.id, \{ minCount \}\)/, '通用 DELETE 不许传放行标记 —— 那就是留孤儿的入口')
})
