// =========================================================================
// GridView.drag.js —— GridView 的行/列拖拽、落点高亮框与虚影（方法模块）
//
// 逐字搬运自 GridView.vue 的 methods，未改写任何逻辑与注释；
// 方法体内部经 ctx 闭包调用（script setup）：状态为 ref（.value 访问），组件根节点取 ctx.gridContainer.value（模板 ref）。
// =========================================================================

import { applyRowShift, applyColShift, clearShift, createEdgeAutoScroll, computeColReorder, computeRowReorder } from '../../../composables/tableDragFx';

import { nextTick } from 'vue'

export function useGridViewDrag(ctx) {
  return {

    // ==================== 拖拽落点高亮框 ====================
    // 整层包住目标行/列的蓝色边框（不用 border 直接改单元格，避免撑动列宽/行高）
    createDropBox() {
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;display:none;box-sizing:border-box;will-change:transform;border:2px solid var(--color-info, #2563eb);border-radius:4px;';
      document.body.appendChild(box);
      return box;
    },
    // rect: {left, top, right, bottom}（视口坐标）；container 内裁剪，避免滚动时溢出表格范围
    updateDropBox(box, rect, container) {
      if (!box) return;
      if (!rect) { box.style.display = 'none'; return; }
      let { left, top, right, bottom } = rect;
      if (container) {
        const c = container.getBoundingClientRect();
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
      const w = right - left, h = bottom - top;
      if (w <= 0 || h <= 0) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      box.style.transform = `translate(${left}px, ${top}px)`;
      box.style.width = w + 'px';
      box.style.height = h + 'px';
    },
    // 拖拽开始时一次性缓存各行与容器的几何信息，拖动过程中纯计算，避免每帧 O(n) 布局读取
    _cacheRowGeom() {
      const trs = ctx.gridContainer.value ? ctx.gridContainer.value.querySelectorAll('tbody tr') : [];
      const arr = [];
      for (let i = 0; i < trs.length; i++) {
        const r = trs[i].getBoundingClientRect();
        // fixed = 不能作为落点的行（课表大课间/午休/休息、讲台、分隔行）。
        // 它们仍参与让位的「连续铺开」（否则可让位行会撞上它们），只是不能当落点。
        arr.push({
          left: r.left, top: r.top, right: r.right, bottom: r.bottom,
          fixed: !ctx.isRowDropTarget(ctx.rows.value[i]),
          // 时段分组（课表用）：让位不跨段，避免拆散跨行合并块
          section: ctx.rows.value[i] ? ctx.rows.value[i]._section : undefined,
        });
      }
      ctx._rowGeom = arr;
      const c = ctx.gridTable.value;
      ctx._rowGeomContainer = c ? c.getBoundingClientRect() : null;
    },
    // 列拖拽几何缓存：按下时一次性量出各数据列的左右边界、表头行 top、表底 bottom 与容器 rect，
    // 拖动过程中纯数值比较，避免每帧 O(n) getBoundingClientRect 触发布局（INP 优化）
    _cacheColGeom() {
      const ths = ctx.colHeaderEls();
      const off = ctx.colThOffset();
      const arr = [];
      for (let i = 0; i < ths.length; i++) {
        const colIdx = i - off;
        if (colIdx < 0) continue; // 元数据列（时段/节次/时间/行号）不参与落点
        const col = ctx.colHeaders.value[colIdx];
        if (col === undefined) { arr[colIdx] = null; continue; }
        const r = ths[i].getBoundingClientRect();
        // 走廊列（同桌模式下的间隔列）不是落点目标，但它的几何要参与「逐列补偿」，
        // 否则跨越走廊拖动时相邻列会让错位置。
        arr[colIdx] = { left: r.left, right: r.right, aisle: col === '走廊' };
      }
      ctx._colGeom = arr;
      ctx._colGeomHeaderTop = ths.length ? ths[0].parentElement.getBoundingClientRect().top : null;
      // 数据区顶端（表头下沿）：列虚影按这个位置对齐，表头不投影
      ctx._colGeomDataTop = ths.length ? ths[0].parentElement.getBoundingClientRect().bottom : null;
      const tbl = ctx.gridContainer.value ? ctx.gridContainer.value.querySelector('table') : null;
      ctx._colGeomTblBottom = tbl ? tbl.getBoundingClientRect().bottom : null;
      const c = ctx.gridTable.value;
      ctx._colGeomContainer = c ? c.getBoundingClientRect() : null;
    },
    // 复制一份跟手虚影作为「落点虚影」：更淡、无阴影、初始隐藏，
    // 位置由 update*DropBox 贴在目标格上。两个虚影同时存在：手上跟手，落点提示位置。
    _cloneGhostForSlot(src, opacity) {
      if (!src) return null;
      const el = src.cloneNode(true);
      el.style.opacity = String(opacity);
      el.style.boxShadow = 'none';
      el.style.display = 'none';
      el.style.zIndex = '99997';
      document.body.appendChild(el);
      return el;
    },
    updateRowDropBox() {
      const box = ctx._rowDropBox;
      if (!box) return;
      const hide = () => {
        box.style.display = 'none';
        if (ctx._rowSlotGhost) ctx._rowSlotGhost.style.display = 'none';
        ctx._rowDropSig = null;
      };
      const geom = ctx._rowGeom;
      const overIdx = ctx.rowDragOverIdx.value;
      const g = (geom && overIdx !== null) ? geom[overIdx] : null;
      if (!g) { hide(); return; }
      // 落点还在源行（未发生位移）时也画框：槽就是源行原位，大小 = 源行自身高度。
      let { left, top, right, bottom } = g;
      // 蓝框画「让位之后真正空出来的槽」，大小 = 被拖行的高度（不是目标行的高度）。
      // 位置直接取**块内连续重排**算出的落点 top（与被拖行最终落位一致）：
      // 区间里夹着固定行（课表休息行/讲台）时，块底/块顶那种算法会偏 —— 固定行不腾位，
      // 槽并不在目标行的边上。只有在拿不到 nextTop 时才退回「向下开块底、向上开块顶」。
      const fromIdx = ctx.rowDragIdx.value;
      const sameSlot = fromIdx !== null && fromIdx === overIdx;
      if (fromIdx !== null && fromIdx !== overIdx) {
        const srcGeom = geom[fromIdx] || null;
        const hFrom = srcGeom
          ? Math.round(srcGeom.bottom - srcGeom.top)
          : Math.round(bottom - top);
        const reorder = computeRowReorder(geom, fromIdx, overIdx);
        const slotTop = reorder.nextTop.get(fromIdx);
        if (slotTop != null) {
          top = slotTop;
          bottom = slotTop + hFrom;
        } else if (fromIdx < overIdx) {
          // 兜底：向下拖，槽开在块底（目标行原位置下部）
          bottom = g.bottom;
          top = g.bottom - hFrom;
        } else {
          // 兜底：向上拖，槽开在块顶（不是源行原位，否则拖到第一行时框会跑到下面去）
          top = g.top;
          bottom = g.top + hFrom;
        }
      }
      const c = ctx._rowGeomContainer;
      if (c) {
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
      const w = right - left, h = bottom - top;
      if (w <= 0 || h <= 0) { hide(); return; }
      // 每帧都会走到这里；几何没变就别再写样式
      const sig = `${left}|${top}|${w}|${h}`;
      if (ctx._rowDropSig === sig) return;
      ctx._rowDropSig = sig;
      // 落点虚影延迟到「确实要显示」时才克隆（避免按下瞬间多克隆一份整表）
      if (!ctx._rowSlotGhost && ctx._rowGhost) {
        ctx._rowSlotGhost = ctx._cloneGhostForSlot(ctx._rowGhost, 0.22);
      }
      const ghost = ctx._rowSlotGhost;
      box.style.display = 'block';
      box.style.transform = `translate(${left}px, ${top}px)`;
      box.style.width = w + 'px';
      box.style.height = h + 'px';
      // 落点虚影：被拖行的半透明副本固定在落点上（不跟随鼠标）
      // 落在源行自身时只画框、不贴虚影：虚影就是源行的副本，叠上去只是加深一层重影。
      if (ghost && sameSlot) {
        ghost.style.display = 'none';
      } else if (ghost) {
        ghost.style.display = 'block';
        ghost.style.transform = `translate(${left}px, ${top}px)`;
        ghost.style.width = w + 'px';
        ghost.style.height = h + 'px';
      }
    },
    updateColDropBox() {
      const box = ctx._colDropBox;
      if (!box) return;
      const hide = () => {
        box.style.display = 'none';
        if (ctx._colSlotGhost) { ctx._colSlotGhost.remove(); ctx._colSlotGhost = null; }
        ctx._colSlotSig = null;
        ctx._colDropSig = null;
      };
      const geom = ctx._colGeom;
      const g = (geom && ctx.colDragOverIdx.value !== null) ? geom[ctx.colDragOverIdx.value] : null;
      if (!g || ctx._colGeomHeaderTop == null) { hide(); return; }
      // 与「行拖动」完全同构：框画的是**让位后真正空出来的槽**，尺寸取被拖列自身宽度。
      //   · 向右拖：槽贴目标列右端 → [g.right - w(from), g.right]
      //   · 向左拖：槽贴目标列左端 → [g.left, g.left + w(from)]
      // 源/目标任一缺失才不画框。
      const from = ctx.colDragIdx.value;
      const to = ctx.colDragOverIdx.value;
      if (from == null || to == null) { hide(); return; }
      // 还没换列（from === to）也画框：槽就是源列原位，尺寸取源列自身，
      // 和行拖动的「原地不动画源行原位」完全一致，提示「松手会放回这里」。
      const sameSlot = from === to;
      const srcGeom = geom[from] || null;
      const wSrc = srcGeom
        ? Math.round(srcGeom.right - srcGeom.left)
        : Math.round(g.right - g.left);
      let left, right;
      if (sameSlot) {
        left = srcGeom ? srcGeom.left : g.left;
        right = srcGeom ? srcGeom.right : g.right;
      } else if (from < to) {
        right = g.right;
        // 被拖列比目标列宽时，别让框越过目标列的左边界盖到邻列上
        left = Math.max(g.left, g.right - wSrc);
      } else {
        left = g.left;
        right = Math.min(g.right, g.left + wSrc);
      }
      let top = ctx._colGeomHeaderTop;
      let bottom = ctx._colGeomTblBottom;
      const c = ctx._colGeomContainer;
      if (c) {
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
      const w = right - left, h = bottom - top;
      if (w <= 0 || h <= 0) { hide(); return; }
      // 每帧都会走到这里；几何没变就别再写样式（带上 to：等宽列之间移动时几何不变，
      // 但表头虚影要换成目标位置的那一格，签名里必须体现索引）
      const sig = `${left}|${top}|${w}|${h}|${to}`;
      if (ctx._colDropSig === sig) return;
      ctx._colDropSig = sig;
      // 落点虚影 = **整列**（表头 + 数据列），贴在空槽上：
      //   · 表头取「目标位置那一列的表头」—— 座位表列名是位置标签，数字按位置刷新才对；
      //   · 数据取「被拖列」的单元格 —— 松手后落进去的就是这份内容。
      // 宽度一律等于空槽宽（= 被拖列宽），所以框、影子、让位三者同宽，不会出现
      // 「框一大块、影一小块」。走廊与普通分支共用同一套槽位算法，只是上面的
      // left/right 已按方向算好（走廊的差异由让位动画自己处理）。
      box.style.display = 'block';
      box.style.transform = `translate(${left}px, ${top}px)`;
      box.style.width = w + 'px';
      box.style.height = h + 'px';
      // 原地不动（from === to）只画框、不贴落点虚影：虚影就是源列的副本，
      // 叠在源列自己身上只会多一层重影（与行拖动同款处理）。
      if (sameSlot) {
        if (ctx._colSlotGhost) { ctx._colSlotGhost.remove(); ctx._colSlotGhost = null; }
        ctx._colSlotSig = null;
      } else {
        ctx.updateColSlotGhost(left, top, w, h, from, to);
      }
    },
    // 落点整列虚影：几何或索引一变就重建（数字要跟着目标位置换，不能简单平移旧副本）
    updateColSlotGhost(left, top, width, height, fromIdx, toIdx) {
      // 源/目标任一缺失时不画（th 索引要靠 toIdx 取，缺了会取错列）
      if (fromIdx == null || toIdx == null) {
        if (ctx._colSlotGhost) { ctx._colSlotGhost.remove(); ctx._colSlotGhost = null; }
        ctx._colSlotSig = null;
        return;
      }
      const key = `${left}|${top}|${width}|${height}|${fromIdx}|${toIdx}`;
      if (ctx._colSlotSig === key) return;
      ctx._colSlotSig = key;
      if (ctx._colSlotGhost) { ctx._colSlotGhost.remove(); ctx._colSlotGhost = null; }
      const g = ctx.createColSlotGhost(fromIdx, toIdx, width, top, height);
      ctx._colSlotGhost = g;
      if (g) g.style.transform = `translate(${left}px, ${top}px)`;
    },
    // 表头 + 数据列的整列副本。表头按 toIdx 取（数字按位置刷新），数据按 fromIdx 取。
    createColSlotGhost(fromIdx, toIdx, slotW, top, totalH) {
      const ths = ctx.colHeaderEls();
      const dstTh = ths[toIdx + ctx.colThOffset()];
      if (!dstTh || !slotW || totalH <= 0) return null;
      const dataTop = Math.max(ctx._colGeomDataTop != null ? ctx._colGeomDataTop : top, top);
      const bottom = Math.max(top + totalH, dataTop);
      const gTable = document.createElement('table');
      gTable.style.cssText = 'position:absolute;left:0;top:0;border-collapse:collapse;table-layout:fixed;width:' + slotW + 'px;';
      // 表头：克隆目标列的 th，去掉拖动手柄
      const gThead = document.createElement('thead');
      const gThRow = document.createElement('tr');
      const gTh = dstTh.cloneNode(true);
      gTh.querySelectorAll('.drag-handle').forEach((n) => n.remove());
      gTh.style.transition = 'none';
      gTh.style.width = slotW + 'px';
      gTh.style.height = Math.max(0, Math.round(dataTop - top)) + 'px';
      gTh.style.overflow = 'hidden';
      gThRow.appendChild(gTh);
      gThead.appendChild(gThRow);
      gTable.appendChild(gThead);
      // 数据列：克隆被拖列的单元格，只取可视范围内的行
      const gTbody = document.createElement('tbody');
      const trs = ctx.gridContainer.value ? ctx.gridContainer.value.querySelectorAll('tbody tr') : [];
      let firstTop = null;
      for (let r = 0; r < trs.length; r++) {
        const tr = trs[r];
        const rect = tr.getBoundingClientRect();
        if (rect.bottom <= dataTop || rect.top >= bottom) continue;
        const refs = ctx.cellRefs.value[r];
        const srcCell = (refs && refs[fromIdx]) || null;
        if (firstTop == null) firstTop = rect.top;
        const gTr = document.createElement('tr');
        gTr.style.height = rect.height + 'px';
        const gTd = srcCell ? srcCell.cloneNode(true) : document.createElement('td');
        gTd.style.transition = 'none';
        gTd.style.width = slotW + 'px';
        gTd.style.overflow = 'hidden';
        gTr.appendChild(gTd);
        gTbody.appendChild(gTr);
      }
      if (firstTop == null) return null;
      // 首行可能被表头遮住一部分：用一条等高占位行补齐，后面的行才与原件严丝合缝
      const spacer = Math.round(firstTop - dataTop);
      if (spacer > 0.5) {
        const spTr = document.createElement('tr');
        const spTd = document.createElement('td');
        spTd.style.height = spacer + 'px';
        spTr.appendChild(spTd);
        gTbody.insertBefore(spTr, gTbody.firstChild);
      }
      gTable.appendChild(gTbody);
      const wrapper = ctx._ghostWrapper(slotW, totalH, 0.22, null);
      wrapper.appendChild(gTable);
      return wrapper;
    },
    // ==================== 交换动画（内容互换型 FLIP） ====================
    // 网格表格的交换是「同一批 DOM 节点换内容」，不是节点重排，TransitionGroup 的 move 不会触发，
    // 所以按交换前后的位置差给元素加一次性过渡，让内容看起来从原位滑到新位。
    playSwapFlip(items) {
      const list = (items || []).filter(it => it.el && it.el.isConnected);
      if (!list.length) return;
      list.forEach(({ el, dx = 0, dy = 0 }) => {
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      void ctx.gridContainer.value.offsetWidth; // 强制重排，让起始位移先生效
      list.forEach(({ el }) => {
        el.classList.add('swap-flip');
        el.style.transition = '';
        el.style.transform = '';
        const done = (e) => {
          if (e && e.propertyName !== 'transform') return;
          el.classList.remove('swap-flip');
          el.removeEventListener('transitionend', done);
        };
        el.addEventListener('transitionend', done);
      });
    },
    rowSig(idx) {
      const r = ctx.rows.value[idx];
      if (!r) return '';
      return (r.label || '') + '#' + (r.cells || []).map(c => c.course || '').join(',');
    },
    colSig(idx) {
      return (ctx.rows.value || []).map(r => (r.cells && r.cells[idx] ? r.cells[idx].course || '' : '')).join(',');
    },
    animateRowSwap(fromIdx, toIdx) {
      const trs = ctx.gridContainer.value ? ctx.gridContainer.value.querySelectorAll('tbody tr') : [];
      const a = trs[fromIdx], b = trs[toIdx];
      if (!a || !b) return;
      const dy = b.getBoundingClientRect().top - a.getBoundingClientRect().top;
      if (!dy) return;
      ctx.playSwapFlip([{ el: a, dy }, { el: b, dy: -dy }]);
    },
    animateColSwap(fromIdx, toIdx) {
      const ths = ctx.colHeaderEls();
      const off = ctx.colThOffset();
      const thFrom = ths[off + fromIdx], thTo = ths[off + toIdx];
      if (!thFrom || !thTo) return;
      const dx = thTo.getBoundingClientRect().left - thFrom.getBoundingClientRect().left;
      if (!dx) return;
      const items = [];
      const trs = ctx.gridContainer.value ? ctx.gridContainer.value.querySelectorAll('tbody tr') : [];
      trs.forEach((tr, rowIdx) => {
        const refs = ctx.cellRefs.value[rowIdx];
        if (!refs) return;
        const a = refs[fromIdx], b = refs[toIdx];
        if (a && a.isConnected) items.push({ el: a, dx });
        if (b && b.isConnected) items.push({ el: b, dx: -dx });
      });
      ctx.playSwapFlip(items);
    },

    // ==================== 行过渡容器开关（见模板说明） ====================
    // 开窗：行集合刚发生结构性变化，短窗口内保留 Enter/Leave 动画能力
    openRowsAnimWindow() {
      // 拖拽落位：行已经让位到最终位置，这里不要再开整表 FLIP（否则观感是"弹两下"）。
      // 落位动画统一由松手后的 _playRowSlideIn 负责。
      if (ctx._noRowFlipOnce) {
        ctx._noRowFlipOnce = false;
        if (ctx._rowsAnimTimer) { clearTimeout(ctx._rowsAnimTimer); ctx._rowsAnimTimer = null; }
        ctx.rowsAnimEnabled.value = false;
        return;
      }
      if (ctx._rowsAnimTimer) clearTimeout(ctx._rowsAnimTimer);
      if (!ctx.rowsAnimEnabled.value) ctx.rowsAnimEnabled.value = true;
      ctx._rowsAnimTimer = setTimeout(ctx.closeRowsAnimWindow, 800);
    },
    // 关窗：回退到 Fragment（重建一次 tbody，但无动画类，观感无变化）。
    // 编辑中/拖拽中回退会重建正在输入的编辑框并丢焦点，故延后到这些操作结束。
    closeRowsAnimWindow() {
      if (ctx.editingCell.value || ctx.rowDragIdx.value != null || ctx.colDragIdx.value != null || ctx.longPressActive.value) {
        ctx._rowsAnimTimer = setTimeout(ctx.closeRowsAnimWindow, 300);
        return;
      }
      ctx._rowsAnimTimer = null;
      ctx.rowsAnimEnabled.value = false;
    },

    // ==================== 数据区(tbody)整体从左往右弹入（不含表头） ====================
    playTableEnter() {
      const tbody = ctx.gridContainer.value ? ctx.gridContainer.value.querySelector('tbody') : null;
      if (!tbody) return;
      if (ctx._tableEnterCleanup) ctx._tableEnterCleanup();
      const onEnd = (e) => { if (e && e.target !== tbody) return; ctx._tableEnterCleanup(); };
      ctx._tableEnterCleanup = () => {
        tbody.classList.remove('table-enter');
        tbody.removeEventListener('animationend', onEnd);
        ctx._tableEnterCleanup = null;
      };
      tbody.addEventListener('animationend', onEnd);
      void tbody.offsetWidth; // 强制重排，保证重复导航时动画能重播
      tbody.classList.add('table-enter');
    },

    // ==================== 手动拖拽：半透明整行/整列克隆虚影 ====================
    isRowDropTarget(row) {
      return !!row && !row._isSeparator && !row._mergeCells && !row._isPodium;
    },
    // 表头行里数据列之前的固定列数量（时段/节次/时间/行号）
    colThOffset() {
      if (!ctx.hideMetaColumns.value) return 2 + (ctx.showPeriodColumn.value ? 1 : 0);
      return ctx.showRowNumber.value ? 1 : 0;
    },
    colHeaderEls() { return ctx.gridContainer.value ? ctx.gridContainer.value.querySelectorAll('thead tr:last-child th') : []; },
    // 统一创建虚影的外层容器：fixed + overflow:hidden，滚动区外的像素本来就被裁掉
    _ghostWrapper(width, height, opacity, radius) {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:fixed;left:0;top:0;z-index:100000;pointer-events:none;overflow:hidden;will-change:transform;contain:layout paint;box-shadow:0 6px 18px rgba(0,0,0,0.18);';
      wrapper.style.opacity = opacity;
      if (radius) wrapper.style.borderRadius = radius;
      wrapper.style.width = width + 'px';
      wrapper.style.height = height + 'px';
      document.body.appendChild(wrapper);
      return wrapper;
    },
    // 行虚影：只克隆被拖的那一行（原来克隆整表，屏外行也会参与样式/布局计算）。
    // 列宽按原件实测宽度显式固定，避免单行自动布局重新分配列宽。
    createRowSliceGhost(rowIdx, opacity, radius) {
      const table = ctx.gridContainer.value ? ctx.gridContainer.value.querySelector('table') : null;
      const tr = ctx.gridContainer.value ? ctx.gridContainer.value.querySelectorAll('tbody tr')[rowIdx] : null;
      if (!table || !tr) return null;
      const tblRect = table.getBoundingClientRect();
      const trRect = tr.getBoundingClientRect();
      if (!tblRect.width || !trRect.height) return null;
      const gTr = tr.cloneNode(true);
      gTr.classList.remove('content-visibility-auto', 'opacity-30');
      gTr.style.transition = 'none';
      const srcCells = Array.from(tr.children);
      Array.from(gTr.children).forEach((td, i) => {
        const w = srcCells[i] ? srcCells[i].getBoundingClientRect().width : 0;
        td.style.transition = 'none';
        if (w) td.style.width = w + 'px';
        td.style.overflow = 'hidden';
      });
      const gTable = document.createElement('table');
      gTable.style.cssText = 'border-collapse:collapse;table-layout:fixed;width:' + tblRect.width + 'px;';
      const gTbody = document.createElement('tbody');
      gTbody.appendChild(gTr);
      gTable.appendChild(gTbody);
      const wrapper = ctx._ghostWrapper(tblRect.width, trRect.height, opacity, radius);
      wrapper.appendChild(gTable);
      return wrapper;
    },
    // 列虚影：只渲染滚动容器可视范围内的行（视口外的行不克隆），
    // 内容以「第一条保留的行」为锚点整体偏移，行高全部按原件固定。
    // 讲台/分隔/合并行没有这一列的数据格，只补一条等高的空白行占位：
    // 位置保持准确，但不会把表头或名字的影子投到讲台格上。
    createColSliceGhost(colIndex, colWidth, headerTop, dataTop, dataBottom, opacity, radius) {
      if (!colWidth) return null;
      const view = ctx.gridTable.value;
      const vr = view ? view.getBoundingClientRect() : null;
      const bandTop = vr ? Math.max(dataTop, vr.top) : dataTop;
      const bandBottom = vr ? Math.min(dataBottom, vr.bottom) : dataBottom;
      if (bandBottom <= bandTop) return null;
      const headH = Math.max(0, Math.round(dataTop - headerTop));
      const gTable = document.createElement('table');
      gTable.style.cssText = 'position:absolute;left:0;top:0;border-collapse:collapse;table-layout:fixed;width:' + colWidth + 'px;';
      // 蓝色表头：跟着手上虚影一起走（表格里那一格此时已被 dt-col-src-hidden 隐藏）
      const srcTh = ctx.colHeaderEls()[colIndex + ctx.colThOffset()];
      if (srcTh && headH > 0) {
        const gThead = document.createElement('thead');
        const gThRow = document.createElement('tr');
        const gTh = srcTh.cloneNode(true);
        gTh.querySelectorAll('.drag-handle').forEach((n) => n.remove());
        gTh.style.transition = 'none';
        gTh.style.width = colWidth + 'px';
        gTh.style.height = headH + 'px';
        gTh.style.overflow = 'hidden';
        gThRow.appendChild(gTh);
        gThead.appendChild(gThRow);
        gTable.appendChild(gThead);
      }
      const gTbody = document.createElement('tbody');
      const trs = ctx.gridContainer.value ? ctx.gridContainer.value.querySelectorAll('tbody tr') : [];
      let firstTop = null;
      for (let r = 0; r < trs.length; r++) {
        const tr = trs[r];
        const rect = tr.getBoundingClientRect();
        if (rect.bottom <= bandTop || rect.top >= bandBottom) continue;
        const refs = ctx.cellRefs.value[r];
        const srcCell = (refs && refs[colIndex]) || null;
        if (firstTop == null) firstTop = rect.top;
        const gTr = document.createElement('tr');
        gTr.style.height = rect.height + 'px';
        const gTd = srcCell ? srcCell.cloneNode(true) : document.createElement('td');
        gTd.style.transition = 'none';
        gTd.style.width = colWidth + 'px';
        gTd.style.overflow = 'hidden';
        gTr.appendChild(gTd);
        gTbody.appendChild(gTr);
      }
      if (firstTop == null) return null;
      // 表头占掉 headH 之后，首行若被表头遮住一部分，用一条等高占位行补齐，
      // 后面的行才会和原件严丝合缝（表头固定在 gTable 顶部，不能再整体偏移 gTable）。
      const spacer = Math.round(firstTop - dataTop);
      if (spacer > 0.5) {
        const spTr = document.createElement('tr');
        const spTd = document.createElement('td');
        spTd.style.height = spacer + 'px';
        spTr.appendChild(spTd);
        gTbody.insertBefore(spTr, gTbody.firstChild);
      }
      gTable.appendChild(gTbody);
      const wrapper = ctx._ghostWrapper(colWidth, bandBottom - headerTop, opacity, radius);
      wrapper.appendChild(gTable);
      return wrapper;
    },
    placeGhost(ghost, grab, clientX, clientY) {
      if (!ghost || !grab) return;
      ghost.style.transform = `translate(${clientX - grab.grabX}px, ${clientY - grab.grabY}px)`;
    },

    // ---------- 行拖拽 ----------
    onRowHandleDown(event, rowIdx) {
      if (ctx.disableRowDrag.value || ctx.editingCell.value) return;
      // 上一次拖动若没正常收尾（在窗口外松开、切窗口失焦），监听器与 transform 会留着，
      // 再拖就是在旧位移上继续叠加 —— 表现是「多拖几次整张表乱成一锅粥」。
      // 这里先强制清理上一次的残留（不提交数据）。
      if (ctx._rowGhost || ctx._rowEls) ctx._abortRowDrag();
      const row = ctx.rows.value[rowIdx];
      if (!row || !ctx.canDragRow(row)) return;
      const table = ctx.gridContainer.value.querySelector('table');
      const tr = event.currentTarget.closest('tr');
      if (!table || !tr) return;
      event.preventDefault();
      const trRect = tr.getBoundingClientRect();
      const tblRect = table.getBoundingClientRect();
      const ghost = ctx.createRowSliceGhost(rowIdx, 0.85, '4px');
      if (!ghost) return;
      ctx.rowDragIdx.value = rowIdx;
      ctx.rowDragOverIdx.value = rowIdx;
      ctx._rowGhost = ghost;
      // 落点虚影在 updateRowDropBox 里延迟创建
      ctx._rowGrab = { grabX: event.clientX - tblRect.left, grabY: event.clientY - trRect.top };
      // 跟手虚影：自由跟随指针
      ctx.placeGhost(ghost, ctx._rowGrab, event.clientX, event.clientY);
      // 落点高亮框：包住即将落位的那一行（几何信息在此一次性缓存）
      ctx._cacheRowGeom();
      // 让位与自动滚动的初始状态。
      // 全部行都参与让位的「连续铺开」——固定行（课表休息行/讲台/分隔行）也必须跟着块平移，
      // 否则可让位行没有连续空间可铺、会直接撞到它们身上（虚影/蓝框全乱）。
      // 固定行的「不能动」体现在两处：不作落点（isRowDropTarget）、落位时不换数据。
      ctx._rowEls = Array.from(ctx.gridContainer.value.querySelectorAll('tbody tr'));
      ctx._collectPeriodCells();
      const rg0 = ctx._rowGeom ? ctx._rowGeom[rowIdx] : null;
      ctx._rowSlotH = rg0 ? Math.round(rg0.bottom - rg0.top) : 0;
      ctx._rowAutoScroll = createEdgeAutoScroll(
        () => ctx.gridTable.value,
        (mx, my) => ctx._onRowScrolled(mx, my)
      );
      ctx._rowDropBox = ctx.createDropBox();
      ctx.updateRowDropBox();

      const move = (e) => {
        if (!ctx._rowGhost) return;
        // rAF 对齐到帧：同一帧内多次 mousemove 只处理最后一次
        ctx._rowPending = e;
        if (ctx._rowRaf) return;
        ctx._rowRaf = requestAnimationFrame(() => {
          ctx._rowRaf = null;
          ctx._applyRowMove();
        });
      };
      const up = () => ctx.finishRowDrag();
      ctx._rowMove = move;
      ctx._rowUp = up;
      // passive：这两个监听不阻止默认行为，声明后不阻塞滚动/合成的路径
      window.addEventListener('mousemove', move, { passive: true });
      window.addEventListener('mouseup', up, { passive: true });
    },
    resolveRowIndexAt(clientY) {
      // 优先用拖拽开始时缓存的几何信息（无布局读取）
      const geom = ctx._rowGeom;
      if (geom && geom.length) {
        let best = null, min = Infinity;
        for (let i = 0; i < geom.length; i++) {
          if (!ctx.isRowDropTarget(ctx.rows.value[i])) continue;
          const r = geom[i];
          if (clientY >= r.top && clientY <= r.bottom) return i;
          const d = Math.min(Math.abs(clientY - r.top), Math.abs(clientY - r.bottom));
          if (d < min) { min = d; best = i; }
        }
        return best;
      }
      const trs = ctx.gridContainer.value ? ctx.gridContainer.value.querySelectorAll('tbody tr') : [];
      let best = null, min = Infinity;
      for (let i = 0; i < trs.length; i++) {
        if (!ctx.isRowDropTarget(ctx.rows.value[i])) continue;
        const r = trs[i].getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) return i; // 命中直接返回，避免被相邻行覆盖
        const d = Math.min(Math.abs(clientY - r.top), Math.abs(clientY - r.bottom));
        if (d < min) { min = d; best = i; }
      }
      return best;
    },
    // 应用最近一次待处理的拖拽位置（rAF 帧内执行；松手前也会强制冲刷一次，避免丢最后一帧）
    _applyRowMove() {
      if (!ctx._rowGhost || !ctx._rowPending) return;
      const ev = ctx._rowPending;
      // 跟手虚影自由跟随指针
      ctx.placeGhost(ctx._rowGhost, ctx._rowGrab, ev.clientX, ev.clientY);
      const idx = ctx.resolveRowIndexAt(ev.clientY);
      // 只有目标行变了才重算让位与落点（每帧无条件全量遍历是拖拽卡顿的主因）
      if (idx !== ctx.rowDragOverIdx.value) {
        ctx.rowDragOverIdx.value = idx;
        ctx._syncRowShift();
        ctx.updateRowDropBox();
      }
      // 边缘自动滚动（上下左右）：滚动后由 _onRowScrolled 同步几何缓存
      if (ctx._rowAutoScroll) ctx._rowAutoScroll.update(ev.clientX, ev.clientY);
    },
    // 行让位：**块内连续重排**，与座位表的列完全同一套（computeRowReorder）。
    //
    // 块内元素按新顺序从块顶依次铺开，**每项占自身高度**（不是占别人的槽）：
    // 行高不等时，若让每行去"占前一个位置"，高度不同就会溢出/留空（槽位模型踩过）；
    // 而按自身高度重新铺开，块总高不变、块内首尾相接，天然不会错位。
    // 固定行（课表大课间/午休/休息、讲台）当作「走廊」处理：不能作落点，但跟着块一起平移，
    // 否则可让位行没有连续空间可铺、会撞上去。
    // 收集跨行合并格（上午/下午/晚上）：记录 td、内层元素、起始行索引、跨度。
    // 拖动期间内层元素会被临时撑高/偏移，去覆盖「这几行当前的视觉范围」。
    _collectPeriodCells() {
      const box = ctx.gridContainer.value;
      const els = ctx._rowEls || [];
      const list = [];
      if (!box) { ctx._periodCells = list; return; }
      for (const td of box.querySelectorAll('[data-period-cell]')) {
        const tr = td.closest('tr');
        const startIdx = els.indexOf(tr);
        if (startIdx < 0) continue;
        list.push({
          td,
          inner: td.firstElementChild,
          startIdx,
          span: Number(td.getAttribute('rowspan') || 1),
        });
      }
      ctx._periodCells = list;
    },
    // 拖动中让合并格覆盖「它那几行的实际视觉范围」。
    // td 的 rowspan 高度是布局算的，transform 不改布局，块内行重排后（行高不等）它就不够了。
    _fixPeriodCells() {
      const list = ctx._periodCells;
      if (!list || !list.length) return;
      const els = ctx._rowEls || [];
      for (const item of list) {
        const inner = item.inner;
        if (!inner) continue;
        let minTop = Infinity, maxBottom = -Infinity;
        for (let i = item.startIdx; i < item.startIdx + item.span && i < els.length; i++) {
          const tr = els[i];
          if (!tr) continue;
          const r = tr.getBoundingClientRect();
          if (r.top < minTop) minTop = r.top;
          if (r.bottom > maxBottom) maxBottom = r.bottom;
        }
        if (!isFinite(minTop) || !isFinite(maxBottom)) continue;
        const tdRect = item.td.getBoundingClientRect();
        const dy = Math.round(minTop - tdRect.top);
        const h = Math.round(maxBottom - minTop);
        inner.style.transform = dy ? `translateY(${dy}px)` : '';
        inner.style.height = h > 0 ? h + 'px' : '';
      }
    },
    _resetPeriodCells() {
      const list = ctx._periodCells;
      if (!list) return;
      for (const item of list) {
        if (item.inner) { item.inner.style.transform = ''; item.inner.style.height = ''; }
      }
      ctx._periodCells = null;
    },
    _syncRowShift() {
      // 整行 <tr> 平移（唯一可靠的做法：td 上做 transform 会被 Chromium 拽出行列网格、文字堆到别的格）。
      applyRowShift(ctx._rowEls, ctx.rowDragIdx.value, ctx.rowDragOverIdx.value, ctx._rowGeom, ctx._rowSlotH);
      ctx._fixPeriodCells();
    },
    _clearRowShiftFx() {
      const tbody = ctx.gridContainer.value ? ctx.gridContainer.value.querySelector('tbody') : null;
      if (tbody) clearShift(tbody);
      ctx._resetPeriodCells();
      ctx._rowEls = null;
      ctx._rowSlotH = 0;
    },
    // 容器滚动后同步行几何，保证命中判定与落点框跟手
    _onRowScrolled(mx, my) {
      const geom = ctx._rowGeom;
      if (geom) {
        for (const r of geom) {
          if (!r) continue;
          r.left -= mx; r.right -= mx; r.top -= my; r.bottom -= my;
        }
      }
      ctx.updateRowDropBox();
    },
    // 强制中止一次行拖动：清理监听器/虚影/位移，但**不提交**数据换位。
    // 用于「上一次没正常收尾」的兜底（窗口外松开、切窗口失焦后重按）。
    _abortRowDrag() {
      if (ctx._rowMove) window.removeEventListener('mousemove', ctx._rowMove);
      if (ctx._rowUp) window.removeEventListener('mouseup', ctx._rowUp);
      ctx._rowMove = null;
      ctx._rowUp = null;
      if (ctx._rowRaf) { cancelAnimationFrame(ctx._rowRaf); ctx._rowRaf = null; }
      ctx._rowPending = null;
      ctx._rowGeom = null;
      ctx._rowGeomContainer = null;
      if (ctx._rowAutoScroll) { ctx._rowAutoScroll.stop(); ctx._rowAutoScroll = null; }
      if (ctx._rowGhost) { ctx._rowGhost.remove(); ctx._rowGhost = null; }
      if (ctx._rowSlotGhost) { ctx._rowSlotGhost.remove(); ctx._rowSlotGhost = null; }
      if (ctx._rowDropBox) { ctx._rowDropBox.remove(); ctx._rowDropBox = null; }
      ctx.rowDragIdx.value = null;
      ctx.rowDragOverIdx.value = null;
      ctx._clearRowShiftFx();
    },
    finishRowDrag() {
      if (ctx._rowMove) window.removeEventListener('mousemove', ctx._rowMove);
      if (ctx._rowUp) window.removeEventListener('mouseup', ctx._rowUp);
      ctx._rowMove = null;
      ctx._rowUp = null;
      if (ctx._rowRaf) { cancelAnimationFrame(ctx._rowRaf); ctx._rowRaf = null; }
      ctx._applyRowMove(); // 冲刷最后一帧
      // 松手位置：落位动画的起点
      // 落位动画起点取**虚影的实际位置**（左/上边缘），不是鼠标点：
      // 鼠标和行左边缘差着一个抓取偏移，而落点基准是行的左边缘，
      // 两者凑一起会算出「半个表宽」的假差值 —— 明明已经对齐了，还要横着飞一整段。
      const relRow = ctx._rowGhost && ctx._rowGhost.isConnected
        ? (() => { const g = ctx._rowGhost.getBoundingClientRect(); return { left: g.left, top: g.top }; })()
        : null;
      ctx._rowPending = null;
      ctx._rowGeom = null;
      ctx._rowGeomContainer = null;
      if (ctx._rowAutoScroll) { ctx._rowAutoScroll.stop(); ctx._rowAutoScroll = null; }
      if (ctx._rowGhost) { ctx._rowGhost.remove(); ctx._rowGhost = null; }
      if (ctx._rowSlotGhost) { ctx._rowSlotGhost.remove(); ctx._rowSlotGhost = null; }
      if (ctx._rowDropBox) { ctx._rowDropBox.remove(); ctx._rowDropBox = null; }
      const from = ctx.rowDragIdx.value, to = ctx.rowDragOverIdx.value;
      ctx.rowDragIdx.value = null;
      ctx.rowDragOverIdx.value = null;
      // 先清让位位移再重排：清位与重排在同一 tick，不会出现"先弹回原位"
      ctx._clearRowShiftFx();
      if (from === null || to === null) return;
      if (from === to) {
        // 没换行但拖动位置变了：让虚影滑回这一行的位置，而不是松手瞬间消失。
        // 不要设 _noRowFlipOnce（没有重排，留到下次行增删会错误地抑制 FLIP）。
        if (relRow) nextTick(() => ctx._slideInRow(from, relRow));
        return;
      }
      if (!ctx.isRowDropTarget(ctx.rows.value[to])) return;
      // 落位：抑制整表 FLIP（见 openRowsAnimWindow），松手只做一段从指针滑入落点的收尾
      ctx._noRowFlipOnce = true;
      ctx.emit('swapRows', from, to);
      if (relRow) nextTick(() => ctx._slideInRow(to, relRow));
    },
    // 松手滑入：被移动的这一行从「松手时的指针位置」滑到落点（X/Y 两个方向）
    _slideInRow(to, rel) {
      if (!rel) return;
      const trs = ctx.gridContainer.value ? ctx.gridContainer.value.querySelectorAll('tbody tr') : [];
      const tr = trs[to];
      if (!tr || typeof tr.animate !== 'function') return;
      const r = tr.getBoundingClientRect();
      if (!r.width && !r.height) return;
      const dx = Math.round(rel.left - r.left);
      const dy = Math.round(rel.top - r.top);
      if (!dx && !dy) return;
      tr.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: 200, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' }
      );
    },
    // 松手滑入：被移动的这一列（只数据格，表头不动）从指针位置滑到落点（X/Y 两个方向）
    _slideInCol(to, rel) {
      if (!rel) return;
      let base = null;
      for (let r = 0; r < ctx.rows.value.length; r++) {
        const refs = ctx.cellRefs.value[r];
        const el = refs ? refs[to] : null;
        if (el && el.isConnected) { base = el; break; }
      }
      if (!base) return;
      const br = base.getBoundingClientRect();
      const dx = Math.round(rel.x - (br.left + br.width / 2));
      const dy = Math.round(rel.y - (br.top + br.height / 2));
      if (!dx && !dy) return;
      for (let r = 0; r < ctx.rows.value.length; r++) {
        const refs = ctx.cellRefs.value[r];
        if (!refs) continue;
        const el = refs[to];
        if (!el || !el.isConnected || typeof el.animate !== 'function') continue;
        el.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 200, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' }
        );
      }
    },
    // ---------- 列拖拽 ----------
    onColHandleDown(event, colIndex) {
      if (ctx.editingCell.value) return;
      if (ctx.colHeaders.value[colIndex] === '走廊') return;
      const table = ctx.gridContainer.value.querySelector('table');
      const ths = ctx.colHeaderEls();
      const th = ths[ctx.colThOffset() + colIndex];
      if (!table || !th) return;
      event.preventDefault();
      const thRect = th.getBoundingClientRect();
      const rowRect = th.parentElement.getBoundingClientRect();
      const tblRect = table.getBoundingClientRect();
      // 跟手虚影 = 「蓝色表头 + 数据列」整列：被拖列的表头跟着手走，
      // 表格里那一格由 dt-col-src-hidden 留空（否则会看到两份表头）。
      const headerTop = rowRect.top;
      const dataTop = rowRect.bottom;
      const dataBottom = Math.max(tblRect.bottom, dataTop + 1);
      const ghost = ctx.createColSliceGhost(colIndex, thRect.width, headerTop, dataTop, dataBottom, 0.85);
      if (!ghost) return;
      ctx.colDragIdx.value = colIndex;
      ctx.colDragOverIdx.value = colIndex;
      ctx._colGhost = ghost;
      // 落点虚影在 updateColDropBox 里延迟创建
      ctx._colGrab = { grabX: event.clientX - thRect.left, grabY: event.clientY - headerTop };
      // 跟手虚影：自由跟随指针
      ctx.placeGhost(ghost, ctx._colGrab, event.clientX, event.clientY);
      // 落点高亮框：包住即将落位的那一列（几何信息在此一次性缓存）
      ctx._cacheColGeom();
      // 让位：从 cellRefs 收集每列的数据单元格（只平移 td，表头 th 保持固定）
      const colEls = [];
      for (let r = 0; r < ctx.rows.value.length; r++) {
        const refs = ctx.cellRefs.value[r];
        if (!refs) continue;
        for (const key of Object.keys(refs)) {
          const k = Number(key);
          if (!Number.isInteger(k) || k < 0) continue;
          if (!colEls[k]) colEls[k] = [];
          if (refs[key]) colEls[k].push(refs[key]);
        }
      }
      // 表头 th 与数据格**一起**参与让位：列宽不等时，数据格按新位置铺开，
      // 表头必须同样铺开才能与各自的数据对齐（表头不动就会整体错开一条）。
      // 文字编号由 _syncColShift 按新位置纠正，不会出现「列4 跑到列2 的位置还写着列4」。
      const thsAll = ctx.colHeaderEls();
      const thOff0 = ctx.colThOffset();
      for (let k = 0; k < colEls.length; k++) {
        const th = thsAll[k + thOff0];
        if (!th) continue;
        if (!colEls[k]) colEls[k] = [];
        colEls[k].unshift(th);
      }
      ctx._colEls = colEls;
      const cg0 = ctx._colGeom ? ctx._colGeom[colIndex] : null;
      ctx._colSlotW = cg0 ? Math.round(cg0.right - cg0.left) : 0;
      ctx._colAutoScroll = createEdgeAutoScroll(
        () => ctx.gridTable.value,
        (mx, my) => ctx._onColScrolled(mx, my)
      );
      ctx._colDropBox = ctx.createDropBox();
      ctx.updateColDropBox();

      const move = (e) => {
        if (!ctx._colGhost) return;
        // rAF 对齐到帧：同一帧内多次 mousemove 只处理最后一次
        ctx._colPending = e;
        if (ctx._colRaf) return;
        ctx._colRaf = requestAnimationFrame(() => {
          ctx._colRaf = null;
          ctx._applyColMove();
        });
      };
      const up = () => ctx.finishColDrag();
      ctx._colMove = move;
      ctx._colUp = up;
      // passive：这两个监听不阻止默认行为，声明后不阻塞滚动/合成的路径
      window.addEventListener('mousemove', move, { passive: true });
      window.addEventListener('mouseup', up, { passive: true });
    },
    // 应用最近一次待处理的列拖拽位置（rAF 帧内执行；松手前也会强制冲刷一次）
    _applyColMove() {
      if (!ctx._colGhost || !ctx._colPending) return;
      const ev = ctx._colPending;
      // 跟手虚影自由跟随指针
      ctx.placeGhost(ctx._colGhost, ctx._colGrab, ev.clientX, ev.clientY);
      const hov = ctx.resolveColIndexAt(ev.clientX);
      // 目标列变了才重算让位与落点（每帧无条件全量遍历是拖拽卡顿的主因）
      if (hov !== ctx.colDragOverIdx.value) {
        ctx.colDragOverIdx.value = hov;
        ctx._syncColShift();
        ctx.updateColDropBox();
      }
      // 边缘自动滚动（上下左右）
      if (ctx._colAutoScroll) ctx._colAutoScroll.update(ev.clientX, ev.clientY);
    },
    // 列让位（移动语义）：只平移「数据单元格」，表头保持不动（座位/课表/值日表头固定）。
    // 位移按几何逐列补偿：同桌列 + 走廊列导致列宽不等，统一宽度会让中间列错位。
    _syncColShift() {
      const from = ctx.colDragIdx.value;
      const to = ctx.colDragOverIdx.value;
      applyColShift(ctx._colEls, from, to, ctx._colGeom, ctx._colSlotW);
      ctx._fixColLabels(from, to);
    },
    // 表头文字按「这个 th 挪到了哪个位置」重算，写成 colLabelOverride（数据驱动），
    // 不直接改 DOM —— 拖动中 colDragIdx 变化会触发 Vue 重渲染表头，改 DOM 会被冲掉。
    //
    // 语义与表头名字无关：**表头是一份按位置排列的固定标签序列**，
    // 位置 k 上的第 n 个真实列就该显示原序列里的第 n 个真实列名。
    //   · 座位表  → 列1 列2 列3…（原序列就是 列N，所以等价于按位置编号）
    //   · 卫生值日 → 周一 周二 周三…（拖完还是按位置排周一~周日）
    //   · 课程表  → 同样的星期序列
    // 只要求「非走廊表头互不相同」，避免把重名列（字段名型表头）按位置改写。
    _fixColLabels(from, to) {
      const headers = ctx.colHeaders.value || [];
      if (!headers.length) { ctx.colLabelOverride.value = null; return; }
      const realHeaders = headers.filter(h => h !== '走廊' && h != null && h !== '');
      const positional = realHeaders.length > 0 && new Set(realHeaders).size === realHeaders.length;
      if (!positional || from == null || to == null || from === to) {
        ctx.colLabelOverride.value = null;
        return;
      }
      const reorder = computeColReorder(ctx._colGeom, from, to);
      const seq = reorder.seq || [];
      if (!seq.length) { ctx.colLabelOverride.value = null; return; }
      const lo = Math.min(from, to);
      const countRealBefore = (pos) => {
        let c = 0;
        for (let i = 0; i < pos && i < headers.length; i++) if (headers[i] !== '走廊') c++;
        return c;
      };
      const labelAt = (pos, idx) => {
        if (headers[idx] === '走廊') return '走廊';
        return realHeaders[countRealBefore(pos)] != null ? realHeaders[countRealBefore(pos)] : headers[idx];
      };
      // seq[k] = 现在占据块内第 k 个位置的那一列 → 它的文字改成那个位置的标签
      const ov = new Array(headers.length).fill(null);
      for (let k = 0; k < seq.length; k++) {
        const idx = seq[k];
        ov[idx] = labelAt(lo + k, idx);
      }
      ctx.colLabelOverride.value = ov;
      // 手上的跟手虚影：表头也要显示「它即将落进去的那个位置」的标签，
      // 而不是源列自己的名字。虚影是手动创建的 DOM，直接改文字不会被 Vue 覆盖。
      if (to >= 0 && to < headers.length) ctx._updateColGhostLabel(labelAt(to, to));
    },
    _updateColGhostLabel(label) {
      if (!ctx._colGhost || !label) return;
      const spans = ctx._colGhost.querySelectorAll('th span');
      const el = spans.length ? spans[spans.length - 1] : null;
      if (el && el.textContent !== label) el.textContent = label;
    },
    _restoreColLabels() {
      ctx.colLabelOverride.value = null;
    },
    _clearColShiftFx() {
      ctx._restoreColLabels();
      clearShift(ctx.gridContainer.value);
      ctx._colEls = null;
      ctx._colSlotW = 0;
    },
    // 容器滚动后同步列几何（左右按 mx、表头/表底按 my）
    _onColScrolled(mx, my) {
      const geom = ctx._colGeom;
      if (geom) {
        for (const r of geom) {
          if (!r) continue;
          r.left -= mx; r.right -= mx;
        }
      }
      if (ctx._colGeomHeaderTop != null) ctx._colGeomHeaderTop -= my;
      if (ctx._colGeomTblBottom != null) ctx._colGeomTblBottom -= my;
      ctx.updateColDropBox();
    },
    resolveColIndexAt(clientX) {
      // 优先用拖拽开始时缓存的几何信息（无布局读取）
      const geom = ctx._colGeom;
      if (geom && geom.length) {
        let best = null, min = Infinity;
        for (let k = 0; k < geom.length; k++) {
          const r = geom[k];
          if (!r || r.aisle) continue; // 走廊列/空列不是落点目标（但几何仍参与让位补偿）
          if (clientX >= r.left && clientX <= r.right) return k; // 命中直接返回，避免被相邻列覆盖
          const d = Math.abs(clientX - (r.left + r.right) / 2);
          if (d < min) { min = d; best = k; }
        }
        return best;
      }
      const ths = ctx.colHeaderEls();
      const off = ctx.colThOffset();
      let best = null, min = Infinity;
      for (let i = 0; i < ths.length; i++) {
        const colIdx = i - off;
        const col = ctx.colHeaders.value[colIdx];
        if (colIdx < 0 || col === undefined || col === '走廊') continue;
        const r = ths[i].getBoundingClientRect();
        if (clientX >= r.left && clientX <= r.right) return colIdx; // 命中直接返回，避免被相邻列覆盖
        const d = Math.abs(clientX - (r.left + r.right) / 2);
        if (d < min) { min = d; best = colIdx; }
      }
      return best;
    },
    finishColDrag() {
      if (ctx._colMove) window.removeEventListener('mousemove', ctx._colMove);
      if (ctx._colUp) window.removeEventListener('mouseup', ctx._colUp);
      ctx._colMove = null;
      ctx._colUp = null;
      if (ctx._colRaf) { cancelAnimationFrame(ctx._colRaf); ctx._colRaf = null; }
      ctx._applyColMove(); // 冲刷最后一帧
      // 松手位置：列滑入动画的起点
      const relCol = ctx._colPending ? { x: ctx._colPending.clientX, y: ctx._colPending.clientY } : null;
      ctx._colPending = null;
      const from = ctx.colDragIdx.value, to = ctx.colDragOverIdx.value;
      ctx._colGeom = null;
      ctx._colGeomContainer = null;
      ctx._colGrab = null;
      if (ctx._colAutoScroll) { ctx._colAutoScroll.stop(); ctx._colAutoScroll = null; }
      if (ctx._colGhost) { ctx._colGhost.remove(); ctx._colGhost = null; }
      if (ctx._colSlotGhost) { ctx._colSlotGhost.remove(); ctx._colSlotGhost = null; }
      ctx._colSlotSig = null;
      if (ctx._colDropBox) { ctx._colDropBox.remove(); ctx._colDropBox = null; }
      ctx.colDragIdx.value = null;
      ctx.colDragOverIdx.value = null;
      // 先清让位位移再重排（清位与重排同一 tick，不会先弹回原位）
      ctx._clearColShiftFx();
      if (from === null || to === null || from === to) return;
      // 落位：只给这一列的数据格播「从松手位置滑入」（表头不动）
      ctx.emit('swapColumns', from, to);
      if (relCol) nextTick(() => ctx._slideInCol(to, relCol));
    },
  };
}
