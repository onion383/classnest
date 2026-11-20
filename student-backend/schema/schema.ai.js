// schema 拆分子文件：AI 助手相关表（模型配置 / 模型管理 / 会话 / 消息）+ 各列历史迁移。
function migrateAi(conn) {
  conn.exec(`
    -- AI 助手：模型接入配置（密钥存在已加密的教师库内，仅后端使用）
    CREATE TABLE IF NOT EXISTS ai_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 0,
      -- 在其他页面显示 AI 助手小窗（1 显示 / 0 隐藏，默认显示，保持旧行为）
      floating_enabled INTEGER DEFAULT 1,
      provider TEXT DEFAULT 'deepseek',
      base_url TEXT DEFAULT '',
      model TEXT DEFAULT '',
      api_key TEXT DEFAULT '',
      -- AI 数据保护：HMAC 种子按库走备份/恢复；开关与逐项配置跟着库迁移
      privacy_seed TEXT DEFAULT '',
      privacy_json TEXT DEFAULT '{}',
      -- MCP 侧独立的一份数据保护配置（总开关 / 三个混淆项 / 按表两档）。
      -- 不与 privacy_json 共用：AI 助手是老师自己在用，MCP 面向外部客户端，
      -- 共用意味着「给外部 AI 收紧一张表」会连带把本地助手也锁住。
      mcp_privacy_json TEXT DEFAULT '{}',
      -- MCP 服务端启用开关：opt-in，默认 0。/mcp 端点按 token 绑定库的此列判定，
      -- 没开时带有效 token 也进不来（避免装了服务就一直对外暴露）。
      mcp_enabled INTEGER DEFAULT 0,
      -- MCP 提案的展示/保留设置（不含权限，权限在 mcp_privacy_json）。
      -- 不塞进 log_json：那是访问记录的配置，两者生命周期不同。
      mcp_prefs_json TEXT DEFAULT '{}',
      -- 数据访问记录的设置：{ keep: 500, granularity: 'per_call' | 'per_day' }。
      -- 与 AI 数据保护分开存：那一份是「允许读什么」，这一份是「记多少、怎么看」。
      log_json TEXT DEFAULT '{}'
    );
    INSERT OR IGNORE INTO ai_settings (id) VALUES (1);

    -- AI 助手：模型管理（多模型列表，is_active 标记当前选中，密钥仅存本机）
    CREATE TABLE IF NOT EXISTS ai_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT DEFAULT '',
      provider TEXT DEFAULT 'deepseek',
      base_url TEXT DEFAULT '',
      model TEXT DEFAULT '',
      api_key TEXT DEFAULT '',
      is_active INTEGER DEFAULT 0,
      reasoning INTEGER DEFAULT 1
    );

    -- AI 助手：对话记录（会话 + 消息）
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT DEFAULT '新对话',
      -- 上下文压缩：summary 为较早消息的摘要，summary_upto 为已摘要到的消息 id（含）；
      -- last_prompt_tokens 记录最近一轮模型实际返回的 prompt token 用量，用于触发压缩
      summary TEXT DEFAULT '',
      summary_upto INTEGER DEFAULT 0,
      last_prompt_tokens INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT DEFAULT '',
      process_json TEXT DEFAULT '',
      -- 该条消息附带的文件（[{name, text}]，JSON 字符串），供后续轮次仍能读取
      attachments_json TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages (conversation_id, id);
  `);
}

module.exports = { migrateAi };
