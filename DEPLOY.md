# 部署与数据库配置说明

## 数据持久化概览

游戏状态从原来的 `game-data.json` 本地文件迁移到 **Postgres**。应用重启后数据仍保留。

- 数据层：`db.js`（连接池 + 幂等建表 + 读写函数）
- 服务入口：`server.js` 启动时 `initDb()` 建表、`loadState()` 恢复上次状态
- 连接串：由三个 secret 拼接 —— `postgresql://PG_USER:PG_PASS@PG_HOST:5432/postgres`

## 数据实体与表结构

| 表 | 说明 | 时间戳字段 |
|---|---|---|
| `round` | 当前轮次状态 | `locked_at` |
| `player` | 每轮玩家登记与预测 | `registered_at`、`submitted_at` |
| `identity` | 跨轮次玩家身份档案 | `created_at`、`updated_at` |

玩家 ID 统一为「二维码内容 / 原始 ID」（未经 hash），`player.id` 与 `identity.id` 一致。

表会在应用首次启动时自动创建（幂等，`CREATE TABLE IF NOT EXISTS`），无需手动建表。

## Fly.io 部署步骤

### 1. 准备 Postgres 并写入 secrets

数据库固定连 `postgres` 库。把主机、用户名、密码写进 Fly secrets：

```bash
fly secrets set \
  PG_HOST=your-db-host \
  PG_USER=your-db-user \
  PG_PASS='your-db-password' \
  --app ft-faithful-darkness-5345
```

应用会用这三个值拼出连接串：`postgresql://PG_USER:PG_PASS@PG_HOST:5432/postgres`。
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
| `DATABASE_URL` | 完整连接串，`PG_*` 三个不全时才生效 | 无 |
| `PORT` | 服务端口 | `3000` |
| `STAFF_PASSWORD` | 员工端密码 | `123456` |

> 连接串固定拼成 `postgresql://PG_USER:PG_PASS@PG_HOST:5432/postgres`：端口 5432、库名 `postgres` 写死。
> 用户名和密码会自动 URL 编码，含 `@`、`/`、`:` 等字符不用手工转义。
> 若目标数据库要求 TLS，需要在 `db.js` 的 `Pool` 配置里加 `ssl`，Fly 内网同组织互访不需要。

## 说明

- 员工端会话（`sessions`）仍是**内存态**，服务重启后需要重新登录，这是有意设计，不影响游戏数据持久化。
- 玩家 ID 不再做 hash，直接以二维码内容/原始 ID 作为主键。
