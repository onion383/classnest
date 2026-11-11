// =========================================================================
// uploadSignatures.js —— 收据附件的类型判定与校验
//
// 收据原来只能传图片（multer fileFilter 卡 image/* + 魔数校验图片签名）。
// 现在要收 pdf / doc(x) / xls(x) / ppt(x) / mp4，类型一多，光看扩展名就不可靠了：
// 改个后缀就能把任意文件塞进 uploads，之后还可能被前端当成预览内容渲染。
// 所以这里做两件事：
//   1. 扩展名白名单（决定允许哪些类型、各自的大小上限）
//   2. 真实字节的魔数校验（决定文件内容与扩展名是否对得上）
//
// 魔数只有前若干字节，读 16 字节就够；不整文件读，避免大视频把内存撑爆。
// =========================================================================
const fs = require('fs');

// 每类的扩展名、大小上限。上限按「老师实际会传什么」定：
// 拍一张发票 3~8MB、扫描件 PDF 几 MB、课件 10~30MB、一小段视频 100MB 级。
const KINDS = {
  image: { exts: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'], maxBytes: 20 * 1024 * 1024 },
  pdf: { exts: ['pdf'], maxBytes: 30 * 1024 * 1024 },
  // docx / xlsx / pptx 都是 zip 容器（PK\x03\x04）
  ooxml: { exts: ['docx', 'xlsx', 'pptx'], maxBytes: 30 * 1024 * 1024 },
  // 老版 doc / xls / ppt 是 OLE 复合文档（D0 CF 11 E0 A1 B1 1A E1）
  ole: { exts: ['doc', 'xls', 'ppt'], maxBytes: 30 * 1024 * 1024 },
  video: { exts: ['mp4', 'webm'], maxBytes: 200 * 1024 * 1024 },
  // 纯文本（目前只有 md）：没有魔数，判据见 checkUpload 里的 NUL 字节检查
  text: { exts: ['md'], maxBytes: 5 * 1024 * 1024 },
};

const EXT_TO_KIND = (() => {
  const map = {};
  for (const [kind, def] of Object.entries(KINDS)) {
    for (const ext of def.exts) map[ext] = kind;
  }
  return map;
})();

const ALLOWED_EXT_RE = new RegExp(`\\.(${Object.keys(EXT_TO_KIND).join('|')})$`, 'i');

// 各类的字节签名。前 16 字节够覆盖全部判据。
function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  // jpeg
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image';
  // png
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image';
  // gif
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image';
  // bmp
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image';
  // webp: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image';
  // pdf
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf';
  // zip 容器（docx/xlsx/pptx）
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'ooxml';
  // OLE 复合文档（doc/xls/ppt）
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'ole';
  // webm / mkv：EBML 头
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video';
  // mp4 / mov：offset 4 起是 'ftyp'
  if (buf.length >= 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video';
  return null;
}

function readHead(filePath, len = 16) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, 0);
    return buf.subarray(0, n);
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* 忽略 */ } }
  }
}

/**
 * multipart 文件名解码。
 * multer 底层的 busboy 按 latin1 解析 filename，UTF-8 的中文名会被拆成乱码
 * （「发票.pdf」变成「å\u008f\u0091ç¥¨.pdf」）。这里按 latin1 → 字节 → utf8 转回来。
 * 纯 ASCII 名字转换前后完全一致，无损。
 */
function decodeFileName(name) {
  const raw = String(name || '');
  if (!raw) return '';
  try {
    const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
    // 转回来出现替换字符 = 原字节不是合法 UTF-8（可能是别种编码），那就保持原样，
    // 硬转会把它变成一堆 �
    return utf8.includes('\uFFFD') ? raw : utf8;
  } catch (_) {
    return raw;
  }
}

/**
 * 校验一个上传文件：扩展名在白名单里，且真实字节与扩展名属于同一类。
 * @returns {{ ok: true, kind: string } | { ok: false, error: string }}
 */
function checkUpload(filePath, originalName, size) {
  const ext = String(originalName || '').split('.').pop().toLowerCase();
  const kind = EXT_TO_KIND[ext];
  if (!kind) return { ok: false, error: `不支持的文件类型：.${ext}` };

  const def = KINDS[kind];
  const bytes = Number(size) || 0;
  if (bytes > def.maxBytes) {
    const mb = Math.round(def.maxBytes / 1024 / 1024);
    return { ok: false, error: `「${originalName}」超过 ${mb}MB 上限` };
  }

  // 纯文本没有魔数可用，判据换成「前 512 字节里没有 NUL 字节」：
  // 改了后缀的 exe / 图片 / 压缩包开头几乎必然带 0x00，正常文本文件不会。
  // 512 而不是 16 —— 16 字节太短，一段正常开头的二进制可能还没出现 NUL。
  if (kind === 'text') {
    const head = readHead(filePath, 512);
    if (!head || head.length === 0) return { ok: false, error: `「${originalName}」是空文件` };
    if (head.includes(0)) return { ok: false, error: `「${originalName}」的内容不是文本` };
    return { ok: true, kind };
  }

  const head = readHead(filePath);
  const sniffed = sniff(head);
  if (sniffed !== kind) {
    // 提示文案要能说清「哪里不对」：伪装文件最常见的表现就是后缀与内容不符
    return { ok: false, error: `「${originalName}」的内容不是有效的 ${ext} 文件` };
  }
  return { ok: true, kind };
}

// 落库/展示用的收据类型：ooxml / ole 都是 Office 文档，前端只认 office。
// 校验用的细分 kind 不能合并（魔数要区分 zip 容器与 OLE 复合文档），
// 所以在写入收据前用这里统一归一，避免每个调用点各写一份映射。
const RECEIPT_KIND_ALIAS = { ooxml: 'office', ole: 'office' };
function receiptKind(kind) {
  return RECEIPT_KIND_ALIAS[kind] || kind;
}

module.exports = { KINDS, EXT_TO_KIND, ALLOWED_EXT_RE, sniff, checkUpload, decodeFileName, receiptKind };
