// =========================================================================
// select-bidi.test.js —— 下拉当前值「天 30」倒装的回归钉子
//
// 故障：设置页「登录保持」显示成「天 30」/「天 7」，而代码里的 label 明明是
// `${d} 天`。根因不是文案拼错，是 styles/select.css 的 `.av-select__value`
// 用 `direction: rtl` 实现「超长文案省略号在前」，RTL 把「30 天」这种
// 「数字 + 单位」按 bidi 重排成「天 30」。
//
// 正确修法：外层保留 rtl（管省略号位置），文本套一层 dir=ltr 的内层 span
// （管字符顺序）。**错误修法**有两个，都要挡住：
//   · 把 label 改成 `天 ${d}` —— 只是把倒装写进数据里，:title、其它消费方全跟着错；
//   · 直接删掉 direction: rtl —— 省略号回到尾部，长路径看不到文件名。
//
// 判据是接收源码文本的纯函数，并做变异反证。渲染行为本身需真机看一眼，
// 这里锁的是「接线不能被改回去」。运行：npm run test:units
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const SELECT = 'student-frontend/src/components/base/AppSelect.vue'
const CSS = 'student-frontend/src/styles/select.css'
const APPEARANCE = 'student-frontend/src/views/SettingsView/SettingsView.appearance.js'

function bidiFixOk(selectSrc, cssSrc, appearanceSrc) {
  const isolated = /<span class="av-select__value"[\s\S]{0,500}<span class="av-select__text" dir="ltr">\{\{ display \}\}<\/span>/.test(selectSrc)
  const rtlKept = /\.av-select__value\s*\{[\s\S]{0,220}direction:\s*rtl/.test(cssSrc)
  const ltrText = /\.av-select__text\s*\{[\s\S]{0,160}direction:\s*ltr[\s\S]{0,100}unicode-bidi:\s*isolate/.test(cssSrc)
  const labelUntouched = /label:\s*`\$\{d\} 天`/.test(appearanceSrc)
  return isolated && rtlKept && ltrText && labelUntouched
}

test('下拉当前值：dir=ltr 隔离 + 外层 rtl 保留 + 文案仍是「N 天」', () => {
  assert.equal(bidiFixOk(read(SELECT), read(CSS), read(APPEARANCE)), true,
    '「天 30」倒装的修复接线不全')
})

test('反证：三种「改回去」的写法都必须报红', () => {
  const select = read(SELECT)
  const css = read(CSS)
  const appearance = read(APPEARANCE)

  const flat = select.replace('<span class="av-select__text" dir="ltr">{{ display }}</span>', '{{ display }}')
  assert.equal(bidiFixOk(flat, css, appearance), false,
    '去掉内层方向隔离还能判绿 = 倒装会复现')

  const noRtl = css.replace('direction: rtl;', 'direction: ltr;')
  assert.equal(bidiFixOk(select, noRtl, appearance), false,
    '为修倒装直接删掉 rtl 还能判绿 = 省略号在前的语义会被悄悄改掉')

  // 整条规则删掉（不写死换行，CRLF/LF 都能命中）
  const noLtrText = css.replace(/\.av-select__text\s*\{[^}]*\}/, '')
  assert.equal(bidiFixOk(select, noLtrText, appearance), false,
    '只剩模板里的 dir 属性、CSS 规则被删还能判绿 = 判据失效')

  const wrongLabel = appearance.replaceAll('label: `${d} 天`', 'label: `天 ${d}`')
  assert.equal(bidiFixOk(select, css, wrongLabel), false,
    '把倒装写进 label 文案还能判绿 = 错误修法没被挡住')
})
