import { createApp } from 'vue'
import { createPinia } from 'pinia'
import Migration from './Migration.vue'
// 复用全局主题变量（:root 默认值），使进度窗口与主界面配色一致
import '../../styles/index.css'
import { loadThemeStyles } from '../../styles/themeLoader'
import { useThemeStore } from '../../stores/theme'

const app = createApp(Migration)
const pinia = createPinia()
app.use(pinia)

// 套用用户在设置里选的主题：主色、毛玻璃质感、「组件透明玻璃层」透明度、背景图全部跟随主题，
// 与主界面保持一致（基础主题主色绿、毛玻璃主题主色蓝）。
// applyTheme 内的 theme-chrome 通知来自非主窗口，主进程会直接忽略（见 electron/main.js）。
useThemeStore(pinia).applyTheme()

// 等当前主题的按需样式就绪（applyTheme 已触发加载）再挂载，避免闪一下基础主题配色。
//
// ⚠️ 失败必须显式处理：样式加载失败（CSS 404 / 磁盘读不出）时这条链会 reject，
// 而链尾没有 catch → 变成 unhandled rejection，且 app 永远不会 mount →
// 用户看到的是一个**纯白的迁移窗口**，没有任何提示。
// 兜底策略：样式加载失败也照样挂载（退回基础主题配色），并把错误打到控制台。
loadThemeStyles(document.documentElement.dataset.theme, document.documentElement.dataset.mode)
  .then(() => app.mount('#migration-app'))
  .catch((err) => {
    console.error('[migration] 主题样式加载失败，按基础主题继续挂载', err)
    app.mount('#migration-app')
  })