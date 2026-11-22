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
| 预测 | 点选即上报（500ms 合并、值变才发），大屏实时显示「待确认」；按「确认提交」才落库、不可修改；草稿只存进程内存，不落库、不推进版本号。数字范围 **0–9（含 0 和 9）**，`0` 按「双」判定 |
| 开奖 | 工作人员在员工端点选 0–9 并确认，确认即锁定，不可更改 |
| 轮次 | 锁定后由工作人员手动开启新一轮，轮次号 +1 |
| 场次 | 全集群并行 1–4 场；员工登录默认归属一场，可运行时新建 / 切换 / 关闭，状态按场次隔离，SSE 按场次分组推送 |
| 玩家场次口令 | 多场并行时，玩家选择 / 切换场次必须输入口令；验证后绑定 12 小时，刷新、重开页面、后续操作都固定在该场次，未再次验证不可切换 |
| 员工场次口令 | 员工「切换场次 / 新建场次」需输入独立口令（默认 `7777`，`STAFF_SESSION_PASSWORD` 覆盖）；管理员免校验。与登录密码、玩家口令三者互不复用 |
| 身份档案 | 跨轮次累计每人完成的竞猜轮次数，用于区分「新玩家 / 老玩家」 |
| 实时同步 | 落库变更经 SSE 全量快照广播到全部在线页面，含开奖瞬间；草稿变更按 500ms 合并成 `draft` 补丁；断线重连后全量对齐，玩家端按本地序号补发最后一次选择 |
| 管理界面 | `/admin` 七个入口：当日对账、大屏、新建场次、关闭场次、员工账号、操作日志、奖品设置；仅 `admin` 角色可进 |
| 规则版本 | 奖品四档 + 特殊数字作为一整套规则按版本落库（append-only，一次保存 = 一版，内容不变不新增）；**场次在创建时锁定版本**，改规则不影响正在进行的场次，只有之后新建的场次才用新规则；对账表记录每轮用的是哪一版 |
| 实时大屏 | `/bigscreen` 按场次实时展示每位玩家的当前选项（单/双 + 数字），三态区分「已确认 / 已选待确认 / 未选择」（待确认用虚线边框），另标新加入 / 已离开；与员工端共用 SSE 广播与场次版本号，草稿走独立 `draft` 补丁事件，过期帧直接丢弃 |
| 多语言 | 简体中文 / 繁体中文 / 英文，切换结果按端独立记忆（localStorage） |
| 员工账号 | 一人一账号一独立密码，由管理员在管理界面创建 / 改密 / 停用；密码只存 scrypt 派生值，接口不下发 |
| 员工鉴权 | 账号 + 密码 → 会话 token（12 小时），按账号限频（5 次失败锁 30 秒）；停用或改密立即踢掉该账号所有会话 |
| 玩家端口令 | 口令只以 scrypt 哈希存在于进程内存，不落库、不下发；验证通过后签发 HMAC 绑定令牌，按来源 IP 限频（5 次错误锁 30 秒） |
| 操作日志 | 登录 / 失败 / 退出、切场次、锁定开奖、新一轮、关闭场次、账号增改密、对账导出、日志导出全部落库；append-only，可按天查看与导出 CSV |
| 持久化 | Postgres，运行态 / 归档 / 规则版本 / 账号会话全部落库，首次启动自动建表（新增列幂等补齐），重启后状态保留 |

---

## 2. 项目结构

```
.
├── server.js              # HTTP 服务：静态文件、API、SSE 广播、员工会话
├── store.js               # 共享会话存储：读缓存 + 乐观锁提交 + 变更事件
├── pubsub.js              # 跨实例状态通知（Postgres LISTEN/NOTIFY，断线重连）
├── db.js                  # Postgres 连接池、建表、快照读写、归档、账号、审计、会话与限频
├── public/
│   ├── index.html         # 玩家端（扫码 / 预测 / 等待 / 结果）
│   ├── staff.html         # 工作人员端（登录 / 录入数字 / 结算表 / 开新轮 / 切换场次）
│   ├── admin.html         # 管理界面（当日对账 / 大屏 / 场次管理 / 员工账号 / 操作日志）
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

export ADMIN_PASSWORD='换成你自己的管理员密码'      # 首次启动创建管理员用
export DATABASE_URL='postgres://postgres:postgres@localhost:5432/oddeven'
npm start
```

启动日志会打印入口：

```
单双竞猜已启动: http://localhost:3000/  (玩家端，进入后扫自己的二维码)
工作人员端入口: http://localhost:3000/staff （账号 + 密码登录）
管理界面入口: http://localhost:3000/admin
数据持久化: Postgres（连接串来自 DATABASE_URL，池上限可用 DB_POOL_MAX 覆盖）
```

首次启动会用 `ADMIN_USERNAME`（默认 `admin`）/ `ADMIN_PASSWORD` 建一个管理员账号；**只在库里没有任何管理员时生效**。没设 `ADMIN_PASSWORD` 时用内置默认 `123456`，启动日志会警告——**任何对外可访问的环境都必须覆盖它，并在登录后立刻改掉**。后续员工账号一律在管理界面「员工账号」里创建。

---

## 5. 配置

### 5.1 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | HTTP 监听端口 | `3000` |
| `ADMIN_USERNAME` | 首次启动创建的管理员账号名（仅当库里没有任何管理员时生效） | `admin` |
| `ADMIN_PASSWORD` | 首次启动创建的管理员密码 | `123456` |
| `STAFF_SESSION_PASSWORD` | 员工「切换场次 / 新建场次」口令（管理员免校验） | `7777` |
| `DATABASE_URL` | Postgres 连接串（**唯一的连接配置来源**） | 本地兜底 `postgres://postgres:postgres@localhost:5432/oddeven` |
| `DB_POOL_MAX` | 连接池上限 | `5` |
| `ARCHIVE_TZ_OFFSET_MIN` | 归档对账的「当日」时区偏移（分钟，东八区填 `480`） | `480` |

连接串解析（`db.js`）：

1. `DATABASE_URL`
2. 未设置时用本地兜底 `postgres://postgres:postgres@localhost:5432/oddeven`

**不再支持** `PG_HOST` / `PG_USER` / `PG_PASS` / `PG_PORT` / `PG_DB` / `PG_URL` 等拆开写法（旧值留着也不再读取）；用户名密码里的 `@` `:` `/` 等字符请在连接串里做 URL 编码（`encodeURIComponent`）。

本地没有默认库且未设 `DATABASE_URL` 时，启动会打印 `[db] 数据库初始化失败，应用无法启动` 并退出（`exit 1`），不会带着空状态继续跑。

### 5.2 数据库 TLS

TLS 由 `db.js` 的 `sslOption()` 统一判定，连接串里写 `sslmode` 即可：

```bash
export DATABASE_URL='postgres://user:pass@db.example.com:5432/postgres?sslmode=require'
```

| 连接串写法 | 实际行为 |
|---|---|
| 不带 `sslmode`，主机 `*.supabase.com` | 加密、不校验证书（默认） |
| `sslmode=require` / `prefer` / `no-verify` | 加密、不校验证书 |
| `sslmode=verify-full` / `verify-ca` | 加密 + 严格校验证书链 |
| `sslmode=disable` 或本地非托管主机 | 明文 |

`sslmode` 会被从连接串里摘出来单独处理（`pg` 8.23 起把 `require` 当 `verify-full`，对 Supabase pooler 的自签证书链会直接报错）。因为没有拆开写法的分支，TLS 配置只有连接串这一个入口。

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
3. **点选与确认**：点「单 / 双」与 0–9 数字（含 0 和 9，`0` 算「双」）时即刻上报（500ms 合并，值变才发），大屏马上显示「已选待确认」；点「确认提交」才落库，之后不可修改、不可重复提交。只选不确认 = 未参赛，锁定后作废。
4. **等待开奖**：页面显示已提交的预测，状态条提示等待中；开奖数字在锁定前不会下发给任何客户端。
5. **工作人员锁定**：员工端登录 → 点选 0–9 → 若仍有玩家未提交会先弹提示 → 二次确认 → 锁定并广播结果。
6. **查看结果**：员工端展示逐人命中表（单双命中、数字命中）；玩家端展示开奖数字与自己两项预测的命中情况。
7. **开启新一轮**：员工端「开始新一轮」→ 轮次 +1、本轮玩家清空、跨轮身份档案保留；玩家需重新扫码登记。

### 6.3 玩家端状态

| 状态 | 含义 | 页面表现 |
|---|---|---|
| 选择场次 | 没有本机绑定，且同时进行 ≥2 场（或原场次已关闭） | 显示场次列表；点选后弹出口令输入框 |
| 未登记 | 无本地身份，或新一轮已开始 | 显示扫码卡片 |
| 已登记 | 已识别身份，未提交预测 | 显示预测卡片 |
| 等待开奖 | 已提交，本轮未锁定 | 显示等待动画与自己的预测 |
| 已开奖 | 本轮已锁定 | 显示开奖数字、单双/数字两项命中判定，以及按命中组合对应的奖品文案 |

身份有效性以服务端返回的 `me` 为准：新一轮开始后 `me` 变空，本地保存的身份自动清除，需重新扫码。

登记成功（登录）后自动展示一次玩法说明：10 秒倒计时，页面最底部一条细进度条随剩余时间收缩，卡片内同时显示剩余秒数；点击任意区域立即关闭，超时自动关闭。关闭后遮罩 `display:none`，不拦截后续点击。触发条件只有「登记成功」且同一身份每次页面只触发一次，因此刷新、SSE 重连、状态推送都不会重放；切到后台会暂停计时，回到前台接着算。仅玩家端加载该层，员工端与大屏不受影响。

场次绑定的优先级高于一切入口参数：本地已有绑定（`oe_bind`）时，连 `?s=` 也不会把它切走；想换场次只能点「切换场次」→ 选场次 → 输口令。只有 1 场进行中时免口令，且仍会写入绑定，避免之后开出第二场时被判为「需要重选」。

### 6.4 工作人员端

只有一件事：把这一场跑完。管理动作不在这一页。

- **登录 = 账号 + 自己的密码**。账号由管理员在管理界面创建，一人一份；顶栏会显示当前账号的显示名
- 登录态存 `sessionStorage`，关闭标签页即失效；服务端会话 12 小时过期
- 顶栏右侧：**管理**（只有 `admin` 角色可见，跳 `/admin`）与**切换场次**
- 「本轮概况」实时显示已扫码人数与已提交人数
- 玩家列表用颜色区分新玩家（蓝）与老玩家（金）
- 每个状态变更都会实时刷新，无需手动刷新页面
- 场次条只展示当前场次名称与状态，页面上没有任何新建 / 关闭 / 对账 / 大屏入口

**「切换场次」与玩家端同一套交互**：点顶栏胶囊按钮 → 页面就地展开「选择场次」卡片，其余内容暂时收起；选项整行可点（名称 + 轮次/状态/人数），当前场次打勾（✓）、其他场次显示 `›`；选中后弹出**场次口令**输入层，验证通过才切换，并 toast「已切换到「X」」，卡片自动收起。切换期间按钮自身隐藏，卡片底部给出「取消切换」，取消即原样退回原场次。

场次口令是**场景级凭据**，与登录密码、玩家口令互不复用：员工每次切场次（以及新建场次，因为建完会顺带切过去）都要输一次；连续 5 次错误锁 60 秒，按账号计数（跨实例同一口径），错误尝试会写进操作日志。管理员免校验——场景口令约束的是员工操作，管理员登录本身已是最高凭据。

### 6.5 管理界面（`/admin`）

七个入口，一格一件事，进入后不再叠其他卡片：

| 入口 | 行为 | 前置条件 |
|---|---|---|
| 当日对账 | 就地在页内展开：日期选择（默认今天）+ 场次/已归档轮次/去重人数 + 两种 CSV 下载，带「返回」 | 无 |
| 大屏 | 新窗口打开 `/bigscreen?token=&sid=`（令牌从地址栏抹掉后只存本地；无令牌同样能打开） | 无（有进行中场次才有数据） |
| 新建场次 | 弹窗输入名称（留空自动命名）→ 创建并自动切到新场次，toast 确认 | 进行中场次 < 4 |
| 关闭场次 | 二次确认（红色危险弹窗）→ 关闭当前归属场次，玩家端立即断开 | 当前场次必须是进行中 |
| 员工账号 | 建号 / 改显示名 / 调角色 / 停用 / 重置密码；一人一账号一密码 | 无 |
| 操作日志 | 按天（默认今天）列出所有操作：时间、账号、动作、对象、场次、IP；可导出 CSV | 无 |
| 奖品设置 | 四档结果（数字和单双都中 / 只中数字 / 只中单双 / 未猜中）各配一份「奖品名称 + 说明」，另配全员额外奖励（特殊数字 + 文案）；保存即新增一个规则版本，页面顶部显示「当前规则版本 vN」，**只对之后新建的场次生效** | 无 |

**只允许 `admin` 角色进入。** 员工账号登录 `/admin` 会被挡回登录页并提示需要管理员账号；管理侧接口（对账、账号、日志）在服务端同样只认 `admin`，前端隐藏不是唯一防线。

**员工账号规则：**

- 账号名 2–32 位，只允许 `a-z 0-9 . _ -`，统一小写（`Mary` 与 `mary` 是同一个账号）；密码 6–64 位，且不能与账号名相同
- 密码只存 `scrypt$N$r$p$salt$hash` 派生值，任何接口都不返回它，日志里也不会出现
- 两条硬规则：不能停用自己；不能把最后一个可用管理员降级或停用（否则谁都进不去）
- 停用账号、重置密码、变更角色都会立刻踢掉该账号的所有会话，不等 token 到期
- 初始管理员由 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 在**首次启动**时创建；之后改环境变量不会覆盖库里的密码，改密码请走管理界面

- 登录态与员工端共用：从员工端点「管理」是同标签页跳转，直接复用那份 token；独立打开/收藏夹进入则需输一次管理员账号密码，或带 `?token=` 预置（页面立刻 `history.replaceState` 抹掉）。令牌同时写 `sessionStorage`（员工端）与 `localStorage`（独立打开用），员工端「退出登录」会把两份一起清掉
- 不做实时推送：进页面、切回前台（`visibilitychange`）、每次操作成功后各刷一次场次列表与对账数字
- 场次相关的能力边界与员工端一致：全集群 4 场上限、只能关自己当前归属的场次、已关闭场次不可再进

### 6.5.1 操作日志（审计）

| 动作 `action` | 触发点 | 关键字段 |
|---|---|---|
| `login` / `login_failed` / `logout` | 登录成功、登录失败（含原因：无此账号 / 已停用 / 密码错）、退出 | 账号、角色、IP |
| `session_create` / `session_select` / `session_close` | 新建 / 切换 / 关闭场次 | 场次名、sid、切换前场次 |
| `switch_denied` | 场次口令错误 | 账号、IP |
| `round_lock` | 锁定开奖数字 | 数字、轮次号、是否归档成功、本轮所用 `ruleVersion`、是否命中特殊数字 |
| `round_reset` | 开始新一轮 | 原轮次 → 新轮次、当时是否已锁定 |
| `export_archive` / `export_audit` | 导出对账 CSV / 导出日志 CSV | 口径 level、日期区间、行数 |
| `account_create` / `account_update` / `account_password` | 建号 / 改角色状态 / 重置密码 | 目标账号、变更前后 |
| `archive_sync` | 归档补齐 | 检查轮次数、失败数 |
| `prize_config` | 保存四档奖品文案 | 四档文案快照（`detail.tiers`）+ `ruleVersion` + `created`（是否真的新增了一版） |
| `bonus_config` | 保存特殊数字与全员额外奖励文案 | 特殊数字 + 文案快照（`detail.{number,title,desc}`）+ `ruleVersion` + `created` |

- 表是 **append-only**：`UPDATE` / `DELETE` / `TRUNCATE` 在数据库层被触发器拒绝（与归档表同一套机制）
- 每条记录都带操作账号与角色；未登录的失败尝试记「尝试的账号名」，不记任何密码
- 「锁定人」落在 `round.locked_by` 与 `round_archive.locked_by`，两种对账 CSV 都有这一列（空值 = 无记录）；其后的「规则版本」列来自 `round_archive.rule_version`

### 6.6 竞猜归档与当日对账

**归档（append-only）。** 工作人员点「确认并锁定」的那一刻，本轮完整明细会写进归档表：

- 表头 `round_archive`：`session_id` + 场次名称/序号快照 + 轮次号 + 开奖数字 + 开奖单双 + 锁定时间 + 归档时间 + 扫码人数 + 提交人数 + 锁定人
- 明细 `round_archive_entry`：会员号 + 预测单双 + 预测数字 + 是否提交 + 单双匹配 + 数字匹配 + 登记/提交时间
- 表头带**规则版本**（`rule_version`）：记录这一轮按哪一版规则（奖品四档 + 特殊数字）发的奖，导出 CSV 的「规则版本」列就是它；版本化之前的历史行该列为空
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

**给现场看的第二块屏**：同一场次里每个人的当前选项（单/双 + 数字），玩家一点选就变，不必等确认提交。

- 入口：直接访问 `/bigscreen` 即可，**公开可见、不需要登录或口令**（现场投屏打开即看）；也支持 `?sid=` 指定场次、`?token=` 复用员工会话（仍会从地址栏抹掉，只存本地），管理界面（`/admin`）的「大屏」入口就是带上当前场次与令牌新开窗口
- 数据来源：`GET /api/stream?sid=&view=bigscreen`（带 `token` 时一并带上），与员工端、玩家端**同一条 SSE 通道**；落库变更走 `state`（带版本号），草稿走 `draft` 补丁（500ms 合并），没有额外轮询
- 权限：`view=bigscreen` 会下发开奖前的选项，**默认公开**——拿到 URL 的人都能看到，这是「免登录投屏」的代价。设 `BIGSCREEN_PUBLIC=0` 即恢复「只认有效员工 token」，匿名请求返回 403 `bigscreen_unauthorized`。无论哪种模式，玩家端自己仍走 `publicPlayers()`，开奖前拿不到任何人的选项
- 状态识别：
  - **加入** — 出现新的 `pid`（本轮首次扫码）
  - **未选择** — 已扫码但既没草稿也没提交，灰色占位卡片
  - **已选待确认** — 有草稿未提交：虚线金边框 + 阻尼金文字，状态行写「已选待确认」；这是现场最容易吵的一态（「我选了为什么不算」），视觉上必须和「已确认」明显不同
  - **选项变更** — 同一 `pid` 的选项变化（含草稿来回改），卡片闪一次金色描边；草稿走独立的 `draft` 补丁事件，不动 `version`
  - **已确认** — 点了「确认提交」：实心金边框 + 勾选态
  - **离开** — 玩家页面 `pagehide` 时用 `sendBeacon` 上报 `POST /api/leave`，卡片变灰并保留其已提交的选项；重新扫码或 SSE 重连即撤销标记（刷新、回前台都算回来）
  - **新一轮** — `round` 变化时整屏清空，只留一条「新一轮」动态，不会把上一轮的人当成离场逐个播报
- 一致性：客户端按 `version` 丢弃过期帧（重连补发、并发请求乱序都不会把旧选项盖回去），按 `pid` 增量 diff，DOM 上不会出现重复卡片；卡片数量少时自动放大、多了自动收窄
- 离开标记随 `player.left_at` 落库，服务重启后仍然有效；`reset` 清空本轮玩家时一并消失

### 6.8 开奖结果与奖品（四档）

开奖后玩家端只展示本人的结果：**开奖数字 → 单双/数字两项是否命中 → 对应档位的奖品文案**。

单双与数字是**两次独立猜测**，命中互不蕴含（猜「单」+ 数字 8，开奖 8 就是数字中、单双错），四种组合各成一档：

| 命中情况 | 档位 key | 玩家端档位标签 |
|---|---|---|
| 数字和单双都中 | `both` | 数字和单双都中 |
| 只中数字（数字对、单双错） | `number` | 只中数字 |
| 只中单双（单双对、数字错） | `oddeven` | 只中单双 |
| 两项都没中 | `miss` | 未猜中 |

- **一个玩家只显示一档**，按上面四种组合一一对应，不会出现两个奖品卡片
- 判定在前端用原始值计算（单双按开奖数字奇偶性、数字按相等），与界面语言无关，避免「单/單」字形差异造成误判
- 文案由管理界面「奖品设置」维护（`GET/POST /api/prize-config`）。四档文案与「特殊数字」合起来是一整套**规则**，按版本保存在 `rule_version` 表（详见 6.10）
- **保存不会改变正在进行的场次**：场次在创建时锁定当时的规则版本，玩家端读的是自己那一版；保存只产生新的一版，由之后新建的场次使用。管理界面上的「当前规则版本 vN」就是下一次新建场次会锁定的版本
- 某一档 `title` 与 `desc` 都留空时，玩家端回落到内置文案（三语各一份）；`desc` 单独留空则只显示名称
- 未提交预测的玩家不会进入结果页（状态停在「已登记」），因此不存在「没猜也有奖品」的情况

### 6.9 额外奖品（命中特殊数字 → 全员加奖）

在四档个人奖品之外，另有一套**全员额外奖励**：当开奖数字命中管理员预设的「特殊数字」时，**所有参与者**（含未猜中者）除原有中奖处理外，额外获得一份指定奖品。

- 配置由管理界面「奖品设置」里的「全员额外奖励」区块维护（`GET/POST /api/bonus-prize`），与四档奖品同存于规则版本（`rule_version.bonus`）：`{ number: 0-9|null, title, desc }`。**改特殊数字同样只对之后新建的场次生效**，进行中的场次按它开场时锁定的那一版判定。`number` 与开奖数字同一范围 **0–9**，`0` 是合法特殊数字；「不启用」只能用 `null` / 空值表达（管理界面下拉选「不启用」即传 `null`），因为 `0` 不再当哨兵
- **触发只发生一次**：触发态**不落库**，由「本轮开奖数字是否命中该场次版本的特殊数字」现场重算；开奖后数字不再变、一轮只锁定一次（`confirm` 的 `already_locked` 拒绝重复锁定），故同一轮结果恒定、天然只触发一次；新一轮 `reset` 把数字置 `null` 自然不再触发
- 玩家端 `/api/state` 的 `bonus` 字段带 `{ number, title, desc, triggered }`：`triggered` 表示本轮是否命中特殊数字，命中时结果页额外显示「全员额外奖励」横幅（与个人档位并存，互不影响）
- 员工端结果区同样显示触发提示；**与原有四档判定、发奖流程、结果展示完全独立**，不改变任何命中判定
- 边界：无参与者时照常判定（奖励对象为空但状态正确）；配置缺失/`number` 非法一律视为未启用，不触发

### 6.10 规则版本（改规则怎么生效）

**一句话：规则按版本落库，场次开场即锁定版本，改规则只影响「之后新建的场次」。**

- 「规则」= 奖品四档文案 + 全员额外奖励（特殊数字 + 文案）。两者是同一个整体快照，不拆开各存一份，否则对账时分不清「这轮到底按哪套规则」。
- 保存（`POST /api/prize-config` 或 `POST /api/bonus-prize`）→ `rule_version` 里新增一版（`version` = max+1），旧版本原样保留。只改其中一块时另一块沿用最新版，不会被清空。
- **内容没变不新增版本**：库里按规范化快照的 sha256 判重，反复点保存不会刷出一堆空版本。
- 新建场次时（`POST /api/session-create`、启动自举）把当时的最新版本写进 `game_session.rule_version`，此后该场次的所有轮次（含 `reset` 之后的轮次）都用这一版：
  - 正在进行的场次：玩家端奖品文案、特殊数字判定、`confirm` 的 `bonusTriggered` 全部按锁定的版本
  - 已锁定的轮次：不会再被「事后改特殊数字」翻成触发或翻掉触发
- **规则不缓存，也不存在 TTL**：场次快照那条 SQL 把 `rule_version` 一起 JOIN 出来（`COALESCE(gs.rule_version, max(version))`），管理端读配置每次也直查库。进程里没有规则副本，因此没有「通知丢了要等一会儿才对得上」这种窗口——别的实例刚存的版本，本实例的下一次请求就能看到。
- 对账留痕：`round_archive.rule_version` 在锁定那一刻写入，`/api/archive/export.csv` 的末列「规则版本」就是它；历史行（版本化之前）为空。
- 版本表 `rule_version` 是 append-only（触发器挡 `UPDATE` / `DELETE` / `TRUNCATE`）：要更正规则只能再存一版，改不了历史。
- 升级兼容：老库把配置存在 `app_config`（就地覆盖、无历史）。首次启动时把最后一份配置落成 `v1`，并把版本化之前建的场次统一挂到 `v1`（它们当时用的正是这份配置）。

> 想让新奖品立刻生效？关掉当前场次、新建一场即可（`POST /api/session-close` → `POST /api/session-create`）。这是「改规则不影响正在玩的玩家」的代价，也是它的意义。

---

## 7. HTTP 接口

所有接口返回 JSON；异常统一为 `{ "ok": false, "code": "..." }`。

| 方法 | 路径 | 鉴权 | 请求体 / 参数 | 说明 |
|---|---|---|---|---|
| POST | `/api/staff-login` | — | `{username, password}` | 账号 + 独立密码登录（`username` 必填，缺省返回 400 `username_required`）；成功返回 `{ok, token, sid, sessions, user:{username,role,displayName}}` |
| POST | `/api/staff-logout` | token | `{token}` | 注销会话（写 `logout` 日志） |
| GET | `/api/staff-check` | token | `?token=` | 会话是否仍有效，返回绑定的 `sid`、场次列表与 `user` |
| GET | `/api/sessions` | — | `?token=` | 场次列表；无 token 只返回进行中的场次，带有效 token 返回含已关闭场次的完整列表 |
| POST | `/api/session-create` | token(+场景口令) | `{token, name, sessionPassword}` | 新建场次（上限 4），创建者自动切到新场次，`name` 可省略（自动命名），上限 24 字。`staff` 角色需 `sessionPassword` |
| POST | `/api/session-select` | token(+场景口令) | `{token, sid, sessionPassword}` | 切换该员工会话的归属场次，不影响其他员工。`staff` 角色需 `sessionPassword` |
| POST | `/api/session-close` | token | `{token, sid}` | 关闭场次：通知并断开该场玩家端、从玩家端列表移除、数据保留 |
| POST | `/api/session-unlock` | — | `{sid, password}` 或 `{sid, auto:true}` | 玩家端选择 / 切换场次：校验口令，成功返回绑定令牌 `ut`（12 小时）。`auto` 仅在唯一进行中场次时可用 |
| GET | `/api/state` | — | `?sid=&ut=&pid=`；大屏加 `&view=bigscreen` | 某场次的全量状态快照；带 `pid` 时额外返回该玩家的 `me`（含草稿）。`view=bigscreen` 返回大屏视图（开奖前也含每个人的选项与草稿），默认公开（`BIGSCREEN_PUBLIC=0` 时需员工 token） |
| POST | `/api/scan` | — | `{sid, ut, content}` | 登记身份，返回 `{ok, pid, sid, status:"known"}` |
| PUT | `/api/pick` | — | `{sid, ut, pid, oddEven, number, seq}` | **临时选择（草稿）**：只写内存、不落库、不推进 `version`；`seq` 单调，更小的序号返回 `200 {accepted:false, ignored:"stale_seq"}` 而不是报错 |
| DELETE | `/api/pick` | — | `{sid, ut, pid, seq}` | 撤销草稿，同样按 `seq` 单调判定（删除也吃序号，避免旧请求复活选择） |
| POST | `/api/submit` | — | 头 `Idempotency-Key`，体 `{sid, ut, pid, oddEven, number}` | **确认提交**：`oddEven` 为 `"单"` / `"双"`，`number` 为 0–9；同 key 重放返回 `200 {replay:true}`，异 key 已提交返回 `409 already_submitted` + 终态。**只有它才落库、才算参赛** |
| POST | `/api/predict` | — | `{sid, ut, pid, oddEven, number}` | 老接口，保留兼容（重复提交 → `400 predict_duplicate`）；新前端一律用 `/api/submit` |
| POST | `/api/leave` | — | `{sid, ut, pid}` | 玩家离开现场：只给大屏打 `left` 标记，不删登记与预测；幂等，重复上报不递增版本号 |
| POST | `/api/confirm` | token | `{token, sid, number, ackPending?}` | 锁定该场次本轮数字（唯一写入点，写后不可改）。本轮存在「已选但未确认」的草稿时必须带 `ackPending:true`，否则 `409 pending_confirm_required` + `counts` + `pending[]`；锁定后草稿全部作废 |
| POST | `/api/reset` | token | `{token, sid}` | 该场次轮次 +1 并清空本场本轮玩家（已锁定轮次必须先归档成功，否则返回 409 `archive_write_failed`） |
| GET | `/api/archive/summary` | **admin** | `?token=&date=` 或 `?token=&from=&to=` | 当日聚合：场次数、轮次数、去重参与人数、分场次明细。默认今天 |
| GET | `/api/archive/export.csv` | **admin** | `?token=&level=detail\|round&date=或 from=&to=&sid=` | 对账 CSV（`text/csv`，带 BOM，列头固定见 7.3）；导出动作记 `export_archive` 日志 |
| POST | `/api/archive-sync` | token | `{token}` | 把内存里所有「已锁定但未落归档」的轮次重新写一遍（幂等，正常情况用不到） |
| GET | `/api/accounts` | **admin** | `?token=` | 账号列表（不含密码派升值），附 `me`（当前账号名） |
| POST | `/api/account-create` | **admin** | `{token, username, password, displayName?, role?}` | 建账号；`role` 为 `staff`（默认）/ `admin`。校验账号格式、密码强度、重名 |
| POST | `/api/account-update` | **admin** | `{token, username, displayName?, role?, status?}` | 改显示名 / 角色 / 状态；不能停用自己、不能停用或降级最后一个管理员 |
| POST | `/api/account-password` | **admin** | `{token, username, password}` | 重置密码；该账号所有会话立即失效 |
| GET | `/api/audit` | **admin** | `?token=&date=` 或 `from=&to=`，可选 `&actor=&action=&limit=` | 操作日志，新的在前，`limit` 默认 200、上限 1000 |
| GET | `/api/audit/export.csv` | **admin** | 同上（不分页） | 操作日志 CSV（`时间,账号,角色,操作,场次ID,对象,明细,IP`）；导出动作记 `export_audit` 日志 |
| GET | `/api/prize-config` | **admin** | `?token=` | 读取**最新一版**规则的四档奖品文案：`prizes.{both,number,oddeven,miss}.{title,desc}` + `ruleVersion`，附字段上限 `limits` |
| POST | `/api/prize-config` | **admin** | `{token, prizes:{both,number,oddeven,miss}}` | 保存奖品文案 → **新增一个规则版本**（内容不变则不新增，返回 `created:false`）。每档 `{title, desc}`，去空白、超长按 32 / 120 截断、未知档位与多余字段丢弃；特殊数字沿用最新版。返回 `{prizes, ruleVersion, created}`，写 `prize_config` 审计。**只对之后新建的场次生效** |
| GET | `/api/bonus-prize` | **admin** | `?token=` | 读取最新一版的全员额外奖励配置：`bonus.{number,title,desc}`（`number` 为 `null` 表示未启用）+ `ruleVersion`，附 `limits` 与 `range:{min,max}` |
| POST | `/api/bonus-prize` | **admin** | `{token, bonus:{number,title,desc}}` | 保存特殊数字 → **新增一个规则版本**（同上，内容不变不新增）。`number` 只认 0-9（`0` 合法；非法/缺失/空值视为未启用），`title`/`desc` 去空白并按 32/120 截断；四档文案沿用最新版。返回 `{bonus, ruleVersion, created}`，写 `bonus_config` 审计。**只对之后新建的场次生效** |
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
  "serverTime": 1795206301123,
  "round": 3,
  "locked": false,
  "number": null,
  "prizes": {
    "both":    { "title": "", "desc": "" },
    "number":  { "title": "", "desc": "" },
    "oddeven": { "title": "", "desc": "" },
    "miss":    { "title": "", "desc": "" }
  },
  "bonus": { "number": 8, "title": "幸运加奖", "desc": "全员一瓶饮料", "triggered": false },
  "counts": { "total": 3, "submitted": 1, "draft": 1, "none": 1, "left": 0 },
  "players": [
    { "id": "M00123", "submitted": true,  "status": "submitted", "draft": false, "isVeteran": true },
    { "id": "M00124", "submitted": false, "status": "draft",     "draft": true,  "isVeteran": false }
  ],
  "me": { "id": "M00124", "oddEven": null, "number": null,
          "draft": { "oe": "双", "num": 6, "seq": 3 } }
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

`view=bigscreen`（默认公开，无需 token）换成大屏视图：多了 `"view": "bigscreen"`，`players[]` 在开奖前就带选项 —— `oe`/`num` 是**当前显示值**（已确认取提交值，未确认取草稿值），另有 `status`（`submitted`/`draft`/`none`）与 `draftOddEven`/`draftNumber`/`draftSeq`、`left`/`leftAt`/`registeredAt`/`submittedAt`。`submitted` 只表示**已确认提交**，统计与归档只认它。

### 7.1 SSE 事件

- 连接按 `session_id` 分组，广播只发往该场次的连接，不同场次的客户端互不可见
- 连接建立后立即下发一次 `state` 事件（全量快照），事件 `id` 为场次状态版本号
- 之后每次**落库**变更广播 `state`；`Last-Event-ID` 仅作版本对照，服务端广播始终是全量快照，重连天然对齐
- 草稿变更走单独的 `draft` 事件：`{sid, items:[{pid, draft:{oe,num,seq,at}|null}]}`，按场次 500ms 合并，**不带事件 id**（草稿不落库、不推进版本号，靠首帧 `state` 带全量对齐）
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
| `predict_invalid` | 400 | 数字不是 0–9 的整数 |
| `unauthorized` | 401 | 员工 token 缺失、过期，或账号已被停用 |
| `wrong_password` | 401 | 账号或密码错误（不区分「账号不存在」与「密码错」，避免枚举账号） |
| `account_disabled` | 401 | 账号已停用 |
| `too_many_attempts` | 429 | 同一账号连续 5 次密码错误，锁 30 秒（返回 `retryAfter` 秒数） |
| `staff_session_password_required` | 403 | 员工切场次 / 新建场次未带场景口令 |
| `staff_wrong_password` | 401 | 员工场次口令错误（连续 5 次后返回 429 `staff_too_many_attempts`，锁 60 秒） |
| `staff_too_many_attempts` | 429 | 该账号场次口令错误次数超限（返回 `retryAfter`） |
| `username_invalid` | 400 | 账号名不合法（2–32 位 `a-z 0-9 . _ -`） |
| `username_taken` | 409 | 账号已存在 |
| `account_not_found` | 404 | 目标账号不存在 |
| `password_too_short` / `password_too_long` / `password_too_weak` | 400 | 密码过短（<6）/ 过长（>64）/ 与账号名相同 |
| `role_invalid` / `status_invalid` | 400 | 角色不是 `staff`/`admin`，状态不是 `active`/`disabled` |
| `cannot_disable_self` | 409 | 不能停用当前登录的账号 |
| `last_admin` | 409 | 不能停用或降级最后一个可用管理员 |
| `nothing_to_update` | 400 | `account-update` 没有携带任何可改字段 |
| `invalid_number` | 400 | 锁定数字不是 0–9 的整数 |
| `pending_confirm_required` | 409 | 本轮存在「已选但未确认」的草稿，员工开奖未带 `ackPending`（返回 `counts` 与 `pending[]` 名单） |
| `pick_invalid` / `pick_invalid_oe` / `seq_invalid` / `pick_not_scanned` | 400 | 草稿参数不合法：数字不是 0–9、单双不是「单/双」、序号非正整数、该 pid 未在本场次登记 |
| `already_submitted` | 409 | 该玩家已确认提交，再次提交或改草稿被拒（返回 `submit` 终态，前端据此展示成功态） |
| `round_locked` | 409 | 本轮已锁定，草稿与提交都关闭（返回 `number`） |
| `idempotency_key_required` | 422 | `POST /api/submit` 缺 `Idempotency-Key` 或格式不合规（8–64 位 `A-Za-z0-9_-`） |
| `already_locked` | 400 | 本轮已锁定（返回已锁定的 `number`） |
| `session_not_found` | 404 | `sid` 不存在，或多个场次并行时未指定 `sid`（返回可用场次列表） |
| `session_closed` | 409 | 目标场次已关闭，拒绝入场 / 锁定 |
| `session_limit` | 409 | 进行中场次已达 4 个（返回 `max`） |
| `session_already_closed` | 409 | 重复关闭同一场次 |
| `session_name_too_long` | 400 | 场次名超过 24 字（返回 `maxLen`） |
| `session_locked` | 403 | 本机已绑定其他场次，请求的 `sid` 与绑定不符（返回 `boundSid`） |
| `session_need_unlock` | 403 | 未带有效绑定令牌，且当前有 ≥2 个进行中场次，需先过口令 |
| `bigscreen_unauthorized` | 403 | 仅在 `BIGSCREEN_PUBLIC=0` 时出现：请求了 `view=bigscreen` 却没带有效员工 token（大屏会看到未开奖的选项，公开模式下不再拦） |
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
会员号,预测单双,预测数字,是否提交,单双命中,数字命中,登记时间,提交时间,锁定人,规则版本
```

`level=round`（一轮一行，含 0 人轮次）：

```
场次ID,场次名称,场次序号,轮次号,开奖数字,开奖单双,锁定时间,归档时间,扫码人数,提交人数,锁定人,规则版本
```

格式约定：

- 时间列一律为运营时区（`ARCHIVE_TZ_OFFSET_MIN`）下的 `YYYY-MM-DD HH:mm:ss`，**不带偏移后缀**，跨时区使用请自行按列头口径换算
- `是否提交`：`是` / `否`；`单双命中` / `数字命中`：`命中` / `未中` / `未提交`
- `锁定人`：该轮点「确认并锁定」的账号；两种口径都有此列，空值表示该行没有记录（历史数据）
- `规则版本`：该轮所用规则（奖品四档 + 特殊数字）的版本号，取自场次开场时锁定的那一版（见 6.10）；空值 = 版本化之前的历史行，当时没有版本概念。同一场次的所有轮次版本号相同，跨场次可能不同
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

启动时 `initDb()` 幂等建表（`CREATE TABLE IF NOT EXISTS`），**只负责建出缺失的表**：表结构以本文档与 `db.js` 的定义为唯一基准。

`initDb()` **不回填数据、不改约束**：表结构以 `db.js` 的定义为唯一基准，启动只创建缺失的表。库结构与之不一致时不会自动修正（缺列会在第一条读写上报错），需按当前 DDL 手工对齐或重建。

唯一的例外是**新增列**：`game_session.rule_version` 与 `round_archive.rule_version` 用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 幂等补齐（已经在跑的库拿不到新列，历史上踩过这个坑）。补列不写数据：老场次由启动流程挂到最早一版规则，老归档行保持 `null`（归档表 append-only，不允许回填）。改类型、加约束、批量回填仍然只能手工做。

| 表 | 内容 | 写入策略 |
|---|---|---|
| `game_session` | 场次实体：ID、名称、状态（open/closed）、显示序号、创建/关闭时间、**锁定的规则版本 `rule_version`** | 建场次时插入（版本由 `max(rule_version)` 算出）；随快照提交 upsert 元信息，不动版本 |
| `session_state` | 每个场次一行：**状态版本号** + 最近提交时间（多实例乐观锁凭据） | 提交事务里 `version + 1`（CAS） |
| `round` | 每个场次一行：当前轮次、开奖数字、锁定时间、锁定人账号 `locked_by`（**主键 `session_id`**） | 按场次 upsert |
| `player` | 本场次本轮每个玩家的登记与预测（**主键 `(session_id, id)`**）；`left_at` 为大屏用的离开标记，null = 在场 | 批量 `unnest` upsert + 删除快照里不存在的行 |
| `identity` | 场次内跨轮次身份档案：最近出现轮次、已完成轮次数（**主键 `(session_id, id)`**） | 批量 `UPSERT`，不删除，跨轮保留 |
| `round_archive` | 竞猜归档表头：一轮一行，场次快照 + 轮次号 + 开奖数字 + 锁定时间 + 人数统计 + 锁定人 `locked_by` + **规则版本 `rule_version`**（唯一键 `(session_id, round)`） | 只 `INSERT`，重复轮次跳过 |
| `rule_version` | 规则版本：版本号 + 四档奖品 JSONB + 全员额外奖励 JSONB + 快照指纹 `config_hash` + 来源 + 操作人（**append-only**） | 管理界面保存时追加一版；内容与最新版相同则不写 |
| `round_archive_entry` | 归档明细：一人一行，会员号 + 预测内容 + 命中结果（主键 `(archive_id, member_id)`） | 只 `INSERT`，重复行跳过 |
| `app_config` | 键值配置：`player_bind_secret`（绑定令牌签名密钥）。旧的 `prize_config` / `bonus_prize` 只在升级时作为 v1 的来源被读取一次，之后不再写入 | 首次启动生成 |
| `staff_session` | 员工登录会话：token、当前归属场次、过期时间、**登录账号 `username`**（角色回查账号表，不存快照）（**跨实例共享**） | 登录插入；过期 / 账号停用 / 改密时按需清理 |
| `staff_account` | 员工账号：账号名、显示名、角色（`staff`/`admin`）、状态、**scrypt 密码派生值**、建号人、最近登录时间 | 管理界面建号 / 改角色状态 / 改密 |
| `audit_log` | 操作日志：时间、账号、角色、动作、场次、对象、明细 JSON、IP（**append-only**） | 只 `INSERT`，`UPDATE` / `DELETE` / `TRUNCATE` 被触发器拒绝 |
| `auth_throttle` | 登录 / 场次口令错误计数：`key` = `login:<账号>`、`switch:<账号>` 或 `player:<ip>` | 原子 upsert，验证通过即删 |

**口令不在任何表里明文出现**：玩家场次口令与员工场次口令只在进程内存保留 `scrypt(口令, 随机盐)`，启动时由 `PLAYER_SESSION_PASSWORD` / `STAFF_SESSION_PASSWORD` 重新计算；员工登录密码在 `staff_account.password_hash` 里是 `scrypt$N$r$p$salt$hash`，无法反推。签名密钥是另一回事（随机、不可反推口令）。

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
  -e ADMIN_USERNAME='admin' \
  -e ADMIN_PASSWORD='your-admin-password' \
  -e STAFF_SESSION_PASSWORD='your-switch-passcode' \
  -e PLAYER_SESSION_PASSWORD='your-session-passcode' \
  -e DATABASE_URL='postgres://user:pass@db.example.com:5432/postgres?sslmode=require' \
  oddeven
```

三个口令各管一件事，互不复用：

| 变量 | 管的动作 | 默认值 |
|---|---|---|
| `PLAYER_SESSION_PASSWORD` | 玩家选择 / 切换场次 | `8888` |
| `STAFF_SESSION_PASSWORD` | 员工切换 / 新建场次（管理员免校验） | `7777` |
| `ADMIN_PASSWORD` | 仅用于首次创建管理员账号 | `123456` |

两个场景口令只在内存里以 scrypt 哈希存在，改口令 = 改环境变量 + 重启所有实例，无需迁移数据；管理员密码建号后就在库里，改它请走管理界面（重置密码）。

镜像为多阶段构建，`.dockerignore` 已排除 `node_modules`、`.git`、`.env`、`test`。

### 9.2 Fly.io

```bash
fly secrets set \
  ADMIN_USERNAME='admin' \
  ADMIN_PASSWORD='your-admin-password' \
  STAFF_SESSION_PASSWORD='your-switch-passcode' \
  PLAYER_SESSION_PASSWORD='your-session-passcode' \
  DATABASE_URL='postgres://user:pass@db.example.com:5432/postgres'

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

可选：**按场次分别部署**（不同门店、彼此不相关的场景）。每场一套实例 + 独立数据库（各配自己的 `DATABASE_URL`，同一 Postgres 上用不同库名/模式即可），入口地址分开。

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

覆盖范围（71 个用例，跑真实 `server.js` + 真实 Postgres，不 mock 业务逻辑）：

| 文件 | 覆盖 |
|---|---|
| `test/archive.test.mjs` | 登录/口令/扫码/预测的全部错误码；锁定与归档同事务；当日聚合口径（场次/轮次/去重人数/命中）；`detail`/`round` 两种 CSV 的列头、转义、命中判定，以及已移除的 `member` 口径返回 400；`reset` 不清归档；0 人轮次口径；跨场次分账与 `sid` 筛选；日期区间与非法日期；接口鉴权；append-only 触发器拒绝 UPDATE/DELETE/TRUNCATE |
| `test/archive-failure.test.mjs` | 归档表不可写时锁定仍生效且返回 `archived:false`；`reset` 被 409 拦住；恢复后 `archive-sync` 幂等补齐；重启自动回填「已锁定但未归档」的轮次 |
| `test/rule-version.test.mjs` | 规则版本落库与边界：升级时旧 `app_config` 落成 v1、历史场次挂 v1；保存 = 新增版本且旧版本原样保留；版本表 append-only（UPDATE/DELETE/TRUNCATE 被拒）；四档与特殊数字同版本、改一块不清空另一块；场次锁定版本（跨轮次不变、新场次用新版）；对账 CSV「规则版本」列与归档行一致；**直查库**（另一实例直接写库、无任何通知，本实例立刻读到新版本与新版奖品） |
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
- **场次口令是「一个场景一个」，不是「一场一个」。** 玩家侧所有场次共用 `PLAYER_SESSION_PASSWORD`，员工侧所有场次共用 `STAFF_SESSION_PASSWORD`；它们拦的是「随便乱换场次」，不构成场次机密（知道该场景口令的人可以进任何一场）。员工侧的口令按账号计数、连续 5 次错误锁 60 秒，且管理员免校验——它是给员工设的操作边界，不是身份认证（身份认证靠登录）。要按场发不同口令，需要给 `game_session` 加口令哈希列，见「12. 待办」。
- **玩家绑定是「防误换」而非强身份认证。** 令牌绑定场次、不可跨场，但任何人拿到这台设备即可沿用其绑定继续玩（与扫码身份同一台设备的既有模型一致）；令牌 12 小时过期，口令本身从不落地，所以清掉 localStorage 只会退回选择界面，仍需口令才能重新进场。
- **令牌走查询参数。** SSE（EventSource）无法自定义请求头，所以员工 token 与玩家绑定令牌都以 `?token=` / `?ut=` 传递，会进访问日志。反向代理层建议关闭查询串记录，或改走 Cookie。令牌都不含口令，泄露影响是「可读该场次状态」，不能改口令、不能跨场。
- **规则改动不会立刻生效，这是设计而非缺陷。** 保存奖品/特殊数字只产生新版本，正在进行的场次继续用它开场时锁定的那一版，只有之后新建的场次才用新规则（详见 6.10）。需要立刻切换就关场重建。
- **没有人数上限校验。** 单场 6–12 位是运营约定，服务端不拦；人数越多，每次状态变更的写放大与全量广播开销越大，延迟随人数线性上升。同时进行的场次上限为 4（`MAX_SESSIONS`），超出会被拒。
- **支持多实例（水平扩容）。** 会话、员工登录态、限频全部在 Postgres，跨实例变更走 `LISTEN/NOTIFY`，写入用 `session_state.version` 乐观锁 + 全局 advisory lock 串行化（详见 9.5）。仍有的边界：`LISTEN` 不能走事务级连接池；SSE 连接是每实例各自的（不需要粘性会话）；进程内读缓存 TTL 5 秒，通知全丢时最坏有 5 秒延迟；同时进行的场次上限 4 是**全集群**口径。
- **员工会话重启不再丢失（行为变化）。** 会话落在 `staff_session`，有效期 12 小时；这是多实例的硬要求（A 签发的 token 必须能被 B 认）。要立刻下线某人：在管理界面**停用该账号或重置密码**，会立即删掉它所有会话行（不会等 12 小时）。登录会话的鉴权以账号表当前状态为准，所以降级角色同样立即生效。
- 托管库强制 TLS 时，在 `DATABASE_URL` 里加 `sslmode`（TLS 只有一个入口，没有拆开写法的分支）。

**数据**

- **历史轮次只保留归档快照，不是运行态。** 每轮锁定即写入 `round_archive` / `round_archive_entry`，事后可复盘「某一轮谁猜了什么、中了没有」；但归档存的是**锁定那一刻**的会员号与预测原文，玩家后续的行为变化不会回写，且归档表禁改禁删（要更正只能追加新记录）。`reset` 之前的未锁定轮次（字都没录）不留痕，这是有意的。
- **归档一旦写失败会拒绝开新一轮。** `reset` 在清空前会强制归档落定，失败返回 409 `archive_write_failed`；锁定接口则返回 `archived:false` 并保持锁定（重按只会得到 `already_locked`），需要用 `POST /api/archive-sync` 补齐。
- **`archive-sync` 只能补「还在内存里的已锁定轮次」。** 若某轮既没归档又已经被 reset，那就真的没有明细了——这种情况被上面的 409 拦住，正常流程不会发生。
- **归档表没有分区与归档清理。** 单场一天几十轮、每轮十来人，量级很小；长期运行（数千场次）后建议按 `locked_at` 做月分区或冷备导出，目前没有实现。
- 玩家 ID 未做加密或哈希，直接以会员号明文入库并与 `identity` 关联。
- 写库是「抢版本号 + 快照重写」（`db.commitSnapshot`），多实例安全；但同一场次的写入仍是**整场快照**语义，玩家数很多时单次提交成本随人数上升（已从「一人一条 SQL」优化为批量 `unnest`）。
- 写失败不再静默：`store.mutate` 会丢弃脏缓存并让接口返回 `write_failed`（锁定路径还会区分为「已锁定但未归档」），不会出现「页面显示成功、库里没有」。
- 员工登录态现在落库（`staff_session`），过期由读取时顺手清理，没有后台定时任务；要立即使某人失效用「停用账号 / 重置密码」。
- 登录失败计数按**账号**（`login:<账号>`），场次口令计数也按**账号**（`switch:<账号>`），玩家口令按来源 IP（`player:<ip>`）：一个人连错不会把全店锁在门外。副作用是攻击者可以轮换账号名刷失败次数，但账号不存在时同样计入该名字，不会泄露账号是否存在。
- **操作日志只增不删，没有清理策略。** 按门店一天几百条的量级，长期运行后建议按月导出并分区（与归档表同一条待办）。
- **两个场景口令来自环境变量，必须全实例一致。** 口令只以 scrypt 哈希存在进程内存，多实例部署时每个实例都按同一份 `PLAYER_SESSION_PASSWORD` / `STAFF_SESSION_PASSWORD` 重算；改了变量要重启所有实例才生效。
**安全**

- 默认口令只适合本地演示（见 5.1 环境变量）。上线前必须做三件事：用 `ADMIN_PASSWORD` 指定初始管理员密码（或登录后立刻在管理界面改掉默认 `123456`）、用 `PLAYER_SESSION_PASSWORD` / `STAFF_SESSION_PASSWORD` 覆盖两个场景口令、给每位员工单独建号而不是共用 `staff`。
- 权限只有两档：`staff` 能操作场次 / 锁定 / 新一轮，`admin` 另有对账与账号管理。没有更细的颗粒度（例如「只能锁定不能关闭」）。
- 初始管理员密码由环境变量引导，只在**库里没有任何 admin 时**生效；之后改 `ADMIN_PASSWORD` 不会改库里的密码。忘记管理员密码时，只能手工把一条已知 scrypt 派生值写进 `staff_account.password_hash`，或临时删掉全部 admin 行重启让它重新引导。
- 玩家身份没有任何校验：任意字符串（≤512 字符）都能注册成身份，知道别人会员号即可抢先占用。
- 静态资源与 API 响应均为 `Cache-Control: no-store`。

---

## 12. 待办

以下是已确认需要做、但当前代码尚未实现的事项：

1. **测试补齐与 CI 接入**：`test/` 仍缺：SSE 重连时的 `Last-Event-ID` 对齐、身份跨轮累计的独立用例；`.github/workflows/` 目前只有部署，尚未在部署前跑 `npm test`。
2. **玩家 ID 入库前加密**：引入密钥对（公钥加密 / 私钥解密，密钥经环境变量注入），对 `player.id`、`identity.id`、归档表的 `member_id` 及展示用的会员号做加密处理，并配套密钥轮换方案；同时评估现有数据的迁移与清理。注意这与对账口径有冲突，需先定“对账按什么标识”再落加密（归档表是 append-only，加密后历史行不会回写，只能在导出层解密）。
3. **多实例支持**：遗留项：`store` 读缓存目前是进程内 LRU-less Map，场次数长期增长后需要加容量上限。
4. **直播大屏**：更改美化格式。

---

## 13. 相关文档

- `DEPLOY.md`：数据库连接串、表结构说明与 Fly.io 部署步骤（配合本文第 5、9 节阅读）
