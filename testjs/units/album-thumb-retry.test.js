// =========================================================================
// album-thumb-retry.test.js —— 相册缩略图 404 必须能自愈
// 运行：npm run test:units
//
// 背景（真实故障）：清理微缩图之后进相册，一屏图全是空白，等十秒也不长回来。
// 两个原因叠在一起：
//   ① 后端：批量接口一次要 12 张 > 现场生成配额闸 8 张 → 整批被拒 → 全部转交子进程
//      → 子进程出图前，单张接口也一路 404「排队生成中」。
//      （行为层由 testjs/smoke/album-thumbs-rebuild-batch-test.cjs 钉）
//   ② 前端：error 就把 <img> 换成 data URI 占位图。占位图是直接写进 DOM 的，
//      而模板里 :src 算出来仍是原来那个 URL —— Vue 比较后认为「没变化」就不碰 DOM，
//      于是**刷新页面之前永远不会重试**。
//
// 这个文件守的是 ②：404 不等于「这张照片没有缩略图」，必须退避重试几次，
// 只有一直拿不到才认定真的没有、贴占位图。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const VIEW = path.join(ROOT, 'student-frontend/src/views/AlbumView.vue')

const src = () => fs.readFileSync(VIEW, 'utf8')

/** 取某个顶层函数的函数体（按「function 名字(」定位，花括号配平） */
function fnBody(code, name) {
  const at = code.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `找不到 function ${name}(`)
  const open = code.indexOf('{', at)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (!depth) return code.slice(open + 1, i)
    }
  }
  throw new Error(`${name} 的花括号没有配平`)
}

test('照片格子的 @error 必须传 photoId（拿不到 id 就没法按图重试）', () => {
  const code = src()
  // 只约束网格里的 <img>：相册封面的 error 处理是「贴 data URI 兜底」，
  // 它没有占位层也不参与按图重试，允许只传 $event。
  const gridAt = code.indexOf('v-if="!isVideo(p) && thumbSrc(p)"')
  assert.ok(gridAt > 0, '找不到网格缩略图的 <img>（模板结构变了？下面这条判据会失效）')
  const errAt = code.indexOf('@error="onThumbError($event, p.id)"', gridAt)
  assert.ok(errAt > gridAt && errAt < gridAt + 900,
    '网格缩略图的 @error 必须传 p.id，否则失败后无法按图重试')
})

test('照片格子失败走占位层，不把 src 改成 data URI', () => {
  const body = fnBody(src(), 'onThumbError')
  assert.match(body, /THUMB_RETRY_MAX/, 'onThumbError 里必须有重试上限判断（否则一次 404 就永久占位）')
  assert.match(body, /thumbRetry/, 'onThumbError 里必须更新重试计数（否则 URL 不变，浏览器不会重发）')
  // 封面（id 为 null）没有占位层，保留 data URI 兜底
  assert.match(body, /if \(id == null\) \{[\s\S]{0,240}?THUMB_PLACEHOLDER/,
    '封面分支应保留 data URI 兜底（它的模板里没有占位层）')
  // 照片格子：直接把 e.target.src 改成 data URI 是上一版的坑 ——
  // 模板算出的 URL 没变，Vapor 不碰 DOM，重试成功后也换不回来（永久占位）。
  assert.match(body, /markThumbBroken\(id, true\)/, '照片格子失败时必须立刻盖上占位层')
})

/* ============ 失败时的观感：不许出现破图 + alt 文本（「裂缝」） ============
 * 真实反馈：整屏格子显示成「破图图标 + IMG_2022....jpg 文件名」。
 * 根因是 onThumbError 在重试窗口内什么都不做，<img> 一直停在加载失败态，
 * 浏览器就把 alt 文本画出来了（100+200+2400ms 一共 2.7 秒）。 */
test('模板有占位层，且失败时盖住那张破图', () => {
  const code = src()
  assert.match(code, /class="thumb-ph[^"]*absolute inset-0/, '缺少覆盖在格子上的占位层')
  assert.match(code, /v-if="!isVideo\(p\) && \(!thumbSrc\(p\) \|\| thumbBroken\.has\(p\.id\)\)"/,
    '占位层必须在「无 src」或「加载失败」两种情况下显示')
  // 破图必须被藏起来，否则 alt 文本（文件名）会露出来
  assert.match(code, /:class="thumbBroken\.has\(p\.id\) \? 'opacity-0' : ''"/,
    '失败时 <img> 必须 opacity-0，否则浏览器会画出破图图标和 alt 文本')
  // 但 <img> 不能从 DOM 移除：重试靠 src 变化触发，元素没了就没人重新请求
  assert.match(code, /v-if="!isVideo\(p\) && thumbSrc\(p\)"/,
    '<img> 的 v-if 不许包含 thumbBroken —— 移除元素后重试不会发生')
  assert.match(code, /@load="onThumbLoad\(p\.id\)"/, '必须有 @load：成功时要把占位层撤掉')
})

test('占位层给了两种状态文案 + 查看原图提示', () => {
  const code = src()
  assert.match(code, /正在生成微缩图/, '缺少「正在生成微缩图」文案')
  assert.match(code, /生成微缩图失败/, '缺少「生成微缩图失败」文案')
  assert.match(code, /可直接点击此处查看原图/, '缺少「可直接点击此处查看原图」提示')
  const body = fnBody(code, 'thumbPhTitle')
  assert.match(body, /THUMB_RETRY_MAX/, '文案必须按重试次数切换，否则永远是同一个状态')
})

test('重试 URL 带 &r=N（同 URL 不会重新请求）', () => {
  const body = fnBody(src(), 'withThumbRetry')
  assert.match(body, /&r=\$\{/, 'withThumbRetry 必须拼 &r=N，否则 <img> src 不变、不会重发请求')
})

test('网格缩略图回落到 withThumbRetry（不是直接 albumThumbUrl）', () => {
  const body = fnBody(src(), 'thumbSrc')
  assert.match(body, /withThumbRetry\(/, 'thumbSrc 批量回落时必须走 withThumbRetry')
  assert.doesNotMatch(body, /albumThumbUrl\(/, 'thumbSrc 里不该再直接调 albumThumbUrl（会绕过重试）')
})

test('重试定时器走 useDisposables（卸载后不许再有回调写状态）', () => {
  const code = src()
  const body = fnBody(code, 'onThumbError')
  assert.match(body, /thumbD\.timeout\(/, '重试定时器必须用 d.timeout 登记')
  assert.doesNotMatch(body, /(^|[^.\w])setTimeout\(/, 'onThumbError 里不许裸 setTimeout（卸载后回调仍会跑）')
  assert.match(code, /const thumbD = useDisposables\(\)/, '缺少 useDisposables() 登记表')
})
