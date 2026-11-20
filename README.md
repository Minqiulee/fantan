# 羊多一点 · 单双竞猜（门店互动版）

门店现场使用的手机端互动竞猜工具。顾客扫描自己的会员码登记，猜本轮数字的单/双与具体数字；工作人员确认本轮数字后立即开奖，结果实时推送到所有在线设备。参与者凭竞猜结果在门店按规则获取积分。

运营规模：**单场 6–12 位玩家**，一位工作人员用一部手机即可主持；同一门店同一时段可**全集群并行 1–4 场**（多实例共享同一份状态），场次可随时新建、切换、关闭，不需改配置或重启（跨场汇总仍待补，见 [6.1 运营模型与容量](#61-运营模型与容量)）。

本项目只负责「登记 → 预测 → 锁定 → 开奖 → 展示」这条链路，**不包含积分记账与发放**，积分体系由门店侧另行实现。

- 玩家端：`/`
- 工作人员端：`/staff`
- 技术栈：Node.js 原生 `http` 模块 + Postgres，除 `pg` 外无第三方运行时依赖
- 实时通道：SSE（Server-Sent Events），断线自动重连

---

## 1. 功能特性

| 模块 | 能力 |
|---|---|
| 玩家登记 | 扫自己手上的会员二维码（默认前置摄像头），或手动输入二维码内容；同一内容重复扫幂等返回同一身份 |
| 规则介绍 | 玩家登记成功后自动弹出玩法说明，10 秒倒计时（页面最底部细进度条 + 剩余秒数），点击任意处立即关闭；仅玩家端，同一身份每次登录只触发一次 |
| 预测 | 单/双 + 1–8 数字，一次提交，不可修改；开奖后关闭入口 |
| 开奖 | 工作人员在员工端点选 1–8 并确认，确认即锁定，不可更改 |
| 轮次 | 锁定后由工作人员手动开启新一轮，轮次号 +1 |
| 场次 | 全集群并行 1–4 场；员工登录默认归属一场，可运行时新建 / 切换 / 关闭，状态按场次隔离，SSE 按场次分组推送 |
| 场次口令 | 多场并行时，玩家选择 / 切换场次必须输入口令；验证后绑定 12 小时，刷新、重开页面、后续操作都固定在该场次，未再次验证不可切换 |
| 身份档案 | 跨轮次累计每人完成的竞猜轮次数，用于区分「新玩家 / 老玩家」 |
| 实时同步 | 所有状态变更经 SSE 广播到全部在线页面，含开奖瞬间；断线重连后全量对齐 |
| 管理界面 | `/admin` 集中四个管理动作：当日对账、大屏、新建场次、关闭场次；与员工端共用同一份员工登录态 |
| 实时大屏 | `/bigscreen` 按场次实时展示每位玩家的当前选项（单/双 + 数字），区分新加入 / 未选择 / 选项变更 / 已离开；与员工端共用同一套 SSE 广播与场次版本号，过期帧直接丢弃 |
| 多语言 | 简体中文 / 繁体中文 / 英文，切换结果按端独立记忆（localStorage） |
| 员工鉴权 | 密码登录 → 会话 token（12 小时），5 次失败锁定 30 秒 |
| 玩家端口令 | 口令只以 scrypt 哈希存在于进程内存，不落库、不下发；验证通过后签发 HMAC 绑定令牌，按来源 IP 限频（5 次错误锁 30 秒） |
| 持久化 | Postgres，六张表 + 一张配置表，首次启动自动建表，重启后状态保留 |

---

## 2. 项目结构

```
.
├── server.js              # HTTP 服务：静态文件、API、SSE 广播、员工会话
├── store.js               # 共享会话存储：读缓存 + 乐观锁提交 + 变更事件
├── pubsub.js              # 跨实例状态通知（Postgres LISTEN/NOTIFY，断线重连）
├── db.js                  # Postgres 连接池、建表、快照读写、归档、会话与限频
├── public/
│   ├── index.html         # 玩家端（扫码 / 预测 / 等待 / 结果）
│   ├── staff.html         # 工作人员端（登录 / 录入数字 / 结算表 / 开新轮 / 切换场次）
│   ├── admin.html         # 管理界面（当日对账 / 大屏 / 新建场次 / 关闭场次）
│   ├── bigscreen.html     # 实时大屏（按场次展示每位玩家的当前选项）
│   ├── i18n.js            # 三语文案与切换逻辑（两端共用）
│   └── html5-qrcode.min.js # 本地二维码解码库（无 CDN 依赖）
├── test/
│   ├── run.mjs            # 测试入口：起临时 Postgres（Docker）→ 串行跑全部用例
│   ├── helpers.mjs        # 基座：起服务、HTTP 客户端、连库、CSV 解析
│   ├── archive.test.mjs   # 主流程：锁定即归档 / 聚合 / 两种 CSV / reset / 跨场分账 / append-only
│   ├── archive-failure.test.mjs # 故障路径：归档失败、reset 拦截、archive-sync、重启回填
│   └── multi-instance.test.mjs  # 多实例：共享存储、跨实例 SSE、并发写、集群上限、重启不掉登录
├── Dockerfile             # 多阶段构建，node:26-slim
├── fly.toml               # Fly.io 部署配置（可替换为任意平台）
├── .github/workflows/fly-deploy.yml  # 推送到 main/master 自动部署
├── DEPLOY.md              # 数据库与 Fly.io 部署补充说明
└── package.json           # 仅一个依赖：pg
```

请求分流：`/api/stream` → SSE；`/api/*` → JSON 接口；其余 → `public/` 静态文件（`/staff` → `staff.html`，`/admin` → `admin.html`，`/bigscreen` → `bigscreen.html`，路径穿越被拦）。

---

## 3. 运行要求

- **Node.js**：仓库未声明 `engines`，Dockerfile 固定 `node:26.12.0-slim`。本地建议与镜像版本保持一致。
- **Postgres**：需要一个可访问的 Postgres 实例。首次启动会对目标库执行 `CREATE TABLE`，账号需要建表权限。
- 浏览器端：扫码依赖 `getUserMedia`，**移动浏览器访问时必须使用 HTTPS 或 localhost**，否则摄像头无法打开（可用手动输入兜底）。

---

## 4. 快速开始（本地）

### 4.1 起一个本地 Postgres

```bash
docker run -d --name oddeven-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=oddeven \
  -p 5432:5432 postgres:16
```

### 4.2 安装依赖并启动

```bash
npm install

export STAFF_PASSWORD='换成你自己的密码'
export DATABASE_URL='postgres://postgres:postgres@localhost:5432/oddeven'
npm start
```

启动日志会打印两个入口：

```
单双竞猜已启动: http://localhost:3000/  (玩家端，进入后扫自己的二维码)
工作人员端入口: http://localhost:3000/staff
数据持久化: Postgres（PG_HOST/PG_USER/PG_PASS，端口与库名可用 PG_PORT/PG_DB 覆盖）
```

> 未设置 `STAFF_PASSWORD` 时会回退到内置默认密码 `123456`，启动日志会给出警告。**任何对外可访问的环境都必须覆盖它。**

---

## 5. 配置

### 5.1 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | HTTP 监听端口 | `3000` |
| `STAFF_PASSWORD` | 工作人员端登录密码（上线前必须设置） | `123456` |
| `PG_HOST` | Postgres 主机 | 无 |
| `PG_USER` | Postgres 用户名 | 无 |
| `PG_PASS` | Postgres 密码 | 无 |
| `PG_PORT` | Postgres 端口（配合 `PG_*` 使用） | `5432` |
| `PG_DB` | 数据库名（配合 `PG_*` 使用） | `postgres` |
| `DATABASE_URL` | 完整连接串；`PG_*` 三件套不全时才生效 | 无 |
| `PG_URL` | 同 `DATABASE_URL`，优先级更低 | 无 |
| `ARCHIVE_TZ_OFFSET_MIN` | 归档对账的「当日」时区偏移（分钟，东八区填 `480`） | `480` |

连接串解析优先级（`db.js`）：

1. `PG_HOST` + `PG_USER` + `PG_PASS` 三者齐备 → 拼接 `postgresql://USER:PASS@HOST:PORT/DB`（用户名与密码自动 URL 编码，密码含 `@` `:` `/` 无需手工转义）
2. `DATABASE_URL`
3. `PG_URL`
4. 本地兜底 `postgres://postgres:postgres@localhost:5432/oddeven`

三个都不配置且本地无默认库时，启动会打印 `[db] 数据库初始化失败，应用无法启动` 并退出（`exit 1`），不会带着空状态继续跑。

### 5.2 数据库 TLS

代码里没有显式写 `ssl` 配置。托管库如果强制 TLS，在**连接串**里带 `sslmode` 即可（`pg` 的连接串解析层会把它转成 `ssl` 配置）：

```bash
export DATABASE_URL='postgres://user:pass@db.example.com:5432/postgres?sslmode=require'
```

- `sslmode=require` / `verify-full`：按 `verify-full` 语义处理，需要服务端证书可被校验
- `sslmode=no-verify`：加密但不校验证书（自签证书场景）
- 注意：走 `PG_HOST/PG_USER/PG_PASS` 分支时无法附加 TLS 参数，需要 TLS 请改用 `DATABASE_URL`，或按“待办”一节补代码

---

## 6. 使用说明

### 6.1 运营模型与容量

| 项目 | 设计值 | 说明 |
|---|---|---|
| 单场玩家数 | 6–12 位 | 服务端**没有人数上限校验**，超员不会被拒绝；6–12 是场地组织与员工端结算表的可读区间 |
| 并行场次 | 1–4 场 | 每场由一位工作人员主持，各自独立登录、独立录号、独立开新轮 |
| 场内轮次 | 不限，连续开轮 | 一场内可反复「锁定 → 开始新一轮」，轮次号在该场内递增 |

**场次隔离：一个实例可同时承载 1–4 个场次。** `round` / `player` / `identity` 均带 `session_id`，主键为 `(session_id, id)`；运行态按 `session_id` 分区，SSE 也按场次分组广播。同一门店同一时段可以：

- **一个部署跑多场**：员工登录后默认归属某一场，随时在员工端新建 / 切换 / 关闭场次，全程不修改配置、不重启服务。
- **按场次分别部署**（仍是可选方式）：每场一套实例 + 独立数据库，适合不同门店、彼此不相关的场景。

上限 4 场（`server.js` 的 `MAX_SESSIONS`），关闭一场即释放名额。

#### 运营侧的两项硬需求与现状

| 需求 | 现状 | 影响 |
|---|---|---|
| 场次随时增开 / 关闭，不改配置、不重启 | ✅ 支持。员工端「新建 / 切换 / 关闭」，立即生效；关闭后该场玩家端退回场次选择，数据保留可回看 | 开店节奏不再被部署绑定 |
| 跨场次对账（当日参与人数、逐人猜测明细） | ✅ 支持。每轮锁定即追加写入归档表（append-only），提供当日聚合接口与 CSV 导出，见 6.6 | 按 `session_id` 分账；同一会员号跨场记录逐行导出，不合并不算分 |


### 6.2 一轮的完整生命周期

1. **选择场次（多场并行时）**：打开玩家端 → 若同时进行 ≥2 场，先选择自己所在场次并输入**场次口令**。验证通过后本机绑定该场次（12 小时），刷新 / 重开页面 / 扫码 / 预测都固定在此场次；想换场次必须重新输入口令。只有 1 场进行中时免口令自动进入（无处可选）。
2. **玩家登记**：扫自己的会员码（或手动输入会员号）→ 服务端以二维码内容本身作为玩家唯一 ID 建档。本轮开奖后新码无法入场。
3. **提交预测**：选择「单 / 双」与 1–8 中的一个数字 → 一次提交，不可修改或重复提交。
4. **等待开奖**：页面显示已提交的预测，状态条提示等待中；开奖数字在锁定前不会下发给任何客户端。
5. **工作人员锁定**：员工端登录 → 点选 1–8 → 若仍有玩家未提交会先弹提示 → 二次确认 → 锁定并广播结果。
6. **查看结果**：员工端展示逐人命中表（单双命中、数字命中）；玩家端展示开奖数字与自己两项预测的命中情况。
7. **开启新一轮**：员工端「开始新一轮」→ 轮次 +1、本轮玩家清空、跨轮身份档案保留；玩家需重新扫码登记。

### 6.3 玩家端状态

| 状态 | 含义 | 页面表现 |
|---|---|---|
| 选择场次 | 没有本机绑定，且同时进行 ≥2 场（或原场次已关闭） | 显示场次列表；点选后弹出口令输入框 |
| 未登记 | 无本地身份，或新一轮已开始 | 显示扫码卡片 |
| 已登记 | 已识别身份，未提交预测 | 显示预测卡片 |
| 等待开奖 | 已提交，本轮未锁定 | 显示等待动画与自己的预测 |
| 已开奖 | 本轮已锁定 | 显示数字与两项命中判定 |

身份有效性以服务端返回的 `me` 为准：新一轮开始后 `me` 变空，本地保存的身份自动清除，需重新扫码。

登记成功（登录）后自动展示一次玩法说明：10 秒倒计时，页面最底部一条细进度条随剩余时间收缩，卡片内同时显示剩余秒数；点击任意区域立即关闭，超时自动关闭。关闭后遮罩 `display:none`，不拦截后续点击。触发条件只有「登记成功」且同一身份每次页面只触发一次，因此刷新、SSE 重连、状态推送都不会重放；切到后台会暂停计时，回到前台接着算。仅玩家端加载该层，员工端与大屏不受影响。

场次绑定的优先级高于一切入口参数：本地已有绑定（`oe_bind`）时，连 `?s=` 也不会把它切走；想换场次只能点「切换场次」→ 选场次 → 输口令。只有 1 场进行中时免口令，且仍会写入绑定，避免之后开出第二场时被判为「需要重选」。

### 6.4 工作人员端

只有一件事：把这一场跑完。管理动作不在这一页。

- 登录态存 `sessionStorage`，关闭标签页即失效；服务端会话 12 小时过期
- 顶栏右侧只有两个入口：**管理**（跳 `/admin`）与**切换场次**
- 「本轮概况」实时显示已扫码人数与已提交人数
- 玩家列表用颜色区分新玩家（蓝）与老玩家（金）
- 每个状态变更都会实时刷新，无需手动刷新页面
- 场次条只展示当前场次名称与状态，页面上没有任何新建 / 关闭 / 对账 / 大屏入口

**「切换场次」与玩家端同一套交互**：点顶栏胶囊按钮 → 页面就地展开「选择场次」卡片，其余内容暂时收起；选项整行可点（名称 + 轮次/状态/人数），当前场次打勾（✓）、其他场次显示 `›`；选中即刻切换并 toast「已切换到「X」」，卡片自动收起。切换期间按钮自身隐藏，卡片底部给出「取消切换」，取消即原样退回原场次。员工已用管理密码登录，因此切换不重复要求场次口令（玩家端要口令是因为玩家侧没有员工身份）。

### 6.5 管理界面（`/admin`）

四个入口，一格一件事，进入后不再叠其他卡片：

| 入口 | 行为 | 前置条件 |
|---|---|---|
| 当日对账 | 就地在页内展开：日期选择（默认今天）+ 场次/已归档轮次/去重人数 + 两种 CSV 下载，带「返回」 | 无 |
| 大屏 | 新窗口打开 `/bigscreen?token=&sid=`（令牌立即从地址栏抹掉，只存本地） | 需要一个进行中的当前场次 |
| 新建场次 | 弹窗输入名称（留空自动命名）→ 创建并自动切到新场次，toast 确认 | 进行中场次 < 4 |
| 关闭场次 | 二次确认（红色危险弹窗）→ 关闭当前归属场次，玩家端立即断开 | 当前场次必须是进行中 |

- 登录态与员工端共用：从员工端点「管理」是同标签页跳转，直接复用那份 token；独立打开/收藏夹进入则需输一次管理密码，或带 `?token=` 预置（页面立刻 `history.replaceState` 抹掉）。令牌同时写 `sessionStorage`（员工端）与 `localStorage`（独立打开用），员工端「退出登录」会把两份一起清掉
- 不做实时推送：进页面、切回前台（`visibilitychange`）、每次操作成功后各刷一次场次列表与对账数字
- 场次相关的能力边界与员工端一致：全集群 4 场上限、只能关自己当前归属的场次、已关闭场次不可再进

### 6.6 竞猜归档与当日对账

**归档（append-only）。** 工作人员点「确认并锁定」的那一刻，本轮完整明细会写进归档表：

- 表头 `round_archive`：`session_id` + 场次名称/序号快照 + 轮次号 + 开奖数字 + 开奖单双 + 锁定时间 + 归档时间 + 扫码人数 + 提交人数
- 明细 `round_archive_entry`：会员号 + 预测单双 + 预测数字 + 是否提交 + 单双匹配 + 数字匹配 + 登记/提交时间
- **不记录任何积分、得分、总分字段**：归档只回答「谁猜了什么、实际开了什么、猜中没猜中」，折算积分是门店侧的事
- 归档与运行态快照在**同一个事务**里写：要么「已锁定且有归档」，要么整体回滚，不存在只锁不归档的中间态
- 归档表由数据库触发器守着，`UPDATE` / `DELETE` / `TRUNCATE` 一律抛错；`reset` 只清 `round` / `player`，碰不到归档
- 唯一键是 `(session_id, round)`：重复保存同一轮不会产生第二份记录，也不会改写既有行

**「当日」的口径。** 一律按 `locked_at`（锁定时间）落在运营时区的自然日内计算，与建档时间、提交时间无关。时区由 `ARCHIVE_TZ_OFFSET_MIN` 决定（默认 `480`，即 UTC+8），按固定偏移切分而不是 IANA 时区库——港/深/澳没有夏令时，日界永远稳定。

**当日聚合**（管理界面「当日对账」/ `GET /api/archive/summary`）——只统计参与规模，不统计结果：

| 指标 | 定义 |
|---|---|
| 场次数 | 当天**有已归档轮次**的场次数（不是当前进行中的场次数） |
| 轮次数 | 当天已归档的轮次总数（含 0 人轮次） |
| 参与人数 | 明细里 `member_id` 的去重计数（跨场次去重，同一个会员号在 A 场和 B 场只算 1 人） |
| 扫码/提交人次 | `sum(player_count)` / `sum(submitted_count)`，按人次而非按人 |

**对账导出**（`GET /api/archive/export.csv`，`level` 二选一）：

| level | 粒度 | 用途 |
|---|---|---|
| `detail`（默认） | 一人一轮一行，跨场次全量 | 逐人核对：猜测内容、实际开奖、两项是否匹配；同一会员号在不同场次各占一行，**不合并、不算总分、不算命中率** |
| `round` | 一轮一行（含 0 人轮次） | 核对「当天到底开了几轮」，与 `detail` 的行数不必然相等 |

CSV 用 UTF-8 BOM + CRLF，Excel 双击不乱码；列头顺序固定，见 7.3。

### 6.7 实时大屏（`/bigscreen`）

**给现场看的第二块屏**：同一场次里每个人的当前选项（单/双 + 数字），玩家一提交就变。

- 入口：管理界面（`/admin`）的「大屏」入口（带当前场次与员工令牌新开窗口），或直接访问 `/bigscreen`（需输入员工密码）；支持 `?sid=&token=` 预置，页面会把令牌从地址栏抹掉后只存本地，刷新不用重输
- 数据来源：`GET /api/stream?sid=&token=&view=bigscreen`，与员工端、玩家端**同一条 SSE 通道、同一个场次版本号**，没有额外轮询
- 权限：`view=bigscreen` 会下发开奖前的选项，因此**只认有效员工 token**，否则 403 `bigscreen_unauthorized`；玩家端仍走 `publicPlayers()`，开奖前拿不到任何人的选项
- 状态识别：
  - **加入** — 出现新的 `pid`（本轮首次扫码）
  - **未选择** — 已扫码但 `oddEven` 为空，虚线卡片
  - **选项变更** — 同一 `pid` 的选项由空变有（或数值变化），卡片闪一次金色描边；业务上「一次提交不可修改」不变，所以这只覆盖「未选择 → 已选择」
  - **离开** — 玩家页面 `pagehide` 时用 `sendBeacon` 上报 `POST /api/leave`，卡片变灰并保留其已提交的选项；重新扫码或 SSE 重连即撤销标记（刷新、回前台都算回来）
  - **新一轮** — `round` 变化时整屏清空，只留一条「新一轮」动态，不会把上一轮的人当成离场逐个播报
- 一致性：客户端按 `version` 丢弃过期帧（重连补发、并发请求乱序都不会把旧选项盖回去），按 `pid` 增量 diff，DOM 上不会出现重复卡片；卡片数量少时自动放大、多了自动收窄
- 离开标记随 `player.left_at` 落库，服务重启后仍然有效；`reset` 清空本轮玩家时一并消失

---

## 7. HTTP 接口

所有接口返回 JSON；异常统一为 `{ "ok": false, "code": "..." }`。

| 方法 | 路径 | 鉴权 | 请求体 / 参数 | 说明 |
|---|---|---|---|---|
| POST | `/api/staff-login` | — | `{password}` | 成功返回 `{ok, token, sid, sessions}`，`sid` 为登录后默认归属的场次 |
| POST | `/api/staff-logout` | token | `{token}` | 注销会话 |
| GET | `/api/staff-check` | token | `?token=` | 会话是否仍有效，返回当前绑定的 `sid` 与场次列表 |
| GET | `/api/sessions` | — | `?token=` | 场次列表；无 token 只返回进行中的场次，带有效 token 返回含已关闭场次的完整列表 |
| POST | `/api/session-create` | token | `{token, name}` | 新建场次（上限 4），创建者自动切到新场次，`name` 可省略（自动命名），上限 24 字 |
| POST | `/api/session-select` | token | `{token, sid}` | 切换该员工会话的归属场次，不影响其他员工 |
| POST | `/api/session-close` | token | `{token, sid}` | 关闭场次：通知并断开该场玩家端、从玩家端列表移除、数据保留 |
| POST | `/api/session-unlock` | — | `{sid, password}` 或 `{sid, auto:true}` | 玩家端选择 / 切换场次：校验口令，成功返回绑定令牌 `ut`（12 小时）。`auto` 仅在唯一进行中场次时可用 |
| GET | `/api/state` | — | `?sid=&ut=&pid=`；大屏加 `&token=&view=bigscreen` | 某场次的全量状态快照；带 `pid` 时额外返回该玩家的 `me`。`view=bigscreen` 返回大屏视图（开奖前也含每个人的选项），需员工 token |
| POST | `/api/scan` | — | `{sid, ut, content}` | 登记身份，返回 `{ok, pid, sid, status:"known"}` |
| POST | `/api/predict` | — | `{sid, ut, pid, oddEven, number}` | `oddEven` 为 `"单"` / `"双"`，`number` 为 1–8 |
| POST | `/api/leave` | — | `{sid, ut, pid}` | 玩家离开现场：只给大屏打 `left` 标记，不删登记与预测；幂等，重复上报不递增版本号 |
| POST | `/api/confirm` | token | `{token, sid, number}` | 锁定该场次本轮数字（唯一写入点，写后不可改） |
| POST | `/api/reset` | token | `{token, sid}` | 该场次轮次 +1 并清空本场本轮玩家（已锁定轮次必须先归档成功，否则返回 409 `archive_write_failed`） |
| GET | `/api/archive/summary` | token | `?token=&date=` 或 `?token=&from=&to=` | 当日聚合：场次数、轮次数、去重参与人数、分场次明细。默认今天 |
| GET | `/api/archive/export.csv` | token | `?token=&level=detail\|round&date=或 from=&to=&sid=` | 对账 CSV（`text/csv`，带 BOM，列头固定见 7.3） |
| POST | `/api/archive-sync` | token | `{token}` | 把内存里所有「已锁定但未落归档」的轮次重新写一遍（幂等，正常情况用不到） |
| GET | `/api/stream` | — | `?sid=&ut=&pid=`；大屏加 `&token=&view=bigscreen` | SSE 长连接，只推送该场次的事件 |

**玩家侧准入（`/api/state`、`/api/scan`、`/api/predict`、`/api/stream` 共用一套判定）**：

- 带有效 `ut`：一律以**令牌里的场次**为准。请求的 `sid` 与绑定不一致 → `session_locked`，改 URL / localStorage 都换不了场次
- 不带 `ut`：只有 1 个进行中场次时放行（无处可选）；≥2 场一律 `session_need_unlock`，必须先过口令
- `ut` 过期（12 小时）或场次被关闭 → 客户端清掉本地绑定，退回场次选择

`sid` 省略时：若只有一个进行中的场次则自动使用它，多个场次并行时必须显式指定，否则返回 `session_not_found`。

`/api/state` 返回结构：

```json
{
  "ok": true,
  "session": { "id": "efca97c6", "name": "A 场", "status": "open" },
  "version": 12,
  "round": 3,
  "locked": false,
  "number": null,
  "players": [{ "id": "M00123", "submitted": true, "isVeteran": true }],
  "me": { "id": "M00123", "oddEven": "单", "number": 5 }
}
```

`/api/session-unlock` 返回结构：

```json
{
  "ok": true,
  "sid": "efca97c6",
  "ut": "efca97c6.1795206286748.ce3fa24cf5cb1896ca55d06374bc1432",
  "expiresAt": 1795206286748,
  "session": { "id": "efca97c6", "name": "A 场", "round": 3, "locked": false },
  "sessions": []
}
```

令牌是 `场次.过期时间.HMAC-SHA256 前 128 位`，只含场次与过期时间——不含口令、不含玩家 ID，服务端无状态校验。签名密钥随机生成后存在 `app_config`，所以**服务重启后玩家无需重新输入口令**；密钥不在仓库与配置里。

开奖后 `players[]` 才会补上每人的 `oddEven` 与 `number`；开奖前任何人都拿不到他人的预测内容。`version` 与 `round`、`players` 一样都是**该场次**的，各场次互不影响。

`view=bigscreen`（需员工 token）换成大屏视图，差别只有两处：多了 `"view": "bigscreen"`，且 `players[]` 在开奖前就带 `oddEven` / `number`（外加 `left`、`leftAt`、`registeredAt`、`submittedAt`）。

### 7.1 SSE 事件

- 连接按 `session_id` 分组，广播只发往该场次的连接，不同场次的客户端互不可见
- 连接建立后立即下发一次 `state` 事件（全量快照），事件 `id` 为场次状态版本号
- 之后每次状态变更广播 `state`；`Last-Event-ID` 仅作版本对照，服务端广播始终是全量快照，重连天然对齐
- 场次被关闭时向该场连接下发一次 `session_closed`（带最新场次列表），随后断开；客户端据此退回场次选择
- 每 15 秒发送一次 `ping` 心跳，防止代理/浏览器超时断连
- 服务端下发 `retry: 2000`，客户端断线 2 秒后重连

### 7.2 错误码

| code | HTTP | 触发场景 |
|---|---|---|
| `bad_request` | 400 | 请求体不是合法 JSON / 超过 64 KB |
| `scan_empty` | 400 | 二维码内容为空 |
| `scan_too_long` | 400 | 内容超过 512 字符（`maxLen` 一并返回） |
| `scan_locked` | 400 | 本轮已开奖，新码不允许入场 |
| `predict_not_scanned` | 400 | 未登记就提交预测 |
| `predict_closed` | 400 | 已开奖，预测关闭 |
| `predict_duplicate` | 400 | 已提交过，不可重复或修改 |
| `predict_invalid_oe` | 400 | 单双取值非「单 / 双」 |
| `predict_invalid` | 400 | 数字不是 1–8 的整数 |
| `unauthorized` | 401 | 员工 token 缺失或过期 |
| `wrong_password` | 401 | 员工密码错误 |
| `too_many_attempts` | 429 | 连续 5 次密码错误，锁 30 秒（返回 `retryAfter` 秒数） |
| `invalid_number` | 400 | 锁定数字不是 1–8 的整数 |
| `already_locked` | 400 | 本轮已锁定（返回已锁定的 `number`） |
| `session_not_found` | 404 | `sid` 不存在，或多个场次并行时未指定 `sid`（返回可用场次列表） |
| `session_closed` | 409 | 目标场次已关闭，拒绝入场 / 锁定 |
| `session_limit` | 409 | 进行中场次已达 4 个（返回 `max`） |
| `session_already_closed` | 409 | 重复关闭同一场次 |
| `session_name_too_long` | 400 | 场次名超过 24 字（返回 `maxLen`） |
| `session_locked` | 403 | 本机已绑定其他场次，请求的 `sid` 与绑定不符（返回 `boundSid`） |
| `session_need_unlock` | 403 | 未带有效绑定令牌，且当前有 ≥2 个进行中场次，需先过口令 |
| `bigscreen_unauthorized` | 403 | 请求了 `view=bigscreen` 却未带有效员工 token（大屏会看到未开奖的选项，不对玩家开放） |
| `unlock_password_required` | 403 | `auto` 绑定仅在唯一进行中场次时允许，多场时被拒 |
| `player_wrong_password` | 401 | 场次口令错误（超过 5 次后返回 429，见下） |
| `player_too_many_attempts` | 429 | 该来源 IP 连续 5 次口令错误，锁 30 秒（返回 `retryAfter`） |
| `bad_date_range` | 400 | `date` / `from` / `to` 不是合法的 `YYYY-MM-DD`（含 `2026-02-31` 这类不存在的日期） |
| `bad_level` | 400 | `level` 不是 `detail` / `round`（`member` 已移除：不做跨场汇总） |
| `archive_write_failed` | 409 | 本轮尚未成功写入归档，拒绝「开始新一轮」（避免抹掉唯一留痕） |
| `round_changed` | 409 | 开新一轮时发现轮次已被别的实例推进（返回当前 `round`），本次不再重复清场 |
| `write_conflict` | 409 | 同一场次连续多次提交都撞上版本冲突（正常流量下不会出现，见 9.5 并发控制） |
| `write_failed` | 500 | 状态写库失败（连接中断等），本次变更未生效 |
| `create_failed` | 500 | 新建场次时数据库写入失败 |
| `internal_error` | 500 | 未预期的服务端异常 |

### 7.3 对账 CSV 列头契约

**列的顺序就是契约**：下游按位置或列名解析，改列名 / 插列等于破坏对账。要加字段只能追加到末尾。

`level=detail`（一人一轮一行，跨场次全量；按会员号 → 锁定时间排序，同一人的跨场记录连续）：

```
场次ID,场次名称,场次序号,轮次号,开奖数字,开奖单双,锁定时间,归档时间,
会员号,预测单双,预测数字,是否提交,单双命中,数字命中,登记时间,提交时间
```

`level=round`（一轮一行，含 0 人轮次）：

```
场次ID,场次名称,场次序号,轮次号,开奖数字,开奖单双,锁定时间,归档时间,扫码人数,提交人数
```

格式约定：

- 时间列一律为运营时区（`ARCHIVE_TZ_OFFSET_MIN`）下的 `YYYY-MM-DD HH:mm:ss`，**不带偏移后缀**，跨时区使用请自行按列头口径换算
- `是否提交`：`是` / `否`；`单双命中` / `数字命中`：`命中` / `未中` / `未提交`
- **没有任何积分、总分、命中率列**：明细只给逐次匹配结果，跨场不做合并；某会员当天参与几场就看他有几行
- 含逗号 / 引号 / 换行的字段会被标准 CSV 双引号包裹（会员号来自二维码原文，可能出现任意字符）
- ⚠️ 会员号是**原文**，不做公式转义：若某个 ID 以 `=` `+` `-` `@` 开头，Excel 可能当成公式。对账请按文本导入，或用 `level=round` 做人数交叉校验

`/api/archive/summary` 返回结构：

```json
{
  "ok": true,
  "date": "2026-11-20",
  "from": 1795104000000,
  "to": 1795190400000,
  "tzOffsetMin": 480,
  "sessions": 2,
  "rounds": 4,
  "members": 4,
  "entries": 5,
  "submitted": 4,
  "predictedMembers": 3,
  "bySession": [
    { "sessionId": "main", "sessionName": "第 1 场", "sessionSeq": 1,
      "rounds": 2, "entries": 4, "submitted": 3, "members": 3,
      "firstLockedAt": 1795164313825, "lastLockedAt": 1795164313898 }
  ]
}
```

---

## 8. 数据模型

启动时 `initDb()` 幂等建表（`CREATE TABLE IF NOT EXISTS`），**只负责建出缺失的表，不做任何结构迁移**：表结构以本文档与 `db.js` 的定义为唯一基准，库结构与代码不一致时需先手工对齐 DDL 再启动。

| 表 | 内容 | 写入策略 |
|---|---|---|
| `game_session` | 场次实体：ID、名称、状态（open/closed）、显示序号、创建/关闭时间 | 随快照提交 upsert |
| `session_state` | 每个场次一行：**状态版本号** + 最近提交时间（多实例乐观锁凭据） | 提交事务里 `version + 1`（CAS） |
| `round` | 每个场次一行：当前轮次、开奖数字、锁定时间（**主键 `session_id`**） | 按场次 upsert |
| `player` | 本场次本轮每个玩家的登记与预测（**主键 `(session_id, id)`**）；`left_at` 为大屏用的离开标记，null = 在场 | 批量 `unnest` upsert + 删除快照里不存在的行 |
| `identity` | 场次内跨轮次身份档案：最近出现轮次、已完成轮次数（**主键 `(session_id, id)`**） | 批量 `UPSERT`，不删除，跨轮保留 |
| `round_archive` | 竞猜归档表头：一轮一行，场次快照 + 轮次号 + 开奖数字 + 锁定时间 + 人数统计（唯一键 `(session_id, round)`） | 只 `INSERT`，重复轮次跳过 |
| `round_archive_entry` | 归档明细：一人一行，会员号 + 预测内容 + 命中结果（主键 `(archive_id, member_id)`） | 只 `INSERT`，重复行跳过 |
| `app_config` | 键值配置，目前只存 `player_bind_secret`（绑定令牌签名密钥） | 首次启动生成后 upsert |
| `staff_session` | 员工登录会话：token、当前归属场次、过期时间（**跨实例共享**） | 登录插入，过期按需清理 |
| `auth_throttle` | 登录 / 场次口令错误计数：`key` = `staff` 或 `player:<ip>` | 原子 upsert，验证通过即删 |

**口令不在任何表里**：玩家端口令只在进程内存保留 `scrypt(口令, 随机盐)`，启动时由 `PLAYER_SESSION_PASSWORD` 重新计算；数据库、日志、接口响应都没有它，签名密钥则是另一回事（随机、不可反推口令）。

时间戳统一为毫秒级 `BIGINT`，与代码里的 `Date.now()` 语义一致。`identity.completed_rounds` 在每次开奖时对已提交预测的玩家 +1，这是「老玩家」判定的唯一依据。

同一会员号可以同时存在于多个场次（各场次是独立记录），因此 `player` / `identity` 的主键是 `(session_id, id)`；空库首次启动时由 `bootstrapSessions()` 建出第一个场次（ID 固定为 `main`，员工与玩家链接可长期复用）。

所有写操作按场次走一次事务：`BEGIN` → 抢版本号（CAS）→ 写 `game_session` / `round` / `player` / `identity` → 归档段（`SAVEPOINT`）→ `COMMIT`。玩家的写入从「一 人一条 SQL」改成「一次 `unnest` 批量 upsert + 一条删除」，单次提交固定为 4–5 条语句，锁持有时间不再随人数线性增长。

**归档表与运行态表是两套东西。** `round` 只留一行、`player` 每轮被清空，它们是「当前一轮」的可变快照；`round_archive` / `round_archive_entry` 是一轮结束后的只增不改留痕。两者的写入点在同一个事务里（`db.commitSnapshot` → `archiveRoundInTx`），归档段用 `SAVEPOINT` 单独包住，并有三重保护：

1. 归档行只在 `number` 与 `lockedAt` 都有值时写入，未锁定的轮次不留痕
2. 唯一键 `(session_id, round)` + `ON CONFLICT DO NOTHING`：重复保存不产生第二份，也不改写既有行
3. 数据库触发器 `archive_block_mutation()`：`UPDATE` / `DELETE` / `TRUNCATE` 直接抛异常，绕过应用层也改不了历史

因此 `reset` 之后的「开始新一轮」不会影响任何已归档数字：当天聚合的轮次数只会随新的锁定增加。

---

## 9. 部署

### 9.1 Docker

```bash
docker build -t oddeven .
docker run -d --name oddeven -p 3000:3000 \
  -e STAFF_PASSWORD='your-password' \
  -e PLAYER_SESSION_PASSWORD='your-session-passcode' \
  -e DATABASE_URL='postgres://user:pass@db.example.com:5432/postgres?sslmode=require' \
  oddeven
```

`PLAYER_SESSION_PASSWORD` 是玩家选择 / 切换场次用的口令（不设置则回退到默认值 `8888`，启动日志会提示）。它只在内存里以 scrypt 哈希存在，改口令 = 改环境变量 + 重启，无需迁移数据。

镜像为多阶段构建，`.dockerignore` 已排除 `node_modules`、`.git`、`.env`、`test`。

### 9.2 Fly.io

```bash
fly secrets set \
  STAFF_PASSWORD='your-password' \
  PLAYER_SESSION_PASSWORD='your-session-passcode' \
  PG_HOST=your-db-host \
  PG_USER=your-db-user \
  PG_PASS='your-db-password' \
  PG_PORT=5432 \
  PG_DB=postgres

fly deploy
```

- `fly.toml` 中的 `app` 名与 `primary_region` 需按自己的应用改
- 配置为 `min_machines_running = 0` + `auto_stop_machines = 'stop'`：无流量时机器会被停掉。**现场活动期间建议改为 `min_machines_running = 1` 并关闭自动停机**，否则冷启动会让玩家端的 SSE 连接整体断一次
- GitHub Actions（`.github/workflows/fly-deploy.yml`）在推送 `main`/`master` 时执行 `flyctl deploy --remote-only`，需要仓库 secret `FLY_API_TOKEN`

### 9.3 反向代理注意事项

- SSE 长连接不能被缓冲：服务端已下发 `X-Accel-Buffering: no`，Nginx 侧仍需确认 `proxy_buffering off`、读超时大于 15 秒心跳间隔
- 玩家端扫码依赖摄像头，必须走 HTTPS（`force_https = true` 已覆盖 Fly.io）

### 9.4 多场次并行（1–4 场）

**推荐：单实例多场次。** 起一套实例，员工端「新建场次」即可加场，切换/关闭都在页面内完成，不碰配置、不重启：

- 员工登录后默认归属某一场次；场次条显示当前场次与状态，顶栏「切换场次」可随时切换（新建 / 关闭 / 大屏 / 对账在管理界面 `/admin`）
- 每个场次的 `round` / `player` / `identity` 独立、SSE 只推给本场客户端；关闭一场不影响其他场次
- 已关闭场次从玩家端与员工端切换列表同时消失、无法再进入；数据保留在归档表，可在管理界面「当日对账」导出回看

可选：**按场次分别部署**（不同门店、彼此不相关的场景）。每场一套实例 + 独立数据库（不同 `DATABASE_URL`，或同一 Postgres 上换 `PG_DB`），入口地址分开。

⚠️ 同一套 `DATABASE_URL` 起多个实例是受支持的（见 9.5），但要注意 SSE 连接与 `LISTEN` 通道的部署约束。

### 9.5 多实例（水平扩容）

同一套 `DATABASE_URL` 起多个实例（多副本 / 多机 / 滚动发布）是**受支持**的：进程内不再持有任何权威状态，所有可变数据都在 Postgres，跨实例的变更通过 `LISTEN/NOTIFY` 通知。

**三个关键机制**

| 问题 | 机制 | 代码 |
|---|---|---|
| 会话丢失 / 各实例状态不一致 | Postgres 是唯一事实来源；进程内只有读缓存（TTL 5s，通知到达即失效） | `store.js`、`db.loadSessionSnapshot` |
| 状态变更不同步 | 每次提交后 `pg_notify` 一条 `{type,sid,version}`；收到通知的实例重新读库、比对版本、广播给本机 SSE 连接 | `pubsub.js`、`store.applyRemote` |
| 同一资源的并发写被覆盖 | 提交事务先做 `UPDATE session_state SET version = version + 1 WHERE session_id=$1 AND version=$2`；更新不到行即视为冲突，整体回滚、重新读最新快照后重跑业务逻辑（最多 6 次） | `db.commitSnapshot`、`store.mutate` |

**并发控制策略细节**

- **乐观锁（主路径）**：`session_state.version` 是唯一凭据。CAS 成功才允许写 `round` / `player` / `identity`，所以后写的实例一定基于最新版本重算，不会用旧快照盖掉别人的改动。版本号同时用作 SSE 的 `Last-Event-ID`，跨实例单调递增。
- **串行化（仅用于全局不变量）**：新建场次的「数上限 + 分配序号 + 插入」放在 `pg_advisory_xact_lock` 内，两台实例同时点「新建」既不会超卖 4 场，也不会撞序号；归档补写用另一把 advisory lock，避免同一轮被并发补写。
- **业务级幂等 / 意图校验**：重复扫码、重复提交预测、重复开新一轮，都在 mutator 里基于最新快照判断；`reset` 额外核对「轮次号 + 锁定时间」，两个实例同时点「新一轮」只有一个生效，另一个得到 `round_changed`。
- **员工会话与限频落库**：`staff_session` / `auth_throttle`，所以 A 实例签发的 token 在 B 实例有效、重启也不掉登录；「连续 5 次错锁 30 秒」是全局口径，不会因为副本数变成 5×N 次。

**部署注意**

- **不要把 `LISTEN/NOTIFY` 接到事务级连接池**（如 pgbouncer `pool_mode=transaction`）：`LISTEN` 要求连接长期归属同一会话，事务池会在语句之间换连接。用 session 池或直连。
- **SSE 连接由各实例各自持有**：不需要粘性会话（客户端连任意实例，写入都会广播回来），但容量规划要按「总连接数 / 实例数」算单机连接数。
- **通知是尽力而为**：消息丢失不会导致状态错误——接收方收到提示后一律回库读；通知全丢时读缓存 TTL（5s）兜底，重连成功后 `store.resync()` 再全量对齐一次。
- **滚动发布**：新旧实例可短暂共存（协议只有通道名 + `{type,sid,version}` 三个字段）。换通道名等于换协议，需同时升级所有实例。
- **健康检查**：任何实例的 `/api/sessions` 都反映集群真实场次列表，可直接用作存活探针。


---

## 10. 开发与测试

### 10.1 自动化测试

```bash
npm test                                  # 用 Docker 起临时 postgres:16-alpine，跑完自动删容器
TEST_DATABASE_URL=postgres://... npm test # 复用已有库，不碰 Docker
```

覆盖范围（30 个用例，跑真实 `server.js` + 真实 Postgres，不 mock 业务逻辑）：

| 文件 | 覆盖 |
|---|---|
| `test/archive.test.mjs` | 登录/口令/扫码/预测的全部错误码；锁定与归档同事务；当日聚合口径（场次/轮次/去重人数/命中）；`detail`/`round` 两种 CSV 的列头、转义、命中判定，以及已移除的 `member` 口径返回 400；`reset` 不清归档；0 人轮次口径；跨场次分账与 `sid` 筛选；日期区间与非法日期；接口鉴权；append-only 触发器拒绝 UPDATE/DELETE/TRUNCATE |
| `test/archive-failure.test.mjs` | 归档表不可写时锁定仍生效且返回 `archived:false`；`reset` 被 409 拦住；恢复后 `archive-sync` 幂等补齐；重启自动回填「已锁定但未归档」的轮次 |
| `test/multi-instance.test.mjs` | 两个真实进程共用一个库：员工 token 跨实例有效、A 写入 B 立刻可读、并发提交预测/并发锁定/并发开新一轮只有一个成功、场次上限是集群口径、A 的变更推到 B 的 SSE、A 关闭场次时 B 收到 `session_closed`、实例重启后登录态仍在 |

注意：

- 测试会 `DROP SCHEMA public CASCADE`，**`TEST_DATABASE_URL` 绝不能指向有数据的库**；
- 两个测试文件共用一个 schema，入口固定 `--test-concurrency=1` 串行执行；
- 失败路径测试会临时改名归档表、禁用触发器来制造故障，属测试专用，生产代码没有这些操作。

仍建议手工验证的部分（自动化尚未覆盖）：SSE 实时推送与断线重连、双设备一致性、三语界面、扫码相机权限。

---

## 11. 已知限制与注意事项

**部署形态**

- **场次维度已就绪，跨场汇总已落地。** `game_session` + 三张运行态表的 `session_id` 与归档表的 `session_id` 一致，1–4 场可在同一集群内隔离运行并动态开闭；当日聚合、对账导出都按 `session_id` 自动分账。
- **场次口令是「一个」而不是「一场一个」。** 所有场次共用 `PLAYER_SESSION_PASSWORD`；它拦的是「随便乱换场次」，不构成场次机密（知道口令的人可以进任何一场）。要按场发不同口令，需要给 `game_session` 加口令哈希列，见「12. 待办」。
- **玩家绑定是「防误换」而非强身份认证。** 令牌绑定场次、不可跨场，但任何人拿到这台设备即可沿用其绑定继续玩（与扫码身份同一台设备的既有模型一致）；令牌 12 小时过期，口令本身从不落地，所以清掉 localStorage 只会退回选择界面，仍需口令才能重新进场。
- **令牌走查询参数。** SSE（EventSource）无法自定义请求头，所以员工 token 与玩家绑定令牌都以 `?token=` / `?ut=` 传递，会进访问日志。反向代理层建议关闭查询串记录，或改走 Cookie。令牌都不含口令，泄露影响是「可读该场次状态」，不能改口令、不能跨场。
- **没有人数上限校验。** 单场 6–12 位是运营约定，服务端不拦；人数越多，每次状态变更的写放大与全量广播开销越大，延迟随人数线性上升。同时进行的场次上限为 4（`MAX_SESSIONS`），超出会被拒。
- **支持多实例（水平扩容）。** 会话、员工登录态、限频全部在 Postgres，跨实例变更走 `LISTEN/NOTIFY`，写入用 `session_state.version` 乐观锁 + 全局 advisory lock 串行化（详见 9.5）。仍有的边界：`LISTEN` 不能走事务级连接池；SSE 连接是每实例各自的（不需要粘性会话）；进程内读缓存 TTL 5 秒，通知全丢时最坏有 5 秒延迟；同时进行的场次上限 4 是**全集群**口径。
- **员工会话重启不再丢失（行为变化）。** 会话落在 `staff_session`，有效期 12 小时；这是多实例的硬要求（A 签发的 token 必须能被 B 认）。要立刻下线某人只能等过期或清表；如需「踢人」能力，应补一个管理接口删会话行。
- 托管库强制 TLS 时只能通过 `DATABASE_URL` 加 `sslmode`；`PG_*` 分支无法附加 TLS 参数。

**数据**

- **历史轮次只保留归档快照，不是运行态。** 每轮锁定即写入 `round_archive` / `round_archive_entry`，事后可复盘「某一轮谁猜了什么、中了没有」；但归档存的是**锁定那一刻**的会员号与预测原文，玩家后续的行为变化不会回写，且归档表禁改禁删（要更正只能追加新记录）。`reset` 之前的未锁定轮次（字都没录）不留痕，这是有意的。
- **归档一旦写失败会拒绝开新一轮。** `reset` 在清空前会强制归档落定，失败返回 409 `archive_write_failed`；锁定接口则返回 `archived:false` 并保持锁定（重按只会得到 `already_locked`），需要用 `POST /api/archive-sync` 补齐。
- **`archive-sync` 只能补「还在内存里的已锁定轮次」。** 若某轮既没归档又已经被 reset，那就真的没有明细了——这种情况被上面的 409 拦住，正常流程不会发生。
- **归档表没有分区与归档清理。** 单场一天几十轮、每轮十来人，量级很小；长期运行（数千场次）后建议按 `locked_at` 做月分区或冷备导出，目前没有实现。
- 玩家 ID 未做加密或哈希，直接以会员号明文入库并与 `identity` 关联。
- 写库是「抢版本号 + 快照重写」（`db.commitSnapshot`），多实例安全；但同一场次的写入仍是**整场快照**语义，玩家数很多时单次提交成本随人数上升（已从「一人一条 SQL」优化为批量 `unnest`）。
- 写失败不再静默：`store.mutate` 会丢弃脏缓存并让接口返回 `write_failed`（锁定路径还会区分为「已锁定但未归档」），不会出现「页面显示成功、库里没有」。
- 员工登录态现在落库（`staff_session`），过期由读取时顺手清理，没有后台定时任务；要立即使某人失效只能删表行或等 12 小时过期。
- 密码错误计数虽已按 `staff` / `player:<ip>` 分开，但员工侧仍是**全局计数**：任何人连错 5 次都会把所有人锁在门外 30 秒。
**安全**

- 默认口令只适合本地演示（见 5.1 环境变量），上线前必须用 `STAFF_PASSWORD` / `PLAYER_SESSION_PASSWORD` 覆盖。
- 员工权限只有"能登录/不能登录"，无角色与操作审计。
- 玩家身份没有任何校验：任意字符串（≤512 字符）都能注册成身份，知道别人会员号即可抢先占用。
- 静态资源与 API 响应均为 `Cache-Control: no-store`。

---

## 12. 待办

以下是已确认需要做、但当前代码尚未实现的事项（原第 1 项「结算归档与跨场次汇总对账」已完成，见 6.6 / 7.3 / 第 8 节）：

1. **测试补齐与 CI 接入**：`test/` 已覆盖归档与对账主流程、故障路径、聚合口径、append-only，以及多实例共享存储 / 跨实例 SSE / 并发写（见 10.1），仍缺：SSE 重连时的 `Last-Event-ID` 对齐、身份跨轮累计的独立用例；`.github/workflows/` 目前只有部署，尚未在部署前跑 `npm test`。
2. **玩家 ID 入库前加密**：引入密钥对（公钥加密 / 私钥解密，密钥经环境变量注入），对 `player.id`、`identity.id`、归档表的 `member_id` 及展示用的会员号做加密处理，并配套密钥轮换方案；同时评估现有数据的迁移与清理。注意这与对账口径有冲突，需先定“对账按什么标识”再落加密（归档表是 append-only，加密后历史行不会回写，只能在导出层解密）。
3. **数据库 TLS 配置化**：在 `Pool` 配置里支持显式 ssl 选项，使 `PG_*` 分支也能启用 TLS，不依赖连接串参数。
4. **多实例支持**：遗留项：归档表读多写多之后可考虑读副本；`store` 读缓存目前是进程内 LRU-less Map，场次数长期增长后需要加容量上限。
5. **直播大屏**：更改美化格式。
6. **中奖动画**：开奖后在玩家端显示中奖内容。
7. **独立密码**：为切换员工场次、切换玩家场次、员工登入、管理登入等不同场景提供独立密码。在管理界面中为员工创建账号，并为每个账号设置独立密码，员工登入时使用自己的账号和密码进行身份验证。汇出对账时，员工账号也会被记录在日志中，以便追踪操作记录。
8.  **归档表分区与冷备**：按 `locked_at` 做月分区或定期导出后归档到对象存储，避免长期运行后单表无限增长。

---

## 13. 相关文档

- `DEPLOY.md`：数据库连接串、表结构说明与 Fly.io 部署步骤（配合本文第 5、9 节阅读）
