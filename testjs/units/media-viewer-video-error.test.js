// =========================================================================
// media-viewer-video-error.test.js —— 视频加载失败不能停在骨架无限等（复核 A4-03）
//
// `<img>` 有 `@error` 兜底（失败也置 mediaReady），`<video>` 没有：视频地址失效/编码
// 不支持时 loadeddata 永不触发，界面一直停在 media-waiting 的骨架 —— 用户看到的是
// 「一直在加载」，既没内容也没有任何错误提示（复核报告 A4-03 判定成立）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const VUE = path.join(__dirname, '../../student-frontend/src/components/base/MediaViewer.vue')
const SRC = fs.readFileSync(VUE, 'utf8')

// 切出 `<video ...>` / `<img ...>` 这类自闭合标签的属性段
function tagAttrs(src, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>`, 'g')
  const all = [...src.matchAll(re)].map((m) => m[0])
  assert.ok(all.length > 0, `找不到 <${tag}> 标签`)
  return all
}

test('视频标签必须有 @error，且失败时同样解除骨架', () => {
  const [video] = tagAttrs(SRC, 'video')
  assert.match(video, /@error="mediaReady = true"/,
    '视频加载失败必须也置 mediaReady，否则一直停在 media-waiting 骨架')
  assert.match(video, /@loadeddata="mediaReady = true"/, '成功路径不能被改坏')
})

test('图片的兜底保持原样（别在修视频时删掉）', () => {
  const [img] = tagAttrs(SRC, 'img')
  assert.match(img, /@load="mediaReady = true"/)
  assert.match(img, /@error="mediaReady = true"/)
})

test('骨架类名只由 mediaReady 决定（失败置真后必能切到 media-in）', () => {
  const seg = SRC.slice(SRC.indexOf('<!-- 视频 -->'), SRC.indexOf('<!-- 图片'))
  assert.match(seg, /mediaReady \? 'media-in' : 'media-waiting'/)
})
