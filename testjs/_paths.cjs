// =========================================================================
// _paths.cjs —— 测试代码的路径服务（唯一定位真源）
//
// 为什么有它：
//   之前 253 个测试文件各自写 `path.resolve(__dirname, '../..')`，写法有 6 种；
//   还有 101 个文件各抄一遍 `const read = (p) => fs.readFileSync(p, 'utf8')`。
//   测试文件一旦分目录（units/seat/…），所有 `'../..'` 都会静默错位一层。
//
// 怎么做到「位置无关」：
//   ROOT 不按层级推算，而是**从本文件所在目录向上找**「同时含
//   student-frontend 与 student-backend 的那一层」。所以本文件自己挪窝、
//   引用它的测试文件挪窝，ROOT 都不会变。
//
// 用法（参数一律是**相对项目根**的路径，因此不受调用方位置影响）：
//   const { ROOT, FE, BE, read, abs } = require('#testjs/paths')
//   const src = read('student-frontend/src/views/SeatView.vue')   // 读文本
//   const p   = abs('student-backend/routes/seat.js')             // 绝对路径
//   backendRequire(abs('student-backend/services/aiStore.js'))    // 交给 require
//
// 关于 `#testjs/paths`：根 package.json 里有
//   "imports": { "#testjs/paths": "./testjs/_paths.cjs" }
// 所以测试文件**在任何子目录**都用同一行 require，不会因为分目录而崩。
// 这是 Node 官方的包内别名，CJS 的 require() 直接可用。
//
// ⚠️ 不要再用 `path.join(__dirname, '../..')`：那正是本文件要消灭的写法。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')

function findRoot(start) {
  let d = start
  for (;;) {
    if (fs.existsSync(path.join(d, 'student-frontend')) && fs.existsSync(path.join(d, 'student-backend'))) {
      return d
    }
    const up = path.dirname(d)
    if (up === d) throw new Error('_paths.cjs：向上找不到项目根（需要同时含 student-frontend 与 student-backend 的目录）')
    d = up
  }
}

const ROOT = findRoot(__dirname)
const FE = path.join(ROOT, 'student-frontend')
const FE_SRC = path.join(FE, 'src')
const BE = path.join(ROOT, 'student-backend')
const EL = path.join(ROOT, 'electron')
const TESTJS = path.join(ROOT, 'testjs')

/** 读源码文本。rel 是相对项目根的路径。 */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** 拼绝对路径，参数相对项目根，可多段。取名 abs 而非 at：`at` 常被局部用作索引变量。 */
const abs = (...parts) => path.join(ROOT, ...parts)

/** 相对项目根的路径存在吗。 */
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

module.exports = { ROOT, FE, FE_SRC, BE, EL, TESTJS, read, abs, exists }
