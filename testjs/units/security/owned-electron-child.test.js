// =========================================================================
// owned-electron-child.test.js —— 性能探针退出时必须关掉自己启动的 Electron
//
// 根因：三个探针（inp-probe / mode-probe / vapor-bench）把新 spawn 的 Electron
// 存在 ensureRunner 局部变量里，只在 one-shot 成功路径 killTree；Ctrl+C / SIGTERM /
// 异常 catch 只停 Vite，Electron 连同 renderer/GPU/backend 后代残留，占着单实例锁。
// 且探针可能复用外部已启动实例，那种绝不能杀。
// 修法：共享 ownedChild 工具登记「本进程 spawn 的」child，幂等 stop，所有退出路径都调。
//
// 判据：
//   1. 真跑 ownedChild：adopt(null) 不登记；adopt(child) 后 stop 只杀一次；重复 stop 无害。
//   2. 扫三个探针源码：spawn 后必须 adopt；one-shot / catch / 信号 / exit 各路径必须 stop；
//      不许再出现裸 killTree(child)（会漏掉复用实例保护与幂等）。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { createOwnedChild } = require(abs('testjs/tools/ownedChild.cjs'))

test('复用外部实例（adopt null）不登记，stop 不误杀', () => {
  let killed = 0
  const owned = createOwnedChild({ killTree: () => { killed++ } })
  owned.adopt(null)
  owned.adopt(undefined)
  assert.equal(owned.hasOwned(), false)
  owned.stop()
  owned.stop()
  assert.equal(killed, 0, '借用的实例一个都不能杀')
})

test('本进程启动的 child：stop 幂等，只杀一次', () => {
  let killed = 0
  const killedChildren = []
  const owned = createOwnedChild({ killTree: (c) => { killed++; killedChildren.push(c) } })
  const child = { pid: 12345 }
  owned.adopt(child)
  assert.equal(owned.hasOwned(), true)
  owned.stop()
  owned.stop()
  owned.stop()
  assert.equal(killed, 1, '幂等：三次 stop 只杀一次')
  assert.strictEqual(killedChildren[0], child)
  assert.equal(owned.hasOwned(), false)
  // stop 后再 adopt 新的，仍能正常登记与清理
  const child2 = { pid: 999 }
  owned.adopt(child2)
  owned.stop()
  assert.equal(killed, 2)
  assert.strictEqual(killedChildren[1], child2)
})

test('killTree 抛异常不冒泡到清理路径', () => {
  const owned = createOwnedChild({ killTree: () => { throw new Error('taskkill 失败') } })
  owned.adopt({ pid: 1 })
  assert.doesNotThrow(() => owned.stop(), '清理路径抛异常会掩盖真正的错误')
  assert.equal(owned.hasOwned(), false, '即使杀失败也要清句柄，避免重复触发')
})

const PROBES = [
  { file: 'testjs/probe/inp-probe.mjs', label: 'inp' },
  { file: 'testjs/probe/mode-probe.mjs', label: 'mode' },
  { file: 'testjs/tools/vapor-bench.mjs', label: 'bench' },
]

for (const { file, label } of PROBES) {
  test(`${label} 探针：spawn 后登记，所有退出路径都幂等停止`, () => {
    const code = fs.readFileSync(abs(file), 'utf8')
    // 引入共享工具并创建 owned 句柄。相对路径取决于脚本自身所在目录：
    // tools/ 下的用 './ownedChild.cjs'，probe/ 下的用 '../tools/ownedChild.cjs'。
    const ownedPath = file.startsWith('testjs/tools/') ? './ownedChild.cjs' : '../tools/ownedChild.cjs'
    assert.ok(code.includes(`require('${ownedPath}')`), `${file} 必须引入共享工具（应为 require('${ownedPath}')）`)
    assert.match(code, new RegExp(`createOwnedChild\\(\\{ killTree, label: '${label}' \\}\\)`), `${file} 必须建立 owned 句柄`)
    // spawn 后登记（adopt 在 Electron spawn 附近）
    assert.ok(code.includes('ownedElectron.adopt(child)'), `${file} 必须登记本进程启动的 child`)
    // 不能再有裸 killTree(child)：它绕过了「复用不误杀 + 幂等」
    assert.ok(!/killTree\(child\)/.test(code), `${file} 不许再直接 killTree(child)`)
    // 逐条退出路径核验，不能用 stop 总数 —— 少接一条但别处多一处就会假绿。
    // 钩子有两种写法：行内直接 stop，或委托给本文件里带 stop 的具名函数（inp 的 kill）。
    function handlerStops(evt) {
      const m = code.match(new RegExp(`^.*process\\.on\\('${evt}'[^\\n]*$`, 'm'))
      if (!m) return false
      const line = m[0]
      if (/ownedElectron\.stop\(\)/.test(line)) return true
      const fn = line.match(/process\.on\('[^']+',\s*(\w+)\s*\)/)
      if (!fn) return false
      // 具名处理函数（含 `const kill = () => {...}`）：取定义后 400 字符看有没有 stop
      const at = code.search(new RegExp(`(?:function\\s+${fn[1]}\\s*\\(|const\\s+${fn[1]}\\s*=)`))
      if (at < 0) return false
      return /ownedElectron\.stop\(\)/.test(code.slice(at, at + 400))
    }
    for (const evt of ['SIGINT', 'SIGTERM', 'exit']) {
      assert.ok(handlerStops(evt), `${file} 的 ${evt} 钩子必须停 Electron（行内或委托函数）`)
    }
    const catchLine = code.match(/^.*main\(\)\.catch[^\n]*$/m)
    assert.ok(catchLine, `${file} 必须有异常 catch`)
    // vapor 的 stop 在 catch 块下一行（多行写法）
    const catchBlock = code.slice(code.indexOf('main().catch'), code.indexOf('main().catch') + 250)
    assert.match(catchBlock, /ownedElectron\.stop\(\)/, `${file} 的 catch 必须停 Electron`)
    // 主流程末尾的 process.exit(0)（one-shot）前必须 stop，不限定是否包在 if 里：
    // inp/mode 是 env 条件块，vapor 是测完直接退出。
    const exitAt = code.indexOf('process.exit(0)')
    assert.ok(exitAt >= 0, `${file} 必须有 one-shot 退出点`)
    const before = code.slice(Math.max(0, exitAt - 300), exitAt)
    assert.match(before, /ownedElectron\.stop\(\)/, `${file} 的 one-shot 退出前必须停 Electron`)
  })
}
