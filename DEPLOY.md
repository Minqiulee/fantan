# 部署与数据库配置说明

## 数据持久化概览

Postgresql：

- 数据层：`db.js`（连接池 + 幂等建表 + 快照读写 + 会话/限频）
- 会话存储：`store.js`（读缓存 + 乐观锁提交 + 变更事件）、`pubsub.js`（跨实例 LISTEN/NOTIFY）
- 服务入口：`server.js` 启动时 `initDb()` 建表，`bootstrapSessions()` 自举首场次，`backfillArchives()` 补写未归档轮次；状态本体始终在库里，进程内只有可丢弃的读缓存
- 连接串：**只认 `DATABASE_URL`**（一条完整串，托管库如 Supabase pooler 就给这个）；
  不设时回落到本地默认库。解析与池参数集中在 `db.js` 的 `resolveConnectionString()` / `getPool()`

## 数据实体与表结构

| 表 | 说明 | 时间戳字段 |
|---|---|---|
| `game_session` | 场次实体（ID、名称、开关状态、显示序号） | `created_at`、`closed_at` |
| `round` | 每个场次一行：轮次、开奖数字、锁定人账号 | `locked_at` |
| `player` | 每轮玩家登记与预测（主键 `(session_id, id)`） | `registered_at`、`submitted_at` |
| `identity` | 场次内跨轮次玩家身份档案（主键 `(session_id, id)`） | `created_at`、`updated_at` |
| `round_archive` | 竞猜归档表头：一轮一行，含场次快照、轮次号、开奖数字、锁定时间、人数、锁定人（唯一键 `(session_id, round)`） | `locked_at`、`archived_at` |
| `round_archive_entry` | 归档明细：一人一行，含会员号、预测内容、命中结果（主键 `(archive_id, member_id)`） | `registered_at`、`submitted_at`、`archived_at` |
| `app_config` | 键值配置，只存 `player_bind_secret`（玩家绑定令牌签名密钥） | `updated_at` |
| `session_state` | 每个场次一行：状态版本号（多实例乐观锁凭据） | `updated_at` |
| `staff_session` | 员工登录会话（token、归属场次、过期时间、登录账号；角色回查账号表），跨实例共享 | `expires_at`、`created_at` |
| `staff_account` | 员工账号：账号名（主键）、显示名、角色（`staff`/`admin`）、状态、scrypt 密码派生值、建号人 | `created_at`、`updated_at`、`last_login_at` |
| `audit_log` | 操作日志：时间、账号、角色、动作、场次、对象、明细 JSON、IP（append-only） | `at` |
| `auth_throttle` | 登录 / 场次口令错误计数（`login:<账号>`、`switch:<账号>` 或 `player:<ip>`），跨实例共享 | `updated_at` |

**归档表是 append-only 的**：`round_archive` / `round_archive_entry` 由触发器 `archive_block_mutation()` 守着，任何 `UPDATE` / `DELETE` / `TRUNCATE` 都会抛异常。要修正历史只能追加新记录（或走导出层处理），不要直连数据库改这两张表。`reset` 只清 `round` / `player`，不影响归档。

玩家 ID 统一为「二维码内容 / 原始 ID」（未经 hash），`player.id` 与 `identity.id` 一致；同一 ID 可同时存在于多个场次，因此主键带 `session_id`。

**两个场景口令不入库**：玩家场次口令与员工场次口令只在进程内存保存 scrypt 哈希 + 随机盐，启动时由 `PLAYER_SESSION_PASSWORD` / `STAFF_SESSION_PASSWORD` 重算（多实例必须配同一份值）；玩家绑定令牌用 `app_config` 里的随机密钥做 HMAC 签名，因此重启后玩家的场次绑定仍然有效。员工登录密码是另一套：`staff_account.password_hash` 存 `scrypt$N$r$p$salt$hash`，任何接口都不返回。

**审计表也是 append-only**：`audit_log` 与归档表共用 `archive_block_mutation()` 触发器，`UPDATE` / `DELETE` / `TRUNCATE` 都会被拒。

表会在应用首次启动时自动创建（幂等，`CREATE TABLE IF NOT EXISTS`），无需手动建表。

> 应用**不做结构迁移**：不补列、不回填历史行、不改主键、不改既有列类型。表结构以 `db.js` 的定义为唯一基准，启动只创建缺失的表；库结构与代码不一致时不会自动修正（缺列会在第一条读写上报错），需按当前 DDL 手工对齐或重建库。

## 多实例部署

同一套 `DATABASE_URL` 可以起多个实例（多副本 / 多机 / 滚动发布），无需粘性会话：

- **状态**：全部在 Postgres，进程内只有 TTL 5 秒的读缓存；任一实例写入后其他实例读到的都是最新值
- **广播**：每次提交后 `pg_notify('oddeven_session_events', {type,sid,version})`；其他实例收到后回库读最新快照，再推给本机的 SSE 连接
- **并发写**：`session_state.version` 乐观锁（CAS 失败即重读重试，最多 6 次）；新建场次的「上限 + 序号」用 `pg_advisory_xact_lock` 串行化
- **会话**：`staff_session` 落库，A 实例签发的 token 在 B 实例有效，重启也不掉登录；限频计数同样落库，是全集群口径

部署检查项：

1. **数据库连接不能是事务级池**：`LISTEN` 要求连接长期归属同一会话。pgbouncer 用 `pool_mode=session`，或让应用直连（Fly Postgres 直连即可）。
2. **每个实例一条额外连接**：`pubsub.js` 会自建一条长连接用于 `LISTEN` + `pg_notify`，容量规划时按「实例数 + 池大小」算 `max_connections`。
3. **可选 `INSTANCE_ID`**：日志与通知里用于区分实例（默认 `i-<pid>-<随机>`），排查跨实例问题（如「谁提交了这一版」）时有用。
4. **滚动发布**：新旧版本可短暂共存；若改了通知通道名或 payload 结构，属于协议变更，需一次性全量升级。
5. **验证**：任意实例 `curl /api/sessions` 都应返回同一份场次列表；`fly logs` 里能看到 `[pubsub] 已订阅 oddeven_session_events（实例 xxx）`。

```bash
# 起第二个实例（本地验证多实例行为）
DATABASE_URL=postgres://... PORT=3001 INSTANCE_ID=node-b node server.js
DATABASE_URL=postgres://... PORT=3002 INSTANCE_ID=node-c node server.js
# 在 3001 登录拿 token，拿去 3002 调 /api/staff-check 必须 ok:true
```

## Fly.io 部署步骤

### 1. 准备 Postgres 并写入 secrets

数据库连接只走 secrets，**不写进 `fly.toml`**（那个文件进 git）。当前用的是 Supabase
pooler，一条完整连接串就够：

```bash
fly secrets set \
  DATABASE_URL='postgresql://postgres.siuilxncmpklkpcnpimg:<PASSWORD>@aws-1-ap-south-1.pooler.supabase.com:6543/postgres' \
  --app ft-faithful-darkness-5345
```

设置 secret 会触发一次重启，启动日志会打印脱敏后的目标库与 TLS 模式
（`[db] 连接 postgresql://...:***@host:port/db（池上限 5，TLS 不校验证书）`），
先核对这里再去点业务功能。

**换库时顺手清掉历史遗留的拆开写法**（代码已不再读取，但留在 secrets 里只会误导排障）：

```bash
fly secrets unset PG_HOST PG_USER PG_PASS PG_PORT PG_DB --app ft-faithful-darkness-5345
```

> 连接配置只有 `DATABASE_URL` 一个入口：拆开的 `PG_*`（含 `PG_URL`）已从代码中移除，
> 设不设都不生效。

#### Supabase pooler 的两个坑（代码里已处理）

| 坑 | 处理 |
| --- | --- |
| pooler 用**自签证书链**，而 `pg` 8.23 起把 `sslmode=require` 当成 `verify-full`（严格校验证书链）→ 报 `self-signed certificate in certificate chain` | `db.js` 把 `sslmode` 从连接串里摘出来，自己算 `ssl: { rejectUnauthorized: false }` 传给 Pool / Client，不依赖 pg 的版本语义 |
| **6543 是事务模式，不支持 LISTEN/NOTIFY**，跨实例通知会静默失效 | `pubsub` 长连接自动改走同一主机的会话模式 `5432`（`db.js` 的 `resolveListenConfig()`） |

TLS 判定规则（`db.js` 的 `sslOption()`）：

| 连接串写法 | 实际行为 |
| --- | --- |
| 不带 `sslmode`，主机 `*.supabase.com` | 加密、不校验证书（默认） |
| `sslmode=require` / `prefer` / `no-verify` | 加密、不校验证书 |
| `sslmode=verify-full` | 加密 + 严格校验（需 `sslrootcert`，pooler 用自签链时**会失败**） |
| `sslmode=disable` 或本地非托管主机 | 明文 |

> 别再往连接串里加分 `sslmode=require` 求"更安全" —— 在 pg 8.23+ 那等于
> `verify-full`，对 Supabase pooler 反而连不上。

池子默认 `max=5`（事务模式连接被复用，开大只会在 pooler 侧排队），
可用 `DB_POOL_MAX` 覆盖。跨区访问 `ap-south-1` 延迟约 70–100ms，
应用区域建议放 `bom`（孟买）而不是现在的 `nrt`（东京）。

### 2. 部署应用

```bash
fly deploy
```

### 3. 验证

```bash
# 查看日志，确认数据库初始化成功
fly logs
```

正常启动日志应包含：
- `数据持久化: Postgres（连接串来自 DATABASE_URL，池上限可用 DB_POOL_MAX 覆盖）`
- 无 `[db] 数据库初始化失败` 报错

首次启动会额外建 `round_archive` / `round_archive_entry` 与只增不改触发器（`CREATE TABLE IF NOT EXISTS`，不动已有表）。上线后自检归档链路：

```bash
# 用员工端登录拿到的 token 查当日聚合，rounds 应与当天实际锁定轮次一致
curl "https://<your-app>/api/archive/summary?token=<staff-token>"
```

## 本地开发（可选）

本地不设 `DATABASE_URL` 时，连本地默认库 `postgres://postgres:postgres@localhost:5432/oddeven`：

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/oddeven node server.js
```

若本地有 Docker，可用一行命令起一个 Postgres：

```bash
docker run -d --name oddeven-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=oddeven \
  -p 5432:5432 postgres:16
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串（**唯一的连接配置来源**） | 本地兜底 `postgres://postgres:postgres@localhost:5432/oddeven` |
| `DB_POOL_MAX` | 连接池上限 | `5` |
| `PORT` | 服务端口 | `3000` |
| `ADMIN_USERNAME` | 首次启动创建的管理员账号 | `admin` |
| `ADMIN_PASSWORD` | 首次启动创建的管理员密码（**只在库里没有任何管理员时生效**） | `123456` |
| `STAFF_SESSION_PASSWORD` | 员工切换 / 新建场次的场景口令（管理员免校验） | `7777` |
| `PLAYER_SESSION_PASSWORD` | 玩家端场次口令：多场并行时玩家选择 / 切换场次需要它 | `8888` |
| `ARCHIVE_TZ_OFFSET_MIN` | 归档对账的「当日」时区偏移（分钟）；东八区 `480` | `480` |

> `PG_HOST` / `PG_USER` / `PG_PASS` / `PG_PORT` / `PG_DB` / `PG_URL` 已从代码中移除，不再读取。
> 用户名密码里的 `@`、`/`、`:` 请在连接串里 URL 编码（`encodeURIComponent`）。
> TLS 已由 `db.js` 统一判定，连接串**不必**带 `sslmode`：托管库（`*.supabase.com`）默认
> 加密但不校验证书；要严格校验才写 `sslmode=verify-full`（pooler 自签链会失败）。
> Fly 内网同组织互访默认明文。

## 说明

- 员工登录会话落在 `staff_session`，服务重启**不掉登录**（多实例的硬要求）。要立即下线某人：在管理界面停用该账号或重置其密码，该账号所有会话会被立刻删除。
- 玩家端场次绑定（`oe_bind`：sid + 签名令牌 + 过期时间）**不受重启影响**，因为签名密钥持久化在 `app_config`；改 `PLAYER_SESSION_PASSWORD` 只会让后续选择场次需要新口令，已发出的令牌仍有效到 12 小时过期。
- 玩家 ID 不再做 hash，直接以二维码内容/原始 ID 作为主键。
