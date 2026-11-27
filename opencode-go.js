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
  if (OPENCODE_GO_MODELS[s]) return s
  // 去掉尾部的日期 / 版本后缀再试：-261017 / -1017 / -20261017
  const trimmed = s.replace(/-\d{4,8}$/, '')
  if (OPENCODE_GO_MODELS[trimmed]) return trimmed
  return null
}

/** 这个模型在某个档位的月度额度（美元）；免费模型 / 不认识返回 null */
export function goModelLimit(modelId, tier) {
  const key = normalizeGoModel(modelId)
  if (key === null) return null
  const row = OPENCODE_GO_MODELS[key]
  if (row.free === true || !row.limits) return null
  const t = tier === 'go-plus' || tier === 'go-teams' ? tier : 'go'
  const v = row.limits[t]
  return typeof v === 'number' && v > 0 ? v : null
}

/** 这个模型的官方单价（美元 / 1M tokens）；不认识返回 null */
export function goModelPrice(modelId) {
  const key = normalizeGoModel(modelId)
  if (key === null) return null
  const row = OPENCODE_GO_MODELS[key]
  if (typeof row.input !== 'number') return null
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
      if (key === null || OPENCODE_GO_MODELS[key].free !== true) unmatched.push(String(id))
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
