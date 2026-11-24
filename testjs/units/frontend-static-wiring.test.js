// =========================================================================
// frontend-static-wiring.test.js —— 前端静态接线守卫（聚合父测试）
//
// 由 4 个纯静态单测合并而来，事故面说明与断言原样保留：
//   import-template-save-toast.test.js —— 下载标准导入表保存成功后弹提示条
//   classinfo-dialog-animation.test.js —— 班级设置弹窗必须走通用 dialog 动画
//   splash-ring-shadow.test.js         —— 占位页圈圈不能被 Tailwind .ring 套黑框
//   media-viewer-video-error.test.js   —— 视频加载失败不能停在骨架无限等
//
// 这里只放「源码接线形态」断言：不跑内存库、不改产物、不碰进程。
// 带行为验证或变异反证的守卫继续留在各自独立文件里，别往这里塞。
// 新增静态守卫按分节追加，并在头部索引补一行来源。
// =========================================================================
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- import-template-save-toast ----------
// saveBlobWithDialog 语义：非空路径=成功、空串=用户取消、抛异常=失败。
// 只有成功才该提示；取消不打扰，失败走既有 parseError。
const importExcel = read('student-frontend/src/components/import-export/ImportExcel.vue')

test('引入并初始化 useNotification 的 success', () => {
  assert.match(importExcel, /import \{ useNotification \} from '\.\.\/\.\.\/composables\/useNotification'/, '缺少 useNotification 引入')
  assert.match(importExcel, /const \{ success: notifySuccess \} = useNotification\(\)/, '缺少 notifySuccess 初始化')
})

test('保存成功的返回值被接住，且只在非空（真保存）时弹提示', () => {
  const fn = importExcel.match(/async function downloadTemplate\(\)[\s\S]*?\n\}/)
  assert.ok(fn, '找不到 downloadTemplate')
  const body = fn[0]
  assert.match(body, /const saved = await saveBlobWithDialog\(/, '必须接住 saveBlobWithDialog 的返回值')
  assert.match(body, /if \(saved\) notifySuccess\('标准导入表已保存'\)/, '只在成功时弹「标准导入表已保存」')
  // 提示必须在 try 内、catch 之前 —— 失败时不该报成功
  const tryAt = body.indexOf('try {')
  const catchAt = body.indexOf('} catch')
  const toastAt = body.indexOf('notifySuccess(')
  assert.ok(tryAt < toastAt && toastAt < catchAt, '提示应位于 try 内、catch 之前')
})

// ---------- classinfo-dialog-animation ----------
// 事故面：该弹窗曾自写 scale(0.985) 的 scoped 动画盖掉通用 dialogCardIn，
// 进场近乎看不出，且各主题观感不一致。判据盯住「不自建覆盖 + 仍挂通用类」。
const classInfoDialog = read('student-frontend/src/components/dialogs/ClassInfoDialog.vue')

test('班级设置弹窗挂通用 dialog-card，由 DialogShell 的 Transition 驱动', () => {
  const root = classInfoDialog.match(/<div class="([^"]*dialog-card[^"]*)"/)
  assert.ok(root, '弹窗卡片必须带 dialog-card 才有通用进/离场动画')
  assert.doesNotMatch(root[1], /class-switch-card/, '私有的 class-switch-card 已删，不应残留')
})

test('不再用 scoped 动画覆盖通用动画', () => {
  assert.doesNotMatch(classInfoDialog, /classSwitchCardIn|classSwitchCardOut/, '自写的极轻微动画必须删掉')
  assert.doesNotMatch(classInfoDialog, /@keyframes[^{]*classSwitch/, '不该再留自定义关键帧')
  const style = classInfoDialog.slice(classInfoDialog.indexOf('<style scoped>'))
  assert.doesNotMatch(style, /\.dialog-card\s*\{[^}]*animation/, '不能给 dialog-card 再写 animation 覆盖通用规则')
})

test('仍引入通用动画样式并提供通用卡片动画所需的类', () => {
  assert.match(classInfoDialog, /import '\.\.\/\.\.\/styles\/dialog-transition\.css'/, '必须引入通用动画样式')
  assert.match(classInfoDialog, /<DialogShell[\s\S]*?visible="visible"/, '外层仍由 DialogShell 的 Transition 统一驱动')
})

// ---------- splash-ring-shadow ----------
// 事故面：占位页 <svg class="ring"> 的 ring 撞上 Tailwind .ring 工具类，
// 主 CSS 加载完成那一刻会给圈圈画一圈 currentcolor 黑框。
const splashCss = read('student-frontend/splash/splash.css')
const splashHtml = read('student-frontend/splash/splash.html')

test('占位页圈圈仍用 class="ring"（撞名前提成立）', () => {
  assert.match(splashHtml, /<svg class="ring"/, '圈圈标记变了则本判据失效，需重新评估')
})

test('splash.css 用更高特异性显式关掉 .ring 的 box-shadow', () => {
  // Tailwind .ring 是 0-1-0；守卫必须 0-2-0（.app-splash .ring）才压得住
  assert.match(
    splashCss,
    /\.app-splash \.ring\s*\{[^}]*box-shadow:\s*none/,
    '缺少 .app-splash .ring { box-shadow: none } 守卫，Tailwind .ring 会给圈圈画黑框',
  )
})

test('切到夜间后圈圈的描边规则还在，守卫没误伤主题配色', () => {
  assert.match(splashCss, /:root\[data-mode="night"\][^{]*\.app-splash \.ring circle:not\(\.spin\)/)
  assert.match(splashCss, /:root\[data-mode="night"\][^{]*\.app-splash \.ring \.spin/)
})

// ---------- media-viewer-video-error ----------
// 事故面：<img> 有 @error 兜底，<video> 没有；视频失效时 loadeddata 永不触发，
// 界面一直停在 media-waiting 骨架，用户既没内容也没错误提示（复核 A4-03）。
const mediaViewer = read('student-frontend/src/components/base/MediaViewer.vue')

// 切出 `<video ...>` / `<img ...>` 这类自闭合标签的属性段
function tagAttrs(src, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'g')
  const all = [...src.matchAll(re)].map((m) => m[0])
  assert.ok(all.length > 0, `找不到 <${tag}> 标签`)
  return all
}

test('视频标签必须有 @error，且失败时同样解除骨架', () => {
  const [video] = tagAttrs(mediaViewer, 'video')
  assert.match(video, /@error="mediaReady = true"/,
    '视频加载失败必须也置 mediaReady，否则一直停在 media-waiting 骨架')
  assert.match(video, /@loadeddata="mediaReady = true"/, '成功路径不能被改坏')
})

test('图片的兜底保持原样（别在修视频时删掉）', () => {
  const [img] = tagAttrs(mediaViewer, 'img')
  assert.match(img, /@load="mediaReady = true"/)
  assert.match(img, /@error="mediaReady = true"/)
})

test('骨架类名只由 mediaReady 决定（失败置真后必能切到 media-in）', () => {
  const seg = mediaViewer.slice(mediaViewer.indexOf('<!-- 视频 -->'), mediaViewer.indexOf('<!-- 图片'))
  assert.match(seg, /mediaReady \? 'media-in' : 'media-waiting'/)
})
