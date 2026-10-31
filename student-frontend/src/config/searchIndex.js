// 侧栏导航的页面清单（Sidebar 静态引入，模板不动、视觉不变）。
// 注意：搜索弹窗专用的索引数据与匹配逻辑已拆到 searchData.js ——
// 本文件被 Sidebar 静态引用、内容会进入首屏入口 chunk，这里只保留侧栏真正需要的清单。

// 页面清单：结构与 Sidebar 的导航分组完全一致
export const PAGE_GROUPS = [
  {
    title: '概览',
    items: [
      { to: '/',              label: '班级概览', emoji: '🏠', color: '#10b981', icon: 'home', py: 'bjgl' },
    ],
  },
  {
    title: '基础信息',
    items: [
      { to: '/students',      label: '学生管理', emoji: '📚', color: '#60a5fa', icon: 'students', py: 'xsgl' },
      { to: '/group-manage',  label: '分组管理', emoji: '👥', color: '#818cf8', icon: 'group', py: 'fzgl' },
      { to: '/schedule',      label: '课程表',   emoji: '📅', color: '#a3e635', icon: 'schedule', py: 'kcb' },
    ],
  },
  {
    title: '核心管理',
    items: [
      { to: '/fee',           label: '班费管理', emoji: '💰', color: '#fbbf24', icon: 'fee', py: 'bfgl' },
      { to: '/seats',         label: '座位管理', emoji: '🪑', color: '#fb923c', icon: 'seat', py: 'zwgl' },
      { to: '/duty',          label: '卫生值日', emoji: '🧹', color: '#34d399', icon: 'duty', py: 'wszr' },
      { to: '/leaves',        label: '请假管理', emoji: '🛌', color: '#a78bfa', icon: 'leave', py: 'qjgl' },
      { to: '/scores',        label: '加分管理', emoji: '🏅', color: '#f87171', icon: 'score', py: 'jfgl' },
    ],
  },
  {
    title: '活动中心',
    items: [
      { to: '/album',         label: '班级相册', emoji: '📷', color: '#f472b6', icon: 'album', py: 'bjxc' },
      { to: '/activities',    label: '班级活动', emoji: '🎉', color: '#fb7185', icon: 'activity', py: 'bjhd' },
    ],
  },
  {
    title: '系统管理',
    items: [
      { to: '/ai-assistant',  label: 'AI 助手',  emoji: '🤖', color: '#38bdf8', icon: 'ai', py: 'aizs' },
      { to: '/settings',      label: '系统设置', emoji: '⚙️', color: '#94a3b8', icon: 'settings', py: 'xtsz' },
      { to: '/about',         label: '关于软件', emoji: 'ℹ️', color: '#94a3b8', icon: 'about', py: 'gyrj' },
    ],
  },
]

