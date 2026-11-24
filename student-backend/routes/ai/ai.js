// =========================================================================
// AI 助手后端
//   1. 配置读写（OpenAI 兼容协议，多模型可切换：DeepSeek/OpenAI/Kimi/通义…）。
//   2. 对话 + function calling：模型只能「读」表（query），「写」走 propose_write
//      生成提案，交由前端确认后通过既有 CRUD 执行——后端绝不直接改库。
// =========================================================================

const express = require('express');
const router = express.Router();
const { READ_TABLES, WRITE_TABLES } = require('./ai.constants');
router.use(require('./ai.memory'));
router.use(require('./ai.skills'));
// 注意：app.js 对 /api/ai 另有一条「首屏快路径」直挂同一个 ai.config 模块
// （慢机器上完整 router 注册要等让路链）。此处保留是为了 ai router 被单独挂载时
// /config 仍可用；两处复用同一模块，配置读写只有一份实现（Q3-04 确认非缺陷）。
router.use(require('./ai.config'));
router.use(require('./ai.conversations'));
router.use(require('./ai.dataRoutes'));
router.use(require('./ai.upload'));
module.exports = router;
module.exports.READ_TABLES = READ_TABLES;
module.exports.WRITE_TABLES = WRITE_TABLES;
