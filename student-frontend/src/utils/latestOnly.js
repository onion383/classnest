// =========================================================================
// latestOnly.js —— 「只认最后一次请求」的守卫（全库唯一实现）
//
// 为什么要有它：
//   同一类 bug 在审查里出现了十几次，写法都是「发请求 → await → 直接写 ref」：
//     · DutyView.loadActive/loadMaster：快速切模式，旧响应覆盖新表
//     · AlbumPhotoPickerDialog.load：换相册/快速重开，旧相册覆盖当前列表
//     · ScheduleView.history：快速切周，旧周快照覆盖新周
//     · AiRecordTable.load：连续打开不同记录，旧记录覆盖新记录
//     · useTableCRUD.fetchRows：连续刷新，旧表覆盖新表
//   它们的共同点不是「忘了 try/catch」，而是**异步结果回来时假定世界没变**。
//   逐个手写 `let seq = 0; const my = ++seq; ... if (my !== seq) return` 容易漏、
//   也容易把守卫写反（用 `>` 或忘了 ++），所以抽成一个小物件。
//
// ⚠️ 本文件是**唯一**实现。早先还有一份 `composables/useSeq.js`（API 叫
// `take()` / `isLatest()`），语义完全相同 —— 两份近似的封装并存，新代码挑哪个
// 全凭记忆，漏守卫就无从察觉。已于 2026-11-04 合并到本文件，旧文件删除。
//    · 合并后 API：`take()` → `begin()`、`isLatest(n)` → `isCurrent(n)`
//    · `current()`（读当前号但不递增）从 useSeq 搬了过来：
//      用于「同一次操作的两阶段」（如先选文件取号、读盘完成后再解析，两步属同一次操作）
//
// 用法（四条约定，缺一条就会漏）：
//   const latest = createLatest()
//
//   async function load() {
//     const token = latest.begin()            // ① 发请求前取号
//     loading.value = true
//     try {
//       const data = await fetchSomething()
//       if (!latest.isCurrent(token)) return   // ② await 之后、写状态之前必须判断
//       list.value = data
//     } catch (e) {
//       if (!latest.isCurrent(token)) return   // ③ catch 里也要判断：
//       notifyError(e)                         //    否则旧请求的失败会盖掉新请求的成功
//     } finally {
//       if (latest.isCurrent(token)) loading.value = false  // ④ 只让最新请求收尾
//     }
//   }
//
// 注意：
//   · 守卫只能保护「写入」，不能取消网络请求。真要省流量再叠 AbortController。
//   · **别把 token 存进响应式状态**：那会让守卫自己变成副作用源。
//   · 守卫实例不要放进响应式对象（它是普通闭包对象，放进 ref 会被无谓地深度代理）。
// =========================================================================

export function createLatest() {
  // 序号存闭包普通变量而非 ref：不参与渲染，做成响应式只会带来无谓的依赖收集
  let seq = 0
  return {
    // 发起一次新请求：返回本次的令牌，同时让此前所有在途请求失效
    begin() {
      seq += 1
      return seq
    },
    // 读当前号但不递增：用于「同一次操作的两阶段」
    current() {
      return seq
    },
    // 这次令牌是否仍是最新的（唯一允许写状态的判断）
    isCurrent(token) {
      return token === seq
    },
    // 让所有在途请求失效（卸载/切用户时用）
    invalidate() {
      seq += 1
    },
  }
}
