// =========================================================================
// schema.mcp.js —— 方向 B（应用作为 MCP 服务端）的提案表
//
// 外部 AI 客户端通过 /mcp 提交的写操作不直接落库，先在这里存一条「待确认提案」，
// 由班集前端轮询展示、老师确认后才走现有写入链路执行。这是「后端绝不直接改库」
// 原则在方向 B 的等价物：外部写请求和本地 AI 的 propose_* 一样必须过用户确认。
//
// proposal_id 用随机 hex（不递增），避免外部客户端枚举；状态流转：
//   pending → processing（确认时原子抢占）→ confirmed / failed
//          → rejected（拒绝）/ expired（超时）
// processing 是幂等锁：写入与定稿在同一事务，崩溃时整批回滚，超时可重抢。
// =========================================================================
function migrateMcp(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS mcp_proposals (
      proposal_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'row_write',
      label TEXT DEFAULT '',
      table_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      payload TEXT NOT NULL,
      requested_by TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_proposals_status ON mcp_proposals(status, created_at);

    -- MCP 令牌明文副本：core/.mcp-tokens.json 只留 hash→slug 索引供鉴权（不需开库），
    -- 明文存在这里——班级库是加密的，主密钥保护。这样老师刷新页面后仍可「复制令牌」，
    -- 而不是像以前那样只在创建瞬间展示一次、丢了只能撤销重建。
    -- hash 与 core json 同源（sha256(token)），两处按 hash 关联；跨库两写靠补偿保证一致。
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      hash TEXT PRIMARY KEY,
      token_plain TEXT NOT NULL,
      slug TEXT NOT NULL,
      label TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_tokens_slug ON mcp_tokens(slug);
  `);
  // 旧库升级：mcp_tokens 建表时还没有 expires_at，补列。NULL = 永不过期，老令牌不受影响。
  const tokenCols = conn.prepare('PRAGMA table_info(mcp_tokens)').all().map((c) => c.name);
  if (!tokenCols.includes('expires_at')) {
    conn.exec('ALTER TABLE mcp_tokens ADD COLUMN expires_at TEXT');
  }
}

module.exports = { migrateMcp };
