// =========================================================================
// foreignKeySpec.js —— 外键声明的唯一契约清单
//
// 为什么单独成文件：这 10 条声明此前只存在于 schema/*.js 的 DDL 文本里，
// 探测代码（foreignKeyProbe）与单元测试（schema-foreign-keys.test）各自需要
// 「期望的清单」，各抄一份就必然会漂移 —— 加了一条外键、只改了 DDL，
// 探测会报「不完整」，而测试还绿着，两边说法相反。
//
// 本文件只放**数据**，不 require 任何模块：探测、测试、将来的 AI 表结构描述
// 都可以直接引用，不会把 db / electron 拖进纯计算场景。
//
// 加外键的唯一正确顺序：
//   ① schema/<域>.js 写 REFERENCES  →  ② 本文件登记一条  →  ③ 跑 testjs/units/fk-probe.test.js
// 第 ③ 步有一条「清单 ↔ DDL 双向对账」，漏了 ② 会当场变红。
// =========================================================================

'use strict';

// 每条：[子表, 子列, 父表, 父列, ON DELETE 策略]
// 父列固定 id：全库所有外键都指向主键，没有指向业务列的先例。
const FK_DECLARATIONS = Object.freeze([
  Object.freeze({ table: 'score_records', column: 'student_id', parent: 'students', onDelete: 'CASCADE' }),
  Object.freeze({ table: 'leave_records', column: 'student_id', parent: 'students', onDelete: 'CASCADE' }),
  Object.freeze({ table: 'cadre_members', column: 'cadre_id', parent: 'cadres', onDelete: 'CASCADE' }),
  Object.freeze({ table: 'cadre_members', column: 'student_id', parent: 'students', onDelete: 'CASCADE' }),
  Object.freeze({ table: 'groups', column: 'dimension_id', parent: 'group_dimensions', onDelete: 'CASCADE' }),
  Object.freeze({ table: 'group_members', column: 'group_id', parent: 'groups', onDelete: 'CASCADE' }),
  Object.freeze({ table: 'group_members', column: 'student_id', parent: 'students', onDelete: 'CASCADE' }),
  Object.freeze({ table: 'album_photos', column: 'album_id', parent: 'albums', onDelete: 'CASCADE' }),
  Object.freeze({ table: 'album_scan_tasks', column: 'album_id', parent: 'albums', onDelete: 'CASCADE' }),
  Object.freeze({ table: 'ai_messages', column: 'conversation_id', parent: 'ai_conversations', onDelete: 'CASCADE' }),
]);

// 刻意**不加**外键的三处。写在这里不是为了检查（检查在测试里对 PRAGMA 做），
// 是为了让后来者看到「这里没有外键」时先读到原因，而不是顺手补一条然后改坏数据。
const INTENTIONALLY_UNLINKED = Object.freeze([
  Object.freeze({
    table: 'cadres', column: 'parent_id',
    reason: '0 是「没有上级」的哨兵值，而 0 不是任何 cadres.id；要加外键得先把哨兵改成 NULL，那是数据改造',
  }),
  Object.freeze({
    table: 'group_members', column: 'member_name',
    reason: '这是快照列，权威引用是同表的 student_id；姓名本身在 students 里不唯一（同名学生合法），'
      + 'SQLite 外键要求父列 PK/UNIQUE，所以不能指向 students.姓名',
  }),
]);

module.exports = { FK_DECLARATIONS, INTENTIONALLY_UNLINKED };
