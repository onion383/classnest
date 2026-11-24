// =========================================================================
// pinyinSearch.js —— 前端「文本/拼音」命中的唯一实现（Q1-01 / Q1-07）
//
// SearchDialog 早已接 pinyin-match，但设置页、导出面板、表格搜索仍只认手写
// 首字母或纯文本 —— 同一句「输入 zs 能不能搜到张三」在不同页面答案不同。
// 这里把 match 收成一处，三处调用方共用。
//
// 注意：pinyin-match 只在「关键字是字母」时才有意义；中文关键字直接走 includes。
// =========================================================================
import PinyinMatch from 'pinyin-match'

const match = (PinyinMatch && PinyinMatch.match) || (PinyinMatch && PinyinMatch.default && PinyinMatch.default.match) || null

// text 里是否含 query（支持全拼 / 首字母 / 多音字）；非字母或不支持时返回 false。
export function pinyinHit(text, query) {
  if (!match) return false
  const q = String(query == null ? '' : query).trim()
  if (!q) return false
  try { return !!match(String(text == null ? '' : text), q) } catch (_) { return false }
}

// 「纯文本子串 或 拼音」的统一判定：调用方就不用各自写两遍。
export function textOrPinyinHit(text, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase()
  if (!q) return true
  if (String(text == null ? '' : text).toLowerCase().includes(q)) return true
  return pinyinHit(text, q)
}
