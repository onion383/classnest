// ===== 启动分段打点 =====
// 主进程的「后端就绪」只覆盖「fork → listen 成功」这一整段，中间是黑盒；实测线上出现过
// 283ms ~ 5325ms 的 18 倍波动，无法判断是 Node 引导、模块 require 还是 listen 本身。
// 这里按阶段打 stdout（主进程 backendLog 会写进 backend.log），只看不改行为。
// 文字刻意避开 "listening" / "server started" —— 主进程靠正则 detectBackendReady 判就绪，不能被误触。
const _bootT0 = Date.now();
const _boot = (name) => { try { console.log(`[boot] +${Date.now() - _bootT0}ms ${name}`); } catch (_) { /* 日志失败不影响启动 */ } };
_boot('后端进程入口');

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const { auth, authStatic } = require('./middleware/auth');
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
  exposedHeaders: ['X-Auth-Required', 'X-Renewed-Token', 'X-Renewed-Media'],
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
      const result = secureChannel.performHandshake(pub);
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

// 托管前端静态文件（生产模式用）
app.use(express.static(path.join(__dirname, '../dist')));

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
      try { console.log(`[boot] +${Date.now() - _bootT0}ms 数据库 warmup 完成（本段 ${Date.now() - _warmT0}ms）`); } catch (_) { /* 忽略 */ }
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
      // 数据管理：设置页的「表清单 / 取表数据 / 打 zip」，只读业务表，无写路径
      () => { app.use('/api/data', auth(['teacher']), require('./routes/dataExport')); },
      () => { app.use('/api/ai', auth(['teacher']), require('./routes/ai/ai')); },
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
                path.join(dbManager.dataDir, 'receipt-trash')
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
    const errorHandlerStep = () => {
      if (errorHandlerInstalled) return;
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
      try { console.log(`[boot] +${Date.now() - _bootT0}ms 懒加载路由全部注册完成（队列 ${Date.now() - _deferT0}ms）`); } catch (_) { /* 忽略 */ }
    };

    // ===== 让路链启动 =====
    // 端口冲突时 startServer 会递归重入，这里保证链只排一次（否则路由会被重复 app.use）。
    if (deferredStarted) return;
    deferredStarted = true;
    const steps = [warmupStep, ...deferredLoaders, errorHandlerStep, finishStep];
    let stepIdx = 0;
    let _deferT0 = 0;
    const runStep = () => {
      // 旧口径：_deferT0 记在「deferredLoaders 全部入队」那一刻，不含 warmup。
      // 链里第 0 步是 warmup，第 1 步起才是 loader，故在跑第 1 步前记时。
      if (stepIdx === 1) _deferT0 = Date.now();
      const step = steps[stepIdx++];
      try { step(); } catch (err) { console.error('[defer] 让路链某步失败:', err); }
      if (stepIdx < steps.length) setImmediate(runStep);
    };
    setImmediate(runStep);
  });

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