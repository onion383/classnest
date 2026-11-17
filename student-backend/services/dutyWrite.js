// =========================================================================
// dutyWrite.js —— 值日域「写」的事务唯一出口
//
// 为什么单独成模块：这 5 个写入口原先各自在 routes/duty.js 里开 db.transaction，
// 于是「哪几张表必须一起成功」这条业务规则散在路由层。事务边界跟着数据操作走
// （services.md §6 第③档），调用方（AI 工具、撤销执行器、批量导入）复用同一份实现，
// 不会各写一份、各漏一个校验。
//
// ⚠️ 唯一不能错的一点：validateRow 必须在事务**里面**。
//   它经 assertDutyRefs → ensureProvisionalStudent 会把名册外的姓名直接建档（写库，
//   有意的副作用 —— 值日格允许存「姓名」这种没身份的形态）。放到事务外时，只要后面
//   任一步失败，值日表回滚了、临时学生却已提交，用户在名册里看到凭空多出来一个人（v6 · N2-06）。
//   better-sqlite3 的嵌套事务走 SAVEPOINT，内层 resolveNames 的事务在这里自动降级。
//   注意 P2-2 之后格子里也可能是学生 id（数字）：assertDutyRefs 只对字符串建档，
//   数字原样跳过 —— 不要再把 id 拿去 resolve，否则会建出一个名叫「16」的临时学生。
//
// 与 routes/duty.js 里保留下来的读路径分工：读（getDoc + unpackMode）仍可留在路由，
// 本模块只负责「一起成功 / 一起失败」的写。
// =========================================================================
const { db } = require('../db')
const store = require('./slotStore')
const { validateRow } = require('./businessRules')
const { packMode, unpackMode } = require('./dutyMode')
const dutyConfig = require('./dutyConfig')
const dutyCycle = require('./dutyCycle')
const { shiftDateStr, mondayOf } = require('../utils/date')

// 全局设置：列名（days）+ 劳动项目（items）+ 可选模式配置（config）同事务。
// 只写一半会出现「列头是组名、项目还是旧列表」的错位状态。
function saveSettings(mode, { days, items, config } = {}) {
  const row = store.getDoc('duty_settings')
  const mergedItems = packMode(row ? row.items : null, mode, items)
  db.transaction(() => {
    dutyConfig.writeDays(mode, days)
    store.setDoc('duty_settings', { items: JSON.stringify(mergedItems) })
    if (config) dutyConfig.writeConfig(mode, config)
  })()
}

// 当前值日表（duty_layout）
function saveLayout(mode, { cells, settings } = {}) {
  db.transaction(() => {
    validateRow('duty_layout', { cells })
    const row = store.getDoc('duty_layout')
    const mergedCells = packMode(row ? row.cells : null, mode, cells)
    const mergedSettings = packMode(row ? row.settings : null, mode, settings || {})
    store.setDoc('duty_layout', {
      cells: JSON.stringify(mergedCells),
      settings: JSON.stringify(mergedSettings),
    })
  })()
}

// 值日模板（duty_template）
function saveTemplate(mode, { cells, settings } = {}) {
  db.transaction(() => {
    validateRow('duty_template', { cells })
    const row = store.getDoc('duty_template')
    const mergedCells = packMode(row ? row.cells : null, mode, cells)
    const mergedSettings = packMode(row ? row.settings : null, mode, settings || {})
    store.setDoc('duty_template', {
      cells: JSON.stringify(mergedCells),
      settings: JSON.stringify(mergedSettings),
    })
  })()
}

// 一次性保存：设置 + 当前表 + 模板。三个请求合成一次提交，省 2 次往返，
// 且不会出现「设置存了但表没存」的错位状态。
// active / master 为可选：只有显式传入（对象，哪怕空对象 {}）时才写对应的表。
function saveAll(mode, { days, items, config, active, master } = {}) {
  db.transaction(() => {
    // 校验在事务内：建档副作用与写入同生共死（见文件头）
    if (active !== undefined) validateRow('duty_layout', { cells: active })
    if (master !== undefined) validateRow('duty_template', { cells: master })

    // ① 全局设置（时间 + 劳动项目）
    const s = store.getDoc('duty_settings')
    const mergedItems = packMode(s ? s.items : null, mode, items)
    dutyConfig.writeDays(mode, days)
    store.setDoc('duty_settings', { items: JSON.stringify(mergedItems) })
    if (config) dutyConfig.writeConfig(mode, config)

    // ② 当前值日表
    if (active !== undefined) {
      const row = store.getDoc('duty_layout')
      const mergedCells = packMode(row ? row.cells : null, mode, active)
      const mergedSettings = packMode(row ? row.settings : null, mode, {})
      store.setDoc('duty_layout', {
        cells: JSON.stringify(mergedCells),
        settings: JSON.stringify(mergedSettings),
      })
    }

    // ③ 值日模板
    if (master !== undefined) {
      const row = store.getDoc('duty_template')
      const mergedCells = packMode(row ? row.cells : null, mode, master)
      const mergedSettings = packMode(row ? row.settings : null, mode, {})
      store.setDoc('duty_template', {
        cells: JSON.stringify(mergedCells),
        settings: JSON.stringify(mergedSettings),
      })
    }
  })()
}

// 历史补齐：从 start 到 upper 逐日补快照，整批要么全成、要么全不成
// （逐日 INSERT 各自提交时中途失败会留下「补了 37 天」这种半截结果）。
// 大扫除只在命中日补 —— 它的「周期 + 星期几」决定发生频率，逐日补会让值日指数
// 永远等于学期天数（对所有人一样）。日常值日维持逐日补。
// start / upper 由调用方按学期范围裁剪后传入；命中日判定在内部（口径单源在本模块）。
// 事务体全是同步调用（没有 await），可以安全放进 better-sqlite3 的同步事务。
function backfillHistory({ mode, start, upper, today, includeToday } = {}) {
  const layout = store.getDoc('duty_layout')
  const layoutPayload = {
    cells: layout ? unpackMode(layout.cells, mode) : {},
    settings: layout ? unpackMode(layout.settings, mode) : {},
  }

  const hitConfig = mode === 'big' ? dutyConfig.readConfig('big') : null
  const baseMonday = mondayOf(start)
  const isHit = (dateStr) => (hitConfig ? dutyCycle.isHitDate(dateStr, hitConfig, baseMonday) : true)

  let inserted = 0
  db.transaction(() => {
    let cur = start
    while (cur <= upper) {
      const isToday = cur === today
      const exists = store.histFind('duty', cur, mode)
      // 大扫除：非命中日一律不补（今天例外：今天是大扫除日就该有记录）
      if (!(isToday && includeToday) && !isHit(cur)) {
        cur = shiftDateStr(cur, 1)
        continue
      }
      if (isToday && includeToday) {
        // 今天：总是覆盖为当前值日表
        if (exists) store.histUpdateByDate('duty', cur, mode, layoutPayload)
        else store.histInsert('duty', { weekStart: mondayOf(cur), snapDate: cur, mode, payload: layoutPayload })
        inserted++
      } else if (!exists) {
        // 过去日期：缺失才补，沿用最近一天该模式的值日表；没有更早快照则用当前值日表
        const src = store.histPrev('duty', cur, mode)
        const payload = src ? { cells: src.payload.cells || {}, settings: src.payload.settings || {} } : layoutPayload
        store.histInsert('duty', { weekStart: mondayOf(cur), snapDate: cur, mode, payload })
        inserted++
      }
      cur = shiftDateStr(cur, 1)
    }
  })()
  return { inserted }
}

module.exports = {
  saveSettings,
  saveLayout,
  saveTemplate,
  saveAll,
  backfillHistory,
}
