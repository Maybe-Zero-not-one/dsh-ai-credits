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

import { describeBilling } from './usage.js'

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
    const autoMode = billingInfo.auto(id)
    const mode = billingInfo.effective(id)
    const override = billingInfo.override(id)

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
      // ---- 计费分类 ----
      billing: {
        mode,
        auto: autoMode,
        override,
        manual: override !== null,
        label: billingInfo.labels[mode],
        // 手选过、且和自动判定不一样 —— 界面提示「已按你的选择」
        changed: override !== null && override !== autoMode,
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
        overrides: overrides || {},
        byMode: { token: 0, estimate: 0, credits: 0 },
        manual: 0,
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

  // 按计费方式分组统计：订阅几条、按量几条、等价几条
  const byBilling = { token: 0, estimate: 0, credits: 0 }
  let manualCount = 0
  for (const route of ordered) {
    if (route.billing && byBilling[route.billing.mode] !== undefined) byBilling[route.billing.mode] += 1
    if (route.billing && route.billing.manual) manualCount += 1
  }

  const value = {
    ok: error === null,
    at: collectedAt,
    error,
    defaultSelection,
    defaultModel,
    routes: ordered,
    totals: { routes: ordered.length, models: totalModels, configured, missing },
    billing: {
      modes: billingInfo.modes,
      labels: billingInfo.labels,
      overrides: overrides || {},
      byMode: byBilling,
      manual: manualCount,
    },
  }

  cache = { at: Date.now(), value, overrideKey }
  return value
}
