/**
 * ai-credits · codingplan.fyi 聚合源
 * ============================================================================
 * 订阅价目表的主数据源。codingplan.fyi 把各家订阅套餐（197 个 / 52 个平台）
 * 汇总成三个静态 JSON，我们直接读，不再逐个去各家官网抄。
 *
 *   plans.json      套餐本体：价格（首月 / 月 / 季 / 年）、请求额度、支持模型、备注
 *   platforms.json  平台信息：名称、状态（open / restricted / delisted）、是否国内
 *   config.json     全站配置：汇率、更新日期、说明
 *
 * 为什么要它：原先报价靠人工抄 65 条、每天还得把 65 个官网页面挨个探一遍。
 * 换成聚合源以后，网络请求降到 3 条（另有官网备用，见 index.js 的 plan 巡检），
 * 数据也从 65 条涨到 147 条（剔除 50 个已下架的）。
 *
 * 边界：
 *   - 只取订阅套餐，不取按量 API 单价（那个仍在 prices.js + 官网实时价核对里）
 *   - `action` 字段是聚合站的推广跳转链接，**不采用**，卡片一律链到聚合站首页
 *   - 已下架（delisted）的套餐默认丢弃，不计入条目
 *   - 拿不到就用 plans.js 里的本地快照，界面会标「快照」
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const AGGREGATOR_ID = 'codingplan-fyi'
export const AGGREGATOR_LABEL = 'codingplan.fyi'
export const AGGREGATOR_HOME = 'https://codingplan.fyi/'
export const AGGREGATOR_ENDPOINTS = [
  { key: 'plans', url: 'https://codingplan.fyi/plans.json' },
  { key: 'platforms', url: 'https://codingplan.fyi/platforms.json' },
  { key: 'config', url: 'https://codingplan.fyi/config.json' },
]
export const AGGREGATOR_TTL_MS = 6 * 60 * 60 * 1000

const CACHE_VERSION = 1
const CACHE_NAME = 'codingplan-cache.json'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** 纯编程工具订阅：只能在自家客户端里用，不共享 API Key */
const CODING_TOOL_SLUGS = new Set([
  'qoder-cn',
  'qoder-intl',
  'workbuddy',
  'trae-cn',
  'trae-intl',
  'github',
  'cursor',
  'command-code',
  'codex',
  'claude',
  'opencode',
])

let memory = null

function cacheFile(home) {
  return join(home, 'ai-credits', CACHE_NAME)
}

function readDisk(home) {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(home), 'utf8'))
    if (!raw || raw.v !== CACHE_VERSION || !Array.isArray(raw.plans)) return null
    return raw
  } catch (error) {
    return null
  }
}

function writeDisk(home, payload) {
  try {
    mkdirSync(join(home, 'ai-credits'), { recursive: true })
    const file = cacheFile(home)
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, file)
  } catch (error) {}
}

/** 同步拿最近一次结果，不发请求。publicPlans() 用它决定走聚合还是走快照。 */
export function cachedAggregator(home) {
  if (memory && memory.plans && memory.plans.length > 0) return memory
  const disk = readDisk(home)
  if (disk) {
    memory = disk
    return disk
  }
  return null
}

// ---------------------------------------------------------------- 映射

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function currencyOf(plan, platform) {
  if (plan.currency === '¥') return 'CNY'
  if (plan.currency === '$') return 'USD'
  if (plan.currency === '₹') return 'INR'
  // 聚合站多数套餐 currency 为 null，按平台是否国内推断
  return platform && platform.supportsDomestic === true ? 'CNY' : 'USD'
}

/** 地区跟币种走：人民币套餐归国内，美元归国际。比按 supportsDomestic 猜准。 */
function regionOf(currency) {
  return currency === 'CNY' ? '国内' : '国际'
}

function categoryOf(platformSlug) {
  return CODING_TOOL_SLUGS.has(platformSlug) ? 'coding' : 'general'
}

/** 月额度：优先请求数，其次取各模型里最大的月 token 数 */
function quotaOf(plan) {
  const q = plan.requestQuota
  if (q && typeof q === 'object') {
    const parts = []
    if (num(q.fiveHours) !== null) parts.push('5 小时 ' + q.fiveHours.toLocaleString('en-US') + ' 次')
    if (num(q.weekly) !== null) parts.push('周 ' + q.weekly.toLocaleString('en-US') + ' 次')
    if (num(q.monthly) !== null) parts.push('月 ' + q.monthly.toLocaleString('en-US') + ' 次')
    if (parts.length > 0) return parts.join(' / ')
  }
  let best = null
  let bestModel = null
  for (const m of Array.isArray(plan.planModels) ? plan.planModels : []) {
    const usage = m && m.usage
    if (!usage || typeof usage !== 'object') continue
    const value = num(usage.monthlyTokenInM)
    if (value === null) continue
    if (best === null || value > best) {
      best = value
      bestModel = m.modelSlug || null
    }
  }
  if (best === null) return ''
  const text = best >= 1000 ? (best / 1000).toFixed(1) + 'B' : Math.round(best) + 'M'
  return '约 ' + text + ' tokens / 月' + (bestModel ? '（' + bestModel + '）' : '')
}

/** 权益只用聚合站自己列的 benefits，不把备注再拆一遍 —— 备注会单独显示，免得卡片重复 */
function benefitsOf(plan) {
  const list = []
  for (const item of Array.isArray(plan.benefits) ? plan.benefits : []) {
    const text = String(item || '').trim()
    if (text && !list.includes(text)) list.push(text)
  }
  return list.slice(0, 6)
}

function trimNote(plan) {
  const note = typeof plan.note === 'string' ? plan.note.replace(/^[•\-·]\s*/gm, '').trim() : ''
  return note.length > 420 ? note.slice(0, 420) + '…' : note
}

function sourceDateOf(config) {
  const raw = config && config.header && config.header.updateDate
  const match = typeof raw === 'string' ? raw.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/) : null
  if (!match) return null
  return match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0')
}

function mapPlan(plan, platform, sourceDate) {
  const monthly = num(plan.monthlyPrice)
  const first = num(plan.firstMonthPrice)
  const price = monthly !== null ? monthly : first
  if (price === null) return null

  const slug = typeof plan.platformSlug === 'string' ? plan.platformSlug : ''
  const platformName =
    (platform && typeof platform.name === 'string' && platform.name) || slug || AGGREGATOR_LABEL
  const currency = currencyOf(plan, platform)
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''

  const priceNoteParts = []
  if (first !== null && monthly !== null && first !== monthly) {
    priceNoteParts.push('首月 ' + symbol + first)
  }
  if (num(plan.quarterlyPrice) !== null) priceNoteParts.push('季付 ' + symbol + plan.quarterlyPrice)
  if (num(plan.yearlyPrice) !== null) priceNoteParts.push('年付 ' + symbol + plan.yearlyPrice)

  return {
    id: 'cp:' + (plan.slug || slug + '-' + plan.name),
    title: platformName + ' ' + String(plan.name || '').trim(),
    provider: platformName,
    region: regionOf(currency),
    category: categoryOf(slug),
    kind: /agent/i.test(String(plan.name || '') + ' ' + slug) ? 'agent' : 'plan',
    currency,
    price,
    period: 'monthly',
    priceNote: priceNoteParts.join(' · '),
    quota: quotaOf(plan),
    benefits: benefitsOf(plan),
    url: AGGREGATOR_HOME,
    checkUrl: AGGREGATOR_HOME,
    sourceDate,
    source: 'aggregator',
    sourceLabel: AGGREGATOR_LABEL,
    planStatus: plan.planStatus === 'restricted' ? 'restricted' : 'open',
    note: trimNote(plan),
  }
}

function mapAll(raw, { keepDelisted = false } = {}) {
  const plans = Array.isArray(raw.plans) ? raw.plans : []
  const platforms = Array.isArray(raw.platforms) ? raw.platforms : []
  const bySlug = new Map()
  for (const item of platforms) {
    if (item && typeof item.slug === 'string') bySlug.set(item.slug, item)
  }
  const sourceDate = sourceDateOf(raw.config)

  const out = []
  const seen = new Set()
  let skippedDelisted = 0
  let skippedBroken = 0

  for (const plan of plans) {
    if (!plan || typeof plan !== 'object') continue
    if (plan.billingMode && plan.billingMode !== 'subscription') {
      skippedBroken += 1
      continue
    }
    if (plan.planStatus === 'delisted') {
      skippedDelisted += 1
      if (!keepDelisted) continue
    }
    const mapped = mapPlan(plan, bySlug.get(plan.platformSlug), sourceDate)
    if (mapped === null) {
      skippedBroken += 1
      continue
    }
    if (seen.has(mapped.id)) continue
    seen.add(mapped.id)
    out.push(mapped)
  }

  return {
    plans: out,
    stats: {
      total: plans.length,
      kept: out.length,
      skippedDelisted,
      skippedBroken,
      platforms: new Set(out.map((item) => item.provider)).size,
      coding: out.filter((item) => item.category === 'coding').length,
      general: out.filter((item) => item.category === 'general').length,
    },
    sourceDate,
    usdToCnyRate: num(raw.config && raw.config.usdToCnyRate),
  }
}

// ---------------------------------------------------------------- 抓取

async function getJson(url, timeoutMs) {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'application/json,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const status = response.status
    const text = await response.text()
    if (status < 200 || status >= 300) {
      return { ok: false, url, httpStatus: status, bytes: text.length, ms: Date.now() - started, error: 'HTTP ' + status }
    }
    let value = null
    try {
      value = JSON.parse(text)
    } catch (error) {
      return { ok: false, url, httpStatus: status, bytes: text.length, ms: Date.now() - started, error: '不是合法 JSON' }
    }
    return { ok: true, url, httpStatus: status, bytes: text.length, ms: Date.now() - started, value }
  } catch (error) {
    return {
      ok: false,
      url,
      httpStatus: 0,
      bytes: 0,
      ms: Date.now() - started,
      error: String((error && error.message) || error).slice(0, 140),
    }
  }
}

/**
 * 拉一次聚合数据并落盘。拿不到就返回 ok:false，调用方回退本地快照。
 * 缓存 6 小时：聚合站自己也只一天更新一次，没必要更勤。
 */
export async function collectAggregatorPlans(home, { force = false, timeoutMs = 20000 } = {}) {
  const disk = readDisk(home)
  if (!force && disk && Date.now() - Date.parse(disk.at) < AGGREGATOR_TTL_MS) {
    memory = disk
    return { ...disk, cached: true }
  }

  const results = await Promise.all(
    AGGREGATOR_ENDPOINTS.map(async (endpoint) => {
      const hit = await getJson(endpoint.url, timeoutMs)
      return { key: endpoint.key, ...hit }
    }),
  )

  const byKey = new Map(results.map((item) => [item.key, item]))
  const endpoints = results.map((item) => ({
    key: item.key,
    url: item.url,
    ok: item.ok === true,
    httpStatus: item.httpStatus,
    bytes: item.bytes,
    ms: item.ms,
    error: item.error || null,
  }))

  const plansHit = byKey.get('plans')
  const platformsHit = byKey.get('platforms')
  if (!plansHit || plansHit.ok !== true || !plansHit.value) {
    // 主表拿不到就整体算失败，不拿旧数据冒充新数据
    const failure = {
      v: CACHE_VERSION,
      at: new Date().toISOString(),
      ok: false,
      label: AGGREGATOR_LABEL,
      home: AGGREGATOR_HOME,
      endpoints,
      error: (plansHit && plansHit.error) || 'plans.json 不可用',
      plans: [],
      stats: null,
      sourceDate: null,
      usdToCnyRate: null,
    }
    // 失败不覆盖已有缓存
    return { ...failure, cached: false }
  }

  const raw = {
    plans: plansHit.value.plans || [],
    platforms: platformsHit && platformsHit.ok ? platformsHit.value.platforms || [] : [],
    config: (byKey.get('config') && byKey.get('config').ok && byKey.get('config').value) || null,
  }

  const mapped = mapAll(raw)
  if (mapped.plans.length < 10) {
    return {
      v: CACHE_VERSION,
      at: new Date().toISOString(),
      ok: false,
      label: AGGREGATOR_LABEL,
      home: AGGREGATOR_HOME,
      endpoints,
      error: '解析出来的套餐太少（' + mapped.plans.length + ' 条），当作不可用',
      plans: [],
      stats: mapped.stats,
      sourceDate: mapped.sourceDate,
      usdToCnyRate: mapped.usdToCnyRate,
      cached: false,
    }
  }

  const payload = {
    v: CACHE_VERSION,
    at: new Date().toISOString(),
    ok: true,
    label: AGGREGATOR_LABEL,
    home: AGGREGATOR_HOME,
    endpoints,
    error: null,
    plans: mapped.plans,
    stats: mapped.stats,
    sourceDate: mapped.sourceDate,
    usdToCnyRate: mapped.usdToCnyRate,
  }
  writeDisk(home, payload)
  memory = payload
  return { ...payload, cached: false }
}

/** 巡检用：只探三个端点，不解析。返回数组（顺序同 AGGREGATOR_ENDPOINTS） */
export async function probeAggregator(probeFn, timeoutMs) {
  return Promise.all(
    AGGREGATOR_ENDPOINTS.map(async (endpoint) => {
      const result = await probeFn(endpoint.url, timeoutMs)
      return {
        key: endpoint.key,
        url: endpoint.url,
        checkedAt: result.checkedAt,
        httpStatus: result.httpStatus,
        reachable: result.reachable,
        note: result.note,
      }
    }),
  )
}