// ===== 启动分段打点 =====
// 主进程的「后端就绪」只覆盖「fork → listen 成功」这一整段，中间是黑盒；实测线上出现过
// 283ms ~ 5325ms 的 18 倍波动，无法判断是 Node 引导、模块 require 还是 listen 本身。
// 这里按阶段打 stdout（主进程 backendLog 会写进 backend.log），只看不改行为。
// 文字刻意避开 "listening" / "server started" —— 主进程靠正则 detectBackendReady 判就绪，不能被误触。
const _bootT0 = Date.now();
// 2-21：PERF_STARTUP=1 时额外带上绝对 epoch，供主进程把「fork 发起 / 子进程 spawn」与这里的
// 「入口 / 监听成功」按同一时钟相减，拆开「进程创建」和「Node 引导 + bundle 加载」两段空档。
const _bootEpoch = () => (process.env.PERF_STARTUP === '1' ? ` @${Date.now()}` : '');
const _boot = (name) => { try { console.log(`[boot] +${Date.now() - _bootT0}ms ${name}${_bootEpoch()}`); } catch (_) { /* 日志失败不影响启动 */ } };
_boot('后端进程入口');

// 2-17 归因：PERF_STARTUP=1 时记录 ≥10ms 的 GC 停顿，判断后端启动期事件循环
// 的 128ms 阻塞是否来自 V8 垃圾回收（不改变任何业务行为）。
if (process.env.PERF_STARTUP === '1') {
  try {
    const { PerformanceObserver } = require('perf_hooks');
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration >= 10) {
          try { console.log(`[boot] GC kind=${e.kind} ${e.duration.toFixed(1)}ms @${Date.now()}`); } catch (_) { /* 静默 */ }
        }
      }
    });
    obs.observe({ entryTypes: ['gc'] });
  } catch (_) { /* 观察器不可用不影响启动 */ }
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const { auth, authStatic, warmupAuth } = require('./middleware/auth');
const { createDynamicTableRouter } = require('./routes/dynamicTable');

// 上传文件的类型校验（扩展名白名单 + 真实字节魔数）已统一到
// services/uploadSignatures.js —— 收据不再只收图片，签名表跟着扩展了，
// 不再在这里留第二份只有图片签名的副本。

const { db } = require('./db');
const dbManager = require('./dbManager/dbManager');
const secureChannel = require('./services/secureChannel');
const { deleteRow } = require('./services/tableService');
const { studentRelations, purgeStudentRelations } = require('./services/studentRelations');
const { resolveNames } = require('./services/provisionalStudents');
const { autoSemester } = require('./utils/semester');

// 关键路由：启动时立即加载（登录必需）
const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');

_boot('核心模块 require 完成（含 db/middleware/auth）');

const app = express();
// 端口可用环境变量覆盖（默认 3000）：打包/日常运行行为不变，
// 仅用于在同一台机器上并行起一个「隔离数据目录」的测试后端做性能测量。
const PORT = Number(process.env.PORT) || 3000;

// 首屏归因（v6 · 2-13）：PERF_STARTUP=1 时记录 /api/dashboard 到达 Express 的 epoch。
// 与 handler 里的「进入 <epoch>」相减，判断空档在 Node 事件循环/让路链，还是在渲染层/网络。
if (process.env.PERF_STARTUP === '1') {
  app.use((req, res, next) => {
    if (req.path === '/api/dashboard') {
      try {
        console.log(`[boot] dashboard 到达 ${req.method} ${Date.now()}`);
        // 预检（OPTIONS）与真实 GET 是两段：记录各自完成时刻，才能分清「预检响应被事件循环拖住」
        // 与「真实请求到达后排队」。只在显式开关下输出，默认零日志。
        res.on('finish', () => {
          try { console.log(`[boot] dashboard 完成 ${req.method} ${Date.now()}`); } catch (_) { /* 静默 */ }
        });
      } catch (_) { /* 打点失败静默 */ }
    }
    next();
  });
}

// CORS 白名单：只允许应用自身来源（Electron 自定义协议 / file://）与本机回环页面访问。
// 之前裸 cors() 会回显任意站点的 Origin，任意网页都能把响应读走，配合本机明文凭据会扩大攻击面。
const CORS_ORIGIN_RE = /^(?:app:\/\/|file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$)/;
app.use(cors({
  origin(origin, cb) {
    // 无 Origin：Electron 主进程 / Node 客户端 / 同源请求；'null'：file:// 页面
    if (!origin || origin === 'null') return cb(null, true);
    return cb(null, CORS_ORIGIN_RE.test(origin));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Auth-Proof'],
  // X-Photo-Id：首页随机配图的照片 id，随二进制缩略图一起回，用来从首页点进相册时定位到这一张。
  exposedHeaders: ['X-Auth-Required', 'X-Renewed-Token', 'X-Renewed-Media', 'X-Photo-Id'],
}));

// Host 校验：仅接受本机回环地址的请求，阻断「任意网页/DNS rebinding 探测 localhost API」。
// 本服务是本地单用户后端，且 Token 可通过 Header/Cookie/Query 携带，
// 恶意网页即使跨域发来请求，其 Host 头也不是 localhost，故一律拒绝。
app.use((req, res, next) => {
  const host = String(req.get('host') || '').replace(/:\d+$/, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return next();
  return res.status(403).json({ error: '非法访问' });
});
// 备份包内含整库 base64 数据，体积可能达数十 MB，需放大请求体上限以避免 413
app.use(express.json({ limit: '200mb' }));

// 加密通道中间件：请求解密优先于路由处理，响应加密在 express.json 之后
// 仅当有 K_master（SECURE_MASTER 注入）时才真正安装，否则不影响明文请求
if (secureChannel.hasMaster()) {
  app.use(secureChannel.requestDecrypt);
  app.use(secureChannel.responseEncrypt);
  // 信道凭据：解 X-Auth-Proof 为 req.channelToken / 会话绑定身份。
  // 必须排在 requestDecrypt 之后：凭据的 sid 要与请求体加密用的会话一致（见中间件内校验）。
  app.use(secureChannel.requestAuthProof);
  // 握手端点：前置公开，不要求认证
  const secureRouter = express.Router();
  secureRouter.post('/handshake', (req, res) => {
    try {
      const { pub } = req.body;
      if (!pub || typeof pub !== 'string') {
        return res.status(400).json({ error: 'bad request' });
      }
      const _hsT0 = Date.now();
      const result = secureChannel.performHandshake(pub);
      if (process.env.PERF_STARTUP === '1') {
        const dt = Date.now() - _hsT0;
        try { console.log(`[boot] 握手处理 ${dt}ms @${Date.now()}`); } catch (_) { /* 静默 */ }
      }
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });
  app.use('/api/secure', secureRouter);
  console.log('[secure] 安全通道已启用（K_master 注入），加密传输生效');
} else {
  console.log('[secure] 安全通道未注入密钥，保持明文传输（兼容默认环境）');
}

// 静态图片资源鉴权：收据、背景图均需登录（Cookie/Header 校验），避免敏感文件被未授权访问
// 目录统一指向 DATA_DIR/uploads（可写，打包后位于 userData，不在只读 asar 内）
app.use('/uploads', authStatic(), express.static(dbManager.uploadsDir));
app.use('/api/background', authStatic(), express.static(dbManager.backgroundDir));

// ===================== 关键路由（登录页必需） =====================
// 引导页学期推荐（免登录）：首次安装时账号还没创建，但「班级与学期」表单要先显示推荐日期。
// 只返回 autoSemester() 的纯日期建议，不读任何用户数据 —— 所以放在鉴权之外是安全的。
// 已登录且库里有当前学期时，前端走 /api/schedule/semesters/prefill（能拿到真实值与 id）。
app.get('/api/setup/semester-prefill', (req, res) => {
  res.json({ id: null, ...autoSemester() });
});
app.use('/api', authRoutes);
app.use('/api/account', accountRoutes);
// 首屏聚合接口：登录页/首页最早的一条业务请求，必须在 listen 之前就挂好。
// 原先它排在懒加载队列最后一个 loader，队列被拆成逐 tick 让路后，它可能在
// 队列跑完前就到达 —— 路由不存在会直接 404，前端首屏就拿不到数据。
// 这里只 require 一个很轻的 Router；9 个业务读函数仍在 handler 内按需 require。
app.use('/api/dashboard', auth(['teacher']), require('./routes/dashboard'));
// 首屏 AI 配置：App.vue 挂载后立刻 GET /api/ai/config 决定是否显示浮动按钮，与 dashboard
// 同一条原则 —— 首屏依赖不能交给让路链。慢机器上链要 ~85ms 才跑到 ai 这一步，请求先到
// 就是 404，AI 入口会一直消失到下次刷新。
// 这里只挂 ai.config（顶层仅 express / crypto / aiConfigStore，不碰 pdf-parse 等重模块）；
// 让路链仍在后台注册完整 ai router，其它 /api/ai/* 穿过本 router 落到它，行为不变。
// 两处复用同一个 ai.config 模块，配置读写只有一份实现。
app.use('/api/ai', auth(['teacher']), require('./routes/ai/ai.config'));
app.use('/api/students', auth(['teacher']), createDynamicTableRouter('students', {
  protectedColumns: ['学号', '姓名'],
  extraRoutes: (router) => {
    // 姓名解析：值日/座位/小组成员里直接输入的名字 → 稳定的 students.id。
    // 正式学生唯一同名直接复用；没有就建一条临时学生（is_provisional=1）；
    // 正式名单里本来就有多个同名时返回 candidates，让前端自己让用户选，绝不新建。
    // body: { names: string[], create?: boolean } → { results: [{ name, id, created, is_provisional, ambiguous?, candidates? }] }
    router.post('/resolve', (req, res) => {
      try {
        const names = Array.isArray(req.body && req.body.names) ? req.body.names : [];
        if (!names.length) return res.status(400).json({ error: '缺少姓名' });
        const create = !(req.body && req.body.create === false);
        res.json({ results: resolveNames(names, { create }) });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // 临时学生列表：在其他表格里直接输入的新名字先落成 is_provisional=1 的学生，
    // 由「学生管理 → 数据管理」统一转正。引用数量复用删除前的关联统计，
    // 让老师在转换前看到「这个人还挂在哪些表里」。
    router.get('/provisional', (req, res) => {
      try {
        const rows = db.prepare('SELECT * FROM students WHERE is_provisional = 1 ORDER BY position, id').all();
        res.json({ data: rows.map((s) => ({ ...s, relations: studentRelations(s) })) });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // 批量转正：只改成员状态位，id 与所有引用保持不变（转正不需要迁移任何数据）。
    router.post('/provisional/convert', (req, res) => {
      try {
        const raw = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
        const ids = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
        if (!ids.length) return res.status(400).json({ error: '请选择要转换的临时学生' });
        let converted = 0;
        db.transaction(() => {
          const upd = db.prepare('UPDATE students SET is_provisional = 0 WHERE id = ? AND is_provisional = 1');
          for (const id of ids) converted += upd.run(id).changes;
        })();
        res.json({
          message: converted ? `已转换 ${converted} 名临时学生为正式学生` : '所选学生已经是正式学生',
          converted,
        });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    // 删前影响预览：返回该生关联的 请假/加分/座位/值日 数量（学生本身不与它们建外键，靠 id/姓名弱关联）
    router.get('/:id/relations', (req, res) => {
            const id = Number(req.params.id);
      const student = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
      if (!student) return res.status(404).json({ error: '学生不存在' });
      res.json(studentRelations(student));

    });

    // 一并删除学生 + 勾选的关联记录（body.relations：{ leave/score/seat/duty/group/cadre }）。
    // 返回被删的请假/加分整行，便于前端登记撤销。
    router.post('/:id/delete-with-relations', (req, res) => {
      try {
        const id = Number(req.params.id);
        const student = db.prepare('SELECT * FROM students WHERE id = ?').get(id);
        if (!student) return res.status(404).json({ error: '学生不存在' });
        const rel = (req.body && req.body.relations) || {};
        let removed = null;
        db.transaction(() => {
          // 把学生整行也放进 removed：撤销要重建这个学生，不能只靠前端传回的前端行
          // （前端行可能是列表里的投影，缺列）。七处清理结果合成一条可撤销快照。
          removed = {
            student,
            ...purgeStudentRelations(student, {
              leave: !!rel.leave, score: !!rel.score, seat: !!rel.seat, duty: !!rel.duty,
              group: !!rel.group, cadre: !!rel.cadre,
            }),
          };
          // 关联已按用户勾选 purge 完，显式放行「删学生」的关联守卫：
          // 用户可能故意保留某些关联（撤销要能整条还原），这是他的选择，不是漏清。
          deleteRow('students', id, { allowStudentOrphans: true });
        })();
        res.json({ message: '已删除学生及其关联记录', removed });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
  }
}));

// 前端静态资源由 Electron 的 app:// 协议提供（见 electron/main/main.protocol.js）。
// B1 不再让后端托管 dist：页面 origin 保持 app://local，只有 /api 经主进程代理到本进程，
// 避免把 UI 暴露成 127.0.0.1 上任何本机程序都能打开的源。

// ---- 延后路由的「按需注册」门卫 ----
// lateLoaders 要等 LATE_LOAD_DELAY_MS 才挂（让出首屏），但界面可见在 ~479ms，用户完全
// 可能在这 800ms 里就点进「数据管理 / 班费明细」。少了这个门卫，这两个前缀会直接落到
// Express 默认 404。命中就同步 flush 一次再 next()，本次请求可继续走到刚追加的 layer
// （实测：请求处理期间 app.use 追加的路由，同一次请求就能命中）。
// 定时到点与按需走同一个 flushLateLoaders，靠 lateLoaded 保证不重复 app.use。
const LATE_PATH_PREFIXES = ['/api/data', '/api/fee-records'];
let flushLateLoaders = null;
app.use((req, res, next) => {
  const p = req.path;
  if (flushLateLoaders && LATE_PATH_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`))) {
    try { flushLateLoaders(); } catch (err) { console.error('[defer] 延后路由按需注册失败:', err); }
  }
  next();
});

// ===================== 启动服务器 =====================
// 统一错误出口只装一次：startServer 在端口被占用时会递归重入，
// 若每次都 app.use 会在栈里堆叠多个错误中间件（第一个处理完就结束，不会出错，但没必要）。
let errorHandlerInstalled = false;
// 让路链同理：重入时不能把 warmup / 20 个 loader 再排一遍（会重复 app.use）。
let deferredStarted = false;

// 端口冲突时自动重试（应用退出后旧进程可能未完全释放端口）
function startServer(port) {
  _boot(`开始监听端口 ${port}`);
  // 只监听本机回环地址（127.0.0.1）：若像原先那样不指定 host，Node 会监听 0.0.0.0/::，
  // 首次启动即触发 Windows 防火墙“允许访问”弹窗。本服务只供本机前端/主进程访问，
  // 绑定回环即可满足需求，且不会触发防火墙提示（检查更新是出站请求，本就不会弹窗）。
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`✅ 服务器已启动：http://127.0.0.1:${port}`);
    _boot('监听成功 = 就绪');

    // 2-17 归因：区分「TCP 连接到达」与「请求进入 Express」。
    // 若连接到达早、请求日志晚，说明后端事件循环被占；若连接本身晚，说明在 OS/客户端建连段。
    if (process.env.PERF_STARTUP === '1') {
      const { monitorEventLoopDelay } = require('perf_hooks');
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      server.on('connection', () => {
        try { console.log(`[boot] 连接到达 ${Date.now()}`); } catch (_) { /* 静默 */ }
      });
      setTimeout(() => {
        try {
          console.log(`[boot] 后端事件循环 p50=${(loop.percentile(50) / 1e6).toFixed(1)}ms p95=${(loop.percentile(95) / 1e6).toFixed(1)}ms max=${(loop.max / 1e6).toFixed(1)}ms`);
          loop.disable();
        } catch (_) { /* 静默 */ }
      }, 1500);
      // 阻塞窗口定位：5ms 心跳，凡是「本该 5ms 却隔了 ≥20ms」就说明事件循环被同步工作占住。
      // 与链步骤打点对照，可以判断 110ms 空档是落在某个 require 步骤内，还是在两次步骤之间。
      let _hbLast = Date.now();
      let _hbCpu = process.cpuUsage();
      const _hb = setInterval(() => {
        const now = Date.now();
        const dt = now - _hbLast;
        const cpu = process.cpuUsage(_hbCpu);
        _hbLast = now;
        _hbCpu = process.cpuUsage();
        if (dt >= 20) {
          // cpu：这段停顿里本进程实际用掉的 CPU。接近 0 = 被系统挂起/抢不到 CPU；
          // 接近 dt = 一直在跑（耗时在未被计时的原生/驱动层，如 DLL 加载、文件扫描）。
          try {
            console.log(`[boot] 循环停顿 ${dt}ms cpu=${((cpu.user + cpu.system) / 1000).toFixed(1)}ms 结束于 ${now}`);
          } catch (_) { /* 静默 */ }
        }
      }, 5);
      setTimeout(() => clearInterval(_hb), 3000);
    }

    // 就绪上报：通过 fork 的 IPC 通道告知主进程「端口已监听」，由主进程转发给各渲染窗口。
    // 前端据此在就绪瞬间发起首个请求，不再靠固定退避重试去「撞」端口。
    try { if (process.send) process.send({ type: 'backend-ready', port }) } catch (_) { /* 非 fork 场景忽略 */ }

    // 就绪信号后立即后台暖机：把「require sqlite 原生模块 + 打开 index/default 库并 initSchema」
    // 的一次性冷启动成本放到首个用户请求到达前悄悄完成，避免登录/首屏请求干等 cold start 而转圈。
    // 暖机失败静默，后续请求照常懒加载兜底，不影响功能。
    // 这里只**定义**步骤、不排队：下面统一由 runStep 串成一条每次只跑一步的链，
    // 每步之间事件循环能回到 poll 阶段处理网络请求（见文件末尾「让路链」说明）。
    const warmupStep = () => {
      // warmup 会加载 sqlite 原生模块、打开加密库并 initSchema —— 它不阻塞「就绪」信号，
      // 却直接决定第一个请求能不能立刻返回，也就是首屏数据什么时候到，因此单独计时。
      const _warmT0 = Date.now();
      try { dbManager.warmup(); } catch (_) { /* 暖机失败不影响正常懒加载路径 */ }
      // 鉴权模块预热：jsonwebtoken 首次 require 实测 79ms，原先落在首个请求的
      // verifyToken 里 —— 那次同步加载会把同时到达的首屏请求一起挡住（87~133ms 停顿）。
      // 放在这里：listen 已就绪（就绪信号不受影响）、首屏请求还没到，正好错开。
      try { warmupAuth(); } catch (_) { /* 暖机失败走懒加载兜底 */ }
      try { console.log(`[boot] +${Date.now() - _bootT0}ms 数据库 warmup 完成（本段 ${Date.now() - _warmT0}ms）`); } catch (_) { /* 忽略 */ }
      // 首屏第一笔同步开销提前（2026-11-14 打包版归因）：第一个请求进 auth 的 withDb 时
      // 才第一次开账号库，「KDF + openFile」实测 41~58ms；better-sqlite3 是同步的，这一笔
      // 会把同时到达的另外 4 个首屏请求一起挡在「连接到达」之后（dashboard 因此白等约 50ms）。
      // 这里趁「就绪已完成、首个请求还没到」的空窗先打开上次真正用过的那个库
      // （后端自己在 withDb 里把 slug 记在 data/.last-db，不靠会话猜）。
      // 与上面分开计时：上面那条日志的「本段」口径（含 sqlite 模块加载 + index 库 + 鉴权）保持不变。
      const _wuT0 = Date.now();
      try { dbManager.warmupMostRecent(); } catch (_) { /* 预热失败静默，首屏请求照旧自己冷开 */ }
      try { console.log(`[boot] +${Date.now() - _bootT0}ms 账号库预热完成（本段 ${Date.now() - _wuT0}ms）`); } catch (_) { /* 忽略 */ }
    };

    // 非关键路由懒加载：服务器就绪后再逐个注册，不阻塞就绪信号。
    // 原先这里用 for 循环把 20 个 loader 一次性塞进 setImmediate 队列 —— Node 会在
    // **同一轮 check 阶段把整个队列清空**，于是连续同步执行约 100~160ms，期间到达的
    // HTTP 请求连 accept 都进不去（实测启动期 OPTIONS 预检等了整整一个队列）。
    // 现在改成「一次只跑一步、跑完再排下一步」的让路链：每步之间事件循环会经过
    // poll 阶段，握手这类不依赖路由模块的请求可以立刻被处理，不必陪着 require 干等。
    // 大量 JS 与 .node 原生模块（album 的 sharp、ai 的 pdf-parse 等）总量不变，
    // 只是不再独占事件循环；路由仍会在用户登录后导航过去之前注册完毕。
    const deferredLoaders = [
      // ---- 首屏关键路径：/api/dashboard 的 7 个读函数会 require 这些模块 ----
      // 让路链按数组顺序逐步执行，排前面 = 首屏请求到达时它们已加载完。
      // 分 tick 让路后首屏可能提前到达；若模块还没轮到，dashboard 的 handler
      // 会自己同步 require（功能不坏，但那笔成本就落进首屏等待里）。
      // 所以把首屏依赖集中在链首，把完全用不到的重模块挤到链尾。
      () => { app.use('/api/schedule', auth(['teacher']), require('./routes/schedule')); },
      () => { app.use('/api/leaves', auth(['teacher']), require('./routes/leaves')); },
      () => { app.use('/api/album', auth(['teacher']), require('./routes/album')); },
      () => { app.use('/api/scores', auth(['teacher']), require('./routes/scores')); },
      () => { app.use('/api/duty', auth(['teacher']), require('./routes/duty')); },
      () => { app.use('/api/activities', auth(['teacher']), require('./routes/activities')); },
      () => { app.use('/api/countdowns', auth(['teacher']), require('./routes/countdowns')); },
      // ---- 首屏不需要：用户导航到对应页面之前注册完即可 ----
      () => { app.use('/api/seats', auth(['teacher']), require('./routes/seats')); },
      () => { app.use('/api/group-manage', auth(['teacher']), require('./routes/groupManage')); },
      () => { app.use('/api/widget-settings', auth(['teacher']), require('./routes/widgetSettings')); },
      () => { app.use('/api/undo', auth(['teacher']), require('./routes/undo/undo')); },
      () => { app.use('/api/search', auth(['teacher']), require('./routes/search')); },
      () => { app.use('/api/cadres', auth(['teacher']), require('./routes/cadres')); },
      // ⚠️ /api/ai 是首屏依赖（App.vue 挂载后立刻拉 /api/ai/config）。它不许进
      // lateLoaders（那要等 800ms），但配置部分的路由已在「关键路由」区提前挂好，
      // 所以这里只负责完整 ai router 的注册与重模块预热，首屏不会等它。
      () => { app.use('/api/ai', auth(['teacher']), require('./routes/ai/ai')); },
    ];

    // ---- 首屏用不到的重模块（延后注册）----
    // 判据是「首屏会不会用到」，不是「重不重」：/api/dashboard 的 7 个读函数覆盖了上面
    // 那一整组（连 album 的封面都在内），/api/ai 的完整 router 也首屏期间要用到 ——
    // 配置部分已在关键路由区提前挂好，这一组仍不许挪进 lateLoaders。
    // 真正能挪的只有这两个：数据管理（设置页）与班费明细，它们只在用户点进对应页面时用到，
    // 却各自带着 xlsx / multer 这类依赖。实测两者各 <10ms，所以这一组是**收尾级**收益，
    // 真正贵的那两步（album 20ms、ai 24ms）都是首屏依赖，挪不动。
    // 排到首屏之后（见 LATE_LOAD_DELAY_MS）。这两个前缀若被提前点到，由文件上方的
    // 按需门卫立刻 flush 注册，不会再出现 800ms 的固定 404 空窗。
    const lateLoaders = [
      // 数据管理：设置页的「表清单 / 取表数据 / 打 zip」，只读业务表，无写路径
      () => { app.use('/api/data', auth(['teacher']), require('./routes/dataExport')); },
      // 首屏聚合接口已提前到 listen 之前注册（见「关键路由」区），不再排进让路链：
      // 让路链下它可能在其余 loader 跑完之前就收到请求，路由必须先存在，否则 404。
      // 它的 9 个读函数在 handler 内 require，模块尚未加载时会自行同步加载，
      // Node 模块缓存保证不会和链里的 require 重复加载。
      // fee-records 含 multer（文件上传处理），一起延迟加载
      () => {
        const multer = require('multer');
        const { ALLOWED_EXT_RE, checkUpload, KINDS, decodeFileName, receiptKind } = require('./services/uploadSignatures');
        const { moveReceiptsToTrash } = require('./services/receiptTrash');
        // multer 的 limits 只能设一个总上限，按「最大的一类」给；分类上限在 handler 里判
        const MAX_UPLOAD_BYTES = Math.max(...Object.values(KINDS).map((k) => k.maxBytes));
        const storage = multer.diskStorage({
          destination: (req, file, cb) => cb(null, dbManager.uploadsDir),
          filename: (req, file, cb) => {
            const ext = (path.extname(file.originalname) || '.bin').toLowerCase();
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + ext);
          }
        });
        const upload = multer({
          storage,
          limits: { fileSize: MAX_UPLOAD_BYTES },
          fileFilter: (req, file, cb) => {
            // 只按扩展名初筛：Windows 上 mimetype 对 docx/xlsx 常常不可靠，
            // 真正的类型判断在 handler 里用魔数做（见 services/uploadSignatures.js）
            const ok = ALLOWED_EXT_RE.test(file.originalname || '');
            cb(ok ? null : new Error('不支持的文件类型'), ok);
          }
        });
        app.use('/api/fee-records', auth(['teacher']), createDynamicTableRouter('fee_records', {
          minCount: 1,
          fieldTypeOverrides: { '收支金额': '小数', '收支时间': '日期' },
          extraRoutes: (router) => {
            router.post('/upload-receipt', upload.array('receipts', 20), (req, res) => {
              if (!req.files || req.files.length === 0) {
                return res.status(400).json({ error: '没有上传文件' });
              }
              // 逐个校验扩展名 + 真实字节。任一个不合格就整批回滚 —— 部分成功会让
              // 前端拿到半份结果，用户还得自己比对哪几个传上去了。
              const files = [];
              const errors = [];
              for (const f of req.files) {
                // multer 给的 originalname 是 latin1 解码的，中文名会乱码，先转回 UTF-8
                const originalName = decodeFileName(f.originalname);
                const check = checkUpload(f.path, originalName, f.size);
                if (!check.ok) { errors.push(check.error); continue; }
                files.push({
                  // 收据字段存的是新结构（对象数组），旧数据可能是纯字符串数组，
                  // 前端读取时统一归一化（见 FeeManagement.vue 的 normalizeReceipts）
                  path: `/uploads/${f.filename}`,
                  name: originalName || f.filename,
                  size: f.size,
                  kind: receiptKind(check.kind),
                });
              }
              if (errors.length > 0) {
                req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (_) { /* 已被清理 */ } });
                return res.status(400).json({ error: errors.join('；') });
              }
              res.json({ files });
            }, (err, req, res, next) => {
              // 处理文件类型/大小被 multer 拒绝的情况（fileFilter/limits）
              res.status(400).json({ error: err && err.message ? err.message : '文件上传失败' });
            });

            // 收据文件移进回收站：只在「保存」时调用（前端点取消不该删磁盘文件）。
            // 收据从图片扩到视频后，删除只改数组会让 uploads 悄悄涨到几个 G。
            router.post('/receipt-trash', (req, res) => {
              const list = Array.isArray(req.body && req.body.paths) ? req.body.paths : [];
              const moved = moveReceiptsToTrash(
                list,
                dbManager.uploadsDir,
                dbManager.receiptTrashDir
              );
              res.json({ moved });
            });
          }
        }));
      },
    ];

    // 逐个注册 —— 改为「让路链」，统一在下方（所有步骤定义完之后）启动。
    // ⚠️ 旧写法是 for 循环一次性把 20 个 loader 全塞进 setImmediate 队列：
    // Node 会在**同一轮 check 阶段把整个队列清空**，这些 require 紧挨着连续跑完，
    // 期间到达的网络请求要排队等到队列结束（首个请求往往就是其中之一）。
    // 新写法每次只排一个回调、在回调里再排下一个：check 阶段只清空「进入该阶段时」
    // 的 immediate 队列，回调内部新排的会留到下一轮，于是链跨越多个事件循环迭代，
    // 中间必经 poll 阶段，网络请求有机会被 accept / 处理。
    // ⚠️ 代价：链运行期间部分路由尚未注册。启动期只有 handshake / dashboard 会被访问，
    // 两者都已在 listen 之前挂好；其余路由在用户登录后导航过去之前早已注册完毕。
    // 队列总耗时仍由下方「懒加载路由全部注册完成」打点记录，输出格式与口径不变。

    // 统一错误出口。**必须是最后一个注册的中间件** —— Express 按注册顺序匹配，
    // 错误中间件只能接住「在它之后注册」的路由抛出的错误。
    // 现在它作为让路链的最后一步之一执行：链跑完时全部路由已注册，顺序约束仍成立。
    // 链中途到达的请求若命中已注册路由并抛错，会落到 Express 默认错误处理器（500）；
    // 启动期只会访问 handshake / dashboard，前者自带 try/catch，后者每个读函数都有 safe() 兜底，
    // 所以不存在「先来的请求没有兜底」的实际窗口。
    //
    // 有了它，路由里不再需要
    //    ... 
    // 这种样板：Express 5 会自动捕获 async handler 的 rejected promise，
    // 同步 throw 本来就会被捕获，两者最终都落到这里。
    // 这里也只**定义**步骤，由下方 runStep 排进让路链。
    //
    // ⚠️ 会注册**两次**（见下方 flushLateLoaders）：lateLoaders 里那两个路由是在第一次注册之后才入栈的，
    // Express 只把错误交给「它之后注册的路由」抛出的错误，所以延后注册的路由需要末尾再兜一次。
    // 两次注册都是同一个 handler，同一个错误只会被第一个命中的处理，不会重复响应。
    const errorHandlerStep = (force) => {
      if (errorHandlerInstalled && !force) return;
      errorHandlerInstalled = true;
      app.use((err, req, res, next) => {
        // 响应头已发出（如流式下载写到一半）：交回 Express 默认处理，
        // 此时已无法改状态码，硬写会抛 ERR_HTTP_HEADERS_SENT 掩盖原始错误。
        if (res.headersSent) return next(err);
        const status = Number((err && (err.status || err.statusCode)) || 0) || 500;
        // 全量现场只进本地日志：这是用户自己机器上的单用户工具，控制台是唯一的诊断入口。
        console.error('[express-error]', req.method, req.originalUrl, '->', status, err);
        // 响应体形状必须保持 { error: string }：前端大量代码读 err.response.data.error。
        // 暂仍回传原始 message（本地工具，用户截图反馈时信息更全）；
        // 若将来要避免 SQL 语句 / 文件路径外露，只需改这一行。
        res.status(status).json({ error: (err && err.message) || '服务器内部错误' });
      });
    };

    // 队列完成打点：排在链的最后一环，执行时「懒加载路由已全部注册、兜底已装好」。
    // 输出格式与旧版完全一致；「队列 Xms」仍从第一个 loader 起算（不含 warmup）。
    // 旧口径下它≈首个请求最早能被完整处理的时刻；现在请求可以提前插队，
    // 这个数字只表示「后台 require 链自己跑完要多久」，不再是请求的等待上限。
    const finishStep = () => {
      try { console.log(`[boot] +${Date.now() - _bootT0}ms 懒加载路由全部注册完成（队列 ${Date.now() - _deferT0 - _delayAcc}ms）`); } catch (_) { /* 忽略 */ }
    };

    // ===== 让路链启动 =====
    // 端口冲突时 startServer 会递归重入，这里保证链只排一次（否则路由会被重复 app.use）。
    if (deferredStarted) return;
    deferredStarted = true;

    // 延后加载的等待时长。取值依据（打包版实测）：首屏请求在 listen 后 40~170ms 到达、
    // 250ms 内返回；800ms 让出这一整段窗口。这两个前缀若被提前访问，由按需门卫立刻注册，
    // 不依赖这段等待走完。
    // 置 0 = 立即注册：冒烟测试的隔离后端走这条 —— 用例常在就绪后 100ms 内就打到
    // /api/data、/api/fee-records，虽然有按需门卫兜底，置 0 可让用例不依赖门卫时序。
    const LATE_LOAD_DELAY_MS = Number(process.env.CLASSNEST_LATE_LOAD_DELAY_MS ?? 800) || 0;
    // 链里夹着一个「只等待」的步骤，队列耗时要把这段等待扣掉 —— 否则「队列 Xms」
    // 这个口径会被 800ms 污染，看不出 require 本身到底花多久。
    let _delayAcc = 0;

    // 按需（门卫）与定时（让路链）共用同一个注册入口，幂等。
    // 顺序要求：先补 ①「延后窗口内已注册路由」的错误兜底（链还没跑到就在这里补，
    // 已装过则空转）；再挂 lateLoaders 的路由；末尾再兜一次 ② —— Express 只把错误
    // 交给「在出错路由之后注册」的错误中间件，① 早于这些路由，接不住它们的错误。
    let lateLoaded = false;
    flushLateLoaders = () => {
      if (lateLoaded) return;
      lateLoaded = true;
      errorHandlerStep();
      for (const mount of lateLoaders) mount();
      errorHandlerStep(true);
    };

    const steps = [
      warmupStep,
      ...deferredLoaders,
      errorHandlerStep,                       // ① 先兜住「延后窗口」内已注册路由的错误
      { delay: LATE_LOAD_DELAY_MS },          // 让出首屏，之后再注册那两个重模块
      flushLateLoaders,                      // ② 到点也走同一入口（按需已注册过则空转）
      finishStep,
    ];
    let stepIdx = 0;
    let _deferT0 = 0;
    const runStep = () => {
      // 旧口径：_deferT0 记在「deferredLoaders 全部入队」那一刻，不含 warmup。
      // 链里第 0 步是 warmup，第 1 步起才是 loader，故在跑第 1 步前记时。
      if (stepIdx === 1) _deferT0 = Date.now();
      const step = steps[stepIdx++];
      // 只等待的步骤：不执行任何 require，到点后接着跑下一跳。
      // 等待时长为 0（冒烟测试）时直接跳过这一跳，不额外排一次 timer。
      if (step && typeof step === 'object') {
        const delayMs = Number(step.delay) || 0;
        if (delayMs <= 0) return runStep();
        _delayAcc += delayMs;
        if (process.env.PERF_STARTUP === '1') {
          try { console.log(`[boot] 让路链延后 ${delayMs}ms（首屏优先，之后注册 data / fee-records）`); } catch (_) { /* 静默 */ }
        }
        setTimeout(runStep, delayMs);
        return;
      }
      const _stepT0 = Date.now();
      if (process.env.PERF_STARTUP === '1') {
        try { console.log(`[boot] 链步骤 ${stepIdx - 1} 开始 @${_stepT0}`); } catch (_) { /* 静默 */ }
      }
      try { step(); } catch (err) { console.error('[defer] 让路链某步失败:', err); }
      if (process.env.PERF_STARTUP === '1') {
        const dt = Date.now() - _stepT0;
        if (dt >= 10) {
          try { console.log(`[boot] 链步骤 ${stepIdx - 1} ${dt}ms @${Date.now()}`); } catch (_) { /* 静默 */ }
        }
      }
      if (stepIdx < steps.length) setImmediate(runStep);
    };
    setImmediate(runStep);
  });

  // 1-6：本地回环 + 单客户端（主进程代理），把空闲保活从 Node 默认 5s 拉长到 60s。
  // 好处：间隔超过 5s 的请求不必每次重开 TCP（省一次建连与端口分配）。
  // headersTimeout 必须大于 keepAliveTimeout —— 否则 Node 会先按「请求头超时」把连接掐掉，
  // 保活等于没生效。本服务只供本机前端/主进程访问，拉长不增加外部暴露面。
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 61_000;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${port} 被占用，等待 1s 后重试...`);
      setTimeout(() => server.close(() => startServer(port)), 1000);
    } else {
      console.error('服务器启动失败:', err);
      process.exit(1);
    }
  });

  // 优雅退出：收到 SIGTERM 时关闭服务器
  process.on('SIGTERM', () => server.close(() => process.exit(0)));

  // 退出前先叫醒扫描子进程。
  // 为什么必须主动做：worker 是 fork 出来的子进程，父进程 exit() 后它会**继续活着**
  //（Windows 上更是彻底没人管），变成一个孤儿进程继续扫库写库 —— 磁盘 IO 与 CPU 全被它占着，
  // 而前端已经显示「后端已关闭」。所以退出前发一条 shutdown 让它自己收工退出。
  process.on('exit', () => {
    try { require('./scanWorker').shutdown(); } catch (_) { /* 模块未加载过就算了 */ }
  });
}

// 心跳应答：主进程周期性发 ping，这里的回调只有在事件循环空闲时才会被执行。
// 若后端「假死」（进程尚在但事件循环被同步操作卡住，如 better-sqlite3 慢查询/锁等待），
// pong 会随之延迟或不来，主进程据此判定异常并重连。纯内存操作，不碰数据库、不写日志。
process.on('message', (msg) => {
  if (!msg) return;
  // 性能面板：内存自报（process.memoryUsage()，单位字节，由主进程换算）
  if (msg.type === 'mem-query') {
    try { if (process.send) process.send({ type: 'mem-report', mem: process.memoryUsage() }) } catch (_) { /* 通道断开忽略 */ }
    return;
  }
  // 性能面板：手动 GC（需以 --expose-gc 启动才有 global.gc）
  if (msg.type === 'gc-request') {
    let ok = false;
    try {
      if (typeof global.gc === 'function') { global.gc(); ok = true; }
    } catch (_) { ok = false; }
    try { if (process.send) process.send({ type: 'gc-report', ok }) } catch (_) { /* 通道断开忽略 */ }
    return;
  }
  if (msg.type !== 'ping') return;
  try { if (process.send) process.send({ type: 'pong', t: msg.t }) } catch (_) { /* 通道断开忽略 */ }
});

startServer(PORT);