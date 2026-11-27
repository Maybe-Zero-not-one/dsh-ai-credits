/**
 * ai-credits · 本机 DSH 接入情况
 * ============================================================================
 * 「这台机器上的 DSH 到底接了哪几家 API」—— 全部走宿主自己的活服务问，不读配置文件、
 * 不猜、不碰密钥值：
 *
 *   ctx.llm.listProviders()              现在挂着几条线路（含 trae / workbuddy 这类自带登录的）
 *   ctx.llm.listModels(provider)         每条线路现在能用哪些模型
 *   ctx.llm.listConfigurableProviders()  这条线路的设置在哪个 settings 命名空间下
 *   ctx.settings.describe()              只取 api / baseURL / apiKeyEnv 三个安全字段
 *   ctx.credentials.describe(ref)        这个密钥「配了没 / 从哪来 / 能不能改」，绝不返回值
 *   ctx.get('agentDefaultModel')         新会话默认用哪条线路的哪个模型
 *
 * 任何一步拿不到都只是少一列，不会让整页挂掉 —— 每段都单独兜住。
 * ============================================================================
 */

/** 缓存 30 秒：页面每 60 秒轮询一次，而 listModels 对某些线路会碰网络 */
const CACHE_MS = 30000

import { describeBilling, subscriptionPeriod } from './usage.js'

const isStr = (value) => typeof value === 'string' && value.length > 0

const msgOf = (error) => String((error && error.message) || error || '未知错误')

/** 从一份 profile 里只挑能公开的几个字段，别的一概不带出去 */
function pickSafeProfile(profile) {
  if (profile === null || typeof profile !== 'object') return {}
  const out = {}
  if (isStr(profile.displayName)) out.displayName = profile.displayName
  if (isStr(profile.api)) out.api = profile.api
  if (isStr(profile.baseURL)) out.baseURL = profile.baseURL
  if (isStr(profile.apiKeyEnv)) out.apiKeyEnv = profile.apiKeyEnv
  return out
}

function walkPath(root, path) {
  let current = root
  for (const key of Array.isArray(path) ? path : []) {
    if (current === null || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/**
 * 一次把 settings 全读出来，按 ns 建索引。
 * settings 服务只有 describe()，没有 get()；describe 是异步的，失败就当没有。
 */
async function readSettingsIndex(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.describe !== 'function') return new Map()
  try {
    const list = await settings.describe({ redactSecrets: true })
    const rows = Array.isArray(list) ? list : Array.isArray(list && list.namespaces) ? list.namespaces : []
    const index = new Map()
    for (const row of rows) {
      if (row && isStr(row.ns)) index.set(row.ns, row.value)
    }
    return index
  } catch (error) {
    return new Map()
  }
}

/** 密钥状态：只问「配了没」，describe 按约定不返回任何值 */
async function describeCredential(ctx, ref) {
  if (!isStr(ref)) return null
  const credentials = ctx.get('credentials')
  if (credentials === undefined || typeof credentials.describe !== 'function') {
    return { ref, configured: null, source: null, writable: null }
  }
  try {
    const info = await credentials.describe(ref)
    return {
      ref,
      configured: info && info.configured === true,
      source: (info && info.source) || null,
      writable: info && info.writable === true,
    }
  } catch (error) {
    return { ref, configured: null, source: null, writable: null, error: msgOf(error) }
  }
}

/** 新会话默认选谁 */
function readDefaultSelection(ctx) {
  const service = ctx.get('agentDefaultModel')
  if (service === undefined || typeof service.currentSelection !== 'function') return null
  try {
    const selection = service.currentSelection()
    if (!selection || !isStr(selection.provider) || !isStr(selection.model)) return null
    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort ? String(selection.reasoningEffort) : null,
    }
  } catch (error) {
    return null
  }
}

/** 线路 id → 它的 settings 位置（pi-ai 是 llm-pi-ai + ['providers', id]，deepseek 是 llm-deepseek + []） */
function readDirectory(llm) {
  if (llm === undefined || typeof llm.listConfigurableProviders !== 'function') return []
  try {
    const list = llm.listConfigurableProviders()
    return Array.isArray(list) ? list : []
  } catch (error) {
    return []
  }
}

/** 从 settings 里把这条线路的 profile 挖出来（路径由目录给，可能是 [] 也可能带 providers/id） */
function profileOf(entry, settingsIndex) {
  if (entry === null || !isStr(entry.settingsNs)) return {}
  if (!settingsIndex.has(entry.settingsNs)) return {}
  return pickSafeProfile(walkPath(settingsIndex.get(entry.settingsNs), entry.settingsPath))
}

async function collectRoutes(ctx, llm, directory, settingsIndex, billingInfo) {
  let providers = []
  try {
    const list = llm.listProviders()
    providers = Array.isArray(list) ? list : []
  } catch (error) {
    return { routes: [], error: msgOf(error) }
  }

  const routes = []
  for (const info of providers) {
    const id = isStr(info && info.id) ? info.id : null
    if (id === null) continue

    let models = []
    let modelsError = null
    try {
      const list = await llm.listModels(id)
      models = (Array.isArray(list) ? list : []).map((model) => ({
        id: String(model.id),
        name: String(model.name || model.id),
        inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities.slice() : null,
      }))
    } catch (error) {
      modelsError = msgOf(error)
    }

    const entry = directory.find((item) => item && item.provider === id) || null
    const profile = profileOf(entry, settingsIndex)
    const credential = await describeCredential(ctx, profile.apiKeyEnv)

    // 计费方式：白名单自动判定 + 用户手选覆盖。三种：
    //   token    按量计费，真花钱
    //   estimate 套餐制但折一个等价金额（标「等价」）
    //   credits  纯订阅，只报 token 不折钱
    // 订阅那一档还能再叠一个「折算」开关（订阅 + 折算），算等价金额但仍是订阅。
    const autoMode = billingInfo.auto(id)
    const mode = billingInfo.effective(id)
    const override = billingInfo.override(id)
    const folded = billingInfo.foldCredit(id)
    // 订阅三件套（形式 / 订阅时间 / 优惠说明）+ 套餐表建议档 + 当前计费周期
    const planType = billingInfo.planType(id)
    const subscribedAt = billingInfo.subscribedAt(id)
    const promoNote = billingInfo.promoNote(id)
    const planSuggestion = billingInfo.planSuggestion(id)
    // 这一次订阅了多久（月）：年付要按 12 个月摊，周期也按 12 个月推
    const termMonths = billingInfo.termMonths(id)
    // 自动续费（2.7.5）：null 按 true —— 周期自动对齐到包含今天的最新一期
    const autoRenew = billingInfo.autoRenew(id)
    const period = subscribedAt !== null ? subscriptionPeriod(subscribedAt, Date.now(), termMonths, autoRenew) : null
    const paid = billingInfo.paid(id)
    const quotaPoolCfg = billingInfo.quotaPool(id)

    /**
     * 「这条线路在本机是不是还没配起来」（2.7.1）。
     *
     * 两种没配：
     *   1. 有密钥位但没填（credential.configured === false）—— 火山方舟那几个没加 API 的通道；
     *   2. 压根没有密钥位、也没有 settings 位、且一个模型都列不出来 —— 空挂的壳（volcengine-live）。
     *
     * 自带登录的连接器（trae / qoder / workbuddy / 本地 CLI）没有密钥位但**有模型**，
     * 不算没配；deepseek-account / siliconflow 这类有模型的也不算。
     * 界面默认把这些没配的收起来，别拿一堆点不动的空通道占屏。
     */
    const unconfigured =
      (credential !== null && credential.configured === false) ||
      (credential === null && entry === null && models.length === 0)

    // 本地 CLI agent（2.7.2）：本机有没有登录凭据 —— 没登录就不该算订阅
    const localCli = billingInfo.localCli(id)
    // opencode-go：拿这条线路实际有的模型对官方额度表，给界面「一键填额度」用
    const goPool = id === 'opencode-go' ? billingInfo.goPoolSuggestion(models.map((m) => m.id), 'go') : null

    routes.push({
      id,
      name: isStr(info.name) ? info.name : id,
      api: profile.api || null,
      baseURL: profile.baseURL || null,
      settingsNs: entry && isStr(entry.settingsNs) ? entry.settingsNs : null,
      settingsPath: entry && Array.isArray(entry.settingsPath) ? entry.settingsPath.slice() : null,
      credential,
      models,
      modelCount: models.length,
      modelsError,
      // 本机还没配起来（界面默认隐藏，可展开查看）
      unconfigured,
      // 本地 CLI agent 的登录态（不是这类线路就是 null）
      localCli,
      // ---- 计费分类 ----
      billing: {
        mode,
        auto: autoMode,
        override,
        manual: override !== null,
        // 订阅线路额外打开了折算：仍是订阅，但会算等价金额
        folded,
        // 折算开关本身的状态（订阅 / 套餐两档都可能是 true，界面按钮高亮用）
        estimate: billingInfo.estimateFlag(id),
        label: billingInfo.label(id),
        // 手选过、且和自动判定不一样 —— 界面提示「已按你的选择」
        changed: override !== null && override !== autoMode,
        // 表里有没有这一条（老口径，保留兼容）
        touched: billingInfo.touched(id),
        // 「自动」按钮要不要出现（2.7.5）：只有口径覆盖（手选模式 / 订阅+折算）才算
        resettable: billingInfo.resettable(id),
        // 你手填的参考月费（人民币），没有就是 null
        monthlyCNY: billingInfo.monthlyCNY(id),
        // ---- 订阅三件套：形式 / 订阅时间 / 优惠说明（都只在 credits 线路有意义）----
        planType,
        planTypeLabel: planType !== null && billingInfo.planTypeLabels ? billingInfo.planTypeLabels[planType] || null : null,
        subscribedAt,
        promoNote,
        // 从套餐表按订阅形式挑的参考档（plans 数组 + 最低/最高价 + 是否精确命中）
        planSuggestion,
        // 当前计费周期：第几期、本期起止、距订阅多少天（订阅时间没填就是 null）
        period,
        // ---- 订阅时长与实付（2.7.1）----
        // 这一次订阅了多久（月）；null = 没填，周期账按 1 个月算
        termMonths,
        // 本次实付总额 + 币种（年付就是年费）
        paid,
        // 折合月费 = 实付 ÷ 月数；没填实付就退回手填月费
        effectiveMonthlyCNY: billingInfo.effectiveMonthlyCNY(id),
        // 额度池订阅的配置（基础价 + 每模型额度）；实际折算在 usage 那边按用量算
        quotaPoolConfig: quotaPoolCfg,
        // opencode-go 的官方额度池建议（一键填进 quotaPools）
        goPoolSuggestion: goPool,
        // ---- 官方档位与计费挡位（2.7.4）----
        // 选定的国内官方档位 id；下拉选项在 cnTiers
        planTier: billingInfo.planTier(id),
        // 这条线路的国内官方档位表（Qoder CN / TRAE / WorkBuddy / 码道），没有 null
        cnTiers: billingInfo.cnTiers(id),
        // 月付挡 / 多月包挡 / 年付挡 —— 一次买俩月的限时优惠仍归月付挡
        billingClass: billingInfo.billingClass(id),
        // ---- 自动续费与账户订阅快照（2.7.5）----
        // null = 没设置（按自动续费算）；false = 一次买 N 个月，到期如实标过期
        autoRenew,
        // 从连接器账户读到的订阅信息（档位名 / 到期 / 同步时间），没同步过 null
        accountPlan: billingInfo.accountPlan(id),
        accountSyncedAt: billingInfo.accountSyncedAt(id),
        // 这条订阅线路有没有积分查询端点（没有就只能报 token）
        creditEndpoint: billingInfo.creditEndpoint(id),
      },
    })
  }

  return { routes, error: null }
}

function sortRoutes(routes, defaultSelection) {
  const preferred = defaultSelection ? defaultSelection.provider : null
  return routes.slice().sort((a, b) => {
    if (a.id === preferred && b.id !== preferred) return -1
    if (b.id === preferred && a.id !== preferred) return 1
    return String(a.name).localeCompare(String(b.name), 'en')
  })
}

async function readDefaultModelInfo(llm, selection) {
  if (selection === null) return null
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return null
  try {
    const info = await llm.resolveModelInfo(selection.provider, selection.model)
    const contextWindow =
      info && info.context && Number.isFinite(info.context.contextWindow) ? info.context.contextWindow : null
    return { contextWindow, name: info && isStr(info.name) ? info.name : null }
  } catch (error) {
    return null
  }
}

let cache = { at: 0, value: null }

/**
 * 收集本机接入情况。失败的段落各自降级，整体永远返回一个能渲染的对象。
 * @param ctx - 宿主上下文。
 * @param options - `{ force: true }` 跳过 30 秒缓存；`{ billing: {线路id: 'token'|'estimate'|'credits'} }` 用户手选覆盖。
 */
export async function collectDshApi(ctx, options) {
  const force = !!(options && options.force === true)
  const overrides = (options && options.billing) || null
  // 覆盖表变了就重算 —— 不能拿旧缓存顶着，否则用户点了按钮页面不动
  const overrideKey = overrides ? JSON.stringify(overrides) : ''
  if (!force && cache.value !== null && Date.now() - cache.at < CACHE_MS && cache.overrideKey === overrideKey) {
    return cache.value
  }
  const billingInfo = describeBilling(overrides)

  const llm = ctx.get('llm')
  const collectedAt = new Date().toISOString()

  if (llm === undefined || typeof llm.listProviders !== 'function') {
    const value = {
      ok: false,
      at: collectedAt,
      error: '宿主没有 llm 服务，读不到接入情况',
      defaultSelection: null,
      defaultModel: null,
      routes: [],
      totals: { routes: 0, models: 0, configured: 0, missing: 0, loggedIn: 0 },
      billing: {
        modes: billingInfo.modes,
        labels: billingInfo.labels,
        foldedLabel: billingInfo.foldedLabel,
        planTypes: billingInfo.planTypes,
        planTypeLabels: billingInfo.planTypeLabels,
        overrides: overrides || {},
        byMode: { token: 0, estimate: 0, credits: 0, unknown: 0 },
        manual: 0,
        folded: 0,
      },
    }
    cache = { at: Date.now(), value, overrideKey }
    return value
  }

  const directory = readDirectory(llm)
  const settingsIndex = await readSettingsIndex(ctx)
  const defaultSelection = readDefaultSelection(ctx)
  const { routes, error } = await collectRoutes(ctx, llm, directory, settingsIndex, billingInfo)
  const ordered = sortRoutes(routes, defaultSelection)
  const defaultModel = await readDefaultModelInfo(llm, defaultSelection)

  const totalModels = ordered.reduce((sum, route) => sum + route.modelCount, 0)
  const configured = ordered.filter((route) => route.credential !== null && route.credential.configured === true).length
  const missing = ordered.filter((route) => route.credential !== null && route.credential.configured === false).length
  // 本机还没配起来的（缺密钥 / 空挂的壳）—— 界面默认收起来，这个数告诉用户藏了几条
  const unconfigured = ordered.filter((route) => route.unconfigured === true).length

  // 按计费方式分组统计：订阅几条、按量几条、等价几条；订阅里开了折算的单独数
  // unknown（2.7.2）：本地 CLI agent 没探到登录凭据，既不算订阅也不折钱，单独一格
  const byBilling = { token: 0, estimate: 0, credits: 0, unknown: 0 }
  let manualCount = 0
  let foldedCount = 0
  for (const route of ordered) {
    if (route.billing && byBilling[route.billing.mode] !== undefined) byBilling[route.billing.mode] += 1
    if (route.billing && route.billing.manual) manualCount += 1
    if (route.billing && route.billing.folded) foldedCount += 1
  }

  const value = {
    ok: error === null,
    at: collectedAt,
    error,
    defaultSelection,
    defaultModel,
    routes: ordered,
    totals: { routes: ordered.length, models: totalModels, configured, missing, unconfigured },
    billing: {
      modes: billingInfo.modes,
      labels: billingInfo.labels,
      foldedLabel: billingInfo.foldedLabel,
      planTypes: billingInfo.planTypes,
      planTypeLabels: billingInfo.planTypeLabels,
      overrides: overrides || {},
      byMode: byBilling,
      manual: manualCount,
      // 订阅线路里有多少条同时开了折算
      folded: foldedCount,
    },
  }

  cache = { at: Date.now(), value, overrideKey }
  return value
}
