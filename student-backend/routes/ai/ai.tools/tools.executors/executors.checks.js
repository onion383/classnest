// ===== AI 工具执行：数据体检 / 冲突检测 / 权重评分 =====
// 纯代码搬运自 ../executors.js，行为不变。门面装配见 tools.js。
const store = require('../../../../services/slotStore');
const aiStore = require('../../../../services/aiStore');
const { readScope } = require('../../../../services/aiReadScope');
const { AI_CHECK_RULE_TABLES, AI_SCORE_TABLES } = require('../../../../schema/tableRegistry');
const { gridToDenseCols, seatColumnIndices, rowIsAisle } = require('../../../../services/seatGrid');
const {
  aiParseDate, aiParseJson, aiTodayStr, studentIdNameMap,
  unpackDutyModeCol, dutyModeLabel, aiLooksMultiCourse,
} = require('./executors.common');

// ===== run_checks 工具：按 checks 入参逐条执行数据校验（跑哪几条由调用方传入） =====
const CHECK_LABELS = {
  cadre_dangling: '班干部任职指向了不存在的学生',
  group_dangling: '分组名册成员不在学生名单里',
  score_dangling: '加减分记录指向了不存在的学生',
  leave_dangling: '请假记录指向了不存在的学生',
  seat_dangling: '座位表里有格子指向了不存在的学生',
  duty_dangling: '值日表里有格子指向了不存在的学生',
  leave_reversed: '请假结束时间早于开始时间',
  fee_negative: '班费金额为负',
  sno_duplicate: '学号重复',
};
// 单条校验规则注册表。每条规则自带 `tables`（它实际会读的表）——读闸门直接消费
// 这份声明，表名清单统一定义在 schema/tableRegistry（业务层不许手抄）。
// 新增规则必须在这里登记依赖表：没声明按「拒绝执行」处理（fail-closed）。
const CHECK_RULES = {
  // 班干部任职指向不存在的学生
  cadre_dangling: {
    tables: AI_CHECK_RULE_TABLES.cadre_dangling,
    run: (ctx) => aiStore.listCadreMembers().filter((r) => {
      if (r.student_id != null && Number(r.student_id) > 0) return !ctx.idSet.has(Number(r.student_id));
      return !ctx.nameSet.has(String(r.student_name || ''));
    }).map((r) => ({ id: r.id, cadre_id: r.cadre_id, student_id: r.student_id, student_name: r.student_name })),
  },
  // 分组名册成员不在学生名单里。
  // P2-1 之后 student_id 才是权威：有 id 就按 id 判，只在没有 id 时才退回按姓名 ——
  // 否则「id 指向已删的人、但姓名刚好和另一个同名学生重合」会被判成正常。
  group_dangling: {
    tables: AI_CHECK_RULE_TABLES.group_dangling,
    run: (ctx) => aiStore.listGroupMembers().filter((r) => {
      if (r.student_id != null && Number(r.student_id) > 0) return !ctx.idSet.has(Number(r.student_id));
      const nm = String(r.member_name || '').trim();
      return !!nm && !ctx.nameSet.has(nm);
    }).map((r) => ({ id: r.id, group_id: r.group_id, student_id: r.student_id, member_name: r.member_name })),
  },
  // 加减分 / 请假：只报「有 id 但 id 已经不存在」的行。
  // id 为空的不算孤儿 —— 那是「只存姓名」的历史行，它没有断链，删掉反而丢数据。
  score_dangling: {
    tables: AI_CHECK_RULE_TABLES.score_dangling,
    run: (ctx) => aiStore.listScoreRecordsForChecks()
      .filter((r) => r.student_id != null && Number(r.student_id) > 0 && !ctx.idSet.has(Number(r.student_id)))
      .map((r) => ({ id: r.id, student_id: r.student_id, 姓名: r['姓名'], 学号: r['学号'] })),
  },
  leave_dangling: {
    tables: AI_CHECK_RULE_TABLES.leave_dangling,
    run: (ctx) => aiStore.listLeaveRecordsForChecks()
      .filter((r) => r.student_id != null && Number(r.student_id) > 0 && !ctx.idSet.has(Number(r.student_id)))
      .map((r) => ({ id: r.id, student_id: r.student_id, 姓名: r['姓名'], 开始时间: r['开始时间'], 结束时间: r['结束时间'] })),
  },
  // 座位 / 值日：格子可能是学生 id（新数据）或姓名（老数据）。只报数字且查不到的，
  // 字符串格归 group_dangling 那一类的「按姓名判」管，这里不重复报。
  // 列号按「座位列序号」报（网格下标把走廊列也算进去），与 seat_duplicate 同一口径。
  seat_dangling: {
    tables: AI_CHECK_RULE_TABLES.seat_dangling,
    run: (ctx) => {
      const row = aiStore.readSeatDoc();
      if (!row) return [];
      const seats = aiParseJson(row.seats, []) || [];
      const types = aiParseJson(row.types, []) || [];
      const out = [];
      for (let r = 0; r < seats.length; r++) {
        const line = Array.isArray(seats[r]) ? seats[r] : [];
        const dense = gridToDenseCols(Math.max(line.length, Number(row.cols) || 0), types);
        for (let c = 0; c < line.length; c++) {
          const v = line[c];
          if (typeof v !== 'number') continue;
          if (!ctx.idSet.has(Number(v))) {
            // 座位列号取 dense 映射后的序号；types 缺失/异常时退回网格下标，别报出 NaN
            const col = Number.isInteger(dense[c]) && dense[c] >= 0 ? dense[c] + 1 : c + 1;
            out.push({ 排: r + 1, 列: col, student_id: v });
          }
        }
      }
      return out;
    },
  },
  duty_dangling: {
    tables: AI_CHECK_RULE_TABLES.duty_dangling,
    run: (ctx) => {
      const row = aiStore.readDutyDoc();
      if (!row) return [];
      const out = [];
      for (const m of ['daily', 'big']) {
        const cells = unpackDutyModeCol(row.cells, m);
        for (const item of Object.keys(cells || {})) {
          const daysMap = cells[item] || {};
          for (const day of Object.keys(daysMap)) {
            const raw = daysMap[day];
            const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
            list.forEach((v, i) => {
              if (typeof v !== 'number') return;
              if (!ctx.idSet.has(Number(v))) out.push({ 模式: dutyModeLabel(m), 项目: item, 星期: day, 第几个人: i + 1, student_id: v });
            });
          }
        }
      }
      return out;
    },
  },
  // 请假结束时间早于开始时间
  leave_reversed: {
    tables: AI_CHECK_RULE_TABLES.leave_reversed,
    run: () => {
      const out = [];
      for (const r of aiStore.listLeaveRecordsForChecks()) {
        const a = aiParseDate(r['开始时间']);
        const b = aiParseDate(r['结束时间']);
        if (a && b && b < a) out.push({ id: r.id, 姓名: r['姓名'], 开始时间: r['开始时间'], 结束时间: r['结束时间'] });
      }
      return out;
    },
  },
  // 班费金额为负
  fee_negative: {
    tables: AI_CHECK_RULE_TABLES.fee_negative,
    run: () => aiStore.listFeeRecords()
      .filter((r) => Number(r['收支金额']) < 0)
      .map((r) => ({ id: r.id, 收支类型: r['收支类型'], 收支金额: r['收支金额'], 收支时间: r['收支时间'] })),
  },
  // 学号重复
  sno_duplicate: {
    tables: AI_CHECK_RULE_TABLES.sno_duplicate,
    run: (ctx) => {
      const bySno = {};
      for (const s of ctx.students) {
        const k = String(s['学号'] || '').trim();
        if (!k) continue;
        (bySno[k] = bySno[k] || []).push({ id: s.id, 姓名: s['姓名'] });
      }
      return Object.keys(bySno).filter((k) => bySno[k].length > 1).map((k) => ({ 学号: k, 人数: bySno[k].length, 学生: bySno[k] }));
    },
  },
};

// 把「要跑的规则」按读作用域切成可跑 / 跳过两份。
// 依赖表直接取规则自带的声明；没声明 → 视为不可读（fail-closed），并回给模型，
// 否则它会以为体检结果「全部正常」，而实际是有一批规则根本没执行。
function splitReadable(want, rules) {
  const allowed = [];
  const skipped = [];
  for (const c of want) {
    const spec = rules[c] || {};
    const tables = spec.tables;
    if (!Array.isArray(tables)) {
      skipped.push({ type: c, blocked: ['<未声明依赖表>'] });
      continue;
    }
    const blocked = tables.filter((t) => !readScope.isTableReadable(t));
    if (blocked.length) skipped.push({ type: c, blocked });
    else allowed.push(c);
  }
  return { allowed, skipped };
}
function skippedNote(skipped) {
  return skipped.length ? `另有 ${skipped.length} 项检查因依赖的表已在设置中关闭而未执行` : '';
}

function runChecks({ checks } = {}) {
  // 跑哪几条规则：由 checks 入参决定，不传则全部
  const explicit = checks != null;
  let want = Object.keys(CHECK_RULES);
  if (explicit) {
    const arr = Array.isArray(checks) ? checks : [checks];
    want = arr.map((c) => String(c).trim()).filter((c) => CHECK_RULES[c]);
    if (!want.length) return { error: `checks 只能是 ${Object.keys(CHECK_RULES).join('/')} 中的若干项` };
  }
  const { allowed, skipped } = splitReadable(want, CHECK_RULES);
  if (!allowed.length) {
    // 用户点名要跑的规则全被关掉：明确报错，不返回「体检通过」的假绿。
    if (explicit) return { ok: false, error: readScope.closedError(skipped[0].blocked[0]).error };
    return {
      ok: true, checked: [], skipped, total: 0, clean: true, issues: [],
      note: `所有检查项依赖的表都已在设置中关闭 AI 读取，未执行检查（${skipped.map((s) => s.type).join('、')}）`,
    };
  }
  const students = aiStore.listStudentsForChecks();
  const ctx = {
    students,
    nameSet: new Set(students.map((s) => String(s['姓名'] || '')).filter(Boolean)),
    idSet: new Set(students.map((s) => Number(s.id))),
  };
  const issues = [];
  for (const c of allowed) {
    const items = CHECK_RULES[c].run(ctx) || [];
    if (items.length) issues.push({ type: c, title: CHECK_LABELS[c], count: items.length, items });
  }
  const total = issues.reduce((n, it) => n + it.count, 0);
  const baseNote = total === 0 ? '体检通过：所查规则均未发现问题' : `共发现 ${total} 处问题，分 ${issues.length} 类，见 issues`;
  const extra = skippedNote(skipped);
  return {
    ok: true, checked: allowed, ...(skipped.length ? { skipped } : {}), total, clean: total === 0, issues,
    note: extra ? `${baseNote}；${extra}` : baseNote,
  };
}

// ===== run_conflict_checks 工具：按 checks 入参逐条执行排布冲突检测（跑哪几条由调用方传入） =====
const CONFLICT_LABELS = {
  seat_duplicate: '座位表同一人坐了多个位置',
  duty_duplicate: '值日表同一人同一天被排在多个劳动项目',
  countdown_passed: '倒计时截止日已过',
  schedule_conflict: '课表格内多课 / 结构异常',
};
// 单条冲突检查注册表：每条自带 `tables`（它实际会读的表）与 `run(ctx)`，口径同 CHECK_RULES。
const CONFLICT_RULES = {
  // 座位表：同一人坐多个位置
  seat_duplicate: {
    tables: AI_CHECK_RULE_TABLES.seat_duplicate,
    run: () => {
      const row = aiStore.readSeatDoc();
      if (!row) return [];
      const seats = aiParseJson(row.seats, []) || [];
      const types = aiParseJson(row.types, []) || [];
      const idName = studentIdNameMap();
      const pos = {};
      for (let r = 0; r < seats.length; r++) {
        const line = Array.isArray(seats[r]) ? seats[r] : [];
        // 列号必须按「座位列序号」报：网格下标把走廊列也算进去，
        // 一张 7 座位列的座位表会报出「第3行第13列」，而页面上写的是「列7」。
        const dense = gridToDenseCols(Math.max(line.length, Number(row.cols) || 0), types);
        for (let c = 0; c < line.length; c++) {
          const v = line[c];
          if (v == null || v === '') continue;
          if (dense[c] < 0) continue;
          (pos[String(v)] = pos[String(v)] || []).push({ 排: r + 1, 列: dense[c] + 1 });
        }
      }
      return Object.keys(pos).filter((k) => pos[k].length > 1).map((k) => ({
        姓名: idName[Number(k)] || k, 座位数: pos[k].length, 位置: pos[k],
      }));
    },
  },
  // 值日表：同一人同一天被排在多个劳动项目
  duty_duplicate: {
    tables: AI_CHECK_RULE_TABLES.duty_duplicate,
    run: (ctx) => {
      const row = aiStore.readDutyDoc();
      if (!row) return [];
      const modes = ctx.mode === 'big' ? ['big'] : ['daily'];
      const out = [];
      for (const m of modes) {
        const cells = unpackDutyModeCol(row.cells, m);
        const per = {}; // 姓名 → {星期: [项目]}
        for (const item of Object.keys(cells || {})) {
          const daysMap = cells[item] || {};
          for (const day of Object.keys(daysMap)) {
            const raw = daysMap[day];
            const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
            for (const nm of list) {
              if (!nm) continue;
              (per[nm] = per[nm] || {});
              (per[nm][day] = per[nm][day] || []).push(item);
            }
          }
        }
        for (const nm of Object.keys(per)) {
          for (const day of Object.keys(per[nm])) {
            if (per[nm][day].length > 1) out.push({ 模式: dutyModeLabel(m), 姓名: nm, 星期: day, 项目: per[nm][day] });
          }
        }
      }
      return out;
    },
  },
  // 倒计时：截止日已过
  countdown_passed: {
    tables: AI_CHECK_RULE_TABLES.countdown_passed,
    run: () => {
      const today = aiTodayStr();
      return aiStore.listCountdownsForChecks()
        .filter((r) => { const d = aiParseDate(r['截止日']); return d && d < today; })
        .map((r) => ({ id: r.id, 名称: r['名称'], 截止日: r['截止日'] }));
    },
  },
  // 课表：格内多课 / 结构异常
  schedule_conflict: {
    tables: AI_CHECK_RULE_TABLES.schedule_conflict,
    run: () => {
      const row = aiStore.readScheduleDoc();
      if (!row) return [];
      const cells = aiParseJson(row.cells, []) || [];
      const settings = aiParseJson(row.settings, {}) || {};
      const days = (Array.isArray(settings.days) && settings.days.length) ? settings.days : ['周一', '周二', '周三', '周四', '周五'];
      const out = [];
      for (let r = 0; r < cells.length; r++) {
        const line = Array.isArray(cells[r]) ? cells[r] : [];
        if (line.length && line.length !== days.length) {
          out.push({ 类型: '结构异常', 节次: r + 1, 说明: `该行有 ${line.length} 格，应为 ${days.length} 格（${days.length} 天）` });
        }
        for (let c = 0; c < line.length; c++) {
          const v = line[c];
          const text = v && typeof v === 'object' ? String(v.course || '') : String(v == null ? '' : v);
          if (aiLooksMultiCourse(text)) out.push({ 类型: '同节多课', 节次: r + 1, 星期: days[c] || `第${c + 1}列`, 内容: text });
        }
      }
      return out;
    },
  },
};
function runConflictChecks({ checks, mode } = {}) {
  // 跑哪几条规则：由 checks 入参决定，不传则全部
  const explicit = checks != null;
  let want = Object.keys(CONFLICT_RULES);
  if (explicit) {
    const arr = Array.isArray(checks) ? checks : [checks];
    want = arr.map((c) => String(c).trim()).filter((c) => CONFLICT_RULES[c]);
    if (!want.length) return { error: `checks 只能是 ${Object.keys(CONFLICT_RULES).join('/')} 中的若干项` };
  }
  const { allowed, skipped } = splitReadable(want, CONFLICT_RULES);
  if (!allowed.length) {
    if (explicit) return { ok: false, error: readScope.closedError(skipped[0].blocked[0]).error };
    return {
      ok: true, checked: [], skipped, total: 0, issues: [],
      note: `所有冲突检查依赖的表都已在设置中关闭 AI 读取，未执行检查（${skipped.map((s) => s.type).join('、')}）`,
    };
  }
  const issues = [];
  for (const c of allowed) {
    const items = CONFLICT_RULES[c].run({ mode }) || [];
    if (items.length) issues.push({ type: c, title: CONFLICT_LABELS[c], count: items.length, items });
  }
  const total = issues.reduce((n, it) => n + it.count, 0);
  const baseNote = total === 0 ? '未检测到冲突' : `共发现 ${total} 处冲突，分 ${issues.length} 类，见 issues`;
  const extra = skippedNote(skipped);
  return {
    ok: true, checked: allowed, ...(skipped.length ? { skipped } : {}), total, issues,
    note: extra ? `${baseNote}；${extra}` : baseNote,
  };
}

// ===== score_weights 工具：复用「座位指数/值日指数」口径给排布评分 =====
// 座位：与界面「座位指数」同口径（v7 · 4-9「按当前布局重算」）：
//   历史快照的 [r][c] 先还原成「第几个座位行 / 第几个座位列」（跳过当时的走廊），
//   再对到当前布局的同一逻辑座位取当前权重。几何变化后不串位。
function seatAxisMaps(rowsLen, colsLen, types) {
  const rowOrd = new Array(Math.max(0, rowsLen)).fill(-1);
  let ord = 0;
  for (let r = 0; r < rowOrd.length; r += 1) {
    if (rowIsAisle(types, r)) continue;
    rowOrd[r] = ord;
    ord += 1;
  }
  const colOrd = new Array(Math.max(0, colsLen)).fill(-1);
  seatColumnIndices(colsLen, types).forEach((c, k) => {
    if (c >= 0 && c < colOrd.length) colOrd[c] = k;
  });
  return { rowOrd, colOrd };
}
function ordToGrid(ordArr) {
  const out = [];
  ordArr.forEach((ord, grid) => { if (ord >= 0) out[ord] = grid; });
  return out;
}

function scoreSeatIndex(fromD, toD, lim) {
  const w = aiStore.readSeatWeight();
  const weights = w ? (aiParseJson(w.weights, []) || []) : [];
  const cur = aiStore.readSeatDoc();
  const curTypes = cur ? (aiParseJson(cur.types, []) || []) : [];
  const curRows = Math.max(weights.length, Array.isArray(curTypes) ? curTypes.length : 0);
  const curCols = Math.max(
    Number(cur && cur.cols) || 0,
    weights.reduce((mx, row) => Math.max(mx, Array.isArray(row) ? row.length : 0), 0),
  );
  const curMaps = seatAxisMaps(curRows, curCols, curTypes);
  const curRowGrid = ordToGrid(curMaps.rowOrd);
  const curColGrid = ordToGrid(curMaps.colOrd);
  const idName = studentIdNameMap();
  const rows = aiStore.readSeatHistory(fromD, toD);
  const acc = {};
  for (const row of rows) {
    const seats = aiParseJson(row.seats, []) || [];
    const histTypes = aiParseJson(row.types, []) || [];
    const histCols = Math.max(Number(row.cols) || 0, seats.reduce((mx, r) => Math.max(mx, Array.isArray(r) ? r.length : 0), 0));
    const hist = seatAxisMaps(seats.length, histCols, histTypes);
    for (let r = 0; r < seats.length; r++) {
      const sRow = Array.isArray(seats[r]) ? seats[r] : [];
      const rowOrd = hist.rowOrd[r];
      if (rowOrd < 0) continue;
      const gr = curRowGrid[rowOrd];
      if (gr === undefined) continue;
      const wRow = weights[gr];
      if (!Array.isArray(wRow)) continue;
      for (let c = 0; c < sRow.length; c++) {
        const colOrd = c < hist.colOrd.length ? hist.colOrd[c] : -1;
        if (colOrd < 0) continue;
        const gc = curColGrid[colOrd];
        if (gc === undefined) continue;
        const v = sRow[c];
        if (v == null || v === '') continue;
        const wv = wRow[gc];
        if (typeof wv !== 'number') continue;
        const name = typeof v === 'number' ? (idName[v] || `#${v}`) : String(v);
        acc[name] = (acc[name] || 0) + wv;
      }
    }
  }
  const list = Object.keys(acc).map((name) => ({ 姓名: name, 得分: acc[name] })).filter((x) => x.得分 !== 0).sort((a, b) => b.得分 - a.得分);
  return { 覆盖天数: rows.length, 人数: list.length, 最差: list.slice(0, lim), 最好: list.slice(-lim).reverse() };
}
// 值日：对学期内每日快照的每个槽位，取其项目权重 weights[项目][星期] 累加到姓名（同 DutyView dutyIndexRows）
function scoreDutyIndex(fromD, toD, lim, mode) {
  const m = mode === 'big' ? 'big' : 'daily';
  const wr = aiStore.readDutyWeight();
  const weights = wr ? unpackDutyModeCol(wr.weights, m) : {};
  const rows = aiStore.readDutyHistory(fromD, toD, m);
  const acc = {};
  for (const row of rows) {
    const cells = aiParseJson(row.cells, {}) || {};
    for (const item of Object.keys(cells)) {
      const daysMap = cells[item] || {};
      const wItem = weights[item] || {};
      for (const day of Object.keys(daysMap)) {
        const wv = wItem[day];
        if (typeof wv !== 'number') continue;
        const raw = daysMap[day];
        const names = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
        for (const nm of names) { if (!nm) continue; acc[nm] = (acc[nm] || 0) + wv; }
      }
    }
  }
  const list = Object.keys(acc).map((name) => ({ 姓名: name, 得分: acc[name] })).filter((x) => x.得分 !== 0).sort((a, b) => b.得分 - a.得分);
  return { 模式: dutyModeLabel(m), 覆盖天数: rows.length, 人数: list.length, 最差: list.slice(0, lim), 最好: list.slice(-lim).reverse() };
}
// score_weights 的依赖表来自 registry 的两组声明（业务层不手抄表名数组）。
function runScoreWeights({ type, from, to, top, mode } = {}) {
  const kind = (type === 'seat' || type === 'duty') ? type : 'both';
  let lim = 5;
  if (top != null) {
    const n = Number(top);
    if (!Number.isInteger(n) || n < 1) return { error: `top 需要是 1 以上的整数（收到：${top}）` };
    lim = Math.min(n, 50);
  }
  const seatBlocked = AI_SCORE_TABLES.seat.filter((t) => !readScope.isTableReadable(t));
  const dutyBlocked = AI_SCORE_TABLES.duty.filter((t) => !readScope.isTableReadable(t));
  const canSeat = !seatBlocked.length;
  const canDuty = !dutyBlocked.length;
  const wantSeat = kind === 'seat' || kind === 'both';
  const wantDuty = kind === 'duty' || kind === 'both';
  if (wantSeat && !canSeat && !(wantDuty && canDuty)) return { ok: false, error: readScope.closedError(seatBlocked[0]).error };
  if (kind === 'duty' && !canDuty) return { ok: false, error: readScope.closedError(dutyBlocked[0]).error };
  if (kind === 'seat' && !canSeat) return { ok: false, error: readScope.closedError(seatBlocked[0]).error };
  const st = store.semesterRange();
  const fromD = aiParseDate(from) || aiParseDate(st.start);
  const toD = aiParseDate(to) || aiTodayStr();
  const result = { ok: true, type: kind, range: { from: fromD || '(最早快照)', to: toD }, note: '口径与界面「座位指数/值日指数」一致：学期内每日快照按位置/项目权重逐天累加，数值越高代表承担越多（越吃亏）；最差=累计最高的前若干人。' };
  if (!fromD) result.note += ' 未设置学期开始日，已从最早快照算起。';
  if (wantSeat && canSeat) result.seat = scoreSeatIndex(fromD, toD, lim);
  if (wantDuty && canDuty) result.duty = scoreDutyIndex(fromD, toD, lim, mode);
  const skipped = [];
  if (wantSeat && !canSeat) skipped.push('座位指数');
  if (wantDuty && !canDuty) skipped.push('值日指数');
  if (skipped.length) result.note += ` 另有${skipped.join('、')}因依赖的表已在设置中关闭而未计算。`;
  return result;
}

module.exports = { runChecks, runConflictChecks, runScoreWeights };
