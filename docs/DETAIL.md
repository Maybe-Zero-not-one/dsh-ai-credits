# 赛博鸡蛋领取处

一个 DSH 插件，把「能领免费额度的地方」「各家 API 标价」「订阅档位」「这台机器接了哪几家模型」和「这些线路到底用了多少 token、折多少钱」放在同一页。

## 六个栏目

| 栏目 | 内容 |
|:--|:--|
| **领取入口** | 各家的免费额度 / 代金券 / 学生包入口，每天自动巡检一遍，记下能不能打开；**每一栏按「能打开 / 打不开 / 待检查」分三栏**，点不开的可以一键删掉 |
| **各家价格** | API 官方标价（每百万 tokens，输入 / 输出分列），按币种和地区分组 |
| **通用订阅** | 各家的 Token Plan / 会员 / Coding Plan，同一厂商的档位排在一列 |
| **编程工具订阅** | **限定本家编程软件使用**的订阅（WorkBuddy / CodeBuddy / Qoder / Trae / Cursor / Copilot 等） |
| **接入情况** | 你当前的 DSH 接了哪几条线路、每条有哪些模型、密钥配没配、新会话默认用哪个、**以及这条线路算哪种计费（订阅 / 按量 / 折算）**，判错了可以手选改 |
| **用量花费** | 各线路 token 用量与金额；点开任一渠道可展开**按会话分段的 token 时间轴** |

## 订阅价从哪来（2.4.3 起）

订阅那两个栏目（通用订阅 / 编程工具订阅）**主数据源换成聚合站 codingplan.fyi**：

| 项 | 以前 | 现在 |
|:--|:--|:--|
| 数据来源 | `plans.js` 人工抄的 65 条 | codingplan.fyi 的 `plans.json`（197 条，剔除 50 个已下架 → 145 条） |
| 覆盖平台 | 15 家 | 40 家 |
| 每天网络请求 | 65 个官网页面逐个探 | 3 个聚合端点 + 15 个厂商代表页（备用） |
| 刷新节奏 | 20 小时 | 聚合数据 6 小时缓存，页面巡检 20 小时 |

聚合站拿不到时**自动回退**到 `plans.js` 的本地快照，卡片标「聚合」/ 顶部提示「这次没取到，显示本地快照」——不会拿旧数字冒充新的。

三个端点：

```
https://codingplan.fyi/plans.json       套餐：价格 / 额度 / 支持模型 / 备注
https://codingplan.fyi/platforms.json   平台：名称 / 状态（open / restricted / delisted）
https://codingplan.fyi/config.json      汇率 / 更新日期
```

**没有采用**聚合站的 `action` 字段（那是它的推广跳转链接），卡片一律链到 `codingplan.fyi` 首页，让人自己看详情。

## 删掉点不开的入口

每个入口卡片右上角有个 **✕**。删掉以后：

1. **留档**：URL、标题、分类、当时的 HTTP 状态、删除时间都记进 `catalog.json` 的 `removed`
2. **种子不会复活**：内置清单每次启动都会并回状态里，但删过的会被跳过 —— 否则「删了又回来」等于没删
3. **再搜到只标存疑**：联网发现撞上已删除的链接，**不会**把它加回清单，只把那条留档的 `hits +1` 并标 `suspect`，底部「已删除的入口」里显示「存疑 ×N」
4. **能恢复**：底部面板展开，每条后面一个「恢复」按钮；种子会按内置清单补回，联网发现的直接放回「每日新发现」

`removed` 只在 `$DSH_HOME/ai-credits/catalog.json` 里，不上传。

## 线路算哪种计费：自动判定 + 手选

用量栏里的金额分三种口径，靠一张白名单自动判：

| 标记 | 含义 | 折钱吗 |
|:--|:--|:--|
| **按量计费** | 按 token 后付费，真花钱 | 折真金白银 |
| **套餐 · 折算** | 卖的是套餐/积分包，但折一个「拿官方价买要多少钱」当参考 | 折，但标「等价」 |
| **订阅 · 不折钱** | 只报 token 和积分 | 不折 |

白名单总会漏 —— 新线路、自建线路、连接器内部 id 都不在里面，落进「订阅」只报 token（安全默认，但可能判错，比如一条其实按量扣费的线路会被当成不花钱）。

所以「接入情况」栏每条线路都带一行计费信息：

```
计费  订阅 · 不折钱  按白名单自动判定；判错了可以手选        [API 按量][订阅][折算]
```

点右边三个按钮就改成对应口径，改完立刻重算（用量栏金额跟着变）。手选过的会标「手选」，并多一个「自动」按钮用来退回白名单判定。

手选存在 `$DSH_HOME/ai-credits/billing.json`，形如：

```json
{ "volcengine-live": "token", "trae": { "mode": "estimate", "planType": "coding-plan", "subscribedAt": "2026-10-15" } }
```

只在本机，不上传。删掉这个文件就全部回到自动判定。

### 订阅详情（2.7.0 起）

线路标成「订阅」后多一行小表单，记三样东西：

- **订阅形式** `planType`：`agent-plan` / `token-plan` / `coding-plan` / `token-pack`（特价 token 包）/ `other`。选定后从 `plans.js` 套餐快照里挑「建议价」——按关键词对套餐 **id + 标题** 一起匹配（`agent-plan` 匹配 id 含 "agent" 的档；只匹配标题不够，火山的 id 是 `volcengine-agent-*` 而标题写「Token Plan」）。匹配不上就把全部候选档摆出来标 `matched:false`，套餐表没这条线路的直接提示手填。
- **首次订阅** `subscribedAt`（`YYYY-MM-DD`，2.7.5 改口径）：`subscriptionPeriod(subscribedAt, now, termMonths, autoRenew)` 按自然月推进算「现在第 N 期 + 本期起止 + 已订天数」。月末订阅（1-31）各期钳到当月最后一天。实现用「起点 + 月数直接算」而非逐月 +1 推进——推进式钳过月末后 day 变了（31→28）会原地踏步死循环，单测 `test-subscription.mjs` 专门盯着这条。**autoRenew=true（默认）= 连续订阅：到期日 = 包含今天的这一期结束，自动对齐不用手改；false = 一次买断：到期 = 首订 + term，过期如实标**（`test-renew-align.mjs` 盯着这条）。过了首期还挂着优惠说明，界面提醒「续费价以实际扣款为准」。
- **本期实付** `monthlyCNY` + **优惠说明** `promoNote`（如「首月半价」「40元抵80元」，纯备忘不参与计算）。

三个字段都向后兼容：老记录没有它们就是 `null`，界面照常工作。校验都在 `/billing` POST 路由（planType 认枚举、subscribedAt 认日期格式、promoNote 截断 80 字）。

### 订阅时长与本次实付（2.7.1 起）

- **`termMonths`**（1~120 月）：`subscriptionPeriod(subscribedAt, now, termMonths, autoRenew)` 的第三参。周期按 `idx * term` 推进，年付一个周期跨 12 个月；另返回 `expiresAt` / `daysLeft` / `expired` / `autoRenew` 供界面做到期提醒。不填按 1 个月算（老行为）。
- **`paidTotal` + `paidCurrency`**：一个周期实付**总额**。`effectiveMonthlyCNY = 总额 ÷ termMonths`（美元先乘汇率），这才是跟等价用量比的**等价月付金额** —— 拿年费直接比会得出「贵 12 倍」的假结论。没填总额就退回老的 `monthlyCNY`（界面「按月」框，不论月付/季付/年付都填等价月付）。
- `subscriptionWorth[].refSource` 因此多一档 **`paid`**（原只有 `manual` / `plan`）。⚠ 前端有 4 处按 refSource 分支显示文案，加新档时**四处都要接**，否则来源会被显示成「套餐表」、折算明细里手填参考价的 chip 会消失（2.7.1 开发时踩到，回归探针的 chip 计数从 4 掉到 0 才发现）。

### 额度池订阅 `quota-pool`（2.7.1 起）

OpenCode Go 那种：付一笔**基础价**（$10），各家模型各给一笔额度（DeepSeek $100、Kimi K3 $15）。

算法在 `quotaPoolSpend(pool, usedByModel)`：

```
单模型消耗 = 基础价 × min(1, 该模型用掉的额度 / 该模型额度)
总消耗    = min(基础价, Σ单模型消耗)      ← 超了按比例缩回各行
剩余      = 基础价 × (1 - 总消耗/基础价)
```

**两道封顶都不能少**：单模型钳 100% 防倒扣；总额钳基础价防「两个模型都超额 → $10+$10=$20 > $10」。少第二道会让「已消耗 + 剩余 ≠ 基础价」（单测 `test-quota-term.mjs` 盯着这条）。

配置存 `basePrice` / `baseCurrency` / `quotaPools: [{model, quota}]`（最多 40 条）。`usedByModel` 目前拿**按官方价折出的美元金额**当近似（这家没开放按模型的额度扣减明细），所以结果标 `estimated: true`，界面写明是估算。模型 id 对不上就 `matched: 0`，界面不摆假账。

### 多账号检测（2.7.1 起）

连接器自己的 `/plugins/dsh-connect-*/usage` 就带 `accounts: [{id, accountName, selected}]` + 顶层 `accountId`，**不用扒它们的私有文件**（`.qoder-accounts.cn.json` 那些）。页面同源去问（宿主问不了自己），只取 id / 昵称 / 是否当前，不碰 token/pat。

⚠ 与积分读取分开：**账号数登出也要报**（trae 现在 signed-out 但存着 2 个账号），所以 `readAccounts` 不看 `status`，而 `readCreditBook` 仍然只在 `signed-in` 时读。

### 未配置线路与按量家族兜底（2.7.1 起）

- **`looksTokenBilled(provider)`**：白名单 `TOKEN_BILLED` 之外，按 id 形状补判 `<家族>-<后缀>`（家族 = volcengine / ark / siliconflow / deepseek / tokenplus）算按量；但**含 plan/subscription/member/vip 字样的一律不算**（`ark-agent-plan-cn` 是套餐）。修的是 `volcengine-live` 这类新通道掉进「安全默认=订阅」的问题。
- **`route.unconfigured`**：`credential.configured === false`，或「没有密钥位 + 没有 settings 位 + 零模型」（空挂的壳）。自带登录的连接器（trae/qoder/workbuddy/本地 CLI）没有密钥位但**有模型**，不算未配置。界面默认收起这些，给「显示未配置（N）」开关；**搜索时不藏**。

### 本地 CLI agent：`unknown` 档（2.7.2）

`local-claude-code` / `local-codex-cli` 原来**硬编码在 `CREDIT_ROUTES`** 里，无条件判成订阅。但这些 id 是 **ds-bot 注册的本地命令行 agent**（见 `ds-bot/src/host/local-agents/engines.js`），不是 DSH 买的订阅 —— 它可能 OAuth + Pro/Max 订阅、可能 API key 按量、也可能没登录。

改法：
- `LOCAL_CLI_AGENTS` 表记各家凭据文件与 API key 环境变量名（照 ds-bot 的 `signedIn` 口径）。`probeLocalCliAuth()` **只 `existsSync` 看文件在不在，绝不读内容**。
- `auto()` 对 `local-*`：探到 → `credits`，探不到 → **`unknown`**（新档，标签「未确认」）。
- `unknown` **不在 `BILLING_MODES` 里**（不是手选档位，只是自动判定的一个出口），但要贯通：宿主+前端 `BILLING_LABELS`、`byBilling`/`byMode`、用量聚合的 `creditTokens` 累加（两处都要排除）。
- ⚠ **`priced()` 必须改成白名单式**（`mode === 'token' || mode === 'estimate' || foldCredit`）。原来是 `!== 'credits'` 排除法，加了 unknown 后会把它当成要折钱，凭空多出假花费。

### OpenCode Go 官方额度表（2.7.2）

`opencode-go.js` 是官方快照，来源 **`https://opencode.ai/inference/go/v1/models`（公开端点，不用鉴权）**，文档 <https://opencode.ai/docs/console/go>。

官方口径（文档原话）：「$1.50 of usage on a model with a $15 limit uses **10%** of your monthly allowance. So does $6 on a model with a $60 limit.」→ 各模型额度是**同一个月度额度池的百分比刻度**。

- `OPENCODE_GO_MODELS`：37 个模型 × 三档额度（`go` / `go-plus` / `go-teams`）+ 官方单价（`input` / `output` / `cacheRead` / `peakFactor`）
- `normalizeGoModel()`：去 provider 前缀（`opencode-go/kimi-k3`）、去日期后缀（`-261017`）、大小写归一
- `goUsageUSD()`：按**这家自己的官方单价**把 token 折美元。没有 `cacheRead` 单价的按输入价算（保守，不虚低）
- `buildGoPool(modelIds, tier)`：拿线路实际模型逐个对官方表，生成 `{basePrice, pools, unmatched}` 供界面一键填
- 折算时 `priceSource: 'opencode-official'` → `estimated: false`；其他家仍走 `vendor-estimate`

⚠ **别再拿原厂价折 Go 的用量**：2.7.1 用 DeepSeek 原厂价算出 $15.69，官方单价实际 $14.73，偏差 6.5%。

更准的路子（还没接）：官方响应头 `opencode.allowance` 报每次请求吃掉多少额度；`/inference/go/v1/usage` 给 rolling/weekly/monthly 三个限额的已用百分比。都需要 Go 的 API key。

#### 实时检索（2.7.3）

`fetchGoModels({force})` 宿主直接拉公开端点（6h 缓存 / 15s 超时 / sanity：≥10 个带额度模型且额度 <100000）。失败保留上次成功值（stale），再不行退快照 —— 照 pricing-sync.js 的规矩，绝不用半截数据覆盖。

- `currentGoModels()`：同步读「当前最好的表」（实时缓存优先），`goModelLimit` / `goModelPrice` / `normalizeGoModel` / `buildGoPool` 全走它 → **折算自动跟着实时表**。
- `searchGoModels(query, models, routeModelIds)`：全表检索，本线路有的排前面（id 归一后比对），其余按 Go 额度降序。
- payload `opencodeGo` 段：source/at/count/tiers/models 全表；`/list`、`/dsh`、`/refresh` 三个口都带，`/dsh?refresh=1` 强制刷新表。
- 界面全表在额度池区「查全部模型额度（N）▾」展开，前端本地过滤（goTableQuery state）。

### 多账号逐账号订阅状态（2.7.2，2.7.3 强化）

连接器 `/usage` 的 **`pool.accounts[]`** 带 `member`（是否会员）、`credits`、`planExpiresAtMs`、`current`、`checkedInToday`；`pool.memberAccountIds` / `effectiveMemberAccountIds` 兜底。`readAccounts()` 按 accountId 关联，会员判定优先 `pool.member`，退回落名单，两样都没有 → `null`（界面标「订阅未知」，不瞎猜）。

**过期核查（2.7.3）**：`member === true` 但 `planExpiresAtMs <= now` → member 降为 false、标 `planExpired`（连接器的会员标记可能是缓存旧状态）。界面红色「订阅已过期」，徽标「M/N 已订阅」的 M 不含过期账号。

### 国内官方档位 `cn-tiers.js`（2.7.4）

plans.js 的 Qoder / WorkBuddy 条目是**国际版 USD 价**，国内账号拿它折 ¥7.2 当参考是错的。`cn-tiers.js` 只收国内官方口径（CNY，2026-11-27 核对）：Qoder CN（0/59/169/559）、TRAE（0/49/99/239/699）、WorkBuddy（0/99/199/999）、码道（0/98/198/498），每档带官方名称、促销价与说明、每月积分。

- **`planTier`** 字段：只认表里存在的档位 id（`cnTierById` 校验），全链路贯通（normalize / save / reconcile / POST / 自动清空）。
- **参考价优先级**：官方档位（`refSource='tier'`，单点国内价）> 实付÷月数（paid）> 手填（manual）> plans.js（plan）。⚠ 前端 refSource 分支**三处**都要接新档（坑 #20）。
- **`billingClassOfTerm(termMonths)`**：1~2 → monthly（**两月限时优惠仍归月付挡**）、3~11 → quarterly、12+ → yearly。`billingClass` 透出到 route.billing 与 subscriptionWorth。
- 国际版账号走 `qoder-global` 的 USD 档（表里单列），本机国内账号默认不走。
- **档位付费周期（2.7.5）**：每档带 `cycleMonths`（1 月付 / 12 包年）与 `cycleCNY`（一次付多少）；`cnTierById` 对没写的档兜底成月付、cycleCNY=月价×周期。码道拆出月付/包年共 7 档（包年 823.2/1663.2/4183.2，等价 68.6/138.6/348.6 每月）。界面选档自动把 termMonths 对到该档周期，没填实付时按 cycleCNY 预填。

### 「自动」按钮条件与账户订阅对齐（2.7.5）

- **`resettable`**（usage.js billingRules → describeBilling → dsh-api → client）：「自动」按钮只在**手选了模式**（mode 非空）或**订阅档开了折算**时出现。老条件 `touched`（表里有没有记录）会让只填过额度池/快捷时长的 opencode-go / ark / qoder 一直挂着按钮。按钮语义收窄为「退 mode + 关折算」，订阅信息另给「清空订阅信息」chips。`touched` 字段保留兼容但界面不再用它。
- **`accountPlan` / `accountSyncedAt`**：账户订阅快照 `{ name, planName, planTier, expiresAt, periodStart, source, atMs }`。页面同源读连接器：Qoder `credits.planExpiresAtMs`；WorkBuddy `credits.packages` 里 `monthly:true` 的包名（「CodeBuddy个人体验版」）+ `cycleRefreshMs`；**CodeArts 走 `/api/codearts/status` 的 `credits.credits`（planName / periodStart / periodEnd，最全）**；Trae 只给账号列表，读不到就明说。⚠ **金额（首次订阅时间 / 实付）账户里没有**，永远手填；有效期靠 subscriptionPeriod 从首订日推算对齐。「对齐到账户」按钮把快照 POST 进 billing.json，`matchTierByName` 按关键词（体验版→free、专业→pro…）对上官方档位时顺手选 planTier。
- 新字段全链路：normalize（usage.js + index.js 两份必须镜像）/ saveBillingOverrides 紧凑写 / reconcile 保留 / POST 校验（autoRenew 认布尔、accountPlan 认对象、accountSyncedAt 认正毫秒）。

⚠ `accountsPanel` 在 routeCard 里（约 2497 行），**不能引用用量栏的 `fmtCredits`**（3655 行才声明，const 箭头函数不提升 → TDZ → 整页消失，坑 #1）。面板内自带 `fmtAccCredits`。

## 用量花费怎么算

分三类，因为不是所有线路都在花现金：

- **按量计费**（`deepseek-official` / `deepseek-account` / `siliconflow` / `volcengine` / `ark-cn` / `ark-byteplus` / `tokenplus`）→ 折真金白银的金额
- **套餐 · 等价参考**（`qwen-token-plan` / `opencode-go`）→ 按官方价折算，但明确标注「不是账单」
- **纯套餐 / 订阅**（Trae / Qoder / WorkBuddy / CodeArts / Ark 各 Plan 等）→ 只报 token 和积分，不折金额

金额计算考虑了：

- **分时价（峰谷）**：DeepSeek 工作日 9:00-12:00、14:00-18:00 为高峰；SiliconFlow 只在凌晨 2:00-8:00 给低价。每家用自己的时区判断，**每条调用按自己的时间戳算**，不是拿总量套一个价
- **缓存命中 / 未命中**：日志里 `inputTokens` 是未命中部分、`cacheReadTokens` 是命中部分，单价差几十倍，分开算
- **法定节假日**：内置 2026 年节假日表，那些天全天按空闲价
- **联网搜索**：`function_call` 按次计费（¥5/千次），单列，不计入 token

价格不靠人工抄：宿主会**实时拉 DeepSeek 官网价目表**解析，拉到就以官网为准，拉不到才用本地快照。三重校验防止抓错价。

## 云端出图 / 生视频花费（2.6.0 起）

调云端模型画图 / 生视频的钱单独统计（不并入 token 折算），数据两处来：

- **会话日志**里 `cloud_image_generate` / `image_generate` / `cloud_video_generate` / `cloud_video_task` 的 `tool/call`+`tool/result` 事件对（Agent 那条道）
- **影像工坊面板账本**：`cloud-media-ui.log` + `.cloud-media-state.json`（网页面板手动操作那条道）

两边按**产物文件名**去重。计价：生图**按张**（部分模型按输出像素分档），生视频按官方 token 估算公式（`时长×宽×高×帧率/1024` × 元/M token 单价），所以视频金额标「估算」。只有生成成功的才计费。价格表在 `media-prices.js`（人工核对官方价，带快照日期）。本地模型（SDXL / ComfyUI）出的图不计 —— 不花钱。

## 时间轴

点开任一渠道，行内展开一张图：**横轴是时间，每一行是一个会话**，柱子高度是那一段消耗的 token。subagent 派生的子会话会缩进挂在父会话下面，所以既像时间轴又能看出调用关系。

## 可选：导入官方用量对账

DeepSeek 没有用量查询 API，但开放平台能导出 CSV。「用量花费」栏底部有 **官方账单** 区块：

1. 在 platform.deepseek.com 选好时间段，导出用量
2. 点「导入官方账单」，**直接选那个 .zip，不用解压**
3. 页面立刻刷新，显示官方总额卡 + 按 API key 的逐条明细

之后导入会同名覆盖，不用手动清理旧文件。

**不导入也完全能用** —— 只是少这一栏对照，其余统计照常。

## 需要的环境

- **DSH 0.2.2 或更新**（`engines.dsh` 已声明）
- 不需要任何 npm 依赖，不需要构建

放了哪些外挂数据就有多少功能，都没有也能跑：

| 依赖 | 没有时会怎样 |
|:--|:--|
| `dsh-connect-trae` / `-qoder` / `-workbuddy` 等连接器 | 对应线路的「剩余积分」显示「积分未知」，token 照常统计 |
| 官方用量 CSV | 「官方账单」和逐 key 对比不显示 |
| `.dshw-usage.json`（另一个插件采的 DeepSeek 余额） | 「实际扣费」显示 `—` |
| 某个 provider 不在按量白名单里 | 按「套餐」处理，只报 token 不折金额（安全默认，不会编错数） |
| 官方 CSV 用到的模型名对不上价格表 | 只统计 token，标「没有标价」，不编一个数 |

## 已知限制

- **官方账单里哪个 key 对应哪条线路**，靠 key 名字猜（含 `harness` / `app-managed` 的算账号线路，唯一一个纯数字短名算 API 线路）。猜不准就不显示那栏对比，不影响金额。想精确对应，在插件配置里写 `officialKeyMap`。
- **积分只到线路级、不到模型级**：官方接口只给整条线路的累计消耗，没有按模型拆分的明细，所以模型那里只列 token 占比，不硬摊积分。
- **fork / 分支会话的重复事件已自动去重**：DSH 会把父会话的历史事件原样复制到分叉会话里（时间戳和 usage 都相同），插件按「时间戳+渠道+模型+四类 token」八字段指纹判重并剔除，条数显示在用量栏顶部。
- **折算金额不等于官方账单**：日志统计的是 DSH 这一侧的调用，官方账单是整个账号。差额主要来自「搜索 / 标题生成」这两类不产生 `assistant/message` 的调用，以及别处使用同一账号的消费。
- 价格数字里，DeepSeek 自动跟官网；**其他厂商是人工核对的快照**，改价后需要更新 `prices.js` / `plans.js`。
- **订阅价依赖第三方聚合站**：codingplan.fyi 挂了或改了结构，订阅栏目会回退本地快照（`plans.js`），数字可能过期。聚合站自己也标注「价格以平台官方公布为准」，下单前请看官网。
