# 部署与数据库配置说明

## 数据持久化概览

游戏状态从原来的 `game-data.json` 本地文件迁移到 **Postgres**。应用重启后数据仍保留。

- 数据层：`db.js`（连接池 + 幂等建表 + 读写函数）
- 服务入口：`server.js` 启动时 `initDb()` 建表、`loadState()` 恢复上次状态
- 连接串：环境变量 `DATABASE_URL`

## 数据实体与表结构

| 表 | 说明 | 时间戳字段 |
|---|---|---|
| `round` | 当前轮次状态 | `locked_at`、`updated_at` |
| `player` | 每轮玩家登记与预测 | `registered_at`、`submitted_at`、`last_scan_at` |
| `identity` | 跨轮次玩家身份档案 | `created_at`、`updated_at` |
| `scan_log` | 扫码审计日志 | `ts` |

表会在应用首次启动时自动创建（幂等，`CREATE TABLE IF NOT EXISTS`），无需手动建表。

## Fly.io 部署步骤

### 1. 创建 Postgres 实例

```bash
fly pg create --name oddeven-db
```

创建完成后，Fly 会把 Postgres 附加到应用，并通过名为 `DATABASE_URL` 的 secret 注入连接串。如需手动附加：

```bash
fly postgres attach oddeven-db
```

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
- `数据持久化: Postgres（DATABASE_URL）`
- 无 `[db] 数据库初始化失败` 报错

## 本地开发（可选）

使用本地或任意 Postgres，通过环境变量注入连接串：

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
| `DATABASE_URL` | Postgres 连接串（必填） | 无 |
| `PORT` | 服务端口 | `3000` |
| `STAFF_PASSWORD` | 员工端密码 | `123456` |

> 注意：`DATABASE_URL` 在 Fly.io 上由 `fly postgres attach` 自动注入，请勿手动 `fly secrets set` 覆盖，除非你知道自己在做什么。

## 说明

- 员工端会话（`sessions`）仍是**内存态**，服务重启后需要重新登录，这是有意设计，不影响游戏数据持久化。
- 扫码日志上限 500 条（`scan_log` 表保留最近 500 条）。
