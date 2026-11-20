# 数据库迁移体系（预置件，尚未接入）

这个目录是为**第一版发布之后**准备的。现在**没有任何代码 require 它**，所以它一行都不会执行，
不影响当前任何行为。设计依据见 `doc/开发文档/数据迁移体系-设计草案.md`（不入库）。

## 现在的库是什么状态

第一版还没发出去，所以没有历史包袱：`schema/schema.*.js` 直接按**最终形态**建表，
原来散在各处的 17 处 `if (cols.has(...)) ALTER TABLE` 和座位矩阵化脚本已经删掉。
老库（只有开发机和测试机）不迁移、不兼容——把 `data/` 目录改名留档，让应用重建。

代价是：**从这一刻起，任何结构变更都必须有迹可循**，否则下一版又会临时长出一套补丁。
这个目录就是那个「迹」。

## 里面都是什么

| 文件 | 职责 | 会被谁调用 |
| --- | --- | --- |
| `index.js` | 运行器：版本闸门、备份、跑步骤、保底、终检。**`STEPS` 现在是空数组** | 将来的「打开库」入口 |
| `ledger.js` | 账本表 `schema_migrations` 的读写、脚本指纹 `checksum` | `index.js` |
| `converge.js` | 结构对账（`diffSchema`）、自愈（`converge`）、终检（`assertConverged`） | `index.js`、体检脚本 |
| `snapshot.js` | 结构清单 `EXPECTED`：30 张表 / 244 列 / 22 索引 / 14 视图。**脚本生成，不要手改** | `index.js`、体检脚本 |
| `README.md` | 本文 | — |

目录外还有两个工具（放在 `testjs/tools/`，因为它们属于开发期，不属于运行时）：

| 工具 | 干什么 |
| --- | --- |
| `schema-snapshot-gen.cjs` | 空库跑一遍真实建表，重新生成 `snapshot.js` |
| `schema-drift-check.cjs` | 空库跑建表，和 `snapshot.js` 对账，有差异退出码 1 |

```bash
node testjs/tools/schema-snapshot-gen.cjs   # 改了 schema 之后重跑
node testjs/tools/schema-drift-check.cjs    # 体检：清单和建库结果一致吗
```

## 一条步骤长什么样

`index.js` 里的 `STEPS` 是唯一要手写的地方。**每一条只声明它自己那一版新增的东西**，
绝不引用「当前全量清单」——否则半年前的第 7 条会用今天的清单跑，源码没改、checksum 也不报，
但语义已经漂了。

```js
// 纯结构：加一列
{
  version: 2,                       // 整数，与 user_version 同口径
  name: 'students-show-column',     // 账本里给人看，写完别再改
  structure: { students: { 是否住校: "TEXT NOT NULL DEFAULT ''" } },
}

// 结构 + 搬数据：data 里有 SELECT 的，一律单独开事务
{
  version: 3,
  name: 'seat-grid',
  structure: { seat_slots: { types: "TEXT NOT NULL DEFAULT '[]'" } },
  data(db) {
    // 必须幂等：靠数据特征判断，而不是「现在是第几版」
    const rows = db.prepare('SELECT kind, seats, types FROM seat_slots').all()
    for (const r of rows) {
      if (isFullMatrix(r.types)) continue
      rewrite(r)
    }
  },
}
```

`structure` 的列值要写成 **ADD COLUMN 能直接用的定义片段**（类型 + `NOT NULL` + `DEFAULT`）。
写成 `{ students: ['是否住校'] }`（只有列名）也能通过语法检查，但运行时会明确报
「没有列定义，无法生成 ADD COLUMN」——宁可报错，也不要猜一个类型塞进去。

## 版本号为什么是整数

草案里写的是 `'0002'` 这种字符串，那是**文件名**给人看的顺序。落库时用的是数字部分，
因为 SQLite 的 `user_version` 是库头里一个 32 位整数，存不了字符串。

```
文件名 0002-mcp-privacy.js  →  { version: 2, ... }  →  PRAGMA user_version = 2
```

## 什么时候跑

**打开某个库的那一刻，而且只在那里。**

| 库 | 时机 |
| --- | --- |
| 账号索引库（`index.db`） | 应用启动时，`ensureIndex()` 之后 |
| 班级库 | 第一次切到那个班、懒打开库时 |
| `privacy` 库 | 各自独立，各自的 `user_version` |

不要放在写请求路径（半路失败会留下改了一半的业务表）、退出路径（用户可能强杀）、
定时器里（跑的时候另一个窗口正在读）。

## 结构自愈能做什么、不能做什么

`converge.js` 只做三件事：补列、补索引、补视图。

| 变更 | 自愈能做 | 说明 |
| --- | --- | --- |
| 缺一张表 | ❌ 只报告 | 建表由 `schema/` 的 `CREATE TABLE IF NOT EXISTS` 负责，这里不写第二份 DDL |
| 缺一列 | ✅ `ADD COLUMN` | 定义必须是常量默认值；`NOT NULL` 必须带 `DEFAULT` |
| 缺索引 / 缺视图 | ✅ `CREATE` | 视图已存在时不会更新定义，改视图要自己 DROP 再建 |
| 多一列 | ⚠️ 只提示 | 可能是用户自定义列，也可能是清单漏登记，不当错误 |
| 改类型 / 改默认值 / 加约束 / 删列 | ❌ | SQLite 要重建整表，且无法从声明推导「哪个是对的」 |
| 搬数据 / 改 JSON 形状 | ❌ | 结构可能完全正确，对账什么都看不见 |

做不到的那两类必须写 `data(db)`。这是整套东西唯一不可替代的部分。

## 接入要做什么（等第一版发布前再做）

1. 在打开库的位置调用一次 `runMigrations(db, { expected: EXPECTED, backup })`：
   - 账号库在 `dbManager.base.js` 的 `ensureIndex` 之后；
   - 班级库在懒打开、`initSchema` 之后。
2. `backup` 注入具体实现：`({ fromVersion, toVersion }) => dbManager.backup.js 里那个备份函数`。
   **本目录不许 require 业务代码**，所以备份只能注入。
3. 启动阶段把 `onProgress` 接到 `bootStatusText`（「正在升级数据 2/3」）；
   重型迁移跑完之前拒绝写请求。
4. 打包验证：`migrations/` 只有在被 require 之后才会进 `app.bundle.js`。
   接入后跑一次 `npm run build:backend`，再确认 bundle 里有 `schema_migrations` 字样。

接入是纯加法：`STEPS` 还是空数组、库的 `user_version` 还是 0，第一次接入时什么都不做，
只是从此有了版本号。**第一版发布前必须接入**——发出去之后再补，就会有一批用户库没有版本号。

## 六条硬规矩

1. **迁移目录里不许 `require` 业务代码。** 需要常量就冻结一份进迁移文件。
   否则 `services/` 里某个函数一改，迁移对老数据的解读就跟着变。
2. **已发布的步骤不许改。** 要改就新开一版。账本里的 `checksum` 会算 `version + name + structure + data`
   的指纹，改了会在下一次升级时直接抛错。
3. **备份只做一次，且用 `dbManager.backup.js`。** WAL 模式下自己 `copyFile` 拿到的是残缺快照。
4. **不扫目录，静态注册。** 打包成 `app.bundle.js` 后 `__dirname` 下没有 `migrations/`，
   任何 `readdir` 方案都会在发布版里失效。要加步骤就写进 `STEPS` 数组。
5. **一版一事务，`data` 单独开。** 连续的结构步骤合并成一批（省落盘），
   搬数据的各自单独开（强杀后只损失那一条，下次从它重来）。
6. **库版本高于程序版本时拒启。** 用户回退 exe、或多装一份时，这是唯一能保住数据的选择。

## 还没做的

| 事项 | 说明 |
| --- | --- |
| 单测 | 只用临时脚本验证过六条路径（版本相等跳过、补列并记账、库版本过高拒启、checksum 漂移抛错、备份只做一次且在任何改动之前、缺列定义时明确报错且版本不前进）。接入时转成 `testjs/units/migrations.test.js` |
| 启动页进度 | `onProgress` 已留好，还没接到 `bootStatusText` |
| `MIN_SUPPORTED` / `legacy/` | 主链超过 20 条时再考虑；现在一条都没有 |
| `security_version` | 密钥算法升级那条独立版本线，见草案 §10.4，不属于这个目录 |
| 备份包里的版本字段 | 老备份恢复时要按「备份里记的参数」解，不能按当前默认参数 |

## 维护动作速查

| 场景 | 做什么 |
| --- | --- |
| 加一列 | 改 `schema/` 的 `CREATE` → 重跑生成器 → 在 `STEPS` 追加一条 `structure` → 跑对账 |
| 加一张表 | 同上（表由 `CREATE` 建，步骤里只需要声明它的列） |
| 改列类型 / 删列 | 改 `CREATE` → 生成器 → 追加一条带 `data()` 的步骤（重建表搬数据）→ 跑对账 |
| 只改 JSON 形状 | 追加一条 `data()` 步骤，幂等、认数据特征，不要认版本号 |
| 清单和库对不上 | 先看是「代码漏了列」还是「清单过期」：前者改 `CREATE`，后者重跑生成器 |
