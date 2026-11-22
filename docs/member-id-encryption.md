# 会员号加密改造：实现说明与密钥轮换方案

> 目标：会员号（二维码原文）在**落库**和**页面展示**两处都不再出现明文；密钥通过环境变量注入；
> 提供可执行的密钥轮换方案（版本标识 + 新旧共存过渡）。
>
> **前提假设（已与需求方确认）**：系统里不存在明文历史行。由此产生两处设计取舍：
> ① 无「兼容明文」分支——读库缺密文直接报错，不做明文降级；
> ② 需要处理的「新旧」只有一种：**密钥轮换后不同版本的密文共存**（`mid:v1:` 与 `mid:v2:`）。

---

## 1. 先说一个选型结论

需求写的是「引入非对称密钥对」。直接拿 RSA 逐字段加密在这个系统里跑不通，原因是硬的：

| 问题 | 具体影响 |
|---|---|
| RSA-OAEP 是随机化的 | 同一个人每次加密结果都不同 → 不能当主键，「重复扫码幂等」直接失效 |
| 单条容量 190 字节、密文固定 256 字节 | base64 后 344 字符，铺到大屏/CSV 里是噪声；SSE 每帧全量玩家负载会被放大十几倍 |
| 每次约 0.3–1 ms 的模幂 | `commitSnapshot` 每次状态变更都重写整场玩家行，一场 500 人 = 每次提交几百次 RSA，一次「提交预测」都扛不住 |

所以这里用的是**信封加密**：非对称只负责包裹数据密钥（DEK），字段本身用 AES-256-GCM。

```
env: RSA 私钥 + RSA-OAEP 包裹后的 DEK
  └─ 启动时用私钥解出 DEK（32B），驻留进程内存
       └─ 字段密文 = mid:v1:<iv>:<AES-256-GCM 密文>:<tag>   （58 字符，微秒级）
```

非对称的好处一个没丢：私钥留在进程/未来的 KMS 里，配置面只出现「被包裹的 DEK」；轮换就是换一把 RSA 密钥包一把新 DEK。
另外补了一个**盲索引**（HMAC）解决「密文随机化后没法查/没法当主键」的问题：

| 产出 | 形状 | 用途 |
|---|---|---|
| `ref` | `m_` + 32 hex（HMAC-SHA256 前 128 位） | **主键与接口 pid**。确定性、不可逆、跨场次稳定 |
| `member_enc` | `mid:v1:…`（58 字符） | 落库密文。只在需要复原明文时解密 |
| `maskedId` | `****7766`（保留后 4 位） | 页面/大屏/员工端展示，永不出现明文 |

---

## 2. 需要修改的模块

### 2.1 新增

| 文件 | 作用 |
|---|---|
| `lib/member-id.js` | 全部加解密逻辑：密钥环解析、`ref` / `seal` / `open` / `mask` / `decodeRow`、进程内密文缓存 |
| `scripts/member-keygen.mjs` | 生成 RSA-3072 密钥对 + 随机 DEK + 包裹后的 env 行（`npm run member-keygen`） |
| `test/member-crypto.test.mjs` | 算法层单测 14 例 + 落库/出网端到端断言 |

### 2.2 改动

| 文件 | 位置 | 改什么 |
|---|---|---|
| `db.js` | `initDb` | `player` / `identity` / `round_archive_entry` 各加一列 `member_enc TEXT`（`ADD COLUMN IF NOT EXISTS`，幂等） |
| `db.js` | `SNAPSHOT_SQL` | 两个 `json_build_object` 里补 `'enc', p.member_enc` / `'enc', i.member_enc` |
| `db.js` | `rowToSession` | 用 `memberId.decodeRow(id, enc)` 把行转成 `{ id, enc, maskedId }`；缺密文或 ref 与密文不一致直接抛错（不降级、不猜） |
| `db.js` | `playerColumns` / `commitSnapshot` | 玩家/身份批量写入多带一个 `enc` 列；`member_enc` 不再可能为 NULL（缺了直接抛错，拒绝写「有 ref 没密文」的行） |
| `db.js` | `archiveRoundInTx` | 归档明细写 `member_id = ref` + `member_enc` |
| `db.js` | `archiveEntryRows` | 查询多带 `e.member_enc`（供将来授权复原） |
| `db.js` | `archiveSummary` | 参与人数保持 `count(DISTINCT member_id)`：`member_id` 恒为 ref，密钥版本不同不影响去重 |
| `server.js` | `/api/scan` | 入口处 `content → ref / enc / maskedId`；玩家与身份档案建档时三者一起写 |
| `server.js` | `buildStatePayload` / `publicPlayers` / `bigscreenPlayers` | 负载里 `id = ref`，新增 `maskedId`；`me` 同样 |
| `server.js` | `/api/confirm` | 现场补建的 `identity` 条目带上 `enc` |
| `server.js` | `/api/archive/export.csv` | 会员号列输出 `ref`（`member_id` 本身就是 ref，无需折算） |
| `server.js` | `start()` | 启动即校验密钥，缺配置直接退出，不做明文兜底 |
| `public/staff/app.js` | 结果表 / 本轮名单 | `esc(p.id)` → `esc(p.maskedId \|\| p.id)` |
| `public/bigscreen/app.js` | 玩家卡片 | 展示 `p.maskedId`（`data-pid` 仍是 ref，用于增量 diff） |
| `public/index/app.js` | 扫码成功提示 | 用 `d.maskedId` 而不是 `d.pid` |
| `test/*` | 见 §7 | 断言改用 `memberRef()`；新增「库里无明文」用例 |

---

## 3. 字段变更（DDL）

只加列，不改类型、不改主键，全部幂等：

```sql
ALTER TABLE player              ADD COLUMN IF NOT EXISTS member_enc TEXT;
ALTER TABLE identity            ADD COLUMN IF NOT EXISTS member_enc TEXT;
ALTER TABLE round_archive_entry ADD COLUMN IF NOT EXISTS member_enc TEXT;
```

语义变化（无 DDL，但属于**接口契约**）：

| 列 | 改造前 | 改造后 |
|---|---|---|
| `player.id` | 会员号原文 | 盲索引 ref `m_[0-9a-f]{32}` |
| `identity.id` | 同 player.id | 同上 |
| `round_archive_entry.member_id` | 会员号原文 | 同上 |
| `*.member_enc` | 不存在 | 密文 `mid:v<n>:…`（每行必有，按前缀挑密钥） |

> 主键 `(session_id, id)` 与 `(archive_id, member_id)` 都不变：ref 确定性，去重与唯一约束照旧生效。
> 汇总口径 `count(DISTINCT member_id)` 也不变，跨场次同一个人仍然只算一个。

---

## 4. 接口变更

### 4.1 `POST /api/scan`

```diff
- { "ok": true, "pid": "VIP00887766", "sid": "main", "status": "known" }
+ { "ok": true, "pid": "m_2c2882a3633929cb3e5c0c5afba52d9d", "maskedId": "****7766", "sid": "main", "status": "known" }
```

`pid` 现在是 34 字符的 ref。后续 `/api/predict`、`/api/pick`、`/api/submit`、`/api/leave`、`/api/state?pid=` 的 `pid` 入参一律用这个值 —— 客户端本来就是把 `scan` 返回值原样存进 localStorage 再回传，所以**前端逻辑不用改**，只改了展示。

### 4.2 `/api/state` 与 SSE `state` 帧

```diff
  "players": [
-   { "id": "VIP00887766", "submitted": true, ... }
+   { "id": "m_2c2882…", "maskedId": "****7766", "submitted": true, ... }
  ],
- "me": { "id": "VIP00887766", "oddEven": "单", ... }
+ "me": { "id": "m_2c2882…", "maskedId": "****7766", "oddEven": "单", ... }
```

### 4.3 `GET /api/archive/export.csv`

- **列名与列序不变**（列头是下游契约，不改名）。
- 「会员号」列的**内容**从原文变成 ref。归档表里存的就是 ref，导出不再做任何折算。
- 影响：需要按会员号关联下游数据的脚本，要么改用 ref 作为关联键（推荐，稳定且不泄露），要么走授权复原（当前未提供在线接口，见 §9）。

### 4.4 不兼容点（一次性）

改造前玩家端 localStorage 里存的明文 `pid` 在服务端已认不出 → `state.me` 为空 → 现有逻辑会自动清掉本地 pid 并要求重新扫码。**现场使用建议在开场前发布**，不要在两轮之间切换版本。

---

## 5. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `MEMBER_ID_PEPPER` | ✅ | 盲索引 HMAC key，base64（≥32 字节）。**一经上线不可更换**：换了等于把所有会员号的身份线剪断 |
| `MEMBER_ID_KEY_<n>` | ✅ | 第 n 版的 32 字节 DEK，用 RSA-OAEP(SHA-256) 包裹后的 base64 |
| `MEMBER_ID_KEY_<n>_PRIVATE` | ✅ | 第 n 版 RSA 私钥，base64 的 PKCS#8 PEM（只用于解 DEK） |
| `MEMBER_ID_DEK_<n>` | 可选 | 简化模式：直接注入 32 字节裸 DEK（base64），跳过 RSA。没有 KMS 时可用 |
| `MEMBER_ID_KEY_VERSION` | 可选 | 当前写入用哪一版；缺省 = 已配置的最大版本号 |

生成（不要提交进仓库）：

```bash
npm run member-keygen -- -v 1     # 首次：同时生成 pepper
# 输出粘到 fly secrets / K8s Secret / .env
```

启动时会打印一行：

```
[member-id] 字段加密就绪：AES-256-GCM + RSA-OAEP 包裹，写入版本 v1，可用版本 [1]
```

缺 pepper / 缺密钥 / 指定版本不存在，都会**直接退出**（`KeyConfigError`），不存在明文兜底。

---

## 6. 加解密调用点

| 时机 | 位置 | 调用 |
|---|---|---|
| 扫码入场 | `server.js /api/scan` | `ref(content)`、`seal(content)`、`mask(content)` |
| 读库（每次提交前都会 fresh 读） | `db.js rowToSession` | `decodeRow(id, enc)` → `{ id, enc, maskedId }`（缺密文即抛错） |
| 写运行态 | `db.js commitSnapshot` | 直接落 `pl.enc`（扫码时已算好，不重复加密） |
| 写归档 | `db.js archiveRoundInTx` | 同上 |
| 导出 | `server.js exportMemberRef` | `isRef(x) ? x : ref(x)` |
| 展示 | 三个前端 | `maskedId` |
| 启动 | `server.js start()` | `describe()` 校验密钥环 |

设计上明文只出现在两个瞬间：`/api/scan` 拿到二维码内容的那一刻，以及 `open()` 解密的那一刻（仅用于生成 maskedId）。**内存里的玩家对象不保存明文**（只有 `ref` / `enc` / `maskedId`），所以 heap dump 也拿不到会员号。

---

## 7. 验证要点

### 7.1 自动化（`npm test`，94 项全绿）

新增 `test/member-crypto.test.mjs` 覆盖：

- `ref` 确定性 / 不同号不撞 / 不残留原文；pepper 变化会导致 ref 变化（所以 pepper 不轮换）
- `mask` 只露后 4 位，≤4 位全遮
- `seal/open` 往返；密文 `< 200` 字符；篡改密文/认证标签必失败
- **轮换**：v2 写入、v1 旧密文仍可解；只装 v2 时解 v1 明确报 `KeyConfigError`（不是返回垃圾）
- **严格读取**：`decodeRow` 在「缺密文」和「ref 与密文不一致」两种情况下都抛错（绝不把 ref 当明文再 hash）
- 缺 pepper / 缺密钥 / 版本不存在 → 启动期报错
- 裸 DEK 模式可用（长度必须 32 字节）
- 端到端：扫码 → 预测 → 锁定 → 归档后，`player` / `identity` / `round_archive_entry` 三张表里**没有任何会员号原文**，CSV 里也没有；身份跨轮累计仍然连续
- **轮换共存**：v1 写入的行在 v2 实例上照常读出；新写入落 v2；重扫旧会员把该行升到 v2；两版密文并存时 `/api/archive/summary` 的参与人数仍按 ref 去重

`test/helpers.mjs` 现在为每个测试进程生成一套临时密钥并注入子进程；断言侧用 `memberRef(原文)` 折算。

### 7.2 上线后自检 SQL

```sql
-- 1) 主键是否都是 ref（应为 0）
SELECT count(*) FROM player WHERE id !~ '^m_[0-9a-f]{32}$';

-- 2) 是否有行缺密文（应为 0；不为 0 说明有代码 bug 或人为改库）
SELECT count(*) FROM player WHERE member_enc IS NULL;

-- 3) 归档明细同口径
SELECT count(*) FROM round_archive_entry WHERE member_enc IS NULL;

-- 4) 当前在用的密文版本分布（轮换收尾的判据）
SELECT substring(member_enc from '^mid:(v[0-9]+):') AS ver, count(*)
  FROM player GROUP BY 1 ORDER BY 1;
```

### 7.3 手工冒烟

1. 扫码两次同一个码 → 两次返回的 `pid` 必须完全相同（幂等），`maskedId` 相同。
2. 响应体和 `/api/state` 全文搜不到会员号原文。
3. 员工端名单、大屏卡片、CSV 打开后「会员号」列是 `****xxxx` / `m_…`，不是原文。
4. 重启服务 → 同一码再扫，`pid` 不变（ref 不依赖进程内状态）。
5. 双实例：A 扫码，B 的 `/api/state` 能解出同一 `maskedId`（同一套密钥 env）。
6. 负向：临时删掉 `MEMBER_ID_KEY_1` 重启 → 必须**启动失败**并提示生成方法，不能带病运行。

---

## 8. 密钥轮换方案

### 8.1 版本标识

版本号写在**密文里**：`mid:v1:…` / `mid:v2:…`。读的时候按前缀选密钥，因此：

- 不需要在库里另存 `key_version` 列；
- 不需要停机，也不需要一次性重写已有数据；
- 新旧密文可以在同一张表里共存，各解各的。

### 8.2 过渡（灰度，不停机）

| 步骤 | 操作 | 判定通过的标准 |
|---|---|---|
| 0. 备份 | 导出 `member_enc` 可读性抽检 + 离线备份**现有私钥与 pepper** | 备份文件能在隔离环境解出 3 条样本 |
| 1. 注入新钥 | `fly secrets set MEMBER_ID_KEY_2=… MEMBER_ID_KEY_2_PRIVATE=…`（**一条命令设两个**，避免两次重启） | 启动日志出现 `可用版本 [1,2]`，写入仍是 `v1` |
| 2. 切写入口径 | `fly secrets set MEMBER_ID_KEY_VERSION=2` | 日志 `写入版本 v2`；新扫码的行密文为 `mid:v2:` |
| 3. 观察 | 看 §7.2 第 4 条 | 新写入 100% 是 v2；v1 只剩尚未重写过的行 |
| 4. 收敛旧版本 | 无需批量重写：玩家行每次快照提交都会重写，活跃场次自然转 v2；`identity` 行在该会员再次扫码时转 v2 | 活跃场次的 v1 行趋近 0 |
| 5. 退役 v1 | 见 8.4 | 见 8.4 |

多实例滚动期间的安全性：新旧实例都装了 `v1`+`v2` 两把密钥（步骤 1 先于步骤 2），所以「旧实例写 v1、新实例读 v1」「新实例写 v2、旧实例读 v2」都能成立，不存在读写代际错配。

### 8.3 为什么没有「批量重加密」这一步

现有数据靠「写时顺带」自然升级：每次 `commitSnapshot` 重写整场玩家行、每次重扫把该行带到当前版本；归档表是 append-only，不允许 UPDATE，也不打算重写。

### 8.4 旧版本密钥能不能删？—— 这是本次轮换方案里最容易被忽略的一条

分两种数据看：

| 数据 | 退役条件 | 退役后风险 |
|---|---|---|
| `player` / `identity`（运行态） | 该版本密文行为 0（§7.2 第 4 条），且没有仍在进行的场次存着旧行 | 若还有残留，**场次加载会抛 `KeyConfigError`**（读路径会解密每一行）→ 该场次直接打不开 |
| `round_archive_entry`（归档） | 归档不做 UPDATE，每行永远是写入时那一版；导出只输出 ref，运行期不解密 | 删掉私钥后，这批归档的 `member_enc` **永久无法复原**（只能靠 ref 做匿名对账） |

因此推荐两条明确路线，二选一写进运维手册：

- **路线 A（推荐，保守）**：运行环境只保留「仍有运行态数据」的版本（通常当前版 + 上一版），更早的私钥**离线归档保管**（密码库/HSM 冷备），需要复原历史归档时临时注入再撤回。密钥库按版本号索引，永不销毁。
- **路线 B（严格合规）**：要求任何时点只有一把私钥在线。前提是接受「历史归档不可复原」，并把这个结论写进数据留存策略；同时必须保证退役前 `player` / `identity` 里没有该版本的行（否则场次打不开）。

无论哪条路线，`MEMBER_ID_PEPPER` 都不参与轮换。

### 8.5 回滚

密钥都在 env 里，回滚就是改回去：

```
MEMBER_ID_KEY_VERSION=1   # 回退写入版本（v2 的行仍可读，因为 v2 密钥还在）
```

只有「删了新版本密钥」之后才不可逆 —— 所以退役动作必须放在观察期之后，并且先做一次备份验证。

### 8.6 密钥保管要点

- `MEMBER_ID_PEPPER` 丢失 = 所有 ref 无法重算（新扫码会被当成新会员，历史身份线断裂）；泄露 = 会员号低熵可被字典反推。它与 DEK 分开托管。
- 私钥只用于解 DEK，**不下发到任何前端**，不进日志（启动日志只打版本号）。
- `.env` 已在 `.gitignore` 和 `.dockerignore` 里；部署环境用平台 secret，不要用镜像内文件。
- 轮换演练建议先在预发环境跑一遍 §8.2，特别是「只装 v2 时旧行报错」这条负向路径。

---

## 9. 已知残留与限制（必须知情）

1. **不存在明文历史行，因此没有明文兼容路径。** 代价是：如果库里真出现一行 `member_enc IS NULL`（人为改库、迁移脚本写错、从别的环境导入），该场次会**直接打不开**并报 `缺少密文`。这是有意的——静默猜测只会让身份线错得更隐蔽。排查语句见 §7.2 第 2/3 条。

2. **展示层是「脱敏」不是「密文」**。大屏/员工端显示 `****1234` 而不是 58 字符的密文：密文铺到屏上既不可读，也会被同事截图带走。若合规口径要求「展示密文」，把 `maskedId` 换成 `#` + ref 前 6 位即可（改 `mask()` 一处）。**注意后 4 位相同的两个人 maskedId 会撞**，唯一标识始终是 ref。
3. **导出不再含原文**。需要「导出即给原文」的场景（比如把名单交回业务方）当前没有接口；要做就单独加一个 `admin` + 写审计 + 二次确认的复原接口，不要在 CSV 里开口子。
4. **加密不等于「拖库也无所谓」**。攻击者拿到库 + env 就能解密；本方案的作用是把「明文裸奔」变成「必须同时拿到密钥」，密钥与数据分离（secret 平台 / KMS）才是关键。
5. **`identity` 的 ref 与 `player` 的 ref 必须同一套 pepper**，否则同一个人会被当成两个人。多实例必须共享同一份 env。
6. **`member_enc` 长度会涨**：AES-GCM 每条 58 字符（≈46 字节），一场 500 人约 23 KB，可忽略；这也是没选「每行一次 RSA」的原因之一。

---

## 10. 变更清单速查

```
新增  lib/member-id.js
新增  scripts/member-keygen.mjs
新增  test/member-crypto.test.mjs
改    db.js         initDb / SNAPSHOT_SQL / rowToSession / playerColumns / commitSnapshot / archiveRoundInTx / archiveEntryRows
改    server.js     require / start / /api/scan / buildStatePayload / publicPlayers / bigscreenPlayers / /api/confirm / export.csv
改    public/staff/app.js  public/bigscreen/app.js  public/index/app.js
改    test/helpers.mjs + 8 个既有测试文件的 pid 断言
改    test/run.mjs  package.json  .env(本地)  DEPLOY.md  README.md
```

---

## 11. 命名说明

三种表示在代码里固定叫 **ref / enc / maskedId**（接口字段 `players[].id`、`players[].maskedId`）：

- 不叫 `label`：`label` 在 `public/index/app.js` 已经是「摄像头名」、在 `public/staff/app.js` 是「员工显示名」，
  同一个文件里一词三义，读代码要靠猜（详见 `docs/naming-convention.md` §2.1）。
- 不叫 `memberNo`：它不是会员号，是「脱敏后的会员号」，叫回原名会让人以为能反查。
- `pid` 保留：把它改成 `playerId` 是另一件事（约 206 处纯机械替换，含 localStorage key，会让已扫码玩家掉身份），
  本次不动；要做单独立项，见 `docs/naming-convention.md` §4 A 档。
