// 为开发文档生成「本篇涉及的文件」目录树（从仓库根目录到文件）。
// 用法：
//   node testjs/tools/doc-trees.mjs            # 写入
//   node testjs/tools/doc-trees.mjs --dry-run  # 只打印，不改文件
//
// 规则：
//   - 只统计文档里出现的源码链接（相对路径解析后位于仓库内、且不在 doc/ 下）；
//   - 多文件篇目：只展示这些文件及共同祖先目录；
//   - 单文件篇目：从仓库根目录一路画到该文件；
//   - 描述取自表格的下一列或小节标题里的中文说明，取不到就不写。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOC_DIR = path.join(ROOT, 'doc/development');
const DRY = process.argv.includes('--dry-run');
const MARK_START = '<!-- doc-tree:start -->';
const MARK_END = '<!-- doc-tree:end -->';

// 需要生成树的文档（模块级 README 已在文件清单内画树；data-layer 已手工画过）
const TARGETS = [
  'widgets.md',
  'backend/routes.md',
  'backend/services.md',
  'frontend/composables.md',
  'frontend/entry.md',
  'frontend/views.md',
  'frontend/misc.md',
  'frontend/components/ai.md',
  'frontend/components/album.md',
  'frontend/components/base.md',
  'frontend/components/data-manage.md',
  'frontend/components/dialogs.md',
  'frontend/components/import-export.md',
  'frontend/components/layout.md',
  'frontend/components/root.md',
  'frontend/components/tables.md',
  'testing/README.md',
  'testing/behavior.md',
  'testing/probe.md',
  'testing/smoke.md',
  'testing/tools.md',
  'testing/units.md',
];

function cleanDescription(raw) {
  let text = String(raw || '')
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^[·：:，,\-—]+/, '').replace(/[。；;]$/, '').trim();
  if (text.length > 46) text = text.slice(0, 46) + '…';
  return text;
}

function lineDescription(line, linkStart, linkEnd) {
  const trimmed = line.trim();
  // 表格：取链接所在单元格的下一列
  if (trimmed.startsWith('|')) {
    const cells = trimmed.split('|').map((s) => s.trim());
    const idx = cells.findIndex((c) => c.includes(line.slice(linkStart, linkEnd)));
    const next = idx >= 0 ? cells[idx + 1] : '';
    return cleanDescription(next);
  }
  // 小节标题或列表：取链接后的说明
  const after = line.slice(linkEnd).trim();
  const headingMatch = after.match(/^（([^）]*)）|^\(([^)]*)\)/);
  if (headingMatch) return cleanDescription(headingMatch[1] || headingMatch[2] || '');
  if (/^[·：:\-—]/.test(after)) return cleanDescription(after);
  return '';
}

function sourceLinksOf(content, docDir) {
  const found = new Map(); // repo-relative path -> description
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const line of content.split(/\r?\n/)) {
    linkRe.lastIndex = 0;
    let m;
    while ((m = linkRe.exec(line)) !== null) {
      const raw = m[1].trim();
      if (!raw || raw.startsWith('#') || /^[a-z]+:/i.test(raw)) continue;
      const rel = path.relative(ROOT, path.resolve(docDir, raw));
      if (rel.startsWith('doc/') || rel.startsWith('doc\\')) continue;
      if (!rel || rel.startsWith('..')) continue;
      const normalized = rel.split(path.sep).join('/');
      if (!/\.(js|mjs|cjs|jsx|ts|tsx|vue|css|html|ps1|iss|sh|sql)$/i.test(normalized)) continue;
      const full = path.join(ROOT, normalized);
      if (!fs.existsSync(full)) continue;
      if (!found.has(normalized)) {
        found.set(normalized, lineDescription(line, m.index, m.index + m[0].length));
      }
    }
  }
  return found;
}

function buildTree(paths) {
  const root = { name: 'project-name', type: 'dir', children: new Map() };
  for (const [rel, desc] of paths) {
    const parts = rel.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const key = `${isFile ? 'f' : 'd'}:${part}`;
      if (!node.children.has(key)) {
        node.children.set(key, {
          name: part,
          type: isFile ? 'file' : 'dir',
          desc: isFile ? desc : '',
          children: new Map(),
        });
      }
      node = node.children.get(key);
    });
  }
  return root;
}

function renderTree(node, prefix = '', isRoot = true) {
  const entries = [...node.children.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'en');
  });
  const lines = [];
  entries.forEach((child, idx) => {
    const last = idx === entries.length - 1;
    const branch = last ? '└── ' : '├── ';
    const label = child.name + (child.type === 'dir' ? '/' : '');
    const suffix = child.type === 'file' && child.desc ? `  # ${child.desc}` : '';
    lines.push(`${prefix}${branch}${label}${suffix}`);
    if (child.type === 'dir' && child.children.size) {
      lines.push(...renderTree(child, prefix + (last ? '    ' : '│   '), false));
    }
  });
  if (isRoot) return [`${node.name}/`, ...lines];
  return lines;
}

function blockFor(docRel) {
  const absDoc = path.join(DOC_DIR, docRel);
  const content = fs.readFileSync(absDoc, 'utf8');
  const links = sourceLinksOf(content, path.dirname(absDoc));
  if (!links.size) return null;
  const tree = renderTree(buildTree(links)).join('\n');
  return [
    MARK_START,
    '## 本篇涉及的文件',
    '',
    '只展示本篇会讲到的代码文件（从仓库根目录到文件）；模块内其余文件见同级 README。',
    '',
    '```text',
    tree,
    '```',
    MARK_END,
  ].join('\n');
}

function apply(docRel, block) {
  const file = path.join(DOC_DIR, docRel);
  let content = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
  if (re.test(content)) {
    content = content.replace(re, block);
  } else {
    const h1 = content.match(/^\uFEFF?# .*\r?\n/);
    if (!h1) return false;
    content = content.replace(h1[0], `${h1[0]}\n${block}\n`);
  }
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

let changed = 0;
for (const docRel of TARGETS) {
  const block = blockFor(docRel);
  if (!block) {
    console.log(`跳过（无源码链接）：${docRel}`);
    continue;
  }
  if (DRY) {
    console.log(`\n===== ${docRel} =====\n${block}`);
  } else {
    apply(docRel, block);
    changed++;
    console.log(`已写入：${docRel}`);
  }
}
if (!DRY) console.log(`\n共写入 ${changed} 份文档。`);
