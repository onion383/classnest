// =========================================================================
// album-thumb-priority.test.js —— 缩略图「插队」：粒度与中断
// 运行：npm run test:units
//
// 用户原话：「能不能插队啊，我在看这张它正在生成，我马上滑到另外一个，
// 他就中断生成、生成我新的」+「重新申请生成的粒度是什么，是我看到这几行还是这一整天」。
//
// 查下来两件事都不对：
//   ① 粒度 = 一整天。AlbumView 按 `visibleGroups` 取「每个可见组的全部照片」，
//      而一个组就是一个日期分组 —— 一屏压着 2~3 天，一次要出去好几百个 id。
//   ② 没有中断。前端发出了就一直等，后端也不会因为 HTTP 断开而停 ——
//      Node 的 handler 照跑，配额一直被占着，新滑到的一屏只能排队。
//
// 行为层由 testjs/smoke/album-thumbs-abort-test.cjs 钉（真请求 + 真掐断），
// 这里守接线：粒度必须按视口实测、中断链路必须完整（少一环就静默退化）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const VIEW = path.join(ROOT, 'student-frontend/src/views/AlbumView.vue')
const BATCH = path.join(ROOT, 'student-frontend/src/composables/useThumbBatch.js')
const MEDIA = path.join(ROOT, 'student-frontend/src/utils/albumMedia.js')
const ROUTE = path.join(ROOT, 'student-backend/routes/album.js')

const read = (p) => fs.readFileSync(p, 'utf8')

/** 去掉注释（只用于「某写法不许再出现」这类判据）。
 *  不这么做的话，注释里解释「为什么不能用 X」的文字会让断言假红 ——
 *  本轮写流式时真的踩到了（X-Thumb-Ids 只存在于注释里，判据却报有）。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 取某个顶层函数的函数体（按 `function 名字(` 定位，花括号配平） */
function fnBody(code, name) {
  const at = code.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `找不到 function ${name}(`)
  // **先跳过参数表再找函数体**：签名里可能有解构默认值
  // （`async function sendThumb(res, photoId, { maxAge = 86400 } = {})`），
  // 直接找第一个 `{` 会把它当成函数体开头，取出来只有 ` maxAge = 86400 `。
  const paren = at + `function ${name}`.length
  assert.equal(code[paren], '(', `${name} 后面必须紧跟参数表`)
  let pd = 0
  let close = -1
  for (let i = paren; i < code.length; i++) {
    if (code[i] === '(') pd++
    else if (code[i] === ')') { pd--; if (!pd) { close = i; break } }
  }
  assert.ok(close > 0, `${name} 的参数表没有闭合`)
  const open = code.indexOf('{', close)
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

test('预取粒度按 DOM 实测的视口格子，不是按日期分组整组取', () => {
  const code = read(VIEW)
  const body = fnBody(code, 'measureViewportIds')
  assert.match(body, /querySelectorAll\('\[data-cell-id\]'\)/, '必须按格子实测（data-cell-id），否则会退化回「整天」粒度')
  assert.match(body, /getBoundingClientRect/, '必须用实际矩形判断是否在视口里')
  assert.match(code, /useThumbBatch\(\(\) => viewportPhotoIds\.value\)/, '批量预取的入参必须是视口实测结果')
})

test('不许再把 visibleGroups 里的照片全塞进预取列表（退回「一整天」粒度）', () => {
  const code = read(VIEW)
  // 旧实现特征：遍历 visibleGroups 并 push p.id
  const bad = /for\s*\(\s*const\s+v\s+of\s+visibleGroups\.value\s*\)\s*\{[\s\S]{0,120}?out\.push\(p\.id\)/
  assert.doesNotMatch(code, bad, '预取列表又按 visibleGroups 整组取了 —— 一屏会变成几百张，插队就失效了')
})

test('滚动会重新测量，且节流定时器有清理', () => {
  const code = read(VIEW)
  assert.match(code, /watch\(\[scrollTop, visibleGroups\], scheduleMeasure/, '滚动/分组变化必须重测视口')
  assert.match(code, /thumbD\.add\(\(\) => \{ if \(viewportTimer\)/, '节流定时器必须登记清理（否则卸载后仍在跑）')
})

/* ================= 视口内优先（「15 张先渲染，剩下 25 张后面再说」） =================
 * 链路是：测量时视口内的排前面 → 请求按这个顺序发 → 后端 missing 按请求序 push
 * → GEN_BATCH 分批生成 → 生成一张 write 一张 → 前端收到一张渲染一张。
 * 任何一环把顺序丢了，都退化成「按时间线从上往下慢慢出」，而且用户只会看到
 * 「我要看的那张怎么最后才出来」，界面上没有任何报错。 */
test('测量时视口内的排在缓冲带前面（不加 pad 的那个框才是「真正在看」）', () => {
  const body = fnBody(read(VIEW), 'measureViewportIds')
  // 必须存在两档收集
  assert.match(body, /const inView = \[\]/, '必须区分「视口内」这一档')
  assert.match(body, /const buffer = \[\]/, '必须区分「缓冲带」这一档')
  // 视口内的判据必须用**未加 pad** 的 box 边界
  assert.match(body, /r\.bottom >= box\.top && r\.top <= box\.bottom/, '视口内必须用 box.top/box.bottom（不加 VIEWPORT_PAD），否则等于没分档')
  // 输出顺序必须是 inView 在前
  assert.match(body, /inView\.concat\(buffer\)/, '输出必须是 inView 在前、buffer 在后')
  const concatAt = body.indexOf('inView.concat(buffer)')
  const pushIn = body.indexOf('inView.push(id)')
  assert.ok(pushIn > 0 && concatAt > pushIn, '定位不到「收集 → 合并」顺序')
})

test('顺序变化必须能被 watch 感知（否则重排序永远不生效）', () => {
  const src = read(BATCH)
  // 找 watch 的依赖计算表达式
  const m = src.match(/watch\(\(\) => \{[\s\S]*?\n\s*\}, \(\) => schedule\(\)\)/)
  assert.ok(m, '找不到 useThumbBatch 里的 watch')
  assert.match(m[0], /ids\.join\(','\)/, "依赖必须用完整序列 —— 只比「长度 + 首尾」会把同一屏内的重排序当成没变化")
  assert.doesNotMatch(m[0], /ids\[ids\.length - 1\]/, '不许退回「长度 + 首尾」指纹')
})

test('后端按请求顺序生成（missing 必须按 ids 序 push，不能按 SQL 返回序）', () => {
  const code = stripComments(read(ROUTE))
  // 收集缺图的循环必须以请求的 ids 为迭代源
  assert.match(code, /for \(const id of ids\) \{[\s\S]{0,600}?missing\.push\(r\);/,
    'missing 必须按请求的 ids 顺序 push —— 按 SQL 返回顺序会让「视口内优先」彻底失效')
  // 生成必须从 missing 头部切（slice(0, grant)），保持顺序
  assert.match(code, /const rows = missing\.slice\(0, grant\)/, '生成必须从 missing 头部按序取')
})

test('新一批预取会 abort 上一批（插队的前端一半）', () => {
  const body = fnBody(read(BATCH), 'load')
  // 断言完整语句而不是「文件里出现过 inflightCtl.abort()」——
  // 后者连 `if (false) inflightCtl.abort()` 都能过（变异反证时被抓出来过）。
  assert.match(body, /if \(inflightCtl\) inflightCtl\.abort\(\)/, 'load 开头必须真的 abort 上一批（不能写在死分支里）')
  const abortAt = body.indexOf('inflightCtl.abort()')
  const wantAt = body.indexOf('want.forEach')
  assert.ok(abortAt > 0 && abortAt < wantAt, 'abort 必须发生在收集 want 之后、发请求之前')
})

test('abort 不能被当成「没拿到」（否则白排重试并累加 failStreak）', () => {
  const body = fnBody(read(BATCH), 'load')
  // 必须匹配**语句**而不是裸字符串：注释里就写着「必须排在 `if (!map)` 之前」，
  // 裸 indexOf 会命中注释，等于自己给自己放水（这条坑踩过一次）。
  const abortedAt = body.search(/\n\s*if \(signal\.aborted\) \{/)
  const nullAt = body.search(/\n\s*if \(!res\) \{/)
  assert.ok(abortedAt > 0 && nullAt > 0, 'load 里必须同时有 signal.aborted 与 if (!res) 两个语句')
  assert.ok(abortedAt < nullAt, 'signal.aborted 判断必须排在 if (!res) 之前')
})

test('abort 分支要把没跑到的 chunk 从 inflight 摘掉（否则这些 id 永久缺图）', () => {
  const body = fnBody(read(BATCH), 'load')
  const abortedAt = body.search(/\n\s*if \(signal\.aborted\) \{/)
  const nullAt = body.search(/\n\s*if \(!res\) \{/)
  assert.ok(abortedAt > 0 && nullAt > abortedAt, '定位不到 abort 分支')
  const seg = body.slice(abortedAt, nullAt)
  assert.match(seg, /inflight\.delete/, 'abort 时必须清理 inflight，否则这批 id 之后每一轮都被跳过')
})

test('streamThumbBatch 把 signal 一路传给 fetch 封装', () => {
  const body = fnBody(read(MEDIA), 'streamThumbBatch')
  assert.match(body, /signal/, 'streamThumbBatch 必须支持 signal')
  assert.match(body, /apiFetch\([\s\S]*?signal/, 'signal 必须传进 apiFetch（它透传给 fetch）')
})

test('后端在客户端断开后停止继续生成（插队的后端一半）', () => {
  const code = stripComments(read(ROUTE))
  // 必须挂 **res**：Node 16 起 IncomingMessage 的 'close' 是「请求体读完」就触发，
  // 挂 req 会让 clientGone 从第一帧起就是 true（响应 200 但零帧，且不报错）。
  // 不写死单行格式：close 回调里现在还要立刻归还额度，多了一行（见下面那条测试）。
  assert.match(code, /res\.on\('close', \(\) => \{\s*if \(res\.writableEnded\) return;\s*clientGone = true;/, '必须监听 res 的 close 并区分「正常结束」')
  assert.ok(!/req\.on\('close'/.test(code), "别挂 req 的 close —— 那不是「连接断了」")
  assert.match(code, /i < rows\.length && !clientGone; i \+= GEN_BATCH/, '生成循环必须分批并在批间检查 clientGone')
  assert.match(code, /const GEN_BATCH = \d+;/, '缺少分批常量 GEN_BATCH')
})

/* ================== 流式响应契约（「后端好了就推给前端」的实现） ==================
 * 这几条防的是「改回流式」——那种退化不会有任何报错，只会让用户
 * 重新回到「干等一整批」的体感，而且从日志里完全看不出来。 */
test('后端逐帧写出：每帧自带 id，且生成一张就 write 一张', () => {
  const code = read(ROUTE)
  // 帧头：id + len（两个 uint32），合成一个 Buffer 一次 write
  assert.match(code, /head\.writeUInt32LE\(id, 0\)/, '帧头必须带 photoId —— 流式下没有响应头能对位')
  assert.match(code, /head\.writeUInt32LE\(buf\.length, 4\)/, '帧头必须带长度')
  assert.match(code, /res\.write\(Buffer\.concat\(\[head, buf\]\)\)/,
    '一帧必须合成单个 Buffer 一次 write，分两次 write 会被并发生成的别的帧插进来')
  // 生成循环里必须直接 write，不许先 push 到数组攒着
  const genAt = code.indexOf('for (let i = 0; i < rows.length && !clientGone')
  assert.ok(genAt > 0, '找不到分批生成循环')
  const genSeg = code.slice(genAt, genAt + 2200)
  assert.match(genSeg, /writeFrame\(r\.id, buf\)/, '生成完必须立刻写，攒到批末就退回「等整批」')
  assert.ok(!/parts\.push/.test(genSeg), '不许再攒 parts 数组（那是整包响应的写法）')
})

test('后端已彻底放弃 X-Thumb-Ids 与整包响应', () => {
  // 去掉注释再判：这两个词的「为什么不能这么写」正好写在注释里，
  // 裸 match 会命中说明文字而假红（同一个坑本轮已经踩过一次）。
  const code = stripComments(read(ROUTE))
  assert.ok(!/X-Thumb-Ids/.test(code), 'X-Thumb-Ids 与流式互斥：写第一帧时还不知道会发出哪些 id')
  assert.ok(!/Buffer\.concat\(parts\)/.test(code), '不许再拼整包 body')
  // 开流之后 catch 里不能再发 500（会抛 ERR_HTTP_HEADERS_SENT）
  assert.match(code, /if \(streaming\) \{/, '必须用 streaming 标志分流 catch')
  assert.match(code, /'Cache-Control': 'no-store'/, '流响应不能缓存，否则清完缩略图还拿到旧的空流')
})

test('前端边收边回调：解析出一帧就上屏一张', () => {
  const media = read(MEDIA)
  const body = fnBody(media, 'streamThumbBatch')
  assert.match(body, /res\.body\.getReader\(\)/, '必须流式读，不能用 arrayBuffer 整包等')
  assert.match(body, /const \{ done, value \} = await reader\.read\(\)/, '必须逐块读')
  // 每读完一块就要把完整帧吐出去，而不是攒到最后
  assert.match(body, /emit\(parser\(value\)\)/, '每块读完必须立刻解析并回调，否则「流式」等于没做')

  const batch = fnBody(read(BATCH), 'load')
  const callAt = batch.indexOf('streamThumbBatch(chunk, signal,')
  assert.ok(callAt > 0, 'load 必须调 streamThumbBatch')
  const cbSeg = batch.slice(callAt, callAt + 420)
  assert.match(cbSeg, /urls\.value = next/, '回调里必须立刻写 urls（一张到就上屏一张），不能先攒着')
})

// ---------------------------------------------------------------------------
// 预览额度（2026-11-13）：预览与「后台生成」必须分开，且能立刻插队
//
// 用户原话：「中断是真的会中断后端上一批微缩图吗？能不能中断之后马上释放配额给新任务？
// 能不能预览配额和生成配额分开，并且预览可以直接插队批量生成？」
//
// 查下来：中断是真的（GEN_BATCH 批间检查 clientGone），但配额被两件事卡住 ——
//   ① 额度按「是否在扫描」分档，扫描期间压到 8，而一屏要 40 张
//   ② 已转交子进程待生成的 id 也算额度，子进程没干完，浏览者就排不上
// 实测（90 张 2400×1800，一屏 40，连续 6 轮滑走）：扫描档单张 200 只有 1/60。
// ---------------------------------------------------------------------------

test('预览额度固定，不再按「扫描中 / 空闲」分两档', () => {
  const code = stripComments(read(ROUTE))
  assert.match(code, /const PREVIEW_LIMIT = (\d+)/, '必须有固定的预览额度常量')
  assert.ok(!/ON_DEMAND_LIMIT/.test(code), '不许再退回「扫描中压到 8」的两档额度')
  assert.ok(!/listActive\(\)\.length \?/.test(code), '额度不许再按「有没有扫描任务」切换')
  const m = code.match(/const PREVIEW_LIMIT = (\d+)/)
  assert.ok(Number(m[1]) >= 24, `预览额度 ${m[1]} 太小：一屏 20~40 张，至少要让大部分一次拿到`)
})

test('已转交子进程的 id 不再占预览额度', () => {
  const code = stripComments(read(ROUTE))
  assert.ok(!/pendingInChild\.totalSize\(\)/.test(code),
    'pendingInChild 参与额度减法 = 子进程没干完的活把浏览者挡在门外（滚几屏后恒 404）')
})

test('额度不够时先等（PREVIEW_WAIT_MS），不是立刻 404', () => {
  const code = stripComments(read(ROUTE))
  assert.match(code, /const PREVIEW_WAIT_MS = (\d+)/, '缺少等待上限常量')
  const wait = Number(code.match(/const PREVIEW_WAIT_MS = (\d+)/)[1])
  // 前端第一次重试在 100ms、第二次 200ms。等太久没意义，等太短救不回来。
  assert.ok(wait >= 200 && wait <= 800, `PREVIEW_WAIT_MS=${wait} 不合理：要撑过前端前两次重试（100/200ms）`)
  assert.match(code, /claimPreviewUpTo\(missing\.length, PREVIEW_WAIT_MS\)/, '批量接口必须带等待')
  assert.match(fnBody(code, 'sendThumb'), /claimPreviewUpTo\(1, PREVIEW_WAIT_MS\)/, '单张接口也必须带等待')
  assert.match(code, /previewWaiters/, '必须有等待队列（否则「等」只能靠轮询）')
})

test('releasePreview 有几个给几个，不要求凑满等待者的 n', () => {
  const body = fnBody(stripComments(read(ROUTE)), 'releasePreview')
  assert.match(body, /Math\.min\(w\.n, avail\)/, '必须按当前可用量给：一屏 40 张排队时额度一次只腾出 1~4 个，凑满才唤醒会永远等不到')
  assert.match(body, /clearTimeout\(w\.timer\)/, '唤醒时必须清掉该等待者的超时定时器，否则它会在 400ms 后二次 resolve')
})

test('客户端断开立刻归还「还没轮到」的额度（不等当前批跑完）', () => {
  const code = stripComments(read(ROUTE))
  assert.match(code, /const releaseUnstarted = \(\) => \{/, '必须有 releaseUnstarted')
  assert.match(code, /const idle = claimed - started/, '只还「没开始」的那部分：已开始的真的在占 CPU，收回等于超卖')
  assert.match(code, /started = Math\.min\(rows\.length, i \+ GEN_BATCH\)/, 'started 水位必须随每批提交推进')
  // 定义还不够，必须在 close 里真的调用（「存在 ≠ 接线对」）
  assert.match(code,
    /res\.on\('close', \(\) => \{\s*if \(res\.writableEnded\) return;\s*clientGone = true;\s*releaseUnstarted\(\);/,
    'close 回调里必须在置 clientGone 之后立刻调用 releaseUnstarted()')
})

test('单张接口的额度按张数累加归还（布尔会在两个分支间泄漏）', () => {
  const body = fnBody(stripComments(read(ROUTE)), 'sendThumb')
  assert.match(body, /let claimed = 0/, 'claimed 必须是计数：两处分支各申请一张，用布尔时第二次申请、只还一次 → 额度慢慢泄漏')
  const bumps = (body.match(/claimed \+= grant/g) || []).length
  assert.ok(bumps >= 2, `claimed += grant 只出现 ${bumps} 次，两处申请分支都要累加`)
  assert.match(body, /releasePreview\(claimed\)/, 'finally 必须按实际张数归还')
})

test('排队等槽位的图，客户端走开后不再白跑（检查必须在 acquire 之后）', () => {
  const SCAN = path.join(ROOT, 'student-backend/albumScan.js')
  const body = fnBody(read(SCAN), 'genThumb')
  const acq = body.indexOf('await acquireThumbSlot()')
  const chk = body.indexOf('opts.shouldAbort()')
  assert.ok(acq > 0, 'genThumb 必须先用 acquireThumbSlot 抢并发槽位')
  assert.ok(chk > 0, 'genThumb 必须支持 shouldAbort（否则排队的图拦不住）')
  assert.ok(chk > acq,
    '取消检查必须在 acquireThumbSlot **之后**：放前面只能拦住还没排到的那一小撮，'
    + '而「排队结束」才是真正决定要不要花这次 CPU 的时刻')

  const route = stripComments(read(ROUTE))
  assert.match(route, /genThumb\(r\.id, r\.file_path, isVideo, slug, \{ shouldAbort: \(\) => clientGone \}\)/,
    '批量接口必须把 clientGone 一路传进 genThumb')
  const send = fnBody(route, 'sendThumb')
  assert.match(send, /shouldAbort: \(\) => res\.destroyed/, '单张接口也要传：客户端断开就没必要再生成')
})
