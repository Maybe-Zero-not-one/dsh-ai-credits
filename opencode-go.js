/**
 * ai-credits · OpenCode Go 官方额度与单价快照
 * ============================================================================
 * 来源：https://opencode.ai/inference/go/v1/models （**公开端点，不用鉴权**）
 * 文档：https://opencode.ai/docs/console/go
 * 核对日期：2026-11-27
 *
 * 为什么要有这份表 —— 官方文档把「额度池」的口径写得很明确：
 *
 *   「Each model's monthly limit shows how much usage your plan covers if you
 *     use only that model over the month. For example, **$1.50 of usage on a
 *     model with a $15 limit uses 10%** of your monthly allowance. So does $6
 *     on a model with a $60 limit.」
 *
 * 也就是说：**各模型的额度不是各自独立的钱包，而是同一个「月度额度池」的百分比刻度**。
 * 用掉 $1.5 / $15 额度 = 吃掉 10% 的池子；用掉 $6 / $60 额度 = 同样 10%。
 * 所以折算金额 = 基础价 × Σ(该模型用掉的美元 / 该模型的月度额度)，总额封顶在基础价。
 *
 * 三个档位（官方价）：
 *   Go        $10/月
 *   Go Plus   $40/月
 *   Go Teams  $20/人/月（最少 2 人），每个模型的额度比 Go 高 $5
 *
 * ⚠ 单价是**这家的官方标价**（per 1M tokens），不是 DeepSeek/月之暗面等原厂的价。
 *   拿原厂价去折 Go 的用量会算错 —— 这也是 2.7.2 之前的估算偏差来源。
 *
 * ⚠ `multipliers`：部分模型有分时倍率（如 DeepSeek V4.1 Flash 工作日 ×2）。
 *   这里只记「有没有倍率」，具体倍率随官方变化，精确账要以响应里的
 *   `opencode.allowance` 为准（官方每个响应都报这次请求吃掉多少额度）。
 */

export const OPENCODE_GO_SNAPSHOT_AT = '2026-11-27'
export const OPENCODE_GO_SOURCE = 'https://opencode.ai/inference/go/v1/models'
export const OPENCODE_GO_DOC = 'https://opencode.ai/docs/console/go'

/** 三个档位的月费（美元）与该档在 monthly_usage 里的键 */
export const OPENCODE_GO_TIERS = [
  { id: 'go', label: 'Go', priceUSD: 10, key: 'go' },
  { id: 'go-plus', label: 'Go Plus', priceUSD: 40, key: 'go-plus' },
  { id: 'go-teams', label: 'Go Teams', priceUSD: 20, key: 'go-teams', note: '每人每月，最少 2 人' },
]

/**
 * 模型 id → { 各档月度额度（美元）, 官方单价（美元 / 1M tokens） }
 * `free: true` 的是限时免费模型（没有月度额度，不占池子）。
 * `peakFactor` 有值表示存在分时倍率（这里记官方给的工作日倍率）。
 */
export const OPENCODE_GO_MODELS = {
  'glm-5.3': { limits: { go: 200, 'go-plus': 400, 'go-teams': 205 }, input: 1.4, output: 4.4 },
  'deepseek-v4.1-flash': { limits: { go: 100, 'go-plus': 200, 'go-teams': 105 }, input: 0.15, output: 0.6, cacheRead: 0.003, peakFactor: 2 },
  'minimax-m3': { limits: { go: 60, 'go-plus': 180, 'go-teams': 65 }, input: 0.3, output: 1.2 },
  'mimo-v2.6-flash': { limits: { go: 60, 'go-plus': 120, 'go-teams': 65 }, input: 0.14, output: 0.28 },
  'qwen3.7-plus': { limits: { go: 60, 'go-plus': 180, 'go-teams': 65 }, input: 0.4, output: 1.6 },
  'kimi-k2.7-code': { limits: { go: 60, 'go-plus': 180, 'go-teams': 65 }, input: 0.95, output: 4 },
  hy3: { limits: { go: 60, 'go-plus': 240, 'go-teams': 65 }, input: 0.14, output: 0.58 },
  'kimi-k3.1-pro': { limits: { go: 60, 'go-plus': 120, 'go-teams': 65 }, input: 2, output: 10 },
  'glm-5.3-flash': { limits: { go: 60, 'go-plus': 180, 'go-teams': 65 }, input: 0.15, output: 0.5 },
  'muse-spark-1.3-contributor': { limits: { go: 60, 'go-plus': 120, 'go-teams': 65 }, input: 0.1, output: 0.2 },
  'muse-spark-1.2-contributor': { limits: { go: 60, 'go-plus': 120, 'go-teams': 65 }, input: 0.1, output: 0.2 },
  'longcat-2.5': { limits: { go: 60, 'go-plus': 240, 'go-teams': 65 }, input: 0.3, output: 1.2 },
  hy4: { limits: { go: 60, 'go-plus': 240, 'go-teams': 65 }, input: 0.834, output: 2.501 },
  'gemini-4-argon': { limits: { go: 30, 'go-plus': 120, 'go-teams': 35 }, input: 2, output: 10 },
  'hy4-preview': { limits: { go: 30, 'go-plus': 120, 'go-teams': 35 }, input: 0.834, output: 2.501 },
  'qwen3.8-flash': { limits: { go: 30, 'go-plus': 90, 'go-teams': 35 }, input: 0.15, output: 0.47 },
  'minimax-m3.1-flash': { limits: { go: 20, 'go-plus': 80, 'go-teams': 25 }, input: 0.15, output: 0.6 },
  'qwen4-max': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 1.5, output: 4.5 },
  'qwen3.8-max': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 2, output: 6 },
  'step-5-preview': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 1, output: 2.7 },
  'grok-4.7': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 2, output: 6 },
  'mimo-v2.6-pro': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 0.435, output: 0.87 },
  'kimi-k3': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 3, output: 15 },
  'claude-haiku-5-5': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 0.1, output: 0.5 },
  'gpt-6-luna': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 0.1, output: 0.5 },
  'gpt-5.6-luna': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 0.2, output: 1.2 },
  'deepseek-v4-pro': { limits: { go: 15, 'go-plus': 60, 'go-teams': 20 }, input: 0.66, output: 1.98 },
  // 决策 / 向量模型：按标价计费、没有 Go 折扣，月度额度就等于你付的钱
  'text-embedding-3-small': { limits: { go: 10, 'go-plus': 40, 'go-teams': 15 }, input: 0.02, output: 0 },
  'gpt-6-luna-decision': { limits: { go: 10, 'go-plus': 40, 'go-teams': 15 }, input: 0.1, output: 0 },
  'gemini-decision-1': { limits: { go: 10, 'go-plus': 40, 'go-teams': 15 }, input: 0.1, output: 0 },
  'jev-1.14': { limits: { go: 10, 'go-plus': 40, 'go-teams': 15 }, input: 0.042, output: 0 },
  'qwen3-embedding-8b': { limits: { go: 10, 'go-plus': 40, 'go-teams': 15 }, input: 0.01, output: 0 },
  'gemini-embedding-2': { limits: { go: 10, 'go-plus': 40, 'go-teams': 15 }, input: 0.2, output: 0 },
  // 限时免费：没有月度额度，不占池子
  'beam-free': { free: true, input: 0, output: 0 },
  'hy4-flash-free': { free: true, input: 0, output: 0 },
  'iceman-contributor-free': { free: true, input: 0, output: 0 },
  'hungerg-free': { free: true, input: 0, output: 0 },
}

/**
 * 模型 id 归一：DSH 侧的 id 可能带日期后缀 / 大小写差异
 * （deepseek-v4.1-flash-261017、DeepSeek-V4.1-Flash）。
 */
export function normalizeGoModel(id) {
  if (typeof id !== 'string' || id === '') return null
  let s = id.trim().toLowerCase()
  const at = s.lastIndexOf('/')
  if (at >= 0) s = s.slice(at + 1) // opencode-go/kimi-k3 → kimi-k3
  const table = currentGoModels()
  if (table[s]) return s
  // 去掉尾部的日期 / 版本后缀再试：-261017 / -1017 / -20261017
  const trimmed = s.replace(/-\d{4,8}$/, '')
  if (table[trimmed]) return trimmed
  return null
}

/** 这个模型在某个档位的月度额度（美元）；免费模型 / 不认识返回 null。实时缓存优先 */
export function goModelLimit(modelId, tier) {
  const key = normalizeGoModel(modelId)
  if (key === null) return null
  const row = currentGoModels()[key]
  if (row === undefined || row.free === true || !row.limits) return null
  const t = tier === 'go-plus' || tier === 'go-teams' ? tier : 'go'
  const v = row.limits[t]
  return typeof v === 'number' && v > 0 ? v : null
}

/** 这个模型的官方单价（美元 / 1M tokens）；不认识返回 null。实时缓存优先 */
export function goModelPrice(modelId) {
  const key = normalizeGoModel(modelId)
  if (key === null) return null
  const row = currentGoModels()[key]
  if (row === undefined || typeof row.input !== 'number') return null
  return {
    input: row.input,
    output: typeof row.output === 'number' ? row.output : 0,
    cacheRead: typeof row.cacheRead === 'number' ? row.cacheRead : null,
    peakFactor: typeof row.peakFactor === 'number' ? row.peakFactor : null,
    free: row.free === true,
  }
}

/**
 * 按官方单价把 token 折成美元 —— 这是「用掉多少额度」的口径。
 * 有 cacheRead 单价的按缓存价算命中部分，没有就按输入价（保守，不虚低）。
 */
export function goUsageUSD(modelId, tokens) {
  const price = goModelPrice(modelId)
  if (price === null || price.free === true) return null
  if (!tokens || typeof tokens !== 'object') return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const cacheRead = num(tokens.cacheReadTokens)
  const input = num(tokens.inputTokens)
  const output = num(tokens.outputTokens)
  const cachePrice = price.cacheRead === null ? price.input : price.cacheRead
  const usd = (input * price.input + cacheRead * cachePrice + output * price.output) / 1e6
  return Number(usd.toFixed(6))
}

/**
 * 生成额度池配置（给用户一键填进 quotaPools）：
 * 拿这条线路实际有的模型，逐个对上官方额度表。
 * @returns {{ tier, basePrice, pools:Array<{model,quota}>, unmatched:string[], snapshotAt }|null}
 */
export function buildGoPool(modelIds, tier) {
  if (!Array.isArray(modelIds) || modelIds.length === 0) return null
  const t = OPENCODE_GO_TIERS.find((x) => x.id === tier) || OPENCODE_GO_TIERS[0]
  const pools = []
  const unmatched = []
  for (const id of modelIds) {
    const limit = goModelLimit(id, t.id)
    if (limit === null) {
      const key = normalizeGoModel(id)
      // 免费模型不算「对不上」，它本来就不占额度
      const row = key === null ? null : currentGoModels()[key]
      if (key === null || (row && row.free !== true)) unmatched.push(String(id))
      continue
    }
    pools.push({ model: String(id), quota: limit })
  }
  if (pools.length === 0) return null
  return {
    tier: t.id,
    tierLabel: t.label,
    basePrice: t.priceUSD,
    pools,
    unmatched,
    snapshotAt: OPENCODE_GO_SNAPSHOT_AT,
  }
}

/* ============================================================================
 * 实时检索（2.7.3）—— 直接问官方公开端点，快照只当兜底
 *
 * 主人问「opencode 的各个模型额度检索不到相关信息吗」：能检索，端点公开、
 * 不用鉴权。这里照 pricing-sync.js 的规矩做：拉不到 / 解析不出可信结果 →
 * 返回 ok:false 并保留上次成功值，绝不用半截数据覆盖快照。
 * ==========================================================================*/

const MODELS_URL = 'https://opencode.ai/inference/go/v1/models'
const LIVE_CACHE_MS = 6 * 60 * 60 * 1000 // 6 小时，别每次开页面都打人家端点
const LIVE_TIMEOUT_MS = 15000

let liveCache = null

/**
 * 把端点返回的 data[] 解析成与快照同构的表。
 *  sanity：至少 10 个模型、额度都是正数且 < 100000 —— 越界当解析失败。
 */
function extractLive(json) {
  const list = json && Array.isArray(json.data) ? json.data : null
  if (list === null || list.length < 10) return null
  const models = {}
  let withLimits = 0
  for (const row of list) {
    if (!row || typeof row.id !== 'string' || row.id === '') continue
    const id = row.id.trim().toLowerCase()
    const cost = row.cost && row.cost.text ? row.cost.text : {}
    const input = cost.input && typeof cost.input.price === 'number' ? cost.input.price : null
    const output = cost.output && typeof cost.output.price === 'number' ? cost.output.price : 0
    const cacheRead =
      cost.input && cost.input.cache && typeof cost.input.cache.read === 'number' ? cost.input.cache.read : null
    // 分时倍率：取 multipliers 里最大的 factor（只记有没有、多大，具体条件随官方变）
    let peakFactor = null
    if (Array.isArray(cost.multipliers)) {
      for (const m of cost.multipliers) {
        if (m && typeof m.factor === 'number' && m.factor > 1) {
          peakFactor = peakFactor === null ? m.factor : Math.max(peakFactor, m.factor)
        }
      }
    }
    const mu = row.go && row.go.monthly_usage ? row.go.monthly_usage : null
    if (mu && typeof mu.go === 'number') {
      const limits = {}
      for (const key of ['go', 'go-plus', 'go-teams']) {
        const v = mu[key]
        if (typeof v === 'number' && v > 0 && v < 100000) limits[key] = v
      }
      if (limits.go !== undefined) {
        models[id] = { limits, input, output, cacheRead, peakFactor, name: typeof row.name === 'string' ? row.name : null }
        withLimits += 1
        continue
      }
    }
    // 没有 monthly_usage 的：免费模型（单价 0）或决策/向量以外的新类型
    if (input === 0 && output === 0) {
      models[id] = { free: true, input: 0, output: 0, name: typeof row.name === 'string' ? row.name : null }
    } else if (input !== null) {
      // 有价但没额度信息：只记价，额度当未知（界面标「官方表没给额度」）
      models[id] = { limits: null, input, output, cacheRead, peakFactor, name: typeof row.name === 'string' ? row.name : null }
    }
  }
  if (withLimits < 10) return null
  return models
}

/**
 * 实时拉官方模型表。失败保留上次成功值（stale），再不行退回快照。
 * @returns {{ ok, at, source:'live'|'snapshot', models, count, error? }}
 */
export async function fetchGoModels({ force = false } = {}) {
  const now = Date.now()
  if (!force && liveCache !== null && now - liveCache.atMs < LIVE_CACHE_MS) {
    return { ...liveCache.value, cached: true }
  }
  let json
  try {
    const response = await fetch(MODELS_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    json = await response.json()
  } catch (error) {
    const stale = liveCache !== null ? { ...liveCache.value, cached: true, stale: true } : null
    return {
      ok: false,
      at: new Date().toISOString(),
      source: stale ? 'live' : 'snapshot',
      error: '拉官方模型表失败：' + String((error && error.message) || error),
      models: stale ? stale.models : OPENCODE_GO_MODELS,
      count: Object.keys(stale ? stale.models : OPENCODE_GO_MODELS).length,
      snapshotAt: OPENCODE_GO_SNAPSHOT_AT,
    }
  }
  const models = extractLive(json)
  if (models === null) {
    const stale = liveCache !== null ? { ...liveCache.value, cached: true, stale: true } : null
    return {
      ok: false,
      at: new Date().toISOString(),
      source: stale ? 'live' : 'snapshot',
      error: '官方端点结构变了，解析不出可信额度表（没动快照）',
      models: stale ? stale.models : OPENCODE_GO_MODELS,
      count: Object.keys(stale ? stale.models : OPENCODE_GO_MODELS).length,
      snapshotAt: OPENCODE_GO_SNAPSHOT_AT,
    }
  }
  const value = {
    ok: true,
    at: new Date().toISOString(),
    source: 'live',
    url: MODELS_URL,
    models,
    count: Object.keys(models).length,
  }
  liveCache = { atMs: now, value }
  return value
}

/** 同步读「当前最好的表」：有实时缓存用实时，没有用快照。给折算用，不发网络请求 */
export function currentGoModels() {
  return liveCache !== null ? liveCache.value.models : OPENCODE_GO_MODELS
}

/**
 * 全表检索（给界面「各模型额度」可展开表用）。
 * @param {string|null} query 关键词（模型 id / 名称，大小写不敏感）
 * @param {object|null} models 表（默认当前最好的表）
 * @returns {Array<{model,name,limits,free,input,output,cacheRead,peakFactor,inRoute}>}
 */
export function searchGoModels(query, models, routeModelIds) {
  const table = models && typeof models === 'object' ? models : currentGoModels()
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const routeSet = new Set(
    (Array.isArray(routeModelIds) ? routeModelIds : []).map((id) => normalizeGoModel(id)).filter(Boolean),
  )
  const rows = []
  for (const [id, row] of Object.entries(table)) {
    const name = typeof row.name === 'string' ? row.name : ''
    if (needle !== '' && !id.includes(needle) && !name.toLowerCase().includes(needle)) continue
    rows.push({
      model: id,
      name: name || null,
      limits: row.limits || null,
      free: row.free === true,
      input: typeof row.input === 'number' ? row.input : null,
      output: typeof row.output === 'number' ? row.output : null,
      cacheRead: typeof row.cacheRead === 'number' ? row.cacheRead : null,
      peakFactor: typeof row.peakFactor === 'number' ? row.peakFactor : null,
      inRoute: routeSet.has(id),
    })
  }
  // 线路里有的排前面，其余按 Go 额度从大到小
  rows.sort((a, b) => {
    if (a.inRoute !== b.inRoute) return a.inRoute ? -1 : 1
    const la = a.limits ? a.limits.go || 0 : 0
    const lb = b.limits ? b.limits.go || 0 : 0
    if (la !== lb) return lb - la
    return a.model.localeCompare(b.model)
  })
  return rows
}
