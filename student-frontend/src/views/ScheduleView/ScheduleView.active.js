// ===== 课程表：实行课表加载/保存、行列与单元格交互、设置 =====
// 纯代码搬运自 ScheduleView.vue 的 methods，未改写逻辑；经 ctx 闭包调用（script setup）。
import { reportError } from '../../utils/reportError.js'
import axios from 'axios'
import { recordGridSnapshotUndo } from '../../composables/useUndo.js'
import { createSerialSaver } from '../../utils/serialSaver.js'
import { getSemesterStart, invalidateSemesterStart } from '../../utils/semesterStart.js'

export function useScheduleActive(ctx, { API_BASE }) {
  return {
    // ============= 实行课表操作 =============
    async refreshActive() {
      try {
        await ctx.loadActive()
        if (ctx._activeLoadOk.value) ctx.notifySuccess('已刷新实行课表')
      } catch (e) { /* 错误已在 loadActive 内部处理 */ }
    },
    async loadActive() {
      ctx._activeInFlight = (ctx._activeInFlight || 0) + 1;
      try {
        const res = await axios.get(`${API_BASE}/schedule`);
        const { cells, settings } = res.data;
        ctx.activeCells.value = Array.isArray(cells) ? cells : [];
        if (settings && (settings.sections || settings.periods)) {
          ctx.activeSettings.value = {
            sections: settings.sections || null,
            periods: settings.periods || [],
            days: settings.days || ctx.activeColHeaders.value
          };
          ctx.activeColHeaders.value = ctx.activeSettings.value.days;
        } else {
          // 首次进入不预置作息时间：保持空 sections，等用户在「设置」里添加并保存。
          ctx.activeSettings.value = {
            sections: null,
            periods: [],
            days: ctx.activeColHeaders.value
          };
          ctx.activeColHeaders.value = ctx.activeSettings.value.days;
        }
        ctx.activeCells.value = ctx.adjustCells(ctx.activeCells.value, ctx.activeSettings.value);

        // 加载学期开始日期（单独兜底：失败不影响课表本身的加载判定）
        try {
          ctx.semesterStart.value = await getSemesterStart();
        } catch (e) { console.error(e); }

        ctx._activeLoadOk.value = true;
        ctx.activeError.value = false;
      } catch (e) {
        // 加载失败不再静默：留标记供重进页面时补拉，并给出提示。
        // activeError 是给表格组件的「加载失败态」用的 —— 失败要显示告警 + 重试，
        // 而不是让用户对着一张空表以为数据丢了。
        ctx._activeLoadOk.value = false;
        ctx.activeError.value = true;
        ctx.notifyError('实行课表加载失败，请稍后重试');
        console.error(e);
      } finally {
        ctx._activeInFlight = (ctx._activeInFlight || 1) - 1;
      }
    },
    async saveActive() {
      // 串行保存：连续编辑时不再并发 PUT（并发下先发后到会用旧数据覆盖新数据），
      // 在途期间的多次修改合并为一次「读最新状态再存」；失败时提示一次，成功后复位。
      if (!ctx._activeSaver) {
        ctx._activeSaver = createSerialSaver(() => axios.put(`${API_BASE}/schedule`, {
          cells: ctx.activeCells.value,
          settings: ctx.activeSettings.value
        }))
      }
      const ok = await ctx._activeSaver.request()
      if (!ok) {
        if (!ctx._activeSaveErrorShown) {
          ctx._activeSaveErrorShown = true
          ctx.notifyError('课表保存失败，改动可能未保存，请稍后重试')
          console.error('[schedule] 保存失败', ctx._activeSaver.error)
        }
      } else {
        ctx._activeSaveErrorShown = false
      }
      return ok
    },
    onActiveCellsUpdate(newRows) {
      const prev = ctx.activeCells.value.map(r => [...r]);
      const newCells = [];
      newRows.forEach(row => {
        if (row._lessonIdx !== undefined) newCells[row._lessonIdx] = row.cells;
      });
      let lessonCount = 0;
      const sections = ctx.activeSettings.value.sections;
      if (sections) {
        ['morning', 'noon', 'afternoon', 'evening', 'night'].forEach(key => {
          lessonCount += (sections[key] || []).filter(i => i.type === 'lesson').length;
        });
      }
      for (let i = 0; i < lessonCount; i++) {
        if (!newCells[i]) newCells[i] = Array(ctx.activeColHeaders.value.length).fill({ course: '' });
      }
      ctx.activeCells.value = newCells;
      ctx.activeCells.value = ctx.adjustCells(ctx.activeCells.value, ctx.activeSettings.value);
      ctx.recordCellsDiff('schedule', prev, ctx.activeCells.value);
      ctx.saveActive();
    },
    async onActiveSwapRows(fromIdx, toIdx) {
      // 索引必须落在**显示行**数组上：fromIdx/toIdx 来自 GridView 的 rows 下标
      // （含大课间/午休/休息这些合并行）。早先这里先 filter 再取下标，
      // 一旦拖动跨越休息行就会整体错位一格、甚至取到 undefined 直接 return。
      const all = (ctx.activeDisplayRows && ctx.activeDisplayRows.value) || [];
      const fromRow = all[fromIdx], toRow = all[toIdx];
      if (!fromRow || !toRow) return;
      if (fromRow._isReadonly || toRow._isReadonly || fromRow._mergeCells || toRow._mergeCells) return;
      const fromLessonIdx = fromRow._lessonIdx, toLessonIdx = toRow._lessonIdx;
      // 讲台行 / 分隔行既不是 readonly 也不是 mergeCells，必须靠 _lessonIdx 兜住，
      // 否则 splice(undefined, 1) 会删掉第 0 行、把 cells 结构弄坏
      if (fromLessonIdx === undefined || toLessonIdx === undefined) return;
      // 越界防御：内存里的 cells 若已被上一轮异常改动压短，splice 会写出 holes，
      // 后端遍历时就会抛 "reading 'N'"。宁可这次不生效，也不能再往库里写坏数据。
      const srcCells = ctx.activeCells.value;
      if (!Array.isArray(srcCells) || fromLessonIdx < 0 || fromLessonIdx >= srcCells.length) return;
      const prev = JSON.parse(JSON.stringify(ctx.activeCells.value));
      // 移动语义：与拖动时的让位预览一致（取出源行插入目标位置，中间行顺移）
      const newCells = [...ctx.activeCells.value];
      const [movedRow] = newCells.splice(fromLessonIdx, 1);
      newCells.splice(toLessonIdx, 0, movedRow);
      ctx.activeCells.value = newCells;
      // 先存后登记：串行保存器失败只返回 false 不抛，忽略返回值就会变成
      // 「界面换了、库里没换」，撤销栈里还多一条 new 值从未落库的记录。
      const ok = await ctx.saveActive();
      if (!ok) {
        // 只回滚自己这次的结果：若期间用户又改过（activeCells 已被换成新数组），
        // 不能把后面的编辑一起冲掉。
        if (ctx.activeCells.value === newCells) ctx.activeCells.value = prev;
        return;
      }
      recordGridSnapshotUndo('课程表', 'schedule', prev, JSON.parse(JSON.stringify(newCells)), `交换行：${fromRow.label} ↔ ${toRow.label}`);
    },
    async onActiveSwapColumns(fromIdx, toIdx) {
      if (fromIdx === toIdx) return;
      const fromHeader = ctx.activeColHeaders.value[fromIdx] ?? `列${fromIdx + 1}`, toHeader = ctx.activeColHeaders.value[toIdx] ?? `列${toIdx + 1}`;
      const prev = JSON.parse(JSON.stringify(ctx.activeCells.value));
      // 移动语义：取出源列插入目标位置，中间列的数据顺移（表头固定）
      // 先按列数把每行补齐/截齐：行长短不一时 splice 会产出 undefined 单元格，
      // 渲染与保存链路随后就会崩在 "reading '0'" 这类下标访问上。
      const cols = ctx.activeColHeaders.value.length;
      const newCells = ctx.activeCells.value.map(row => {
        const r = Array.isArray(row) ? [...row] : [];
        while (r.length < cols) r.push({ course: '' });
        while (r.length > cols) r.pop();
        const [m] = r.splice(fromIdx, 1);
        r.splice(toIdx, 0, m || { course: '' });
        return r;
      });
      ctx.activeCells.value = newCells;
      // 口径同交换行：保存成功才算这次交换成立
      const ok = await ctx.saveActive();
      if (!ok) {
        if (ctx.activeCells.value === newCells) ctx.activeCells.value = prev;
        return;
      }
      recordGridSnapshotUndo('课程表', 'schedule', prev, JSON.parse(JSON.stringify(newCells)), `交换列：${fromHeader} ↔ ${toHeader}`);
    },
    onActiveRowMeta({ rowIdx, field, value }) {
      const sections = JSON.parse(JSON.stringify(ctx.activeSettings.value.sections));
      const flat = [];
      ['morning', 'noon', 'afternoon', 'evening', 'night'].forEach(key => {
        (sections[key] || []).forEach(item => flat.push({ section: key, item }));
      });
      if (rowIdx < flat.length) {
        const target = flat[rowIdx].item;
        if (field === 'label') target.name = value;
        else if (field === 'time') {
          const parts = value.split('-');
          if (parts.length === 2) {
            target.start = parts[0].trim();
            target.end = parts[1].trim();
          }
        }
        ctx.activeSettings.value.sections = sections;
        ctx.saveActive();
      }
    },
    async saveActiveSettings(settings) {
      const prev = {
        settings: ctx.activeSettings.value,
        headers: ctx.activeColHeaders.value,
        // adjustCells 可能原地改写行/列，回滚必须用快照而不是引用
        cells: JSON.parse(JSON.stringify(ctx.activeCells.value)),
        semesterStart: ctx.semesterStart.value
      };
      ctx.activeSettings.value = {
        sections: settings.sections,
        periods: settings.periods,
        days: settings.days
      };
      ctx.activeColHeaders.value = settings.days;
      ctx.activeSettingsVisible.value = false;
      ctx.activeCells.value = ctx.adjustCells(ctx.activeCells.value, ctx.activeSettings.value);

      // 保存学期开始日期。设置已在上面写到本地，失败时必须回滚，
      // 否则界面显示「已保存」但刷新后又变回旧值。
      try {
        await axios.put(`${API_BASE}/schedule/settings`, {
          semester_start: ctx.semesterStart.value
        });
        // 学期改了：值日/座位那边缓存的开学日必须失效，否则它们的指数还会按旧开学日算
        invalidateSemesterStart();
        await ctx.saveActive();
      } catch (err) {
        ctx.activeSettings.value = prev.settings;
        ctx.activeColHeaders.value = prev.headers;
        ctx.activeCells.value = prev.cells;
        ctx.semesterStart.value = prev.semesterStart;
        reportError(err, { action: '学期设置保存' });
        console.error('[schedule] 保存学期设置失败', err);
      }
    }
  }
}
