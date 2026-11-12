// =========================================================================
// cryptoStat.js —— 安全通道加解密分段计时（v6 性能专题 · 0-3）
//
// 只做一件事：把一个收集器与一个名字包成「结束时追加一条耗时/字节数」的函数。
//   · 没有收集器（普通请求、子窗口、后台刷新）时返回空操作，零开销；
//   · 收集器由 perfMark.createPhaseLog 创建，最终随首屏一条汇总输出；
//   · 写入失败静默 —— 打点绝不能影响请求。
//
// 为什么单独成模块：encryptAuthProof / encryptBody / decryptBody 都不该知道
// axios config 长什么样，只接收一个 log 对象即可，便于单测与复用。
// =========================================================================

import { perfNow } from './perfMark.js'

// 返回 end(bytes?)：只允许结算一次，防止异常路径重复 end 产生两条记录
export function startCryptoStat(log, name) {
  // 收集器可能来自调用方对象，取 phases 本身也要兜住（例如属性 getter 抛错）
  let phases = null
  try { phases = log && Array.isArray(log.phases) ? log.phases : null } catch (_) { phases = null }
  if (!phases) return () => {}
  const t0 = perfNow()
  let done = false
  return (bytes) => {
    if (done) return
    done = true
    try {
      const size = Number.isFinite(bytes) ? `/${bytes}B` : ''
      phases.push(`${name} ${perfNow() - t0}ms${size}`)
    } catch (_) { /* 打点失败静默 */ }
  }
}
