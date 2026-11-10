// =========================================================================
// licenseDocs.js —— 第三方许可证英文原文（按需加载）
//
// 全文只有一份：doc/development/dependencies/licenses/ 下收录的 7 份原文，
// ?raw 在构建期内联进本模块。本模块只被 AboutView.vue 动态 import，因此
// 这些全文不进入关于页 chunk、也不占首屏；首次点开协议弹窗时才加载，
// 之后由 ES module 自身缓存复用（不需要再写一份模块级 Promise 缓存）。
//
// ⚠️ 不要在这里手写或翻译许可正文。FSF 明确不批准任何译文为正式有效版本，
//    只有英文原文具有法律意义；中文内容只是帮助理解的参考说明，放在
//    AboutView.vue 的 LICENSE_ZH 里。新增许可证类型时补一个 import + 一行映射即可。
// =========================================================================
import mit from '../../../doc/development/dependencies/licenses/MIT.txt?raw'
import isc from '../../../doc/development/dependencies/licenses/ISC.txt?raw'
import apache from '../../../doc/development/dependencies/licenses/Apache-2.0.txt?raw'
import bsd2 from '../../../doc/development/dependencies/licenses/BSD-2-Clause.txt?raw'
import bsd3 from '../../../doc/development/dependencies/licenses/BSD-3-Clause.txt?raw'
import lgpl from '../../../doc/development/dependencies/licenses/LGPL-2.1.txt?raw'
// OFL 取自 SIL 官网提供的 plaintext OFL.txt；已去掉前面的示例占位版权头，只留许可证正文。
import ofl from '../../../doc/development/dependencies/licenses/SIL-OFL-1.1.txt?raw'

export const LICENSE_TEXTS = {
  'MIT': mit,
  'ISC': isc,
  'Apache-2.0': apache,
  'BSD-2-Clause': bsd2,
  'BSD-3-Clause': bsd3,
  // 清单里写的是 -or-later，收录的文件名是 LGPL-2.1.txt；两者共用同一份全文。
  'LGPL-2.1-or-later': lgpl,
  'SIL OFL 1.1': ofl,
}
