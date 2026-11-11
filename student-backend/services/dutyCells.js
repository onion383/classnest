// =========================================================================
// dutyCells.js —— 值日表 cells 的结构遍历（纯函数，不依赖数据库）
//
// 值日 cells 统一存「按模式分键」的结构：{ daily: { 项目: {...} }, big: { 项目: {...} } }。
//
// 本模块把「按模式取根节点」这件事收敛到一处，删除学生的关联统计/清理与改名级联共用。
// =========================================================================

const { MODES: DUTY_MODES } = require('./dutyMode');

// 返回各模式的「根节点列表」（项目 → 星期 → 姓名数组）；畸形模式值直接跳过
function dutyRoots(cells) {
  if (!cells || typeof cells !== 'object' || Array.isArray(cells)) return [];
  return DUTY_MODES
    .map((m) => cells[m])
    .filter((root) => root && typeof root === 'object' && !Array.isArray(root));
}

// 统计某个姓名在值日表里出现的次数（daily 与 big 都算）
//
// 匹配口径：**trim 后比较**（与 renameDutyName 一致）。值日 cells 是手工录入的 JSON，
// 写入路径只查类型、不 trim，库里可能存在 ' 张三 ' 这种带空格的旧名 ——
// 用严格 `===` 时删学生会漏删这格，删完人还在值日表里挂着，值日指数归不到任何人名下。
function countDutyRefs(cells, name) {
  if (!name) return 0;
  let count = 0;
  for (const root of dutyRoots(cells)) {
    for (const item of Object.keys(root)) {
      const byDay = root[item];
      if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) continue;
      for (const day of Object.keys(byDay)) {
        const list = byDay[day];
        if (Array.isArray(list)) {
          count += list.filter((v) => typeof v === 'string' && v.trim() === name).length;
        }
      }
    }
  }
  return count;
}

// 收集某个姓名在值日表里的**全部位置**：[{ mode, item, day, index, value }]。
// 供「删除学生」在清理前做精确定位快照：撤销时只把这些位置放回去，
// 而不是整块覆盖 cells —— 整块覆盖会把删除之后用户对值日表的其它改动一并抹掉。
// 匹配口径与 countDutyRefs / removeDutyName 一致：trim 后比较。
function collectDutyRefs(cells, name) {
  const hits = [];
  if (!name || !cells || typeof cells !== 'object' || Array.isArray(cells)) return hits;
  for (const mode of DUTY_MODES) {
    const root = cells[mode];
    if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
    for (const item of Object.keys(root)) {
      const byDay = root[item];
      if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) continue;
      for (const day of Object.keys(byDay)) {
        const list = byDay[day];
        if (!Array.isArray(list)) continue;
        for (let i = 0; i < list.length; i++) {
          if (typeof list[i] === 'string' && list[i].trim() === name) {
            hits.push({ mode, item, day, index: i, value: list[i] });
          }
        }
      }
    }
  }
  return hits;
}

// 从值日表里移除某个姓名（就地修改 cells），返回移除数量
// 匹配口径同样是 trim 后比较（与 countDutyRefs / renameDutyName 保持一致）。
// 实现改为复用 collectDutyRefs：位置快照与真正删除必须用**同一份**匹配逻辑，
// 否则「记下的位置」和「清掉的位置」会分叉，撤销就放不回原处。
function removeDutyName(cells, name) {
  const hits = collectDutyRefs(cells, name);
  if (!hits.length) return 0;
  // 同一天从后往前删，避免删前面元素时后面的索引整体位移
  const groups = new Map();
  for (const h of hits) {
    const key = `${h.mode}\u0000${h.item}\u0000${h.day}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h.index);
  }
  for (const [key, idxs] of groups) {
    const [mode, item, day] = key.split('\u0000');
    const list = cells[mode][item][day];
    for (const i of idxs.sort((a, b) => b - a)) list.splice(i, 1);
  }
  return hits.length;
}

// 把值日表里的 oldName 改成 newName（学生改名时级联）
//
// 匹配口径：**trim 后比较**。值日 cells 是用户手工录入的名单，历史上可能带首尾空格
// （' 张三 '）。用严格 `===` 比对时，这些格子在改名后不会被改 —— 同一学生在值日表
// 仍叫旧名、在座位表已叫新名，历史值日指数再也归不到他名下，且界面不报任何错。
//
// 写回一律写**规范名**（newName，调用方已 trim 过）：下游 DutyView 的 acc[name] 是
// 精确键聚合，保留原空格会让统计键分裂成 '李四' 和 ' 李四 ' 两个桶。
function renameDutyName(cells, oldName, newName) {
  if (!oldName || !newName || oldName === newName) return 0;
  let changed = 0;
  for (const root of dutyRoots(cells)) {
    for (const item of Object.keys(root)) {
      const byDay = root[item];
      if (!byDay || typeof byDay !== 'object' || Array.isArray(byDay)) continue;
      for (const day of Object.keys(byDay)) {
        const list = byDay[day];
        if (!Array.isArray(list)) continue;
        for (let i = 0; i < list.length; i++) {
          if (typeof list[i] === 'string' && list[i].trim() === oldName) {
            list[i] = newName; changed++;
          }
        }
      }
    }
  }
  return changed;
}

module.exports = { DUTY_MODES, dutyRoots, countDutyRefs, collectDutyRefs, removeDutyName, renameDutyName };
