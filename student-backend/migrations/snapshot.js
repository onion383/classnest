// =========================================================================
// snapshot.js —— 结构清单（`schema/` 的机器可读镜像）
//
// **这个文件由脚本生成，不要手改**：
//   node testjs/tools/schema-snapshot-gen.cjs
//
// 用途：和 `PRAGMA table_info` 对账，抓两类漂移 ——
//   · 代码要的列库里没有（老库没迁移 → no such column，启动时就该报）；
//   · 库里有的列代码不认识（清单漏登记，或用户自定义列）。
// 列的值是「ADD COLUMN 能直接用的定义片段」，所以结构自愈可以按它补列。
//
// 它描述的是「代码想要的结构」：从空库跑 initSchema 导出，不含任何用户数据与自定义列。
// =========================================================================
const EXPECTED = {
  "tables": {
    "access_log": {
      "log_id": "INTEGER",
      "source": "TEXT NOT NULL",
      "actor": "TEXT DEFAULT ''",
      "tool": "TEXT NOT NULL",
      "target": "TEXT DEFAULT ''",
      "detail": "TEXT DEFAULT ''",
      "amount": "INTEGER DEFAULT 0",
      "result": "TEXT NOT NULL DEFAULT 'ok'",
      "reason": "TEXT DEFAULT ''",
      "created_at": "TEXT NOT NULL"
    },
    "activities": {
      "id": "INTEGER",
      "position": "INTEGER DEFAULT 1",
      "时间": "TEXT",
      "主题": "TEXT",
      "地点": "TEXT",
      "简介": "TEXT",
      "参与人员": "TEXT",
      "created_at": "TEXT"
    },
    "ai_conversations": {
      "id": "INTEGER",
      "title": "TEXT DEFAULT '新对话'",
      "summary": "TEXT DEFAULT ''",
      "summary_upto": "INTEGER DEFAULT 0",
      "last_prompt_tokens": "INTEGER DEFAULT 0",
      "created_at": "DATETIME DEFAULT CURRENT_TIMESTAMP",
      "updated_at": "DATETIME DEFAULT CURRENT_TIMESTAMP"
    },
    "ai_messages": {
      "id": "INTEGER",
      "conversation_id": "INTEGER NOT NULL",
      "role": "TEXT NOT NULL",
      "content": "TEXT DEFAULT ''",
      "process_json": "TEXT DEFAULT ''",
      "attachments_json": "TEXT DEFAULT ''",
      "created_at": "DATETIME DEFAULT CURRENT_TIMESTAMP"
    },
    "ai_models": {
      "id": "INTEGER",
      "name": "TEXT DEFAULT ''",
      "provider": "TEXT DEFAULT 'deepseek'",
      "base_url": "TEXT DEFAULT ''",
      "model": "TEXT DEFAULT ''",
      "api_key": "TEXT DEFAULT ''",
      "is_active": "INTEGER DEFAULT 0",
      "reasoning": "INTEGER DEFAULT 1"
    },
    "ai_settings": {
      "id": "INTEGER",
      "enabled": "INTEGER DEFAULT 0",
      "floating_enabled": "INTEGER DEFAULT 1",
      "provider": "TEXT DEFAULT 'deepseek'",
      "base_url": "TEXT DEFAULT ''",
      "model": "TEXT DEFAULT ''",
      "api_key": "TEXT DEFAULT ''",
      "privacy_seed": "TEXT DEFAULT ''",
      "privacy_json": "TEXT DEFAULT '{}'",
      "mcp_privacy_json": "TEXT DEFAULT '{}'",
      "mcp_enabled": "INTEGER DEFAULT 0",
      "mcp_prefs_json": "TEXT DEFAULT '{}'",
      "log_json": "TEXT DEFAULT '{}'"
    },
    "album_photos": {
      "id": "INTEGER",
      "album_id": "INTEGER NOT NULL",
      "file_path": "TEXT NOT NULL",
      "file_name": "TEXT NOT NULL",
      "file_size": "INTEGER DEFAULT 0",
      "mtime": "TEXT DEFAULT ''",
      "photo_date": "TEXT DEFAULT ''",
      "exif_date": "TEXT DEFAULT ''",
      "date_src": "TEXT DEFAULT ''",
      "thumb_path": "TEXT DEFAULT ''",
      "thumb_v": "INTEGER DEFAULT 0"
    },
    "album_scan_tasks": {
      "album_id": "INTEGER",
      "mode": "TEXT NOT NULL DEFAULT 'incremental'",
      "phase": "TEXT NOT NULL DEFAULT 'collect'",
      "done_path": "TEXT NOT NULL DEFAULT ''",
      "scanned": "INTEGER NOT NULL DEFAULT 0",
      "total": "INTEGER NOT NULL DEFAULT 0",
      "state": "TEXT NOT NULL DEFAULT 'running'",
      "token": "INTEGER NOT NULL DEFAULT 0",
      "started_at": "TEXT NOT NULL DEFAULT ''",
      "updated_at": "TEXT NOT NULL DEFAULT ''"
    },
    "albums": {
      "id": "INTEGER",
      "name": "TEXT NOT NULL",
      "folder_path": "TEXT NOT NULL",
      "kind": "TEXT NOT NULL DEFAULT 'folder'",
      "sort_order": "INTEGER DEFAULT 0",
      "created_at": "TEXT DEFAULT ''",
      "updated_at": "TEXT DEFAULT ''"
    },
    "cadre_members": {
      "id": "INTEGER",
      "cadre_id": "INTEGER NOT NULL",
      "student_id": "INTEGER",
      "student_name": "TEXT NOT NULL",
      "sort_order": "INTEGER NOT NULL DEFAULT 0"
    },
    "cadres": {
      "id": "INTEGER",
      "name": "TEXT NOT NULL",
      "parent_id": "INTEGER NOT NULL DEFAULT 0",
      "max_count": "INTEGER NOT NULL DEFAULT 1",
      "sort_order": "INTEGER NOT NULL DEFAULT 0"
    },
    "countdowns": {
      "id": "INTEGER",
      "position": "INTEGER DEFAULT 1",
      "名称": "TEXT",
      "截止日": "TEXT",
      "包含这一天": "INTEGER DEFAULT 0",
      "created_at": "TEXT"
    },
    "domain_history": {
      "id": "INTEGER",
      "domain": "TEXT NOT NULL",
      "week_start": "TEXT NOT NULL DEFAULT ''",
      "snap_date": "TEXT NOT NULL DEFAULT ''",
      "mode": "TEXT NOT NULL DEFAULT ''",
      "payload": "TEXT NOT NULL DEFAULT '{}'",
      "created_at": "DATETIME DEFAULT CURRENT_TIMESTAMP"
    },
    "duty_slots": {
      "kind": "TEXT",
      "days": "TEXT NOT NULL DEFAULT '{\"daily\":[\"周一\",\"周二\",\"周三\",\"周四\",\"周五\"],\"big\":[]}'",
      "items": "TEXT NOT NULL DEFAULT '[]'",
      "cells": "TEXT NOT NULL DEFAULT '{}'",
      "settings": "TEXT NOT NULL DEFAULT '{}'",
      "weights": "TEXT NOT NULL DEFAULT '{}'",
      "conditions": "TEXT NOT NULL DEFAULT '[]'",
      "saved_at": "TEXT NOT NULL DEFAULT ''"
    },
    "fee_records": {
      "id": "INTEGER",
      "position": "INTEGER DEFAULT 1",
      "收支编码": "TEXT",
      "收支类型": "TEXT",
      "收支金额": "REAL",
      "收支时间": "TEXT",
      "备注": "TEXT",
      "收据": "TEXT"
    },
    "group_dimensions": {
      "id": "INTEGER",
      "name": "TEXT NOT NULL",
      "leader_title": "TEXT DEFAULT ''",
      "members_per_group": "INTEGER DEFAULT 0",
      "group_count": "INTEGER DEFAULT 0",
      "is_default": "INTEGER DEFAULT 0",
      "male_group_count": "INTEGER DEFAULT 0",
      "female_group_count": "INTEGER DEFAULT 0",
      "sort_order": "INTEGER DEFAULT 0"
    },
    "group_members": {
      "id": "INTEGER",
      "group_id": "INTEGER NOT NULL",
      "student_id": "INTEGER",
      "member_name": "TEXT DEFAULT ''",
      "remark": "TEXT DEFAULT ''",
      "sort_order": "INTEGER DEFAULT 0"
    },
    "groups": {
      "id": "INTEGER",
      "dimension_id": "INTEGER NOT NULL",
      "name": "TEXT NOT NULL",
      "gender": "INTEGER DEFAULT 0",
      "sort_order": "INTEGER DEFAULT 0"
    },
    "leave_records": {
      "id": "INTEGER",
      "position": "INTEGER DEFAULT 1",
      "student_id": "INTEGER",
      "姓名": "TEXT",
      "类型": "TEXT",
      "开始时间": "TEXT",
      "结束时间": "TEXT",
      "家长联系电话": "TEXT",
      "学生联系电话": "TEXT",
      "状态": "TEXT DEFAULT '请假中'",
      "返校时间": "TEXT",
      "备注": "TEXT",
      "created_at": "TEXT"
    },
    "mcp_proposals": {
      "proposal_id": "TEXT",
      "kind": "TEXT NOT NULL DEFAULT 'row_write'",
      "label": "TEXT DEFAULT ''",
      "table_name": "TEXT NOT NULL",
      "operation": "TEXT NOT NULL",
      "payload": "TEXT NOT NULL",
      "requested_by": "TEXT DEFAULT ''",
      "status": "TEXT NOT NULL DEFAULT 'pending'",
      "result": "TEXT",
      "created_at": "TEXT NOT NULL",
      "decided_at": "TEXT"
    },
    "mcp_tokens": {
      "hash": "TEXT",
      "token_plain": "TEXT NOT NULL",
      "slug": "TEXT NOT NULL",
      "label": "TEXT DEFAULT ''",
      "created_at": "TEXT NOT NULL",
      "expires_at": "TEXT",
      "revoked_at": "TEXT"
    },
    "schedule_slots": {
      "kind": "TEXT",
      "cells": "TEXT NOT NULL DEFAULT '[]'",
      "settings": "TEXT NOT NULL DEFAULT '{}'"
    },
    "score_records": {
      "id": "INTEGER",
      "student_id": "INTEGER",
      "姓名": "TEXT",
      "学号": "TEXT",
      "类型": "TEXT",
      "项目": "TEXT",
      "分值": "REAL",
      "原因": "TEXT",
      "加分时间": "TEXT",
      "created_at": "TEXT",
      "source": "TEXT DEFAULT 'personal'",
      "group_name": "TEXT",
      "成员数": "INTEGER DEFAULT 0"
    },
    "seat_slots": {
      "kind": "TEXT",
      "mode": "TEXT NOT NULL DEFAULT 'single'",
      "rows": "INTEGER NOT NULL DEFAULT 6",
      "cols": "INTEGER NOT NULL DEFAULT 7",
      "seats": "TEXT NOT NULL DEFAULT '[]'",
      "types": "TEXT NOT NULL DEFAULT '[]'",
      "desk_pattern": "TEXT NOT NULL DEFAULT '[]'",
      "aisle_cols": "TEXT NOT NULL DEFAULT '[]'",
      "groups_config": "TEXT NOT NULL DEFAULT '[]'",
      "weights": "TEXT NOT NULL DEFAULT '[]'",
      "settings": "TEXT NOT NULL DEFAULT '{}'",
      "conditions": "TEXT NOT NULL DEFAULT '[]'",
      "saved_at": "TEXT NOT NULL DEFAULT ''"
    },
    "semesters": {
      "id": "INTEGER",
      "name": "TEXT NOT NULL DEFAULT ''",
      "start_date": "TEXT NOT NULL DEFAULT ''",
      "end_date": "TEXT NOT NULL DEFAULT ''",
      "is_current": "INTEGER NOT NULL DEFAULT 0",
      "created_at": "DATETIME DEFAULT CURRENT_TIMESTAMP"
    },
    "students": {
      "id": "INTEGER",
      "position": "INTEGER DEFAULT 1",
      "学号": "TEXT",
      "年级": "TEXT",
      "班级": "TEXT",
      "姓名": "TEXT NOT NULL",
      "年龄": "INTEGER",
      "家长联系电话": "TEXT",
      "学生联系电话": "TEXT",
      "备注": "TEXT",
      "is_provisional": "INTEGER NOT NULL DEFAULT 0"
    },
    "table_meta": {
      "table_name": "TEXT NOT NULL",
      "column_name": "TEXT NOT NULL",
      "data_type": "TEXT DEFAULT '文字'",
      "sort_order": "INTEGER DEFAULT 0"
    },
    "undo_history": {
      "id": "INTEGER",
      "key": "TEXT NOT NULL",
      "type": "TEXT NOT NULL",
      "label": "TEXT NOT NULL DEFAULT ''",
      "payload": "TEXT NOT NULL DEFAULT '{}'",
      "dir": "INTEGER NOT NULL DEFAULT 1",
      "ts": "TEXT NOT NULL DEFAULT ''",
      "origin": "TEXT NOT NULL DEFAULT ''",
      "source": "TEXT NOT NULL DEFAULT 'manual'"
    },
    "users": {
      "id": "INTEGER",
      "username": "TEXT NOT NULL",
      "password": "TEXT NOT NULL",
      "role": "TEXT NOT NULL DEFAULT 'teacher'",
      "db_slug": "TEXT DEFAULT ''",
      "recovery_hash": "TEXT DEFAULT ''"
    },
    "widget_settings": {
      "id": "INTEGER",
      "toolbox_enabled": "INTEGER DEFAULT 0",
      "note_save_path": "TEXT DEFAULT ''",
      "screenshot_save_path": "TEXT DEFAULT ''",
      "desktop_apps": "TEXT DEFAULT '[]'",
      "class_info": "TEXT DEFAULT '{}'",
      "rollcall_exclude_absent": "INTEGER NOT NULL DEFAULT 0",
      "rollcall_include_provisional": "INTEGER NOT NULL DEFAULT 0"
    }
  },
  "indexes": {
    "idx_access_log_created": "CREATE INDEX idx_access_log_created ON access_log(created_at)",
    "idx_access_log_source": "CREATE INDEX idx_access_log_source ON access_log(source, created_at)",
    "idx_ai_messages_conv": "CREATE INDEX idx_ai_messages_conv ON ai_messages (conversation_id, id)",
    "idx_album_photos_album_date": "CREATE INDEX idx_album_photos_album_date ON album_photos (album_id, photo_date DESC)",
    "idx_album_photos_album_id": "CREATE INDEX idx_album_photos_album_id ON album_photos (album_id, id)",
    "idx_album_photos_album_mtime": "CREATE INDEX idx_album_photos_album_mtime ON album_photos (album_id, mtime DESC)",
    "idx_cadre_members_cadre": "CREATE INDEX idx_cadre_members_cadre ON cadre_members (cadre_id, sort_order, id)",
    "idx_domain_history_date": "CREATE INDEX idx_domain_history_date ON domain_history (domain, snap_date, mode)",
    "idx_domain_history_week": "CREATE INDEX idx_domain_history_week ON domain_history (domain, week_start DESC)",
    "idx_fee_time": "CREATE INDEX idx_fee_time ON fee_records (收支时间)",
    "idx_group_members_group": "CREATE INDEX idx_group_members_group ON group_members (group_id, sort_order, id)",
    "idx_group_members_student": "CREATE INDEX idx_group_members_student ON group_members (student_id)",
    "idx_groups_dimension": "CREATE INDEX idx_groups_dimension ON groups (dimension_id, sort_order, id)",
    "idx_leave_student_status": "CREATE INDEX idx_leave_student_status ON leave_records (student_id, 状态)",
    "idx_mcp_proposals_status": "CREATE INDEX idx_mcp_proposals_status ON mcp_proposals(status, created_at)",
    "idx_mcp_tokens_slug": "CREATE INDEX idx_mcp_tokens_slug ON mcp_tokens(slug)",
    "idx_score_student_time": "CREATE INDEX idx_score_student_time ON score_records (student_id, 加分时间)",
    "idx_score_time": "CREATE INDEX idx_score_time ON score_records (加分时间 DESC, id DESC)",
    "idx_students_name": "CREATE INDEX idx_students_name ON students (姓名)",
    "idx_undo_dir_origin": "CREATE INDEX idx_undo_dir_origin ON undo_history (dir, origin)",
    "idx_undo_key": "CREATE INDEX idx_undo_key ON undo_history (key, id)",
    "ux_students_provisional_name": "CREATE UNIQUE INDEX ux_students_provisional_name\n             ON students (姓名) WHERE is_provisional = 1"
  },
  "views": {
    "duty_draft": "CREATE VIEW duty_draft AS\n      SELECT 1 AS id, cells, settings, conditions, saved_at FROM duty_slots WHERE kind = 'draft'",
    "duty_history": "CREATE VIEW duty_history AS\n      SELECT id, week_start, snap_date, mode,\n             json_extract(payload, '$.cells') AS cells,\n             json_extract(payload, '$.settings') AS settings,\n             created_at\n      FROM domain_history WHERE domain = 'duty'",
    "duty_layout": "CREATE VIEW duty_layout AS\n      SELECT 1 AS id, cells, settings FROM duty_slots WHERE kind = 'current'",
    "duty_settings": "CREATE VIEW duty_settings AS\n      SELECT 1 AS id, days, items, settings FROM duty_slots WHERE kind = 'settings'",
    "duty_template": "CREATE VIEW duty_template AS\n      SELECT 1 AS id, cells, settings FROM duty_slots WHERE kind = 'template'",
    "duty_weight": "CREATE VIEW duty_weight AS\n      SELECT 1 AS id, weights, settings FROM duty_slots WHERE kind = 'weight'",
    "master_schedule": "CREATE VIEW master_schedule AS\n      SELECT 1 AS id, cells, settings FROM schedule_slots WHERE kind = 'master'",
    "schedule": "CREATE VIEW schedule AS\n      SELECT 1 AS id, cells, settings FROM schedule_slots WHERE kind = 'current'",
    "schedule_history": "CREATE VIEW schedule_history AS\n      SELECT id, week_start,\n             json_extract(payload, '$.cells') AS cells,\n             json_extract(payload, '$.settings') AS settings,\n             created_at\n      FROM domain_history WHERE domain = 'schedule'",
    "seat_draft": "CREATE VIEW seat_draft AS\n      SELECT 1 AS id, mode, rows, cols, seats, types, desk_pattern, aisle_cols, groups_config, settings, conditions, saved_at\n      FROM seat_slots WHERE kind = 'draft'",
    "seat_history": "CREATE VIEW seat_history AS\n      SELECT id, week_start, snap_date, mode,\n             json_extract(payload, '$.rows') AS rows,\n             json_extract(payload, '$.cols') AS cols,\n             json_extract(payload, '$.seats') AS seats,\n             json_extract(payload, '$.aisleCols') AS aisle_cols,\n             json_extract(payload, '$.groupsConfig') AS groups_config,\n             json_extract(payload, '$.settings') AS settings,\n             created_at\n      FROM domain_history WHERE domain = 'seat'",
    "seat_layout": "CREATE VIEW seat_layout AS\n      SELECT 1 AS id, mode, rows, cols, seats, types, desk_pattern, aisle_cols, groups_config, settings\n      FROM seat_slots WHERE kind = 'current'",
    "seat_template": "CREATE VIEW seat_template AS\n      SELECT 1 AS id, mode, rows, cols, seats, types, desk_pattern, aisle_cols, groups_config, settings\n      FROM seat_slots WHERE kind = 'template'",
    "seat_weight": "CREATE VIEW seat_weight AS\n      SELECT 1 AS id, mode, rows, cols, weights, types, settings\n      FROM seat_slots WHERE kind = 'weight'"
  }
}

module.exports = { EXPECTED }
