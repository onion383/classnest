// =========================================================================
// ExportExcel.exporters.js —— ExportExcel 的各格式导出与字符串构建（方法模块）
//
// 逐字搬运自 ExportExcel.vue 的 methods，未改写任何逻辑与注释；
// 方法体内部经 ctx 闭包调用（script setup），ctx 承载组件状态与跨模块方法。
// 仅 doExport / open / close / cancel 留在主组件。
// =========================================================================
import { loadPdfFontBase64, collectPdfText } from '../../../utils/pdfFont.js'
import { saveBlobWithDialog } from '../../../utils/saveFile.js'
import { csvCell } from '../../../utils/csvCell.js'
import { toRaw } from 'vue'

const SECTION_NAMES = { morning: '上午', noon: '中午', afternoon: '下午', evening: '傍晚', night: '晚上' };

// 导出表头统一色：以 HTML 导出的表头蓝 #3b82f6 为准。
// 图片 / PDF / Excel / 分组导出都取这一份，避免各写一份色值后分叉。
const EXPORT_HEAD_BG = '#3b82f6';
const EXPORT_HEAD_FG = '#ffffff';
const EXPORT_HEAD_RGB = [59, 130, 246];
const EXPORT_HEAD_ARGB = 'FF3B82F6';

// 截图用单元格基础样式。html2canvas 不解析 table-cell 的 vertical-align
// （它按 Range 的文本基线画字），只写 vertical-align:middle 会「踩着底线」；
// 改成固定行高 + 等高 line-height，让浏览器真实布局把字居中，Range 矩形才居中。
const SCREENSHOT_CELL = 'border:1px solid #ccc; padding:0 12px; height:34px; line-height:34px; text-align:center; vertical-align:middle; border-radius:0;';

// html2canvas 截图前在克隆文档里统一：清掉毛玻璃主题给表格/表头加的圆角、
// 表头刷成导出蓝、单元格文字垂直居中。只改克隆，页面本身不受影响。
function normalizeScreenshotTable(clonedEl) {
  if (!clonedEl) return;
  const table = clonedEl.tagName === 'TABLE' ? clonedEl : clonedEl.querySelector('table');
  const scope = table || clonedEl;
  scope.style.borderRadius = '0';
  if (clonedEl !== scope) clonedEl.style.borderRadius = '0';
  if (clonedEl.style.overflow === 'hidden') clonedEl.style.overflow = 'visible';
  scope.querySelectorAll('th, td').forEach(cell => {
    const h = Math.max(24, Math.round(cell.getBoundingClientRect().height || cell.offsetHeight || 34));
    cell.style.lineHeight = `${h}px`;
    cell.style.paddingTop = '0';
    cell.style.paddingBottom = '0';
    cell.style.verticalAlign = 'middle';
    cell.style.borderRadius = '0';
    if (cell.tagName === 'TH' && cell.closest('thead')) {
      cell.style.backgroundColor = EXPORT_HEAD_BG;
      cell.style.color = EXPORT_HEAD_FG;
    }
  });
}

export function useExportFormats(ctx) {
  // 写盘出口。默认走系统保存对话框（原有行为不变）；
  // 调用方在 ctx 上注入 saveFile 时改走注入实现 —— 设置页「数据管理」就是用它把
  // 每张表的内容收进 zip，而不是每张表弹一次保存对话框。格式构建逻辑完全共用，
  // 所以这里只是换出口，不复制第二份导出实现。
  const saveFile = (name, blob) => (typeof ctx.saveFile === 'function' ? ctx.saveFile(name, blob) : saveBlobWithDialog(name, blob));

  return {

    getSectionName(key) {
      return SECTION_NAMES[key] || '';
    },

    isScheduleData(rows) {
      if (!rows || rows.length === 0) return false;
      return rows.some(r => r.type === 'lesson' || r.type === 'globalRest' || r.type === 'innerRest');
    },

    getCellValue(row, headerName, headers) {
      if (headerName === '时段') return ctx.getSectionName(row.section);
      if (headerName === '节次') return row.label || '';
      if (headerName === '时间') return row.time || '';
      if (row[headerName] !== undefined) return row[headerName];
      const idx = headers.indexOf(headerName) - 3;
      if (idx >= 0 && row.cells && row.cells[idx]) return row.cells[idx].course || '';
      return '';
    },

    // 判断是否为讲台行，并且有行号列
    isPodiumRowWithRowNum(row, headers) {
      return row._isPodium && headers.length > 1 && headers[0] === '行号';
    },

    // 检查某列是否为行号列（表头为“行号”）
    isRowNumColumn(headerName) {
      return headerName === '行号';
    },

    // 检查某列是否为走廊列（表头为“走廊”）
    isAisleColumn(headerName) {
      return headerName === '走廊';
    },

    // ==================== 分组导出（groupSource 模式） ====================
    // 按小组下标取小组对象
    groupObjects(idxList) {
      return idxList.map(i => ctx.groupSource.value.groups[i]);
    },
    // 拉平为二维表（用于 CSV / HTML / XLSX 标题行）
    groupFlatRows(idxList) {
      const leaderTitle = ctx.groupSource.value.leaderTitle || '组长';
      const rows = [['小组', '成员', '备注', '职务']];
      ctx.groupObjects(idxList).forEach(g => {
        let first = true;
        for (const m of g.members || []) {
          rows.push([first ? g.name : '', m.member_name || '', m.remark || '', first ? leaderTitle : '']);
          first = false;
        }
      });
      return rows;
    },
    // 生成带标题、可截图/打印的分组 HTML 表格串
    groupTableHTML(idxList, filename) {
      const rows = ctx.groupFlatRows(idxList);
      const head = rows[0];
      const body = rows.slice(1);
      let html = `<div style="text-align:center; font-size:20px; font-weight:bold; margin-bottom:12px;">${ctx.escapeHtml(filename)}</div>`;
      html += '<table style="border-collapse:collapse; margin:0 auto; border-radius:0;">';
      // 表头同样要转义（F03-08）：组名/列名允许用户输入，含 `<` 会破坏导出页结构
      html += `<thead><tr style="background-color:${EXPORT_HEAD_BG}; color:${EXPORT_HEAD_FG};">${head.map(h => `<th style="${SCREENSHOT_CELL}">${ctx.escapeHtml(String(h ?? ''))}</th>`).join('')}</tr></thead><tbody>`;
      for (const r of body) {
        const cells = r.map((c, i) => {
          let style = SCREENSHOT_CELL;
          if (r[0] && i === 0) style += ' font-weight:bold; background-color:#BDD7EE;';
          else if (r[3]) style += ' font-weight:bold;';
          return `<td style="${style}">${String(c ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>`;
        });
        html += `<tr>${cells.join('')}</tr>`;
      }
      html += '</tbody></table>';
      return html;
    },
    async exportGroupCSV(idxList, filename) {
      const rows = ctx.groupFlatRows(idxList);
      const csv = '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      return await saveFile(`${filename}.csv`, blob);
    },
    async exportGroupHTML(idxList, filename) {
      const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${ctx.escapeHtml(filename)}</title></head><body>${ctx.groupTableHTML(idxList, filename)}</body></html>`;
      const blob = new Blob([html], { type: 'text/html' });
      return await saveFile(`${filename}.html`, blob);
    },
    async exportGroupMD(idxList, filename) {
      const rows = ctx.groupFlatRows(idxList);
      const md = ctx.buildMarkdown(rows[0], rows.slice(1), filename);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
      return await saveFile(`${filename}.md`, blob);
    },
    async exportGroupTXT(idxList, filename) {
      const rows = ctx.groupFlatRows(idxList);
      const txt = ctx.buildTxt(rows[0], rows.slice(1), filename);
      const blob = new Blob([txt], { type: 'text/plain;charset=utf-8;' });
      return await saveFile(`${filename}.txt`, blob);
    },
    async exportGroupJSON(idxList, filename) {
      const rows = ctx.groupFlatRows(idxList);
      const json = ctx.buildJson(rows[0], rows.slice(1));
      const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
      return await saveFile(`${filename}.json`, blob);
    },
    async exportGroupImage(idxList, filename) {
      const { default: html2canvas } = await import('html2canvas');
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = ctx.groupTableHTML(idxList, filename);
      tempDiv.style.position = 'absolute';
      tempDiv.style.left = '-9999px';
      document.body.appendChild(tempDiv);
      try {
        ctx.reportProgress(20)
        const canvas = await html2canvas(tempDiv, { scale: 2, onclone: (_, cloned) => normalizeScreenshotTable(cloned) });
        ctx.reportProgress(60)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) return false;
        ctx.reportProgress(90)
        return await saveFile(`${filename}.png`, blob);
      } finally { document.body.removeChild(tempDiv); }
    },
    async exportGroupPDF(idxList, filename) {
      const { default: html2canvas } = await import('html2canvas');
      const { default: jsPDF } = await import('jspdf');
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = ctx.groupTableHTML(idxList, filename);
      tempDiv.style.position = 'absolute';
      tempDiv.style.left = '-9999px';
      // 分组表是整表截图进 PDF：字号调大后按页面宽度缩放，落到纸面上的字也会更大
      tempDiv.style.fontSize = '18px';
      // 分组 PDF 是整表截图：数据行统一白底黑字便于打印，表头保留导出蓝
      // （只影响本次 PDF 截图，HTML / 图片导出仍走 groupTableHTML 的原配色）
      tempDiv.querySelectorAll('[style]').forEach((el) => {
        if (el.closest('thead')) return;
        el.style.backgroundColor = '#ffffff';
        el.style.color = '#000000';
      });
      document.body.appendChild(tempDiv);
      try {
        ctx.reportProgress(20)
        const canvas = await html2canvas(tempDiv, { scale: 2, onclone: (_, cloned) => normalizeScreenshotTable(cloned) });
        ctx.reportProgress(60)
        const img = canvas.toDataURL('image/png');
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const ratio = canvas.width / canvas.height;
        let w = pageW - 20;
        let h = w / ratio;
        if (h > pageH - 20) { h = pageH - 20; w = h * ratio; }
        doc.addImage(img, 'PNG', (pageW - w) / 2, (pageH - h) / 2, w, h);
        // 不能 doc.save()：它会直接触发下载，既绕过系统保存对话框，也绕过
        // 文件名清洗（所有格式都必须走 saveBlobWithDialog，这里曾经漏过）。
        ctx.reportProgress(90)
        return await saveFile(`${filename}.pdf`, doc.output('blob'));
      } finally { document.body.removeChild(tempDiv); }
    },
    async exportGroupXLSX(idxList, filename) {
      const { default: ExcelJS } = await import('exceljs');
      ctx.reportProgress(20)
      const gs = ctx.groupSource.value;
      const leaderTitle = gs.leaderTitle || '组长';
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('分组表');
      const headers = [leaderTitle, '成员', '备注'];
      // 标题行
      const titleRow = sheet.addRow([filename]);
      sheet.mergeCells(1, 1, 1, headers.length);
      // 逐列取单元格写样式（eachCell 会跳过空值单元格，合并列会漏边框）
      for (let col = 1; col <= headers.length; col++) {
        const c = sheet.getCell(1, col);
        c.font = { bold: true, size: 14 };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
        c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      }
      titleRow.height = 24;
      let r = 2;
      ctx.groupObjects(idxList).forEach(g => {
        // 组名行（合并全列）
        sheet.addRow([]);
        sheet.mergeCells(r, 1, r, headers.length);
        const nc = sheet.getCell(r, 1);
        nc.value = g.name;
        nc.font = { bold: true };
        nc.alignment = { horizontal: 'left', vertical: 'middle' };
        for (let col = 1; col <= headers.length; col++) sheet.getCell(r, col).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        sheet.getRow(r).height = 20;
        r++;
        // 表头行：与 HTML / 图片 / PDF 统一蓝底白字
        const headRow = sheet.addRow(headers);
        for (let col = 1; col <= headers.length; col++) {
          const c = sheet.getCell(headRow.number, col);
          c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXPORT_HEAD_ARGB } };
          c.alignment = { horizontal: 'center', vertical: 'middle' };
          c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        }
        r++;
        // 组长行 + 成员行
        (g.members || []).forEach((m, mi) => {
          const row = sheet.addRow([mi === 0 ? leaderTitle : '', m.member_name || '', m.remark || '']);
          for (let col = 1; col <= headers.length; col++) {
            const c = sheet.getCell(row.number, col);
            c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
          }
          if (mi === 0) sheet.getCell(r, 1).font = { bold: true };
          r++;
        });
        r++; // 空行分隔
      });
      for (let i = 1; i <= headers.length; i++) sheet.getColumn(i).width = 20;
      ctx.reportProgress(70)
      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      ctx.reportProgress(90)
      return await saveFile(`${filename}.xlsx`, blob);
    },

    // ==================== XLSX ====================
    async exportXLSX(rows, fields, filename) {
      const { default: ExcelJS } = await import('exceljs');
      ctx.reportProgress(20)
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sheet1');
      const headers = fields.map(f => f.name);
      const isSchedule = ctx.isScheduleData(rows);
      const periodCol = headers.indexOf('时段') + 1;

      // 标题行
      const titleRow = sheet.addRow([filename]);
      sheet.mergeCells(1, 1, 1, headers.length);
      titleRow.height = 24;
      // 逐列取单元格再写样式：eachCell 默认跳过空单元格，合并/空值列会漏掉边框
      for (let col = 1; col <= headers.length; col++) {
        const cell = sheet.getCell(1, col);
        cell.font = { bold: true, size: 14, color: { argb: 'FF000000' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      }

      // 表头行：与 HTML / 图片 / PDF 统一蓝底白字
      const headerRow = sheet.addRow(headers);
      for (let col = 1; col <= headers.length; col++) {
        const cell = sheet.getCell(headerRow.number, col);
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: EXPORT_HEAD_ARGB } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      }

      let currentRow = headerRow.number + 1;

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // ---------- 讲台行处理 ----------
        if (row._isPodium) {
          const isRowNumTable = ctx.isPodiumRowWithRowNum(row, headers);
          const rowData = new Array(headers.length).fill('');
          if (isRowNumTable) {
            rowData[0] = '讲台';
          } else {
            rowData[0] = '讲  台';
          }
          const podiumRow = sheet.addRow(rowData);
          podiumRow.height = 20;

          if (isRowNumTable && headers.length > 1) {
            // 第一列（行号）
            const numCell = sheet.getCell(currentRow, 1);
            numCell.font = { bold: true, color: { argb: 'FF000000' } };
            numCell.alignment = { horizontal: 'center', vertical: 'middle' };
            numCell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            // 合并其余列
            sheet.mergeCells(currentRow, 2, currentRow, headers.length);
            const mergedCell = sheet.getCell(currentRow, 2);
            mergedCell.value = '讲  台';
            mergedCell.font = { bold: true, color: { argb: 'FF000000' } };
            mergedCell.alignment = { horizontal: 'center', vertical: 'middle' };
            for (let col = 2; col <= headers.length; col++) {
              const cell = sheet.getCell(currentRow, col);
              cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            }
          } else {
            // 整行合并
            sheet.mergeCells(currentRow, 1, currentRow, headers.length);
            const cell = sheet.getCell(currentRow, 1);
            cell.value = '讲  台';
            cell.font = { bold: true, color: { argb: 'FF000000' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            for (let col = 1; col <= headers.length; col++) {
              sheet.getCell(currentRow, col).border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            }
          }
          currentRow++;
          continue;
        }

        if (row.type === 'globalRest') {
          const displayText = row.label ? `${row.label} ${row.time}` : '';
          const data = new Array(headers.length).fill('');
          const mergeRow = sheet.addRow(data);
          mergeRow.height = 20;
          sheet.mergeCells(currentRow, 1, currentRow, headers.length);
          const cell = mergeRow.getCell(1);
          cell.value = displayText;
          for (let col = 1; col <= headers.length; col++) {
            const c = sheet.getCell(currentRow, col);
            c.font = { bold: true, color: { argb: 'FF000000' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
          }
          currentRow++;
        } else if (row.type === 'innerRest') {
          const displayText = row.label ? `${row.label} ${row.time}` : '';
          const data = new Array(headers.length).fill('');
          const mergeRow = sheet.addRow(data);
          mergeRow.height = 20;
          if (periodCol > 1) {
            const startCol = periodCol + 1;
            sheet.mergeCells(currentRow, startCol, currentRow, headers.length);
            const cell = sheet.getCell(currentRow, startCol);
            cell.value = displayText;
          } else {
            sheet.mergeCells(currentRow, 1, currentRow, headers.length);
            const cell = mergeRow.getCell(1);
            cell.value = displayText;
          }
          for (let col = 1; col <= headers.length; col++) {
            const c = sheet.getCell(currentRow, col);
            if (periodCol > 1 && col === periodCol) {
              c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
              continue;
            }
            c.font = { bold: true, color: { argb: 'FF000000' } };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
          }
          currentRow++;
        } else {
          // 普通行或座位行
          const rowData = headers.map((h, colIdx) => {
            const val = row[h] !== undefined ? row[h] : '';
            return val;
          });
          const dataRow = sheet.addRow(rowData);
          // 逐列写样式（不用 eachCell）：空值/null 的单元格会被 eachCell 跳过，
          // 导致「有数据的格子有边框、没数据的格子没边框」，导出后表格看着残缺。
          for (let col = 1; col <= headers.length; col++) {
            const cell = sheet.getCell(dataRow.number, col);
            const headerName = headers[col - 1];
            // 设置边框和对齐
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            // 行号列样式
            if (ctx.isRowNumColumn(headerName)) {
              cell.font = { bold: true, color: { argb: 'FF000000' } };
            } else if (ctx.isAisleColumn(headerName)) {
              cell.font = { color: { argb: 'FF000000' } };
            } else {
              // 普通单元格保持默认白色背景
              cell.font = { color: { argb: 'FF000000' } };
            }
          }

          // 课程表时段列竖向合并（如果是课程表数据）
          if (isSchedule && periodCol > 1 && row._rowSpan > 1 && row._isFirstInBlock) {
            sheet.mergeCells(currentRow, periodCol, currentRow + row._rowSpan - 1, periodCol);
            for (let j = 1; j < row._rowSpan; j++) {
              sheet.getCell(currentRow + j, periodCol).border = {
                top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' }
              };
            }
          }
          currentRow++;
        }
      }

      // 列宽
      // 表头也按「中文记 2.2 宽」来量：只按字符个数（中文记 1）+6 估算时，
      // 「家长联系电话」这类纯中文长表头刚好卡边，Excel 里相邻两列表头会互相压住。
      // 字符宽度换算与 Excel 列宽单位（默认字体的 "0" 宽）对齐，留 8 余量。
      const displayLen = (str) => {
        let n = 0;
        for (const ch of String(str ?? '')) n += /[\u4e00-\u9fa5]/.test(ch) ? 2.2 : 1;
        return n;
      };
      for (let i = 1; i <= headers.length; i++) {
        let maxLen = displayLen(headers[i - 1]);
        rows.forEach(row => {
          if (row._isPodium) return;
          if (row.type !== 'globalRest' && row.type !== 'innerRest') {
            const charLen = displayLen(row[headers[i - 1]] || '');
            if (charLen > maxLen) maxLen = charLen;
          }
        });
        sheet.getColumn(i).width = Math.max(12, Math.min(maxLen + 8, 60));
      }
      ctx.reportProgress(70)

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      ctx.reportProgress(90)
      return await saveFile(`${filename}.xlsx`, blob);
    },

    // ==================== HTML ====================
    // 导出一份自包含的静态表格：样式与页面上的 DynamicTable / GridView 对齐，
    // 不内嵌任何脚本 —— 发给别人只用于查看/打印，打开即定稿。
    async exportHTMLTable(rows, fields, filename) {
      const headers = fields.map(f => f.name);
      const periodColIdx = headers.indexOf('时段');
      const esc = ctx.escapeHtml;
      const rowHeadTable = ctx.isRowNumColumn(headers[0]) || headers[0] === '项目' || headers[0] === '劳动项目'
        || rows.some(r => r._isPodium);
      ctx.reportProgress(20)

      let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(filename)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 24px; background: #fff; color: #1f2937; font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
  h2 { margin: 0 0 16px; text-align: center; font-size: 20px; }
  table.dt { margin: 0 auto; border-collapse: collapse; }
  table.dt th, table.dt td { border: 1px solid #9ca3af; padding: 6px 10px; font-size: 14px; line-height: 1.5; text-align: center; vertical-align: middle; }
  table.dt thead th { background: #3b82f6; color: #fff; font-weight: 700; white-space: nowrap; }
  table.dt th.row-head, table.dt td.row-head { background: #3b82f6; color: #fff; font-weight: 700; width: 110px; }
  /* 表头统一蓝，走廊列也不例外：灰色只给数据区的走廊格，否则 thead 里会突兀地出现一格灰。
     原来 th.aisle / td.aisle 共用一条规则，特异性又高于 thead th，把走廊列表头染成了灰。 */
  table.dt thead th.aisle { width: 36px; }
  table.dt td.aisle { width: 36px; background: #e5e7eb; writing-mode: vertical-lr; text-orientation: upright; letter-spacing: 2px; }
  table.dt td.period { background: #eff6ff; font-weight: 700; }
  table.dt tr.fixed td.podium { background: #fef3c7; font-weight: 700; font-size: 18px; letter-spacing: 6px; }
  table.dt tr.fixed td.podium-tag { background: #3b82f6; color: #fff; font-weight: 700; }
  table.dt tr.fixed td.rest { background: #f3f4f6; color: #4b5563; font-weight: 600; }
</style></head><body>
<h2>${esc(filename)}</h2>
<table class="dt">
  <thead><tr>${headers.map((h, i) => {
    const isRowHead = rowHeadTable && i === 0;
    const isAisle = ctx.isAisleColumn(h);
    const cls = [isRowHead ? 'row-head' : '', isAisle ? 'aisle' : ''].filter(Boolean).join(' ');
    return `<th${cls ? ` class="${cls}"` : ''}>${esc(h)}</th>`;
  }).join('')}</tr></thead>
  <tbody>`;

      for (const row of rows) {
        // ---------- 讲台行（保持跨列合并） ----------
        if (row._isPodium) {
          html += '<tr class="fixed">';
          if (rowHeadTable) {
            html += '<td class="podium-tag">讲台</td>';
            if (headers.length > 1) html += `<td class="podium" colspan="${headers.length - 1}">讲  台</td>`;
          } else {
            html += `<td class="podium" colspan="${headers.length}">讲  台</td>`;
          }
          html += '</tr>';
          continue;
        }

        if (row.type === 'globalRest') {
          const displayText = row.label ? `${row.label} ${row.time}` : '';
          html += `<tr class="fixed"><td class="rest" colspan="${headers.length}">${esc(displayText)}</td></tr>`;
        } else if (row.type === 'innerRest') {
          const displayText = row.label ? `${row.label} ${row.time}` : '';
          const remainingCols = periodColIdx >= 0 ? headers.length - periodColIdx - 1 : headers.length;
          html += `<tr class="fixed"><td class="rest" colspan="${remainingCols}">${esc(displayText)}</td></tr>`;
        } else {
          html += '<tr>';
          for (let i = 0; i < headers.length; i++) {
            const h = headers[i];
            const cellVal = row[h] !== undefined ? row[h] : '';
            const isRowHead = rowHeadTable && i === 0;
            const isAisle = ctx.isAisleColumn(h) || String(cellVal).trim() === '走廊';
            const isPeriod = h === '时段';

            if (isRowHead) {
              html += `<td class="row-head">${esc(cellVal)}</td>`;
              continue;
            }
            const cls = [isAisle ? 'aisle' : '', isPeriod ? 'period' : ''].filter(Boolean).join(' ');
            html += `<td${cls ? ` class="${cls}"` : ''}>${esc(cellVal)}</td>`;
          }
          html += '</tr>';
        }
      }

      ctx.reportProgress(70)
      html += '</tbody></table></body></html>';
      ctx.reportProgress(90)
      const blob = new Blob([html], { type: 'text/html' });
      return await saveFile(`${filename}.html`, blob);
    },

    // ==================== CSV ====================
    async exportCSV(rows, fields, filename) {
      const headers = fields.map(f => f.name);
      // 保持逐行 `+=`：实测 5 万行时它与「数组 join」都在 32ms 上下（互有胜负，属噪声），
      // V8 的 rope 字符串对连续拼接本来就有优化，没必要为此多一层数组。
      // 表头必须和数据行走同一个转义：列名里带逗号/引号时，不过 csvCell 会让整行列错位；
      // 另外 csvCell 还负责挡 =+@ 开头的公式注入，表头同样能触发（审查 v4 · B09-02）。
      let csv = '\uFEFF' + headers.map(h => csvCell(h)).join(',') + '\n';
      rows.forEach(row => {
        if (row._isPodium) {
          const isRowNumTable = ctx.isPodiumRowWithRowNum(row, headers);
          if (isRowNumTable) {
            csv += '讲台,讲  台,'.repeat(headers.length - 1).slice(0, -1) + '\n';
          } else {
            csv += '讲台,'.repeat(headers.length).slice(0, -1) + '\n';
          }
          return;
        }
        if (row.type === 'globalRest' || row.type === 'innerRest') return;
        const line = headers.map(h => {
          const v = row[h] !== undefined ? row[h] : '';
          return csvCell(v);
        }).join(',');
        csv += line + '\n';
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      return await saveFile(`${filename}.csv`, blob);
    },

    // ==================== Markdown ====================
    // 单元格转义：管道符会破坏表格结构，反斜杠先转义，换行转为 <br>
    mdEscape(v) {
      const s = v == null ? '' : String(v);
      return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    },
    buildMarkdown(headers, bodyRows, filename) {
      const rowLine = cells => `| ${cells.map(c => ctx.mdEscape(c)).join(' | ')} |`;
      const lines = [
        `# ${ctx.mdEscape(filename)}`,
        '',
        rowLine(headers),
        `| ${headers.map(() => '---').join(' | ')} |`,
        ...bodyRows.map(rowLine)
      ];
      return lines.join('\n') + '\n';
    },
    // 将 rows+fields 规整为 { headers, bodyRows }（bodyRows 为「数组的数组」），供 md/txt/json 复用
    buildTableArrays(rows, fields) {
      const headers = fields.map(f => f.name);
      const isSchedule = ctx.isScheduleData(rows);
      const bodyRows = [];
      for (const row of rows) {
        // ---------- 讲台行 ----------
        if (row._isPodium) {
          const isRowNumTable = ctx.isPodiumRowWithRowNum(row, headers);
          const arr = new Array(headers.length).fill('');
          if (isRowNumTable && headers.length > 1) {
            arr[0] = '讲台';
            arr[1] = '讲  台';
          } else {
            arr[0] = '讲  台';
          }
          bodyRows.push(arr);
          continue;
        }
        // ---------- 全局 / 内部休息行 ----------
        if (row.type === 'globalRest' || row.type === 'innerRest') {
          const displayText = row.label ? `${row.label} ${row.time}` : '';
          const arr = new Array(headers.length).fill('');
          arr[0] = displayText;
          bodyRows.push(arr);
          continue;
        }
        // ---------- 普通行 ----------
        const arr = headers.map(h => {
          if (isSchedule && h === '时段') {
            if (row._rowSpan > 1 && row._isFirstInBlock) return SECTION_NAMES[row.section] || '';
            if (row._rowSpan === 0) return '';
          }
          return row[h] !== undefined ? row[h] : '';
        });
        bodyRows.push(arr);
      }
      return { headers, bodyRows };
    },
    async exportMD(rows, fields, filename) {
      const { headers, bodyRows } = ctx.buildTableArrays(rows, fields);
      const md = ctx.buildMarkdown(headers, bodyRows, filename);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8;' });
      return await saveFile(`${filename}.md`, blob);
    },

    // ==================== 纯文本 (TXT) ====================
    // 首行标题 + 按「显示宽度」对齐的等宽表格：中文/全角记 2 宽，其余记 1 宽，
    // 每列补齐空格到该列最宽值，列间留 2 空格；表头下再画一条等宽分隔线。
    // 单元格内的 Tab/换行压成空格，避免撑破列对齐（Tab 分隔在中文列下本来也对不齐）。
    buildTxt(headers, bodyRows, title) {
      const clean = c => String(c == null ? '' : c).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
      const width = s => {
        let n = 0;
        for (const ch of s) n += /[^\x00-\xff]/u.test(ch) ? 2 : 1;
        return n;
      };
      const rows = [headers, ...bodyRows].map(r => r.map(clean));
      const cols = headers.map((_, i) => Math.max(...rows.map(r => width(r[i] ?? ''))));
      const line = r => r.map((c, i) => c + ' '.repeat(cols[i] - width(c))).join('  ').trimEnd();
      const sep = cols.map(w => '-'.repeat(w)).join('  ');
      const heading = title ? [clean(title), '='.repeat(width(clean(title))), ''] : [];
      return [...heading, line(rows[0]), sep, ...rows.slice(1).map(line)].join('\r\n') + '\r\n';
    },
    async exportTXT(rows, fields, filename) {
      const { headers, bodyRows } = ctx.buildTableArrays(rows, fields);
      const txt = ctx.buildTxt(headers, bodyRows, filename);
      const blob = new Blob([txt], { type: 'text/plain;charset=utf-8;' });
      return await saveFile(`${filename}.txt`, blob);
    },

    // ==================== JSON ====================
    // 以表头为键的对象数组，便于程序化处理/再导入
    buildJson(headers, bodyRows) {
      const data = bodyRows.map(arr => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = arr[i] === undefined || arr[i] === null ? '' : arr[i]; });
        return obj;
      });
      return JSON.stringify(data, null, 2) + '\n';
    },
    async exportJSON(rows, fields, filename) {
      const { headers, bodyRows } = ctx.buildTableArrays(rows, fields);
      const json = ctx.buildJson(headers, bodyRows);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8;' });
      return await saveFile(`${filename}.json`, blob);
    },

    // ==================== 图片 ====================
    async exportImage(rows, fields, filename) {
      const { default: html2canvas } = await import('html2canvas');
      ctx.reportProgress(20)
      const el = ctx.tableElement.value instanceof Element ? ctx.tableElement.value : null;
      if (el && el.offsetParent !== null) {
        try {
          const canvas = await html2canvas(el, { scale: 2, onclone: (_, cloned) => normalizeScreenshotTable(cloned) });
          ctx.reportProgress(60)
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          if (blob) { ctx.reportProgress(90); return await saveFile(`${filename}.png`, blob); }
        } catch (e) {
          // 截图失败（canvas 污染、元素不可渲染等）：退回下面的离屏渲染再试一次
          console.warn('[export] 表格截图失败，退回离屏渲染：', e);
        }
      }

      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = ctx.buildHTMLString(rows, fields, filename);
      tempDiv.style.position = 'absolute';
      tempDiv.style.left = '-9999px';
      document.body.appendChild(tempDiv);
      // 必须 try/finally：html2canvas 抛错时若不摘除，这个临时节点会永久留在 body 里，
      // 反复失败的导出会一直堆积（而且它是 -9999px 的离屏节点，肉眼看不见、也排查不到）。
      let canvas;
      try {
        canvas = await html2canvas(tempDiv, { scale: 2, onclone: (_, cloned) => normalizeScreenshotTable(cloned) });
        ctx.reportProgress(60)
      } finally {
        document.body.removeChild(tempDiv);
      }
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      ctx.reportProgress(90)
      return await saveFile(`${filename}.png`, blob);
    },

    escapeHtml(str) {
      const s = str == null ? '' : String(str);
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    },

    buildHTMLString(rows, fields, filename) {
      const headers = fields.map(f => f.name);
      const periodColIdx = headers.indexOf('时段');

      let html = `<div style="text-align:center; font-size:20px; font-weight:bold; margin-bottom:12px;">${ctx.escapeHtml(filename)}</div>
        <table style="border-collapse:collapse; margin:0 auto; border-radius:0;">
          <thead><tr style="background-color:${EXPORT_HEAD_BG}; color:${EXPORT_HEAD_FG};">
            ${headers.map(h => `<th style="${SCREENSHOT_CELL}">${ctx.escapeHtml(h)}</th>`).join('')}
          </tr></thead><tbody>`;

      for (const row of rows) {
        // ---------- 讲台行 ----------
        if (row._isPodium) {
          const isRowNumTable = ctx.isPodiumRowWithRowNum(row, headers);
          html += '<tr>';
          if (isRowNumTable) {
            html += `<td style="${SCREENSHOT_CELL} font-weight:bold; background-color:${EXPORT_HEAD_BG}; color:${EXPORT_HEAD_FG};">讲台</td>`;
            if (headers.length > 1) {
              html += `<td colspan="${headers.length - 1}" style="${SCREENSHOT_CELL} font-weight:bold; background-color:#FFF9C4;">讲  台</td>`;
            }
          } else {
            html += `<td colspan="${headers.length}" style="${SCREENSHOT_CELL} font-weight:bold; background-color:#FFF9C4;">讲  台</td>`;
          }
          html += '</tr>';
          continue;
        }

        if (row.type === 'globalRest') {
          const displayText = row.label ? `${row.label} ${row.time}` : '';
          html += `<tr><td colspan="${headers.length}" style="${SCREENSHOT_CELL} font-weight:bold; background-color:#D9D9D9;">${ctx.escapeHtml(displayText)}</td></tr>`;
        } else if (row.type === 'innerRest') {
          const displayText = row.label ? `${row.label} ${row.time}` : '';
          html += '<tr>';
          if (periodColIdx >= 0) {
            const remainingCols = headers.length - periodColIdx - 1;
            html += `<td colspan="${remainingCols}" style="${SCREENSHOT_CELL} font-weight:bold; background-color:#D9D9D9;">${ctx.escapeHtml(displayText)}</td>`;
          } else {
            html += `<td colspan="${headers.length}" style="${SCREENSHOT_CELL} font-weight:bold; background-color:#D9D9D9;">${ctx.escapeHtml(displayText)}</td>`;
          }
          html += '</tr>';
        } else {
          html += '<tr>';
          for (let i = 0; i < headers.length; i++) {
            const h = headers[i];
            const cellVal = row[h] !== undefined ? row[h] : '';
            let style = SCREENSHOT_CELL;
            if (h === '行号') {
              style += ` background-color:${EXPORT_HEAD_BG}; color:${EXPORT_HEAD_FG}; font-weight:bold;`;
            } else if (h === '走廊') {
              style += ' background-color:#D9D9D9;';
            }
            html += `<td style="${style}">${ctx.escapeHtml(cellVal)}</td>`;
          }
          html += '</tr>';
        }
      }

      html += '</tbody></table>';
      return html;
    },

    // ==================== PDF ====================
    async exportPDF(rows, fields, filename) {
      const { default: jsPDF } = await import('jspdf');
      const { default: autoTable } = await import('jspdf-autotable');
      ctx.reportProgress(20)
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

      let fontLoaded = false;
      try {
        // 字体按「本次实际要画的字符」现做子集（十几 KB）再嵌入，不再整份塞 13MB 全量字体。
        // 子集来源：文件名 + 表头 + 原始行数据（含 label/time 等派生字段），
        // 渲染时由代码拼出的固定词由 utils/pdfFont.js 的兜底字符覆盖。
        // toRaw：rows/fields 来自 props，是 Vue 响应式代理，逐属性读取要比普通对象慢 7 倍
        // （实测 1000 行×20 列：28.3ms → 4.0ms）；toRaw 取回原始对象后再遍历。
        const fontBase64 = await loadPdfFontBase64(collectPdfText(filename, toRaw(fields), toRaw(rows)));
        doc.addFileToVFS('NotoSansSC.ttf', fontBase64);
        doc.addFont('NotoSansSC.ttf', 'NotoSansSC', 'normal');
        doc.addFont('NotoSansSC.ttf', 'NotoSansSC', 'bold');
        fontLoaded = true;
      } catch (e) {
        console.warn('中文字体加载失败:', e);
      }

      const pdfFont = fontLoaded ? 'NotoSansSC' : 'helvetica';
      ctx.reportProgress(40)
      const pageWidth = doc.internal.pageSize.getWidth();
      // 标题在每页重画（只画一次的话，第 2 页起只有表头没有标题，打印留档时对不上）
      const drawTitle = () => {
        doc.setFontSize(20);
        doc.setFont(pdfFont, 'normal');
        doc.text(filename, pageWidth / 2, 16, { align: 'center' });
      };

      const headers = fields.map(f => f.name);
      const isSchedule = ctx.isScheduleData(rows);
      const periodColIdx = headers.indexOf('时段');

      const body = [];
      for (const row of rows) {
        // ---------- 讲台行 ----------
        if (row._isPodium) {
          const isRowNumTable = ctx.isPodiumRowWithRowNum(row, headers);
          const arr = new Array(headers.length).fill('');
          if (isRowNumTable) {
            arr[0] = '讲台';
            arr._rowNumStyle = true;
            if (headers.length > 1) arr[1] = '讲  台';
            arr._merge = true;
            arr._mergeType = 'podium';
            arr._startIdx = 1;
          } else {
            arr[0] = '讲  台';
            arr._merge = true;
            arr._mergeType = 'podium';
            arr._startIdx = 0;
          }
          body.push(arr);
          continue;
        }

        if (row.type === 'globalRest') {
          const displayText = row.label ? `${row.label} ${row.time}` : '';
          const arr = new Array(headers.length).fill('');
          arr[0] = displayText;
          arr._merge = true;
          arr._mergeType = 'global';
          body.push(arr);
        } else if (row.type === 'innerRest') {
          const displayText = row.label ? `${row.label} ${row.time}` : '';
          const arr = new Array(headers.length).fill('');
          if (periodColIdx >= 0) {
            const startIdx = periodColIdx + 1;
            arr[startIdx] = displayText;
            arr._merge = true;
            arr._mergeType = 'inner';
            arr._startIdx = startIdx;
          } else {
            arr[0] = displayText;
            arr._merge = true;
            arr._mergeType = 'global';
          }
          body.push(arr);
        } else {
          const arr = headers.map(h => {
            if (isSchedule && h === '时段') {
              if (row._rowSpan > 1 && row._isFirstInBlock) {
                return SECTION_NAMES[row.section] || '';
              } else if (row._rowSpan === 0) {
                return '';
              }
            }
            return row[h] !== undefined ? row[h] : '';
          });
          arr._rowNumStyle = true; // 用于标记行号列样式
          arr._schedule = isSchedule; // 课程表标记
          body.push(arr);
        }
      }

      ctx.reportProgress(60)
      autoTable(doc, {
        startY: 26,
        // 每页顶部留出标题高度；showHead 显式写成 everyPage，分页后每页都带表头
        margin: { top: 26 },
        showHead: 'everyPage',
        willDrawPage: drawTitle,
        head: [headers],
        body: body,
        theme: 'plain',
        // 数据行保持白底黑字（打印/复印清楚），表头统一蓝底白字
        styles: {
          font: pdfFont,
          fontStyle: 'normal',
          fontSize: 11,
          cellPadding: 1.5,
          halign: 'center',
          textColor: [0, 0, 0],
          lineColor: [0, 0, 0],
          lineWidth: 0.1
        },
        headStyles: {
          font: pdfFont,
          fontStyle: 'bold',
          fillColor: EXPORT_HEAD_RGB,
          textColor: [255, 255, 255],
          halign: 'center',
          lineWidth: 0.1
        },
        didParseCell: function (data) {
          // 表头颜色交给 headStyles：下面的行样式不许把白字改回黑字
          if (data.row.section === 'head') return;
          const rowArr = data.row.raw;
          if (!rowArr) return;

          data.cell.styles.font = pdfFont;
          data.cell.styles.halign = 'center';
          data.cell.styles.valign = 'middle';

          // 讲台行
          if (rowArr._mergeType === 'podium') {
            if (rowArr._rowNumStyle && data.column.index === 0) {
              data.cell.styles.fontStyle = 'bold';
              return;
            }
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = [0, 0, 0];
            if (rowArr._startIdx === 0) {
              if (data.column.index === 0) {
                data.cell.colSpan = headers.length;
              } else {
                data.cell.text = [''];
              }
            } else {
              if (data.column.index === rowArr._startIdx) {
                data.cell.colSpan = headers.length - rowArr._startIdx;
              } else if (data.column.index > rowArr._startIdx) {
                data.cell.text = [''];
              }
            }
            return;
          }

          // 全局/内部休息行
          if (rowArr._merge) {
            data.cell.styles.fontStyle = 'bold';
            data.cell.styles.textColor = [0, 0, 0];
            if (rowArr._mergeType === 'global') {
              if (data.column.index === 0) {
                data.cell.colSpan = headers.length;
              } else {
                data.cell.text = [''];
              }
            } else if (rowArr._mergeType === 'inner') {
              if (data.column.index === rowArr._startIdx) {
                data.cell.colSpan = headers.length - rowArr._startIdx;
              } else if (data.column.index > rowArr._startIdx) {
                data.cell.text = [''];
              }
            }
            return;
          }

          // 普通行：根据列头设置样式
          const headerName = headers[data.column.index];
          if (headerName === '行号') {
            data.cell.styles.fontStyle = 'bold';
          } else if (headerName === '走廊') {
            data.cell.styles.fontStyle = 'normal';
          }
          data.cell.styles.textColor = [0, 0, 0];

          // 课程表时段列竖向合并
          if (rowArr._schedule && periodColIdx >= 0 && data.column.index === periodColIdx) {
            if (rowArr._rowSpan > 1 && rowArr._isFirstInBlock) {
              data.cell.rowSpan = rowArr._rowSpan;
              data.cell.styles.fontStyle = 'bold';
            } else if (rowArr._rowSpan === 0) {
              data.cell.text = [''];
            }
          }
        }
      });

      const blob = doc.output('blob');
      ctx.reportProgress(90)
      return await saveFile(`${filename}.pdf`, blob);
    }
  };
}
