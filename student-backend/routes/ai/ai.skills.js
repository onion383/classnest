// =========================================================================
// AI 技能（md 指令文件）接口
//   技能由老师在「数据管理」页维护：新建 / 编辑（可改文件名）/ 删除 / 导出。
//   聊天输入框打「/」按技能 md 文件名匹配，选中后其内容随本轮请求注入系统提示。
//   存储由 dbManager 统一实现（dataDir/ai-skills/<slug>/<name>.md），与记忆/备份同层。
// =========================================================================

const express = require('express');
const dbManager = require('../../dbManager/dbManager');

const router = express.Router();
const slugOf = (req) => req.user && req.user.dbSlug;
// 技能正文长度上限（K02-06）：技能会整份注入系统提示，超长文本会挤爆上下文窗口。
const MAX_SKILL_CHARS = 512000;
function skillContentError(content) {
  if (content != null && typeof content !== 'string') return 'content 必须是字符串';
  if (typeof content === 'string' && content.length > MAX_SKILL_CHARS) return `技能内容过长（上限 ${MAX_SKILL_CHARS} 字符）`;
  return '';
}

// GET /api/ai/skills —— 技能列表
router.get('/skills', (req, res) => {
    res.json({ success: true, data: dbManager.listSkills(slugOf(req)) });
});

// GET /api/ai/skills/:name —— 读取某技能内容
router.get('/skills/:name', (req, res) => {
    const name = req.params.name;
  if (!dbManager.skillExists(slugOf(req), name)) return res.status(404).json({ error: '技能不存在' });
  res.json({ success: true, data: { name, content: dbManager.readSkill(slugOf(req), name) } });
});

// POST /api/ai/skills —— 新建技能，body: { name, content }
router.post('/skills', (req, res) => {
  try {
    const rawName = (req.body && req.body.name) || '';
    if (!rawName.trim()) return res.status(400).json({ error: '请填写文件名' });
    if (dbManager.skillExists(slugOf(req), rawName)) return res.status(400).json({ error: '同名技能已存在' });
    const contentErr = skillContentError(req.body && req.body.content);
    if (contentErr) return res.status(400).json({ error: contentErr });
    const content = (req.body && req.body.content) || `# ${rawName.trim()}\n`;
    dbManager.writeSkill(slugOf(req), rawName, content);
    res.json({ success: true, data: dbManager.listSkills(slugOf(req)) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// PUT /api/ai/skills/:name —— 保存技能，body: { name（新的文件名，可与原同名）, content }
router.put('/skills/:name', (req, res) => {
  try {
    const original = req.params.name;
    if (!dbManager.skillExists(slugOf(req), original)) return res.status(404).json({ error: '技能不存在' });
    const next = (req.body && req.body.name) || original;
    if (!String(next).trim()) return res.status(400).json({ error: '请填写文件名' });
    const renamed = String(next).trim() !== String(original).trim();
    if (renamed && dbManager.skillExists(slugOf(req), next)) return res.status(400).json({ error: '同名技能已存在' });
    const contentErr = skillContentError(req.body && req.body.content);
    if (contentErr) return res.status(400).json({ error: contentErr });
    dbManager.writeSkill(slugOf(req), next, (req.body && req.body.content) || '');
    if (renamed) dbManager.deleteSkill(slugOf(req), original);
    res.json({ success: true, data: dbManager.listSkills(slugOf(req)) });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// DELETE /api/ai/skills/:name —— 删除技能
router.delete('/skills/:name', (req, res) => {
    dbManager.deleteSkill(slugOf(req), req.params.name);
  res.json({ success: true, data: dbManager.listSkills(slugOf(req)) });
});

module.exports = router;
