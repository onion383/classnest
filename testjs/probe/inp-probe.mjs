/**
 * INP 交互性能测量脚本（零第三方依赖）
 * ------------------------------------------------------------
 * 覆盖用户点名的四类交互：
 *   切换页面（点侧边栏）/ 打开窗口（点开弹窗的按钮）/ 点击按钮（工具条等）/
 *   表格输入（聚焦输入框打字、双击单元格进入编辑）
 *
 * 原理：
 *   1. 以 INP_DEBUG=1 启动 Electron（开启 Chromium 远程调试端口 9222）；
 *   2. 用 Node 内置 fetch 拿目标页面的 CDP webSocketDebuggerUrl，用内置 WebSocket 连接；
 *   3. 注入 PerformanceObserver({type:'event'}) 采集 event-timing 条目，
 *      按 interactionId 聚合 = INP，并拆成「输入延迟 / 处理 / 呈现」三段；
 *   4. 用 Input.dispatchMouseEvent / dispatchKeyEvent / insertText 派发**真实输入事件**
 *      （真实时间戳才会产生 interactionId，合成 DOM click 不会）；
 *   5. 每个交互按「时间就近」归因到脚本驱动的那一步，输出「场景 → 四段耗时」表；
 *   6. 额外回读开发版探针（inpProbe.js）的分类汇总，给出「按交互类别」的二级视图，
 *      便于和人工乱点得到的日志相互印证。
 *
 * 用法：
 *   1) 关掉正在运行的 dev app（有单实例锁）；
 *   2) node testjs/inp-probe.mjs
 *      脚本会自动探测/启动 Vite，再启动带调试口的 Electron（FORCE_SETUP=0 跳过首次引导）。
 *   2b) node testjs/inp-probe.mjs --prod
 *      生产口径：先构建完整 5 个入口到 testjs/tmp/bench/app<通道>/，起 5180 静态服务，
 *      再把渲染进程导航到产物上。外壳仍由 5173 拉起（主进程 dev 模式的 loadURL 写死它），
 *      但导航后即被替换、不参与测量。全程不打包 exe（本机 SmartScreen 会拦未签名产物）。
 *      代价：inpProbe.js 被摇树删除，报告里的「开发版探针分类视图」会空。
 *   3) 测完窗口会留着不关，方便你自己再点两下；Ctrl+C 结束脚本会一并结束它启动的子进程。
 *      设 INP_ONESHOT=1 可让脚本出报告后直接退出（供自动化用）。
 *
 * 说明：本脚本只「点」界面，但个别交互会走真实前后端逻辑，可能在测试账号的库里留下
 *       无关紧要的操作痕迹。为避免写入数据，弹窗一律用「取消 / Esc」关闭，不点「确定」。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
// 结束子进程树（只杀直接子进程会残留孙进程 → 端口占用 + 进程泄漏）
const { killTree } = require('../tools/killTree.cjs')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FRONTEND = path.join(ROOT, 'student-frontend')
const PORT = Number(process.env.INP_PORT || 9222)
const BASE = `http://127.0.0.1:5173`
const CDP_HOST = `127.0.0.1:${PORT}`

// 通道选择：INP_VUE=36 走 Vue 3.6 预览通道（vapor）；INP_VUE=36v 走 3.6 纯 VDOM 对照组
// （同编译器、无 vapor）；都不设则 3.5（VDOM 基线）。
// 三个通道读的是**同一份源码**：组件上的 `<script setup vapor>` 标记在 3.5 下被静默忽略、
// 在 36v 下被插件剥掉，所以变量只有运行时与编译器。
const LABELS = { 35: 'Vue 3.5 / VDOM', 36: 'Vue 3.6 / Vapor', '36v': 'Vue 3.6 / VDOM' }
const VUE = Object.hasOwn(LABELS, process.env.INP_VUE) ? process.env.INP_VUE : '35'

// --prod：页面换成生产构建产物（排除 dev 运行时断言与未压缩 ESM 的解析开销）。
// 全程不打包 exe —— 这台机器的 SmartScreen 会拦未签名产物、放行要管理员权限。
//
// 关键约束：**静态服务必须占用 5173**，不能换个端口起。
// 原因是登录态按 origin 隔离（authStorage.js 把 token 写进 localStorage），
// 换成 5180 就会落在登录页 —— 第一版就是这么失败的。同端口后 localStorage / cookie
// 全部天然复用，连 location.href 都与 dev 口径一致，不用为测量做任何登录态搬运。
// 代价是必须先把 dev server 关掉（它占着 5173），所以 prod 模式不再启动 Vite，
// 由静态服务直接扮演「5173 上的那个服务器」，主进程的 dev-loader 照样能 loadURL 成功。
const argv = process.argv.slice(2)
const PROD = argv.includes('--prod')
const PROD_DIR = path.join(ROOT, 'testjs', 'tmp', 'bench', `app${VUE}`)
// prod 与 dev 的页面地址完全相同（同端口），保留这个变量只为把「导航到哪」集中一处
const PAGE_BASE = BASE
const VUE_LABEL = LABELS[VUE]
const OUT_DIR = path.join(ROOT, 'testjs', 'tmp')
let ROUTE_LOG = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- 极简 CDP 客户端
class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map() }
  _onMessage(raw) {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)) }
      }, 20000)
    })
  }
  /** 求值并返回 JS 值（returnByValue） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面求值异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

// 让 Message 事件能进到实例上（先建立再挂 handler）
function rawConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000)
    ws.onopen = () => {
      clearTimeout(timer)
      const cdp = new CDP(ws)
      ws.onmessage = (ev) => cdp._onMessage(ev.data)
      ws.onerror = null
      resolve(cdp)
    }
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error('WebSocket 错误: ' + (e?.message || ''))) }
  })
}

async function listTargets() {
  try {
    const res = await fetch(`http://${CDP_HOST}/json/list`, { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

function pickMainTarget(targets) {
  if (!Array.isArray(targets)) return null
  return targets.find((t) => t.type === 'page' && typeof t.url === 'string'
    && t.url.startsWith(BASE) && !t.url.includes('.html')) || null
}

async function waitForMainTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t = pickMainTarget(await listTargets())
    if (t && t.webSocketDebuggerUrl) return t
    await sleep(300)
  }
  return null
}

async function viteUp() {
  const http = require('node:http')
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/`, { timeout: 1500 }, (res) => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

/**
 * 探测 5173 上的 Vite 当前编译的是哪个通道。
 * 依据：3.6 vapor 通道把 `vue` 指到 vue36/ 下的 with-vapor 双运行时，编译产物里会带这条 import；
 * 3.6 纯 VDOM 通道指向同目录下的 vue.runtime.esm-browser.js（只剩 "vue36" 路径）；
 * 3.5 走主线 node_modules。
 * 存在的意义：复用已有 dev server 时，通道搞错了整轮测量就白跑（源码一样、结论相反）。
 */
async function detectViteChannel() {
  const http = require('node:http')
  return new Promise((resolve) => {
    const req = http.get(`${BASE}/src/views/AboutView.vue`, { timeout: 4000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        if (/with-vapor/.test(body)) return resolve('36')
        resolve(/vue36/.test(body) ? '36v' : '35')
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

// 后端健康探测。主进程 fork 出的后端进程在 Electron 起来后约 0.5s 才监听 3000；
// 渲染进程首屏请求若早于它，Vite 代理会 ECONNREFUSED、安全通道握手也一起失败，
// 页面便长期停在「空数据」状态（dtRows=0），后续所有交互都测在空表上。
const BACKEND = 'http://127.0.0.1:3000'
async function backendUp() {
  const http = require('node:http')
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND}/`, { timeout: 1500 }, (res) => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}
async function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await backendUp()) return true
    await sleep(200)
  }
  return false
}

// ---------------------------------------------------------------- 页面内注入脚本
// 原始 event-timing 观测器（durationThreshold 0，抓全部交互）+ 元素定位器。
// 注意：不覆盖 window.__inp —— 那是开发版探针（inpProbe.js）的导出；这里另起 __inpRaw，
// 只在结束时通过 window.__inpProbe() 回读探针的分类汇总。
const INJECT = `
(() => {
  if (!window.__inpRaw) {
    window.__inpRaw = { entries: [] };
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.interactionId) continue;
        window.__inpRaw.entries.push({
          name: e.name,
          interactionId: e.interactionId,
          startTime: e.startTime,
          duration: e.duration,
          processingStart: e.processingStart,
          processingEnd: e.processingEnd,
        });
      }
    });
    try { po.observe({ type: 'event', durationThreshold: 0, buffered: false }); } catch (err) {}
  }
  window.__inpRawReset = () => { window.__inpRaw.entries.length = 0; };

  // 仓库已有 performance.measure（rowsRender / displayRows 整表渲染打点）
  window.__perfMeasures = () => (performance.getEntriesByType('measure') || [])
    .filter(m => m.name === 'rowsRender' || m.name === 'displayRows')
    .map(m => ({ name: m.name, startTime: m.startTime, duration: m.duration }));

  // 开发版探针的分类汇总：调用它拿到 { reason, categories, details }
  window.__inpProbe = () => (typeof window.__inp === 'function' ? window.__inp() : null);

  const DIALOG_SEL = '[role="dialog"], [class*="dialog"], [class*="Dialog"], [class*="modal"], [class*="Modal"], [class*="overlay"], [class*="Overlay"]';

  // 元素定位：按 sel 或 文本正则；inDialog 时只在最上层可见弹窗内找。
  // 返回可点击的中心坐标 + 短文案；找不到返回 null。
  window.__inpFind = (spec) => {
    spec = spec || {};
    let root = document;
    if (spec.inDialog) {
      const ds = Array.from(document.querySelectorAll(DIALOG_SEL))
        .filter(d => d.getBoundingClientRect().height > 0);
      if (!ds.length) return null;
      root = ds[ds.length - 1];
    }
    let els;
    if (spec.sel) els = Array.from(root.querySelectorAll(spec.sel));
    else if (spec.nav) els = Array.from(document.querySelectorAll('.nav-item'));
    else els = Array.from(root.querySelectorAll('button, a, [role="button"], .dcell, input, textarea, select'));
    const total = els.length;
    if (spec.text) {
      const re = new RegExp(spec.text);
      els = els.filter(e => re.test(
        (e.textContent || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').trim()
      ));
    }
    const texted = els.length;
    els = els.filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const el = els[spec.nth || 0];
    // 找不到时不再只返回 null：把「选择器命中几个 / 文案命中几个 / 有尺寸几个」带回去，
    // 这样报告里能直接看出是选择器写错、文案没中、还是被隐藏了。
    if (!el) return {
      _miss: true,
      info: {
        sel: spec.sel || (spec.nav ? '.nav-item' : 'auto'),
        text: spec.text || '',
        inDialog: !!spec.inDialog, nth: spec.nth || 0,
        total, texted, vis: els.length,
        // 当前作用域的可见文案片段：用来区分「选择器写错」和「页面根本没渲染出这块 UI」
        // （典型：AI 助手未启用时聊天区整个不存在；分组管理处于默认维度时不渲染「添加小组」）。
        // 注意 document 的 textContent 恒为 null，非弹窗场景要取 document.body。
        snippet: (((root === document ? document.body : root).textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      },
    };
    let r = el.getBoundingClientRect();
    // 目标可能在滚动区之外（如侧边栏底部的「系统设置/关于软件」）：只滚「最近的可滚动祖先」。
    // 绝不能用 el.scrollIntoView —— 它会沿着祖先链一路滚下去，把 document 也滚走，
    // 于是整页被均匀顶上去一截、钻到自绘标题栏下面。
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const s = getComputedStyle(p);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 1) break;
      p = p.parentElement;
    }
    if (p && p !== document.body && p !== document.documentElement) {
      const box = p.getBoundingClientRect();
      if (r.top < box.top) p.scrollTop += r.top - box.top;
      else if (r.bottom > box.bottom) p.scrollTop += r.bottom - box.bottom;
      r = el.getBoundingClientRect();
    }
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    // elementFromPoint：点这个坐标时「实际会被谁接收」。导航超时多半是坐标被别的元素盖住了，
    // 或者坐标落在视口外（y 超过窗口高度 → 事件等于打在虚空）。
    const hitEl = document.elementFromPoint(cx, cy)
    return {
      x: cx,
      y: cy,
      text: ((el.textContent || el.value || '').trim()).slice(0, 20),
      // 带上标签与类名：导航超时时能看出「到底点到了哪个元素」
      tag: el.tagName,
      cls: (el.className && String(el.className).slice(0, 70)) || '',
      hit: hitEl ? hitEl.tagName + '.' + String(hitEl.className || '').slice(0, 60) : 'null',
      rect: [Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      vp: [window.innerWidth, window.innerHeight],
    };
  };

  // 当前可见弹窗数量（用于「打开窗口是否成功 / 是否已关闭」判定）
  window.__inpDialog = () => Array.from(document.querySelectorAll(DIALOG_SEL))
    .filter(d => d.getBoundingClientRect().height > 0).length;

  // ===== 认证与造数（都必须在页面里做：只有页面带着 localStorage 里的 token）=====
  // 注意：probe 用 Node 直接 fetch 后端是没有登录态的，任何需要鉴权的接口都会 401。
  window.__inpAuth = () => ({
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + (localStorage.getItem('token') || ''),
  });

  // API 前缀：dev 下前端走同源 /api（由 Vite proxy 转发到 3000），生产构建里则是绝对地址
  // （httpClient.js: backendBaseUrl() 返回 import.meta.env.PROD ? 'http://localhost:3000' : ''）。
  // 探针的造数请求此前一律写相对路径，--prod 下会打到静态服务上拿回 "not found"，
  // 紧接着 JSON.parse 抛 SyntaxError —— 就是被这个坑绊住的。
  const API_PREFIX = ${JSON.stringify(PROD ? 'http://localhost:3000' : '')};
  window.__inpApi = (p) => API_PREFIX + p;

  // 学生表为空时补几条测试学生，保证 /students 的表格交互场景有行可点。
  // 仅当表为空才插（反复跑不会把表越撑越大）。POST/GET 均为明文直通，不经加密通道。
  window.__inpSeedStudents = async (n) => {
    const r = await fetch(window.__inpApi('/api/students?_t=' + Date.now()), { headers: window.__inpAuth(), cache: 'no-store' });
    const j = await r.json();
    const cur = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
    if (cur.length) return { seeded: 0, existing: cur.length };
    const fields = ((j && j.fields) || []).filter(f => f.name !== 'id' && f.name !== 'position');
    let ok = 0;
    for (let i = 1; i <= n; i++) {
      const body = {};
      for (const f of fields) {
        if (f.name === '姓名') body[f.name] = '探针学生' + i;
        else if (f.name === '学号') body[f.name] = String(9000 + i);
        else body[f.name] = '测试';
      }
      const res = await fetch(window.__inpApi('/api/students'), { method: 'POST', headers: window.__inpAuth(), body: JSON.stringify(body) });
      if (res.ok) ok++;
    }
    return { seeded: ok, existing: 0 };
  };

  // 铺一条空操作撤销记录（oldValue===newValue）：对数据零影响，却完整走一遍
  // HTTP → flip → 前端回调 的撤销链路。必须在页面里发（带 token）。
  window.__inpSeedUndo = async (table, key) => {
    const r = await fetch(window.__inpApi('/api/' + table + '?_t=' + Date.now()), { headers: window.__inpAuth(), cache: 'no-store' });
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []);
    const row = arr[0];
    if (!row || !Number.isInteger(row.id)) return false;
    const f = Object.prototype.hasOwnProperty.call(row, '备注') ? '备注'
      : Object.keys(row).find(k => k !== 'id' && k !== 'position');
    if (!f) return false;
    const val = row[f] == null ? '' : row[f];
    const res = await fetch(window.__inpApi('/api/undo'), {
      method: 'POST', headers: window.__inpAuth(),
      body: JSON.stringify({
        key, type: 'cell_update', label: '探针seed（空操作）',
        payload: { table: key, rowId: row.id, field: f, oldValue: val, newValue: val }
      })
    });
    return res.ok;
  };

  // 当前路由路径。路由模式随构建而变：dev 是 createWebHistory（看 location.pathname），
  // 生产是 createWebHashHistory（看 location.hash，见 router/index.js:30）。
  // 只认 pathname 的话，--prod 下每个页面都会被判成「还停在 /」→ 全部导航超时（实测整轮多跑 2 分钟且零样本）。
  window.__inpPath = () => {
    const h = (location.hash || '').replace(/^#/, '');
    return h.startsWith('/') ? h : (location.pathname || '/');
  };

  window.__pageInfo = () => ({
    path: window.__inpPath(),
    onLogin: !!document.querySelector('input[type=password]'),
    dtRows: document.querySelectorAll('.dynamic-table tbody tr').length,
    gvCells: document.querySelectorAll('.grid-view-container tbody td').length,
    inlineInputs: document.querySelectorAll('input.w-full.h-full').length,
  });
  return true;
})()
`

// ---------------------------------------------------------------- 交互计划
// 路由 → 侧边栏文案（「切换页面」靠点它，顺带把页面打开）
// 顺序：侧边栏最底部那组（AI 助手/系统设置/关于软件）放最后，其余按侧边栏原序。
// 曾误判为「AI 页浮层接管点击」——实为 Sidebar 根元素 h-screen 放在 44px 标题栏之下，
// 侧边栏比可用区高 44px 且 <nav> 自身不产生溢出 → 底部两项被裁在视口外、点不到。
// 已改为 h-full（可见区域不变，nav 恢复可滚动），该问题消失。
const NAV = {
  '/': '班级概览',
  '/students': '学生管理',
  '/group-manage': '分组管理',
  '/schedule': '课程表',
  '/fee': '班费管理',
  '/seats': '座位管理',
  '/duty': '卫生值日',
  '/leaves': '请假管理',
  '/scores': '加分管理',
  '/album': '班级相册',
  '/activities': '班级活动',
  '/settings': '系统设置',
  '/about': '关于软件',
  '/ai-assistant': 'AI 助手',
}
const ROUTES = Object.keys(NAV)

// 每页的交互步骤。字段：
//   cat         交互类别（与探针分类口径一致）
//   label       场景名（报告里显示）
//   find        定位方式，交给页面内 __inpFind（sel / text / nth / inDialog）
//   act         click | dblclick | type | key | drag
//   text/key    type 的文本 / key 的键名
//   drag        drag 的位移（dx/dy，CSS px）与分几步派发（steps，默认 6，每步间隔一帧）
//   needDialog  该步要求弹窗已打开，否则跳过
//   opensDialog 该步预期打开弹窗，用于校验
//   expectSel   该步执行后应出现的选择器；没出现就记入「跳过的步骤」，
//               防止「点了个空」还当成命中样本（典型：照片没索引时点 .photo-cell）
//   close       true 表示这是「关闭弹窗」步：先点弹窗内「取消」，否则按 Esc
const PAGES = {
  '/students': [
    { cat: '打开窗口', label: '打开「添加学生」', find: { sel: 'button', text: '添加学生' }, act: 'click', opensDialog: true },
    { cat: '表格输入', label: '弹窗内输入姓名', find: { sel: 'input', inDialog: true }, act: 'type', text: '测试', needDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
    { cat: '点击按钮', label: '工具条「搜索」', find: { sel: 'button.btn-search' }, act: 'click' },
    { cat: '表格输入', label: '搜索框输入', find: { sel: 'input[placeholder="输入关键字..."]' }, act: 'type', text: '测' },
    { cat: '键盘', label: 'Esc 收起搜索', act: 'key', key: 'Escape' },
    { cat: '表格输入', label: '单元格双击编辑', find: { sel: '.dynamic-table tbody tr td .dcell', nth: 0 }, act: 'dblclick' },
    { cat: '键盘', label: 'Esc 退出编辑', act: 'key', key: 'Escape' },
    // 撤销/重做路径：先铺一条空操作撤销记录，再按组合键，完整走 HTTP→flip→前端回调 链路（对数据零影响）
    { cat: '键盘', label: '撤销 Ctrl+Z', act: 'combo', key: 'z', ctrl: true, seedUndo: { table: 'students', key: 'students' } },
    { cat: '键盘', label: '重做 Ctrl+Shift+Z', act: 'combo', key: 'z', ctrl: true, shift: true },
  ],
  '/group-manage': [
    { cat: '打开窗口', label: '打开「添加组」', find: { sel: 'button', text: '添加组' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
    // 别找「＋ 添加小组」或组内「＋」：前者只在「普通维度」分支、后者要该维度已有小组卡片，
    // 都是数据依赖。刷新按钮（.btn-refresh）无 v-if、恒在 DOM，且会走一遍拉数据+重渲染，
    // 正好是这页值得测的「点击按钮 + 数据刷新」路径。
    { cat: '点击按钮', label: '刷新分组列表', find: { sel: 'button.btn-refresh' }, act: 'click' },
  ],
  '/schedule': [
    { cat: '表格输入', label: '格子双击编辑', find: { sel: '.grid-view-container tbody td.cursor-pointer', nth: 0 }, act: 'dblclick' },
    { cat: '表格输入', label: '编辑态输入', find: { sel: 'input.w-full.h-full' }, act: 'type', text: '语文' },
    { cat: '键盘', label: 'Esc 退出编辑', act: 'key', key: 'Escape' },
  ],
  '/fee': [
    { cat: '打开窗口', label: '打开「添加记录」', find: { sel: 'button', text: '添加记录' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
    { cat: '点击按钮', label: '工具条「搜索」', find: { sel: 'button.btn-search' }, act: 'click' },
    { cat: '表格输入', label: '搜索框输入', find: { sel: 'input[placeholder="输入关键字..."]' }, act: 'type', text: '测' },
    { cat: '键盘', label: 'Esc 收起搜索', act: 'key', key: 'Escape' },
  ],
  '/seats': [
    { cat: '打开窗口', label: '打开「智能排表」', find: { sel: 'button', text: '智能排表' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
    { cat: '表格输入', label: '格子双击编辑', find: { sel: '.grid-view-container tbody td.cursor-pointer', nth: 0 }, act: 'dblclick' },
    { cat: '表格输入', label: '编辑态输入', find: { sel: 'input.w-full.h-full' }, act: 'type', text: '张三' },
    { cat: '键盘', label: '候选下移', act: 'key', key: 'ArrowDown' },
    { cat: '键盘', label: 'Esc 退出编辑', act: 'key', key: 'Escape' },
  ],
  '/duty': [
    { cat: '打开窗口', label: '打开「智能排表」', find: { sel: 'button', text: '智能排表' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
    { cat: '表格输入', label: '格子双击编辑', find: { sel: '.grid-view-container tbody td', nth: 0 }, act: 'dblclick' },
    { cat: '键盘', label: 'Esc 退出编辑', act: 'key', key: 'Escape' },
  ],
  '/leaves': [
    { cat: '打开窗口', label: '打开「添加请假」', find: { sel: 'button', text: '添加请假' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
  ],
  '/scores': [
    { cat: '打开窗口', label: '打开「添加加分」', find: { sel: 'button', text: '添加.*加分' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
  ],
  // 相册这页此前一个步骤都没有（只有导航步），而它是最重的视图：虚拟滚动 + 缩略图 + 年份尺。
  // 两条约束决定了下面的写法：
  //   1) 照片格依赖真实索引数据（album_stats.photo_count > 0）。没有照片时 .photo-cell 不存在，
  //      expectSel 会把它记成「跳过」而不是伪装成命中样本。
  //   2) 查看器不是 DIALOG_SEL 那种弹窗（它是 fixed 覆盖层 .album-viewer），所以走 expectSel
  //      而不是 opensDialog；关闭也只能点 ✕ —— 这一页没有注册 Esc 监听。
  '/album': [
    // 视图切换：.view-switch-btn 恒在，不依赖数据，先把「时间轴 ⇄ 相册卡片」的整块重渲染测到
    { cat: '点击按钮', label: '切到「相册」视图', find: { sel: '.view-switch-btn', text: '相册' }, act: 'click' },
    { cat: '点击按钮', label: '切回「时间轴」视图', find: { sel: '.view-switch-btn', text: '时间轴' }, act: 'click' },
    // 打开大图 → 翻一张 → 关闭：这是相册页最典型的一条路径
    { cat: '打开窗口', label: '点开一张照片', find: { sel: '.photo-cell', nth: 0 }, act: 'click', expectSel: '.album-viewer' },
    { cat: '点击按钮', label: '查看器「下一张」', find: { sel: '.viewer-nav-next' }, act: 'click' },
    { cat: '点击按钮', label: '关闭查看器', find: { sel: '.viewer-close' }, act: 'click' },
    // 年份尺拖动：监听挂在 window 的 pointermove 上，所以合成鼠标事件能完整驱动。
    // 内容不足一屏时手柄带 --free、拖不动（值不变就没有 INP 条目），会自然落进「未匹配」。
    { cat: '拖拽', label: '年份尺拖动', find: { sel: '.album-ruler-thumb' }, act: 'drag', dy: 140 },
  ],
  '/activities': [
    { cat: '打开窗口', label: '打开「新增活动」', find: { sel: 'button', text: '新增活动' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
    { cat: '点击按钮', label: '切到「倒计时」页签', find: { sel: 'button', text: '倒计时' }, act: 'click' },
    { cat: '打开窗口', label: '打开「添加倒计时」', find: { sel: 'button', text: '添加倒计时' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
  ],
  '/ai-assistant': [
    // 聊天区受 v-if="enabled" 控制（enabled 来自 GET /api/ai/config）。测试账号未配 API Key
    // 时整块 UI 都不渲染，输入框必然不存在 —— 不是选择器问题。「设置」按钮两种情况都在，
    // 用它做该页的稳定交互（只开弹窗、不保存，不写入任何配置）。
    { cat: '打开窗口', label: '打开「AI 设置」', find: { sel: 'button', text: '设置' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
    { cat: '键盘', label: 'Esc', act: 'key', key: 'Escape' },
  ],
  '/settings': [
    { cat: '打开窗口', label: '打开「导出数据库」', find: { sel: 'button', text: '导出数据库' }, act: 'click', opensDialog: true },
    { cat: '点击按钮', label: '弹窗内「取消」', close: true },
  ],
}

// ---------------------------------------------------------------- 输入派发
async function mouseClick(cdp, x, y, dbl) {
  const press = (type, buttons, clickCount) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount })
  if (dbl) {
    await press('mousePressed', 1, 1); await press('mouseReleased', 0, 1)
    await press('mousePressed', 1, 2); await press('mouseReleased', 0, 2)
  } else {
    await press('mousePressed', 1, 1); await press('mouseReleased', 0, 1)
  }
}

// 拖拽：按下 → 分步移动（每步一帧）→ 抬起。Chromium 会把 mouseMoved + buttons=1
// 合成为 pointermove，所以「监听挂在 window 上」的拖拽实现（如年份尺）也能被驱动。
// 分步而不是一步到位：只派发单个 mousemove 时，很多实现把首帧当成「起点对齐」而丢弃位移。
async function mouseDrag(cdp, x, y, dx, dy, steps) {
  const send = (type, cx, cy, buttons) =>
    cdp.send('Input.dispatchMouseEvent', { type, x: cx, y: cy, button: 'left', buttons, clickCount: 1 })
  await send('mousePressed', x, y, 1)
  for (let i = 1; i <= steps; i++) {
    await send('mouseMoved', x + (dx * i) / steps, y + (dy * i) / steps, 1)
    await sleep(16)
  }
  await send('mouseReleased', x + dx, y + dy, 0)
}

async function pressKey(cdp, key) {
  const map = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Tab: 9 }
  const code = map[key] ?? 0
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
}

// 带修饰键的组合键（Ctrl+Z / Ctrl+Shift+Z 等）。modifiers 位掩码：Alt=1 Ctrl=2 Meta=4 Shift=8。
// 用 rawKeyDown 派发，避免组合键再触发一次文本插入。
async function pressCombo(cdp, key, mods = {}) {
  const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0)
  const upper = key.length === 1 ? key.toUpperCase() : key
  const vk = upper.charCodeAt(0)
  const code = key.length === 1 ? `Key${upper}` : key
  // 浏览器里 Shift+字母的 e.key 是大写字母；页面处理器内部 toLowerCase，两种都能命中。
  const evKey = mods.shift && key.length === 1 ? upper : key
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: evKey, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: evKey, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
}

async function waitFor(cdp, expr, ok, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (ok(await cdp.eval(expr))) return true } catch {}
    await sleep(150)
  }
  return false
}

// ---------------------------------------------------------------- 驱动
// 关闭弹窗：优先点弹窗内「取消」，否则按 Esc；返回是否已关闭
async function closeDialog(cdp) {
  const pos = await cdp.eval(`window.__inpFind(${JSON.stringify({ sel: 'button', text: '取消', inDialog: true })})`)
  if (pos && !pos._miss) {
    await mouseClick(cdp, pos.x, pos.y)
    await sleep(400)
    if (!(await cdp.eval('window.__inpDialog()'))) return { pos, via: '取消' }
  }
  await pressKey(cdp, 'Escape')
  await sleep(400)
  return { pos: null, via: 'Esc', closed: !(await cdp.eval('window.__inpDialog()')) }
}

async function driveRoute(cdp, route, out) {
  // 切换页面：点侧边栏对应项
  const navPos = await cdp.eval(`window.__inpFind(${JSON.stringify({ nav: true, text: NAV[route] })})`)
  if (navPos && !navPos._miss) {
    const t = await cdp.eval('performance.now()')
    out.steps.push({ route, cat: '切换页面', label: `→ ${NAV[route]}`, t })
    await mouseClick(cdp, navPos.x, navPos.y)
    const ok = await waitFor(cdp, 'window.__inpPath()', (v) => v === route, 8000)
    if (!ok) out.skipped.push(`${route} 导航超时（仍停在 ${await cdp.eval('window.__inpPath()')}；目标 ${navPos.tag}.${navPos.cls}「${navPos.text}」 rect=${JSON.stringify(navPos.rect)} vp=${JSON.stringify(navPos.vp)} 坐标上实际是 ${navPos.hit}）`)
  } else {
    out.skipped.push(`${route} 未找到导航项「${NAV[route]}」 ${JSON.stringify((navPos && navPos.info) || {})}`)
  }
  await sleep(800)

  const info = await cdp.eval('window.__pageInfo()')
  if (info.onLogin) { out.skipped.push(`${route} 落在登录页，整页跳过`); return info }

  for (const step of PAGES[route] || []) {
    if (step.close) {
      const t = await cdp.eval('performance.now()')
      const r = await closeDialog(cdp)
      if (r.pos) out.steps.push({ route, cat: '点击按钮', label: `关闭弹窗（${r.via}）`, t })
      else out.steps.push({ route, cat: '键盘', label: '关闭弹窗（Esc）', t })
      if (r.pos && r.closed === false) out.skipped.push(`${route} 弹窗未关闭，后续步骤可能受影响`)
      await sleep(600)
      continue
    }
    if (step.act === 'key') {
      const t = await cdp.eval('performance.now()')
      out.steps.push({ route, cat: step.cat, label: step.label, t })
      await pressKey(cdp, step.key)
      await sleep(600)
      continue
    }
    // 组合键步骤（撤销/重做）：不依赖 DOM 目标，可选先铺一条空操作撤销记录再按键
    if (step.act === 'combo') {
      if (step.seedUndo) {
        // 必须在页面里发（带 token）：Node 侧 fetch 没登录态，必然 401
        const seeded = await cdp.eval(`window.__inpSeedUndo(${JSON.stringify(step.seedUndo.table)}, ${JSON.stringify(step.seedUndo.key)})`)
        if (!seeded) out.skipped.push(`${route} 「${step.label}」seed 撤销记录失败（该表无行或未登录）`)
        await sleep(200)
      }
      const t = await cdp.eval('performance.now()')
      out.steps.push({ route, cat: step.cat, label: step.label, t })
      await pressCombo(cdp, step.key, { ctrl: step.ctrl, shift: step.shift, meta: step.meta, alt: step.alt })
      await sleep(600)
      continue
    }
    if (step.needDialog && !(await cdp.eval('window.__inpDialog()'))) {
      out.skipped.push(`${route} 跳过「${step.label}」：弹窗未打开`)
      continue
    }
    const pos = await cdp.eval(`window.__inpFind(${JSON.stringify(step.find)})`)
    if (!pos || pos._miss) { out.skipped.push(`${route} 跳过「${step.label}」：${pos ? JSON.stringify(pos.info) : '未找到目标元素'}`); continue }

    const t = await cdp.eval('performance.now()')
    out.steps.push({ route, cat: step.cat, label: step.label, t })
    if (step.act === 'type') {
      await mouseClick(cdp, pos.x, pos.y) // 先聚焦
      await sleep(120)
      await cdp.send('Input.insertText', { text: step.text })
    } else if (step.act === 'drag') {
      await mouseDrag(cdp, pos.x, pos.y, step.dx || 0, step.dy || 0, step.steps || 6)
    } else {
      await mouseClick(cdp, pos.x, pos.y, step.act === 'dblclick')
    }
    if (step.opensDialog) {
      await sleep(500)
      if (!(await cdp.eval('window.__inpDialog()'))) out.skipped.push(`${route} 「${step.label}」后未见弹窗`)
    }
    if (step.expectSel) {
      await sleep(300)
      const seen = await cdp.eval(`!!document.querySelector(${JSON.stringify(step.expectSel)})`)
      if (!seen) out.skipped.push(`${route} 「${step.label}」后未见 ${step.expectSel}（样本可能不成立）`)
    }
    await sleep(600) // 冷却，避免相邻交互在时间上粘连
  }
  return info
}

// ---------------------------------------------------------------- 生产构建与静态服务
// --prod 专用。构建**完整 5 个入口**（index / widget / desktop-widget / migration / setup），
// 与 vapor-bench 的 --prod 不同：那边 VUE_BENCH=1 只构建 bench.html，INP 必须测真实应用。
let prodServer = null
function stopProd() {
  if (!prodServer) return
  try { prodServer.close() } catch (_) {}
  prodServer = null
}

function buildProd() {
  const vueArgs = VUE === '36' ? ['--vue36'] : VUE === '36v' ? ['--vue36', '--vdom'] : []
  console.log(`[inp] 生产构建（${VUE_LABEL}，5 个入口）→ ${path.relative(ROOT, PROD_DIR)} …`)
  return new Promise((resolve, reject) => {
    // 必须显式 --emptyOutDir false：宿主环境的安全删除 shim 会把「一次删 >50 个文件」拦下来
    // （[SAFE_DELETE_BULK_CONFIRM_REQUIRED]，assets 里有 140+ 个），构建直接失败；
    // 而 Vite 对 root 外的 outDir 默认仍会 emptyDir，只是少传参数并不够。
    // 不清目录没有副作用 —— index.html 每次重写并指向新 hash 的 chunk，
    // 残留的旧 chunk 只是占盘、不会被任何页面引用。
    const child = spawn(
      process.execPath,
      [path.join(FRONTEND, 'dev-vite.js'), ...vueArgs, 'build',
        '--outDir', path.relative(FRONTEND, PROD_DIR), '--emptyOutDir', 'false'],
      { cwd: FRONTEND, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let log = ''
    child.stdout.on('data', (c) => { log += c; process.stdout.write(c) })
    child.stderr.on('data', (c) => { log += c; process.stderr.write(c) })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) return resolve()
      // 只回传末尾几行，避免 Vite 的整屏输出把真正的错误顶走
      reject(new Error(`生产构建失败（code=${code}）：\n${log.trim().split('\n').slice(-8).join('\n')}`))
    })
  })
}

// 静态服务：只做「把 dist 目录喂给渲染进程」这一件事，不模拟任何生产协议栈。
// 生产真身是 app:// 协议（electron/main/protocol.js），这里用 http 是近似 ——
// 两者都是标准安全协议，后端 CORS 白名单也接受回环 origin（student-backend/app.js:50），
// 对 INP 而言差的只是协议换页开销，量级可忽略。
// 监听 5173（与 dev 同端口），登录态才有得复用，理由见文件头。
function serveProd() {
  return new Promise((resolve, reject) => {
    const http = require('node:http')
    const { readFile, stat } = require('node:fs')
    const MIME = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
      '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.map': 'application/json',
    }
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
      const file = path.join(PROD_DIR, rel)
      // 目录穿越保护：解析后的路径必须仍在 PROD_DIR 内
      if (!file.startsWith(PROD_DIR + path.sep) && file !== path.join(PROD_DIR, 'index.html')) {
        res.statusCode = 403; return res.end('forbidden')
      }
      stat(file, (err, st) => {
        if (err || !st.isFile()) { res.statusCode = 404; return res.end('not found') }
        readFile(file, (e, buf) => {
          if (e) { res.statusCode = 500; return res.end('read error') }
          res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
          res.end(buf)
        })
      })
    })
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        return reject(new Error(
          '5173 已被占用，prod 模式需要它来托管生产产物（同端口才能复用登录态）。'
          + '请先关掉正在运行的 dev server / 应用再重试。'))
      }
      reject(err)
    })
    server.listen(5173, '127.0.0.1', () => { prodServer = server; resolve() })
  })
}

// ---------------------------------------------------------------- 主流程
// 本脚本可能自行拉起 Vite：必须保留句柄并在退出时清理，否则 dev server 会残留占用端口。
let viteChild = null
function stopVite() {
  if (!viteChild || viteChild.killed) return
  const pid = viteChild.pid
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-pid, 'SIGTERM')
  } catch (_) {
    try { killTree(viteChild) } catch (_) {}
  }
  viteChild = null
}

async function ensureRunner() {
  if (await waitForMainTarget(1200)) {
    // prod 下 5173 是静态服务，没有 /src 路由，通道探测只会返回 null，跳过免得误导
    if (!PROD) {
      const ch = await detectViteChannel()
      if (ch && ch !== VUE) {
        throw new Error(`已有一个带调试口的实例在跑，但它连的是 Vue ${ch} 通道，本次要测 ${VUE}。请先关掉它再重试。`)
      }
    }
    return { launched: false }
  }

  if (PROD) {
    // 静态服务已经占住 5173，主进程 dev-loader 探测到端口有响应就会 loadURL —— 加载的正是生产产物
    console.log('[inp] prod 模式：不启动 Vite，5173 由静态服务托管生产产物')
  } else if (!(await viteUp())) {
    console.log(`[inp] Vite 未就绪，启动开发服务器（${VUE_LABEL}）…`)
    // 直接用 dev-vite.js 而不是 `npm run dev`：它与 npm script 等价，但额外支持 --vue36 / --vdom
    // 切通道，且省掉两层 npm 套娃（约 1.1s 启动开销，见该文件头注释）。
    const vueArgs = VUE === '36' ? ['--vue36'] : VUE === '36v' ? ['--vue36', '--vdom'] : []
    viteChild = spawn(
      process.execPath,
      [path.join(FRONTEND, 'dev-vite.js'), ...vueArgs],
      {
        cwd: FRONTEND,
        stdio: 'inherit',
        detached: process.platform !== 'win32',
      },
    )
    const deadline = Date.now() + 30000
    while (Date.now() < deadline && !(await viteUp())) await sleep(500)
    if (!(await viteUp())) throw new Error('Vite 开发服务器 30s 内未就绪')
  } else {
    const ch = await detectViteChannel()
    if (ch && ch !== VUE) {
      throw new Error(`5173 上已有的 Vite 是 Vue ${ch} 通道，本次要测 ${VUE}。请先关掉它再重试。`)
    }
    console.log(`[inp] Vite 已在运行（通道 Vue ${ch || '?'}）`)
  }

  const electronPath = require('electron')
  // INP_NO_THROTTLE=1：关闭 Windows 原生「窗口被遮挡/后台」渲染节流。
  // 测量时窗口常被终端盖住，遮挡检测会把帧率压下来，让每次交互都多等一个迟到的帧
  // （呈现被固定抬高到几十毫秒），这不是真实交互成本，可用本开关排除。
  const noThrottle = process.env.INP_NO_THROTTLE
    ? ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
       '--disable-features=CalculateNativeWinOcclusion']
    : []
  // 宿主环境隔离：某些宿主（WorkBuddy 自身就是 Electron 应用 / 部分 CI）会给子进程注入
  // ELECTRON_RUN_AS_NODE=1，此时 electron.exe 会退化成纯 Node 直接跑 main.js，
  // `require('electron').app` 变 undefined → "Cannot read properties of undefined (reading 'isPackaged')"。
  // NODE_OPTIONS 里的 --require 预加载同理会污染主进程。两者都必须摘掉。
  const childEnv = { ...process.env, INP_DEBUG: '1', FORCE_SETUP: '0' }
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.NODE_OPTIONS
  console.log(`[inp] 启动 Electron（INP_DEBUG=1, FORCE_SETUP=0${noThrottle.length ? ', 关闭遮挡节流' : ''}）…`)
  const child = spawn(electronPath, ['.', ...noThrottle], {
    cwd: ROOT,
    env: childEnv,
    stdio: 'inherit',
  })
  child.on('exit', (code) => { console.log(`[inp] Electron 退出（code=${code}）`) })
  return { launched: true, child }
}

async function main() {
  // 生产口径：先把产物建好、静态服务就位，再拉起外壳。
  // 顺序有意如此 —— 构建期间不启动 Electron，避免构建失败时留下一个连不上的实例占着单实例锁。
  if (PROD) {
    // 先确认端口空闲，再花一分多钟构建：反过来会白等
    if (await viteUp()) {
      throw new Error('5173 已被占用（dev server 还在跑）。prod 模式需要它来托管生产产物，请先关掉再重试。')
    }
    await buildProd()
    await serveProd()
    console.log(`[inp] 静态服务已就绪：${PAGE_BASE}（产物 ${path.relative(ROOT, PROD_DIR)}）`)
  }

  const { child } = await ensureRunner()
  const target = await Promise.race([
    waitForMainTarget(45000),
    new Promise((_, rej) => {
      if (child) child.once('exit', (code) => rej(new Error(
        `Electron 启动后立即退出（code=${code}）：通常是有另一个实例正占用单实例锁。请先完全关闭正在运行的 app 再重试。`)))
    }),
  ])
  if (!target) throw new Error('45s 内未发现主窗口调试目标；请确认没有其它实例占用（单实例锁）')
  const cdp = await rawConnect(target.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  // 先等后端起来，再让渲染进程重新加载数据；否则首屏请求会打在未就绪的后端上（ECONNREFUSED），
  // 整轮测量都落在空表 app 上，拿不到任何有效证据。
  console.log('[inp] 等待后端就绪…')
  if (!(await waitForBackend(20000))) console.log('[inp] 警告：后端 20s 内未就绪，页面可能取不到数据')

  // 先回到首页，之后靠点侧边栏切换（这样「切换页面」才是真实交互）
  // prod 下这几行是整轮测量的分水岭：从这里开始渲染进程跑的是生产产物，外壳（5173）不再参与。
  await cdp.send('Page.navigate', { url: PAGE_BASE + '/' })
  await waitFor(cdp, 'document.readyState', (v) => v === 'complete', 20000)
  await sleep(1500)
  await cdp.eval(INJECT)

  // 口径自校验：prod 模式必须真的落在生产产物上。
  // 判据用 dev 探针是否存在 —— inpProbe.js 整个模块被 `if (import.meta.env.DEV)` 包裹、
  // 生产构建时摇树删除，所以 window.__inp 不存在才说明跑的是生产包。
  // 不校验的话，导航静默失败（产物缺 index.html、端口占错）会让整轮测在 dev 页上，结论全反。
  const modeCheck = await cdp.eval(`({
    href: location.href,
    hasDevProbe: typeof window.__inp === 'function',
    scripts: document.querySelectorAll('script[src]').length,
    // 登录态按 origin 存（authStorage.js：token / currentUser），同端口才能复用 ——
    // 一旦这里 tokenLen 为 0，说明整轮会落在登录页，不必等它跑到超时
    tokenLen: (localStorage.getItem('token') || '').length,
    hasUser: !!localStorage.getItem('currentUser'),
  })`)
  console.log('[inp] 页面口径:', JSON.stringify(modeCheck))
  if (PROD) {
    if (modeCheck.hasDevProbe) throw new Error('prod 校验失败：页面仍装着 dev 探针，说明没切到生产产物')
    if (!modeCheck.href.startsWith(PAGE_BASE)) throw new Error(`prod 校验失败：当前 URL 是 ${modeCheck.href}，不是 ${PAGE_BASE}`)
  } else if (!modeCheck.hasDevProbe) {
    console.log('[inp] 提示：dev 通道下也没装 inpProbe（二级视图会空），确认 5173 起的是 dev 而非生产')
  }

  // 诊断（只读）：打印当前主题与合成/绘制相关的计算样式，便于把「呈现」成本归因到具体图层。
  const envInfo = await cdp.eval(`(() => {
    const cs = (el, prop) => (el ? getComputedStyle(el)[prop] : null);
    const glass = [...document.querySelectorAll('*')].filter((e) => {
      const v = getComputedStyle(e).backdropFilter;
      return v && v !== 'none';
    });
    const area = glass.reduce((a, e) => { const r = e.getBoundingClientRect(); return a + r.width * r.height }, 0);
    return {
      theme: document.documentElement.dataset.theme,
      topbar: document.documentElement.dataset.topbarColor,
      hasBgImage: document.documentElement.classList.contains('has-bg-image'),
      bodyBg: (cs(document.body, 'backgroundImage') || '').slice(0, 56),
      bodyBgAttach: cs(document.body, 'backgroundAttachment'),
      mainBgColor: cs(document.querySelector('main'), 'backgroundColor'),
      mainBgAttach: cs(document.querySelector('main'), 'backgroundAttachment'),
      glassPanels: glass.length,
      glassAreaPct: Math.round(100 * area / (innerWidth * innerHeight)),
      dpr: devicePixelRatio,
      vw: innerWidth,
      vh: innerHeight,
      gl: (() => {
        try {
          const c = document.createElement('canvas');
          const g = c.getContext('webgl2') || c.getContext('webgl');
          if (!g) return 'none';
          const d = g.getExtension('WEBGL_debug_renderer_info');
          return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
        } catch (e) { return 'err' }
      })(),
    };
  })()`)
  console.log('[inp] 运行环境:', JSON.stringify(envInfo), '| 通道:', VUE_LABEL)

  // 诊断开关：INP_EXTRA_CSS 注入一段页面样式，用来「假设性」验证某项成本的占比（仅测量用）。
  if (process.env.INP_EXTRA_CSS) {
    await cdp.eval(`(() => {
      const s = document.createElement('style');
      s.textContent = ${JSON.stringify(process.env.INP_EXTRA_CSS)};
      document.head.appendChild(s);
    })()`)
    console.log('[inp] 已注入 INP_EXTRA_CSS')
  }

  const info0 = await cdp.eval('window.__pageInfo()')
  if (info0.onLogin) throw new Error('落在登录页：localStorage 登录态无效，请先在 app 内登录后再跑本脚本')

  // 学生表为空时补 5 条测试学生：否则 /students 的「单元格双击编辑」「撤销/重做」永远被跳过。
  // （仅空表时插入，反复跑不会累积；写入的是当前测试账号，对用户数据无影响）
  console.log('[inp] 学生表预置:', JSON.stringify(await cdp.eval('window.__inpSeedStudents(5)')))

  const out = { steps: [], skipped: [] }
  for (const route of ROUTES) {
    console.log(`\n[inp] ==== ${route}（${NAV[route]}）====`)
    const info = await driveRoute(cdp, route, out)
    ROUTE_LOG.push({ route, name: NAV[route], ...info })
    console.log(`[inp] 页面概况:`, JSON.stringify(info))
  }

  const raw = await cdp.eval('window.__inpRaw.entries')
  const measures = await cdp.eval('window.__perfMeasures()')
  const probe = await cdp.eval('window.__inpProbe()')

  report(out, raw || [], measures || [], probe, envInfo)

  if (process.env.INP_ONESHOT) {
    console.log('\n[inp] 测量结束（one-shot）。')
    cdp.close()
    if (child) killTree(child)
    stopVite()
    stopProd()
    process.exit(0)
  }
  console.log('\n[inp] 测量结束。窗口保持打开，可自行再操作；Ctrl+C 退出脚本。')
  if (!child) cdp.close()
}

// ---------------------------------------------------------------- 报告
function report(out, raw, measures, probe, envInfo) {
  // 按 interactionId 聚合：取该交互里「最长的那条事件」代表整体，并拆三段
  const byId = new Map()
  for (const e of raw) {
    const cur = byId.get(e.interactionId)
    if (!cur || e.duration > cur.duration) byId.set(e.interactionId, e)
  }

  const rows = []
  for (const e of byId.values()) {
    let best = null, bestGap = Infinity
    for (const s of out.steps) {
      const gap = Math.abs(s.t - e.startTime)
      if (gap < bestGap) { bestGap = gap; best = s }
    }
    const matched = best && bestGap < 1500
    const win = measures
      .filter((m) => m.startTime >= e.startTime - 5 && m.startTime <= e.startTime + e.duration + 50)
      .map((m) => `${m.name}=${m.duration.toFixed(0)}ms`)
    rows.push({
      页面: matched ? best.route : '-',
      类别: matched ? best.cat : '未匹配',
      场景: matched ? best.label : `(${e.name})`,
      事件: e.name,
      输入延迟: Math.round(e.processingStart - e.startTime),
      处理: Math.round(e.processingEnd - e.processingStart),
      呈现: Math.round(e.startTime + e.duration - e.processingEnd),
      总耗时: Math.round(e.duration),
      打点: win.join(' '),
    })
  }
  rows.sort((a, b) => b.总耗时 - a.总耗时)

  console.log('\n================ 脚本驱动 INP 报告（按交互总耗时降序）================')
  console.log('总耗时 = 输入延迟 + 处理 + 呈现（event-timing duration，量化到 8ms 台阶）\n')
  if (rows.length) console.table(rows)
  else console.log('（未采集到任何交互，检查窗口是否有输入权限/页面是否已登录）')

  // 按类别聚合（脚本侧口径）
  const agg = new Map()
  for (const r of rows) {
    const k = r.类别
    const a = agg.get(k) || { 类别: k, 次数: 0, 最长: 0, 输入延迟: 0, 处理: 0, 呈现: 0 }
    a.次数++
    if (r.总耗时 > a.最长) { a.最长 = r.总耗时; a.输入延迟 = r.输入延迟; a.处理 = r.处理; a.呈现 = r.呈现 }
    agg.set(k, a)
  }
  const catRows = [...agg.values()].sort((a, b) => b.最长 - a.最长)
  console.log('\n---- 按交互类别（脚本侧，最长那次的三段拆分）----')
  if (catRows.length) console.table(catRows)

  // 开发版探针（≥40ms）的分类视图，跨整个进程累计
  console.log('\n---- 开发版探针分类视图（inpProbe.js，仅 ≥40ms，进程内累计）----')
  if (probe && probe.categories && probe.categories.length) {
    console.table(probe.categories)
    if (probe.details && probe.details.length) {
      console.log('最慢交互明细:')
      console.table(probe.details)
    }
  } else {
    console.log(PROD
      ? '（生产构建把 inpProbe.js 整块摇树删除了，此视图只有 dev 口径才有）'
      : '（探针未装/无样本：确认是 dev 模式启动）')
  }

  if (out.skipped.length) {
    console.log('\n---- 跳过的步骤 ----')
    for (const s of out.skipped) console.log('  · ' + s)
  }
  console.log('\n说明：INP 关注的是「交互 → 下一帧画出来」的总耗时，故重点看「呈现」占比；')
  console.log('     「处理」含 await 网络往返（如保存类请求）；「打点」列是本仓库已有的整表渲染 measure。')

  // 落盘：A/B 两轮各写一份，供 inp-compare.mjs 出对比表（testjs/tmp 不入库）
  // prod / dev 的绝对耗时不可混比（dev 运行时带全套断言、模块未压缩），后缀分开存。
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    const file = path.join(OUT_DIR, `inp-${VUE}${PROD ? '-prod' : ''}.json`)
    writeFileSync(file, JSON.stringify({
      vue: VUE,
      label: VUE_LABEL + (PROD ? '（生产构建）' : ''),
      mode: PROD ? 'prod' : 'dev',
      generatedAt: new Date().toISOString(),
      env: envInfo,
      overview: ROUTE_LOG,
      rows,
      categories: catRows,
      skipped: out.skipped,
    }, null, 2), 'utf8')
    console.log(`\n[inp] 结果已落盘：${path.relative(ROOT, file)}`)
  } catch (err) {
    console.log('\n[inp] 落盘失败（不影响本次结论）：' + err.message)
  }
}

// 清理：结束脚本时一并关掉它启动的子进程
function wireCleanup() {
  const kill = () => {
    stopVite()
    stopProd()
    try { process.exit(0) } catch {}
  }
  process.on('SIGINT', kill)
  process.on('SIGTERM', kill)
  process.on('exit', () => { stopVite(); stopProd() })
}

wireCleanup()
main().catch((err) => { console.error('[inp] 失败:', err.message); process.exit(1) })
