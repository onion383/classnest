// =========================================================================
// refresh-virtual-dir-isolation.test.js —— 虚拟相册刷新测试的目录隔离
//
// 根因：refresh-virtual.test.js 原把 DATA_DIR / dbFile 固定在仓库
// testjs/.startup-measure/refresh-virtual，跑完 fs.rmSync(dataDir,{recursive:true})。
// 那个目录虽被 gitignore，但任何人在里面放的产物都会被测试顺手删掉；
// 且外部 DATA_DIR 被继承时，DATA_DIR 与 dbFile 指向两个不同地方，状态分裂。
//
// 判据不是只看源码字符串：在固定仓库目录和外部 DATA_DIR 各放一个哨兵文件，
// 真跑一遍 refresh-virtual.test.js，两个哨兵都必须原封不动。
// =========================================================================
const test = require('node:test')
const { ROOT, abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const SOURCE = abs('testjs/units/storage/refresh-virtual.test.js')
const FIXED_DIR = abs('testjs/.startup-measure/refresh-virtual')

test('源码不再写死仓库目录，数据目录用独占 mkdtemp 并有退出兜底', () => {
  // 扫描前去注释：注释里说明历史路径是合理的，只有真实代码才算"写死"
  const code = fs.readFileSync(SOURCE, 'utf8')
    .split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.ok(!code.includes('.startup-measure'), '源码不许再引用仓库固定目录')
  assert.match(code, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'refresh-virtual-data-'\)\)/, '数据目录必须是独占 mkdtemp')
  assert.match(code, /process\.env\.DATA_DIR = DATA_DIR/, '外部 DATA_DIR 必须被覆盖，不许继承')
  assert.match(code, /process\.on\('exit'[\s\S]{0,160}fs\.rmSync\(DATA_DIR/, '异常退出也要清掉独占目录')
  assert.match(code, /const dataDir = DATA_DIR/, 'dbFile 所在目录必须和 DATA_DIR 同源')
})

test('真实测试跑完：仓库固定目录哨兵与外部 DATA_DIR 哨兵都原封不动', (t) => {
  // 仓库固定目录哨兵（变异态下会被 fs.rmSync(dataDir) 连带删掉）
  fs.mkdirSync(FIXED_DIR, { recursive: true })
  const repoSentinel = path.join(FIXED_DIR, 'SENTINEL-DO-NOT-DELETE')
  fs.writeFileSync(repoSentinel, 'REPO-SENTINEL')
  // 外部 DATA_DIR 哨兵（验证不被继承、不被清）
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'external-rv-data-'))
  const coreDir = path.join(external, 'core')
  fs.mkdirSync(coreDir, { recursive: true })
  const extSentinel = path.join(coreDir, '.jwt-secret')
  fs.writeFileSync(extSentinel, 'EXTERNAL-SENTINEL')
  t.after(() => {
    try { fs.rmSync(repoSentinel, { force: true }) } catch (_) {}
    try { fs.rmSync(FIXED_DIR, { recursive: true, force: true }) } catch (_) {}
    try { fs.rmSync(external, { recursive: true, force: true }) } catch (_) {}
  })

  const childEnv = { ...process.env, DATA_DIR: external }
  delete childEnv.NODE_TEST_CONTEXT // 从 node --test 内 spawn 时必须摘，否则孙进程跳过执行静默返回 0
  const r = spawnSync(process.execPath, [SOURCE], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60000,
  })
  // 用例数从子套件源码动态解析（T07-07）：写死 8 会让「子套件加/减一条隔离测试」
  // 先误红，而这条断言与目录隔离本身无关。
  const expected = (fs.readFileSync(SOURCE, 'utf8').match(/^\s*await test\(/gm) || []).length
  assert.ok(expected > 0, '未能从子套件解析出用例数')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, new RegExp(`通过 ${expected} 项.*全部通过`), `真实测试必须完整跑完 ${expected} 项`)

  assert.ok(fs.existsSync(repoSentinel), '仓库固定目录里的其它产物绝不能被测试删掉')
  assert.equal(fs.readFileSync(repoSentinel, 'utf8'), 'REPO-SENTINEL')
  assert.ok(fs.existsSync(extSentinel), '外部 DATA_DIR 里的文件绝不能被测试删掉')
  assert.equal(fs.readFileSync(extSentinel, 'utf8'), 'EXTERNAL-SENTINEL')
})
