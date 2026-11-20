# 部署与数据库配置说明

## 数据持久化概览

Postgresql：

- 数据层：`db.js`（连接池 + 幂等建表 + 读写函数）
- 服务入口：`server.js` 启动时 `initDb()` 建表、`loadState()` 恢复上次状态
- 连接串：由 secret 拼接 —— `postgresql://PG_USER:PG_PASS@PG_HOST:PG_PORT/PG_DB`
  （`PG_PORT` 默认 `5432`，`PG_DB` 默认 `postgres`）

## 数据实体与表结构

| 表 | 说明 | 时间戳字段 |
|---|---|---|
| `game_session` | 场次实体（ID、名称、开关状态、显示序号） | `created_at`、`closed_at` |
| `round` | 每个场次一行：轮次与开奖数字 | `locked_at` |
| `player` | 每轮玩家登记与预测（主键 `(session_id, id)`） | `registered_at`、`submitted_at` |
| `identity` | 场次内跨轮次玩家身份档案（主键 `(session_id, id)`） | `created_at`、`updated_at` |
| `app_config` | 键值配置，只存 `player_bind_secret`（玩家绑定令牌签名密钥） | `updated_at` |

玩家 ID 统一为「二维码内容 / 原始 ID」（未经 hash），`player.id` 与 `identity.id` 一致；同一 ID 可同时存在于多个场次，因此主键带 `session_id`。

**玩家端口令不入库**：只在进程内存保存 scrypt 哈希 + 随机盐，启动时由 `PLAYER_SESSION_PASSWORD` 重算；玩家绑定令牌用 `app_config` 里的随机密钥做 HMAC 签名，因此重启后玩家的场次绑定仍然有效。

表会在应用首次启动时自动创建（幂等，`CREATE TABLE IF NOT EXISTS`），无需手动建表。

## Fly.io 部署步骤

### 1. 准备 Postgres 并写入 secrets

把主机、用户名、密码写进 Fly secrets（端口和库名可选，不设则用 `5432` / `postgres`）：

```bash
fly secrets set \
  PG_HOST=your-db-host \
  PG_USER=your-db-user \
  PG_PASS='your-db-password' \
  PG_PORT=5432 \
  PG_DB=postgres \
  --app ft-faithful-darkness-5345
```

应用会用这些值拼出连接串：`postgresql://PG_USER:PG_PASS@PG_HOST:PG_PORT/PG_DB`。
设置 secret 会触发一次自动重启。

> 如果还在用 `fly postgres attach` 注入的 `DATABASE_URL`，两者同时存在时
> **以 PG_HOST/PG_USER/PG_PASS 为准**，`DATABASE_URL` 只在三个变量不全时兜底。

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
- `数据持久化: Postgres（PG_HOST/PG_USER/PG_PASS）`
- 无 `[db] 数据库初始化失败` 报错

## 本地开发（可选）

本地不设 `PG_HOST/PG_USER/PG_PASS` 时，回退到 `DATABASE_URL`；两者都不设则连本地默认库：

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
| `PG_HOST` | Postgres 主机（Fly secret） | 无 |
| `PG_USER` | Postgres 用户名（Fly secret） | 无 |
| `PG_PASS` | Postgres 密码（Fly secret） | 无 |
| `PG_PORT` | Postgres 端口（Fly secret，可选） | `5432` |
| `PG_DB` | 数据库名（Fly secret，可选） | `postgres` |
| `DATABASE_URL` | 完整连接串，`PG_*` 主机/用户/密码不全时才生效 | 无 |
| `PORT` | 服务端口 | `3000` |
| `STAFF_PASSWORD` | 员工端密码 | `123456` |
| `PLAYER_SESSION_PASSWORD` | 玩家端场次口令：多场并行时玩家选择 / 切换场次需要它 | `8888` |

> 连接串拼成 `postgresql://PG_USER:PG_PASS@PG_HOST:PG_PORT/PG_DB`；`PG_HOST`、`PG_USER`、`PG_PASS` 三者缺一就整体回退到 `DATABASE_URL`。
> 用户名和密码会自动 URL 编码，含 `@`、`/`、`:` 等字符不用手工转义。
> 若目标数据库要求 TLS，需要在 `db.js` 的 `Pool` 配置里加 `ssl`，Fly 内网同组织互访不需要。

## 说明

- 员工端会话（`sessions`）仍是**内存态**，服务重启后需要重新登录，这是有意设计，不影响游戏数据持久化。
- 玩家端场次绑定（`oe_bind`：sid + 签名令牌 + 过期时间）**不受重启影响**，因为签名密钥持久化在 `app_config`；改 `PLAYER_SESSION_PASSWORD` 只会让后续选择场次需要新口令，已发出的令牌仍有效到 12 小时过期。
- 玩家 ID 不再做 hash，直接以二维码内容/原始 ID 作为主键。
