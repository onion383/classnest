// =========================================================================
// test-assets.test.js —— 测试资产自身 13 条的回归（批 19：B13 5 条 + B14 8 条）
//
// 为什么单独一个文件：这 13 条修的都是**测试 / 工具本身**的问题
// （假覆盖、临时目录泄漏、死等、漏报、只杀直接子进程）。
// 它们坏了不会让业务代码挂，只会让「验证通过」这句话变得不可信 ——
// 所以更需要判据守着，否则下一轮审查会把这些原样再报一遍。
//
// ⚠️ 一律跑**真实源码**：正则从源码里抽出来真跑，路径从注释里解析出来真查存在性。
// =========================================================================

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------------------------------------------------------------------------
// 静态形态判据
// ---------------------------------------------------------------------------

const CASES = [
  {
    id: 'B13-01 设置探针的空串用例必须是三元组',
    file: 'testjs/smoke/theme-setting-probe.mjs',
    must: ["['空串（写坏）', '', 0.6]", 'if (expected === undefined)'],
    // 原来写成 `expected === undefined ? true` —— 缺 expected 时断言恒真，
    // 空串边界等于没测（就是这条 bug 本身）
    forbid: ['expected === undefined ? true'],
  },
  {
    id: 'B13-02 虚拟相册测试要删仓库内的 dataDir',
    file: 'testjs/units/refresh-virtual.test.js',
    must: ['fs.rmSync(dataDir'],
  },
  {
    id: 'B13-03 页面探针用轮询而非固定死等 5 秒',
    file: 'testjs/tools/electron-page-probe.cjs',
    // 判据从「#out 文本非空即退出」升级为「页面自报 READ_DONE 才退出」：
    // 断言页的 #out 带占位文本，只判非空会读到半截结果。
    must: ['deadline', 'executeJavaScript(READ_DONE)', 'setTimeout(r, 100)'],
    forbid: ['setTimeout(r, 5000)'],
  },
  {
    id: 'B13-04 pathGuard 临时目录统一登记 + after 清理',
    file: 'testjs/units/pathGuard.test.js',
    must: ['createdDirs', 'after('],
  },
  {
    id: 'B13-05 错误边界扫描器要认跨行空 catch、且不把 .catch( 计入分母',
    file: 'testjs/tools/error-boundary-check.cjs',
    must: ['EMPTY_CATCH_BLOCK', 'CATCH_KEYWORD', '(?<![.\\w])catch'],
  },
  {
    id: 'B14-13 嵌入 Python 的路径必须用正斜杠',
    file: 'testjs/smoke/pptx-guard-test.cjs',
    must: ["TMP.replace(/\\\\/g, '/')"],
    // 反斜杠翻倍（`\\\\`）会让 Python 的 r'' 里出现两个反斜杠
    forbid: ['TMP.replace(/\\\\\\\\/g'],
  },
  {
    id: 'B14-15 关服务要 await closeServer（否则 keep-alive 挂着永不退出）',
    file: 'testjs/probe/search-bench.cjs',
    must: ['await closeServer(server)'],
  },
  {
    id: 'B14-16 结束 dev server 要杀整棵进程树',
    file: 'testjs/probe/vapor-verify.mjs',
    must: ['killTree(child)'],
    forbid: ['child.kill()'],
  },
  {
    id: 'B14-17 Electron 子进程要有超时上限',
    file: 'testjs/smoke/secure-channel-retry.js',
    must: ['ELECTRON_TIMEOUT_MS', 'killTree'],
  },
  {
    id: 'B14-18 撤销用例的断言标签要与逻辑一致',
    file: 'testjs/smoke/cadre-undo-test.cjs',
    must: ['王五不受影响'],
    // ⚠️ 不能用裸「成员再次清空」做 forbid：修复注释里就写着「标签原来写「成员再次清空」」，
    //   会命中自己的注释（这个坑批 18 踩过一次）。这里精确匹配断言调用形式。
    forbid: ["check('重做删除：成员再次清空'"],
  },
  {
    id: 'B14-19 未捕获异常要记日志后退出',
    file: 'testjs/probe/toplevel-bottom-probe.cjs',
    must: ['process.exit(3)'],
  },
  {
    id: 'B14-20 run-smoke 要有单脚本超时与统一临时根目录',
    file: 'testjs/run-smoke.cjs',
    must: ['SMOKE_TIMEOUT_MS', 'TMP_ROOT'],
  },
]

for (const c of CASES) {
  test(`[静态] ${c.id}`, () => {
    const src = readSrc(c.file)
    for (const s of c.must || []) {
      assert.ok(src.includes(s), `${c.file} 应包含：${s}`)
    }
    for (const s of c.forbid || []) {
      assert.ok(!src.includes(s), `${c.file} 不该再出现：${s}`)
    }
  })
}

// ---------------------------------------------------------------------------
// B14-14：注释里的跑法路径必须真的存在（「路径漂移」的唯一硬判据）
//
// 7 个文件的头部注释都写了 `node testjs/xxx/yyy.mjs`，
// 文件被搬过目录而注释没跟着改 → 照注释跑必然 MODULE_NOT_FOUND。
// 这里把注释里的路径解析出来逐个查存在性 —— 比"看着像对的"可靠。
// ---------------------------------------------------------------------------

test('[行为] B14-14 头部注释里的跑法路径都指向真实文件', () => {
  const FILES = [
    'testjs/probe/ocr-probe.mjs',
    'testjs/smoke/api-smoke.cjs',
    'testjs/smoke/collator-equiv-probe.js',
    'testjs/smoke/pdf-subset-verify.mjs',
    'testjs/smoke/pptx-guard-test.cjs',
    'testjs/smoke/unzip-safe-test.cjs',
    'testjs/smoke/thumbs-cache-test.cjs',
  ]
  const HINT = /node\s+(testjs\/[\w./-]+\.(?:mjs|cjs|js))/g
  const missing = []
  for (const rel of FILES) {
    const head = readSrc(rel).split(/\r?\n/).slice(0, 30).join('\n')
    const hits = [...head.matchAll(HINT)].map((m) => m[1])
    assert.ok(hits.length > 0, `${rel} 的头部注释里应写明跑法路径`)
    for (const p of hits) {
      if (!fs.existsSync(path.join(ROOT, p))) missing.push(`${rel} → ${p}`)
    }
  }
  assert.deepStrictEqual(missing, [], '注释里的路径不存在：' + missing.join('; '))
})

// ---------------------------------------------------------------------------
// B13-05 行为判据：把扫描器的两个正则从源码里抽出来真跑
//
// 只判「源码里有 EMPTY_CATCH_BLOCK 这个词」是假绿 ——
// 正则写成单行版（`catch\(...\)\s*\{\s*\}` 不含换行）同样有这个词，但多行空 catch 照样漏报。
// 所以这里抽真实正则、喂真实样本，看它到底认不认。
// ---------------------------------------------------------------------------

test('[行为] B13-05 扫描器能抓到多行空 catch，且不把 .catch( 计入 catch 分母', () => {
  const src = readSrc('testjs/tools/error-boundary-check.cjs')

  // 从源码里取 `const NAME = /.../g` 的真身
  const pick = (name) => {
    const m = src.match(new RegExp('const ' + name + ' = (\\/[^\\n]+\\/g)'))
    assert.ok(m, `必须能找到 ${name} 的正则定义`)
    return new Function('return ' + m[1])() // eslint-disable-line no-new-func
  }

  const emptyBlock = pick('EMPTY_CATCH_BLOCK')
  const catchKeyword = pick('CATCH_KEYWORD')

  // ① 多行空块（中间只有换行与空白）必须命中 —— 这正是旧单行正则漏掉的那类
  assert.strictEqual(emptyBlock.test('try { a() } catch (e) {\n\n}'), true,
    '多行空 catch 必须被识别（旧单行正则漏报的就是这种）')

  // ② 块里有语句就不算空
  emptyBlock.lastIndex = 0
  assert.strictEqual(emptyBlock.test('try { a() } catch (e) { b() }'), false,
    '有语句的 catch 不该被算成空捕获')

  // ③ 注释行会被先抹平成空白，抹平后就算空 —— 这是"注释占几行"的场景
  const stripped = 'try { a() } catch (e) {\n      \n}'
  emptyBlock.lastIndex = 0
  assert.strictEqual(emptyBlock.test(stripped), true, '注释抹平后的空块也必须命中')

  // ④ `.catch(` 不是 catch 块，不能计入分母（原来 `/\bcatch\s*\(/` 会算进去）
  assert.strictEqual(('promise.catch(e => { go(e) })'.match(catchKeyword) || []).length, 0,
    '.catch( 不能被计入 catch 分母')
  catchKeyword.lastIndex = 0
  assert.strictEqual(('try { a() } catch (e) { b() }'.match(catchKeyword) || []).length, 1,
    '真正的 catch 块要计入')
})

// ---------------------------------------------------------------------------
// 新增：后端路由测试的样板不许继续扩散
//
// 21 个历史测试文件各自抄了一遍「env 兜底 → 内存库 → 替换 db.js 的 Proxy →
// express.listen(0)」的样板。已抽成 units/_db-express-fixture.cjs：
//   · 第一批：今天新增的 7 个路由测试
//   · 第二批：12 个旧文件（含 seat 系列、dashboard、批量删除等）改用夹具的
//     reset()/call()/多路由挂载
//   · 第三批：4 个 backend-* 数据层校验，靠新加的 faults:true / fx.inject()
//     拿到「第 K 次写抛错」「按 SQL 匹配抛错」的注入能力
//   · 第四批：最后 5 个只 require service 的文件（undo 系列 + 级联删除），
//     只用夹具的 db 部分（fx.reset() / fx.conn，不 mount）
// 基线已归零：往后新写的测试必须走公共夹具，自己再抄一份这里就会红。
// ---------------------------------------------------------------------------
test('[行为] 新增测试不许再抄一遍内存库 + db.js Proxy 样板', () => {
  const unitsDir = path.join(ROOT, 'testjs', 'units')
  const legacy = fs.readdirSync(unitsDir)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => {
      const src = fs.readFileSync(path.join(unitsDir, f), 'utf8')
      return src.includes('require.cache[dbPath].exports') && !src.includes('_db-express-fixture')
    })
    .sort()
  const LEGACY_BASELINE = 0
  assert.ok(legacy.length <= LEGACY_BASELINE,
    `重复样板的测试文件增至 ${legacy.length} 个（基线 ${LEGACY_BASELINE}）：${legacy.join(', ')}；新测试请用 _db-express-fixture.cjs`)
  // 夹具自己也必须在，否则「接了夹具」这句话没有落点
  assert.ok(fs.existsSync(path.join(unitsDir, '_db-express-fixture.cjs')), '公共夹具文件缺失')
})
