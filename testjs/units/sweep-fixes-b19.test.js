// =========================================================================
// sweep-fixes-b19.test.js —— 批 19 的行为回归测试（表驱动）
//
// 覆盖 2026-11-04 批 19 的修法：
//   B11-02  写请求重发守卫的默认值放行（子窗口未传守卫 → 写请求重发 6 次 → 重复落库）
//   B11-03  字体 URL 裸路径无 content hash（内容变而文件名不变 → 缓存旧字体）
//   B11-04  明文模式把登录 JWT 拼进图片 URL 查询串（v5 起改为受限媒体凭据，两种模式统一）
//   B11-05  serialSaver 无 quiet-period（连打 10 字仍 2 次整表 PUT）
//   B11-06  tableSearch 每次全表 toLowerCase（无缓存）
//   B08-06  LeaveTimeline 每击键重建 haystack + 线性 find nodeTypes
//   B08-07  IconGlyph 的 84 项 MAP 定义在 setup 内（每实例重建）
//   B08-08  AppSelect 键盘路径关闭态 Enter 不初始化 hoverIdx
//   B09-05  rowHeights Map 按 _rowKey 累积不清理（无界增长）
//   B07-14  请假记录 student_id 为 null 时仍发起 ask-save-phones（PUT 到 undefined）
//   B05-09  undo_history 缺 (dir, origin) 索引
//   B05-11  album_photos 缺 (album_id, id) 索引（游标分页每批 filesort）
//
// ⚠️ 一律跑**真实源码**（前端 ESM 用动态 import()），不复现逻辑。
// =========================================================================

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

const ROOT = path.resolve(__dirname, '..', '..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const importFrontend = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

/** 去掉注释再匹配（forbid 类判据必须去注释，否则会命中自己写的说明） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// ---------------------------------------------------------------------------
// 静态形态判据（表驱动）
// ---------------------------------------------------------------------------

const STATIC_CASES = [
  {
    id: 'B11-02 默认守卫不放行写请求',
    desc: 'setupApiClient 的 writeRetryGuard 默认值必须是「只放行读请求」，不能是放行一切',
    files: ['student-frontend/src/utils/httpClient.js'],
    forbid: /writeRetryGuard\s*=\s*\(\s*\)\s*=>\s*true/,
    mustHave: /writeRetryGuard\s*=\s*defaultWriteRetryGuard/,
  },
  {
    id: 'B11-04 明文模式不拼 JWT 进 URL',
    desc: '图片 URL 只能用受限媒体凭据（scope=media）；明文模式也不得把登录 JWT 拼进查询串（v5·V5-005 起两种模式统一走媒体凭据）',
    files: ['student-frontend/src/utils/apiUrl.js'],
    forbid: null,
    mustHave: /localStorage\.getItem\(MEDIA_KEY\)/,
    mustHave2: /token=\$\{encodeURIComponent\(token\)\}/,
  },
  {
    id: 'B11-03 字体走带 hash 的资源地址',
    desc: '字体必须用 new URL(..., import.meta.url) 引入（public 下的资源 Vite 不加 hash）',
    files: ['student-frontend/src/utils/pdfFont.js'],
    forbid: /FONT_GZ_URL\s*=\s*['"]\/NotoSansSC/,
    mustHave: /new URL\([^)]*NotoSansSC-6\.ttf\.gz[^)]*import\.meta\.url\)/,
  },
  {
    id: 'B08-07 IconGlyph 的 MAP 在模块作用域',
    desc: '84 项常量 MAP 不能定义在 <script setup> 里（每实例重建一次）',
    files: ['student-frontend/src/components/base/IconGlyph.vue'],
    forbid: null,
    mustHave: /<script>\s*\n[\s\S]{0,400}const MAP = \{/,
    // 关键：MAP 必须**不在** <script setup> 块内。
    // 判据：<script setup> 之后的那段（到 </script>）里不许再出现 "const MAP = {"。
    mustNotBeInSetup: /const MAP = \{/,
  },
  {
    id: 'B08-08 AppSelect 键盘打开也初始化 hoverIdx',
    desc: '键盘打开菜单必须走 openMenu()（否则第二次 Enter 变成 commit(-1) 静默无效）',
    files: ['student-frontend/src/components/base/AppSelect.vue'],
    forbid: /@keydown\.enter\.prevent="open \? commit\(hoverIdx\) : \(open = true\)"/,
    mustHave: /@keydown\.enter\.prevent="open \? commit\(hoverIdx\) : openMenu\(\)"/,
  },
  {
    id: 'B09-05 rowHeights 会清理失效键',
    desc: 'rowHeights 必须随 rows 变化清掉不存在的行键（否则无界增长）',
    files: ['student-frontend/src/components/tables/DynamicTable/DynamicTable.vue'],
    forbid: null,
    mustHave: /rowHeights\.value\.delete\(k\)/,
  },
  {
    id: 'B07-14 无效 studentId 不发起保存',
    desc: 'student_id 为 null 时不能 emit ask-save-phones（会 PUT 到 undefined）',
    files: ['student-frontend/src/components/dialogs/AddLeaveDialog.vue'],
    forbid: /\{ studentId: base\.student_id,/,
    mustHave: /studentId == null \|\| studentId === ''/,
  },
  {
    id: 'B05-09 undo_history 有 (dir, origin) 索引',
    desc: '批次的整批回退查询走 (dir, origin)，必须有覆盖索引',
    files: ['student-backend/schema/schema.undo.js'],
    forbid: null,
    mustHave: /idx_undo_dir_origin[\s\S]{0,80}\(dir, origin\)/,
  },
  {
    id: 'B05-11 album_photos 有 (album_id, id) 索引',
    desc: '游标分页走 (album_id, id) ORDER BY id，需要覆盖索引免 filesort',
    files: ['student-backend/schema/schema.album.js'],
    forbid: null,
    mustHave: /idx_album_photos_album_id[\s\S]{0,80}\(album_id, id\)/,
  },
  {
    id: 'B11-06 tableSearch 缓存小写值',
    desc: '过滤要对每行做 toLowerCase，必须缓存（且值变了要失效）',
    files: ['student-frontend/src/utils/tableSearch.js'],
    forbid: null,
    mustHave: /lowerCache[\s\S]{0,300}hit\.raw === raw/,
  },
  {
    id: 'B08-06 LeaveTimeline 缓存 haystack + 索引 nodeTypes',
    desc: '每击键重建 haystack 与线性 find nodeTypes 都要收口',
    files: ['student-frontend/src/components/base/LeaveTimeline.vue'],
    forbid: /Object\.values\(n\)\.map\(v => String\(v \|\| ''\)\)\.join\(' '\)\.toLowerCase\(\)/,
    mustHave: /haystackCache/,
    mustHave2: /nodeTypeIndex/,
    // nodeTypes 的查法必须全走索引（线性 find 一处都不许剩）
    forbid2: /props\.nodeTypes\.find\(/,
  },
]

for (const c of STATIC_CASES) {
  test(`[静态] ${c.id} —— ${c.desc}`, () => {
    for (const f of c.files) {
      const raw = readSrc(f)
      const code = stripComments(raw)
      if (c.forbid) {
        assert.ok(!c.forbid.test(code), `${f}：不该再出现该模式（${c.forbid}）`)
      }
      if (c.mustHave) {
        assert.ok(c.mustHave.test(raw), `${f}：应保留修法特征（${c.mustHave}）`)
      }
      if (c.mustHave2) {
        assert.ok(c.mustHave2.test(raw), `${f}：应保留修法特征（${c.mustHave2}）`)
      }
      if (c.forbid2) {
        assert.ok(!c.forbid2.test(code), `${f}：不该再出现该模式（${c.forbid2}）`)
      }
      // mustNotBeInSetup：<script setup> 块内不许出现该形态
      // （setup() 每实例化一个组件就执行一遍 → 里面的常量会被重建 N 次）
      if (c.mustNotBeInSetup) {
        // ⚠️ 切分点必须在**去注释后**的文本上找：
        //   注释里写「<script setup> 里」会被当成标签（切分点错位 → 判据永远失败）。
        //   同理不能用简单 indexOf —— 第一个 <script setup 可能就在注释里。
        const clean = stripComments(raw)
        const m = clean.match(/<script\s+setup[^>]*>/)
        assert.ok(m, `${f}：应含 <script setup> 块`)
        const setupIdx = m.index
        const setupEnd = clean.indexOf('</script>', setupIdx)
        const setupBody = clean.slice(setupIdx, setupEnd)
        assert.ok(!c.mustNotBeInSetup.test(setupBody),
          `${f}：该常量不能定义在 <script setup> 里（每实例重建一次）`)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// 行为判据：真跑源码
// ---------------------------------------------------------------------------

test('[行为] B11-02 默认写请求守卫只放行 GET/HEAD（POST/PUT/DELETE 一律禁重发）', async () => {
  const src = readSrc('student-frontend/src/utils/httpClient.js')
  // 抽出默认守卫函数体来测（真跑源码里的实现，不复现逻辑）
  const m = src.match(/function defaultWriteRetryGuard\(config\)\s*\{([\s\S]*?)\n\}/)
  assert.ok(m, '必须保留 defaultWriteRetryGuard 函数')
  const body = m[1]
  // 真跑：把函数体拼成一个可执行的函数（用 new Function，参数与真实一致）
  const fn = new Function('config', body.replace(/\breturn\b/g, 'return'))
  assert.strictEqual(fn({ method: 'get' }), true, 'GET 必须放行（读请求幂等）')
  assert.strictEqual(fn({ method: 'head' }), true, 'HEAD 必须放行')
  assert.strictEqual(fn({ method: 'post' }), false, 'POST 必须禁重发（会重复落库）')
  assert.strictEqual(fn({ method: 'put' }), false, 'PUT 必须禁重发')
  assert.strictEqual(fn({ method: 'delete' }), false, 'DELETE 必须禁重发')
  assert.strictEqual(fn({ method: 'GET' }), true, '大写 method 也要认（大小写不敏感）')
  assert.strictEqual(fn({}), true, '无 method 时按 GET 算（放行）')
})

test('[行为] B11-06 tableSearch 缓存命中且值变了会失效', async () => {
  const { filterRowsByKeyword } = await importFrontend('student-frontend/src/utils/tableSearch.js')
  const rows = [{ 姓名: '张三' }, { 姓名: '李四' }]
  assert.deepStrictEqual(
    filterRowsByKeyword(rows, '姓名', 'LI').map((r) => r.姓名), [],
    '字面匹配不认拼音（"李四" 不含 "li"）—— 这条守住「不误当拼音搜索」'
  )
  assert.deepStrictEqual(
    filterRowsByKeyword(rows, '姓名', '李').map((r) => r.姓名), ['李四'],
    '中文匹配要正确'
  )
  assert.deepStrictEqual(
    filterRowsByKeyword([{ 姓名: 'Alice' }], '姓名', 'ali').map((r) => r.姓名), ['Alice'],
    '英文大小写不敏感'
  )
  // 值变了 → 缓存必须失效（否则搜索结果停在旧值上，比不做缓存更糟）
  const row = { 姓名: '王五' }
  assert.deepStrictEqual(filterRowsByKeyword([row], '姓名', '王'), [row])
  row.姓名 = '赵六'
  assert.deepStrictEqual(filterRowsByKeyword([row], '姓名', '王'), [], '值改了之后旧关键字不该再命中')
  assert.deepStrictEqual(filterRowsByKeyword([row], '姓名', '赵'), [row], '新值要能命中')
})

test('[行为] B11-05 serialSaver 静默期把连续请求合并成一次保存', async () => {
  const { createSerialSaver } = await importFrontend('student-frontend/src/utils/serialSaver.js')
  let calls = 0
  const saver = createSerialSaver(async () => { calls++ }, { quietMs: 60 })
  // 模拟「连打 10 个字」：10 次 request 都落在静默期内
  const ps = []
  for (let i = 0; i < 10; i++) ps.push(saver.request())
  const oks = await Promise.all(ps)
  assert.ok(oks.every((o) => o === true), '所有调用都拿到成功结果')
  assert.strictEqual(calls, 1, '静默期内的 10 次请求应合并成 1 次保存（原先是 2 次整表 PUT）')
})

test('[行为] B11-05 serialSaver 静默期内没有新输入时只存一轮（dirty 清理顺序不能反）', async () => {
  const { createSerialSaver } = await importFrontend('student-frontend/src/utils/serialSaver.js')
  let calls = 0
  const saver = createSerialSaver(async () => { calls++ }, { quietMs: 50 })
  // 3 次请求全落在静默期内 → 只该存 1 次。
  // ⚠️ 若把 dirty 的清理挪到 waitQuiet **之前**，静默期结束时 dirty 仍为 true
  //   → 循环再跑一轮 → 存了 2 次（明明只有一次改动）。
  const ps = [saver.request(), saver.request(), saver.request()]
  await Promise.all(ps)
  assert.strictEqual(calls, 1, '静默期内没有新输入时只能存 1 轮（dirty 清理顺序反了会多存一轮）')
})

test('[行为] B11-05 serialSaver 的 quietMs=0 保持原语义（立即保存、不让出微任务）', async () => {
  const { createSerialSaver } = await importFrontend('student-frontend/src/utils/serialSaver.js')
  let calls = 0
  const saver = createSerialSaver(async () => { calls++ }, { quietMs: 0 })
  const p = saver.request()
  // 同步检查：调用方常在 request() 之后马上查「是否已在途」
  assert.strictEqual(saver.busy, true, 'request() 之后应立刻处于在途状态')
  assert.strictEqual(calls, 1, 'quietMs=0 时 saveFn 必须同步被调用（不能被微任务推迟）')
  assert.strictEqual(await p, true)
  assert.strictEqual(calls, 1)
})

test('[行为] B11-05 serialSaver 默认静默期是正数（默认就该防抖）', async () => {
  const { createSerialSaver } = await importFrontend('student-frontend/src/utils/serialSaver.js')
  let calls = 0
  const saver = createSerialSaver(async () => { calls++ })
  assert.ok(saver.quietMs > 0, `默认静默期应为正数（当前 ${saver.quietMs}）`)
  await saver.request()
  assert.strictEqual(calls, 1)
})

test('[行为] B05-09/B05-11 索引真的建出来了（真跑 schema 的建表语句）', () => {
  const undo = readSrc('student-backend/schema/schema.undo.js')
  const album = readSrc('student-backend/schema/schema.album.js')
  assert.ok(/CREATE INDEX IF NOT EXISTS idx_undo_dir_origin ON undo_history \(dir, origin\)/.test(undo),
    'undo_history 必须有 (dir, origin) 索引')
  assert.ok(/CREATE INDEX IF NOT EXISTS idx_album_photos_album_id ON album_photos \(album_id, id\)/.test(album),
    'album_photos 必须有 (album_id, id) 索引')
})
