/**
 * ai-credits · 各家模型来源的用量与等价花费
 * ============================================================================
 * 数据从 DSH 自己的会话日志里读：每个 `assistant/message` 都带
 *   message.source = { provider, model }
 *   usage          = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
 * 所以「哪个来源、用了多少 token」是宿主自己记的账，不用猜。
 * `compaction/summary` 也带 usage，一并算进来。
 *
 * 花费是「等价金额」：拿上面这些 token 数，乘 prices.js 里那份人工核对的官方标价。
 * 它回答的是「这些用量如果按标价付，是多少钱」，不等于实际扣款
 * —— 套餐内的额度、赠金、谷时折扣都不体现在这里。
 *
 * 性能：日志总共几十 MB，全量解压要两三秒，所以按文件做增量缓存
 * （路径 + mtime + size 没变就直接复用上次结果），页面轮询不会一直重扫。
 * ============================================================================
 */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

import { PRICE_PROVIDERS } from './prices.js'
import { PROVIDER_KEY_MAP } from './official-usage.js'
import { goUsageUSD, goModelLimit, buildGoPool, OPENCODE_GO_SNAPSHOT_AT } from './opencode-go.js'
import { cnTiersOf, cnTierById, billingClassOfTerm, CN_TIERS_SNAPSHOT_AT } from './cn-tiers.js'
import { CODING_PLANS, PLAN_SNAPSHOT_AT } from './plans.js'
import { MEDIA_PRICE_SNAPSHOT_AT, imageUnitPrice, videoCost, shortProvider } from './media-prices.js'
import { readCloudMediaLedger } from './media-ledger.js'

/** 会话日志里没带模型 id 时的兜底别名：宿主用的 id → prices.js 里的 id */
const MODEL_ALIASES = {
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4.1-flash-1017': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-1-flash': 'deepseek-flash',
  'deepseek-v4-1-flash-1017': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
  'doubao-seed-2.1-pro': 'doubao-seed-2.1-pro',
  'doubao-seed-2.1-turbo': 'doubao-seed-2.1-turbo',
  'doubao-seed-2.1-lite': 'doubao-seed-2.1-lite',
  // 硅基的写法有大小写 / 后缀变体，必须落回它自己那条 —— 硅基的峰谷时段
  // 和 DeepSeek 官方不同（低峰 2:00-8:00），走 deepseek-flash 会按官方时段算错
  'deepseek-ai/deepseek-v4.1-flash': 'deepseek-ai/DeepSeek-V4.1-Flash',
  'deepseek-ai/deepseek-v4.1-flash.online': 'deepseek-ai/DeepSeek-V4.1-Flash',
  'deepseek-ai/deepseek-v4.1-flash-online': 'deepseek-ai/DeepSeek-V4.1-Flash',
  // TokenPlus 报的是「厂商/模型」带斜杠的写法
  'deepseek/deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek/deepseek-v4.1-flash-1017': 'deepseek-flash',
  'deepseek/deepseek-v4-flash': 'deepseek-flash',
}

/** 缓存命中输入价通常只有标价的一成左右，note 里没写时按这个比例估 */
const CACHE_READ_RATIO = 0.1

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const zstdAsync = promisify(zstdDecompress)

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * 多帧 zstd：DSH 的会话日志是一帧一帧追加的，得逐帧解。
 * 用异步版解压 —— 日志有几十 MB，同步解会把宿主的事件循环卡住两秒多。
 */
async function decompressAll(buffer) {
  const parts = []
  let offset = 0
  while (offset < buffer.length) {
    try {
      parts.push(await zstdAsync(buffer.subarray(offset)))
    } catch (error) {
      break
    }
    const next = buffer.indexOf(ZSTD_MAGIC, offset + 4)
    if (next < 0) break
    offset = next
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 价格索引：prices.js 里的模型 id → 标价 */
function buildPriceIndex() {
  const index = new Map()
  for (const provider of PRICE_PROVIDERS) {
    for (const model of provider.models) {
      const note = String(model.note || '')
      // 显式字段优先；老格式（只在 note 里写）用正则兜底
      const cacheHit = note.match(/缓存(?:命中)?(?:输入)?\s*[¥$]\s*([\d.]+)/)
      const cacheReadExplicit = model.cacheRead !== undefined ? num(model.cacheRead) : null
      const offPeakRaw = model.offPeak && typeof model.offPeak === 'object' ? model.offPeak : null
      index.set(model.id, {
        providerId: provider.id,
        providerTitle: provider.title,
        currency: provider.currency,
        modelId: model.id,
        modelName: model.name,
        input: num(model.input),
        output: num(model.output),
        cacheRead:
          cacheReadExplicit !== null
            ? cacheReadExplicit
            : cacheHit !== null
              ? Number(cacheHit[1])
              : num(model.input) * CACHE_READ_RATIO,
        cacheReadFromNote: cacheReadExplicit !== null || cacheHit !== null,
        offPeak: offPeakRaw
          ? {
              input: num(offPeakRaw.input),
              output: num(offPeakRaw.output),
              cacheRead: num(offPeakRaw.cacheRead),
            }
          : null,
        peak: provider.peak || null,
        // 这条价格跟不跟 DeepSeek 官网走（方舟托管的 DeepSeek 就是）
        followsOfficial:
          model.followsOfficial !== undefined
            ? String(model.followsOfficial)
            : provider.id === 'deepseek'
              ? model.id
              : null,
        pricingUrl: provider.pricingUrl,
        sourceDate: provider.sourceDate,
      })
    }
  }
  return index
}

const PRICE_INDEX = buildPriceIndex()

/**
 * 官网价覆盖。
 *
 * 拉到官网实时价时，凡是 `followsOfficial` 指向 DeepSeek 某个模型的条目，
 * 都把数值换成官网的（时段配置仍用本地 prices.js 的 —— 那是业务规则，不是价格）。
 * 拉不到就原样用本地快照，绝不让「没拉到」变成「没价格」。
 */
function withOfficial(price, official) {
  if (price === null || !official || official.ok !== true || !official.models) return price
  const target = price.followsOfficial
  if (!target) return price
  const fresh = official.models[target]
  if (!fresh) return price
  return {
    ...price,
    input: fresh.input.peak,
    output: fresh.output.peak,
    cacheRead: fresh.cacheRead.peak,
    offPeak: { input: fresh.input.off, output: fresh.output.off, cacheRead: fresh.cacheRead.off },
    officialAt: official.at || null,
  }
}

/** 小写索引：模型名大小写不一致时靠它兜底（不会串到别家 —— 时段配置挂在价格条目上） */
const PRICE_INDEX_LOWER = new Map()
for (const [id, price] of PRICE_INDEX) {
  const lower = id.toLowerCase()
  if (!PRICE_INDEX_LOWER.has(lower)) PRICE_INDEX_LOWER.set(lower, { id, price })
}

/** 'HH:MM' → 当天第几分钟 */
const minutesOf = (hhmm) => {
  const parts = String(hhmm).split(':')
  const h = Number(parts[0])
  const m = Number(parts[1])
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0
  return h * 60 + m
}

/** 本地日期键（YYYY-MM-DD），跟 dayOf 保持一致 */
const localDayKey = (d) => {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * Intl.DateTimeFormat 实例缓存（按 timeZone）。
 *
 * ⚠ 这个缓存很关键：构造一个 DateTimeFormat 要几十微秒，而用量统计要按
 * 「每条调用」判峰谷 —— 上万条就是几百毫秒到一秒。实测某台机 19824 条记录，
 * 每次新建实例会让整页加载凭空多出 1 秒。缓成按 timeZone 复用后基本归零。
 */
const DATE_FORMAT_CACHE = new Map()

function dateFormatterFor(timeZone) {
  const hit = DATE_FORMAT_CACHE.get(timeZone)
  if (hit !== undefined) return hit
  let fmt = null
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    })
  } catch (error) {
    fmt = null
  }
  DATE_FORMAT_CACHE.set(timeZone, fmt)
  return fmt
}

/**
 * 把一个时间戳换算到指定时区的「当天第几分钟」「星期几」「日期键」。
 *
 * 各家对峰谷时段的定义用的时区不一样 —— DeepSeek 说「北京时间」，
 * SiliconFlow 按 UTC 切。所以判断前必须先换到那家自己声明的时区。
 */
function partsInZone(ms, timeZone) {
  const d = new Date(ms)
  if (!timeZone || timeZone === 'local') {
    return {
      minute: d.getHours() * 60 + d.getMinutes(),
      weekday: d.getDay(),
      dayKey: localDayKey(d),
    }
  }
  const fmt = dateFormatterFor(timeZone)
  if (fmt !== null) {
    const map = {}
    for (const part of fmt.formatToParts(d)) map[part.type] = part.value
    const hour = Number(map.hour)
    const weekday = WEEKDAY_INDEX[map.weekday]
    if (Number.isFinite(hour) && weekday !== undefined) {
      return {
        minute: hour * 60 + Number(map.minute),
        weekday,
        dayKey: `${map.year}-${map.month}-${map.day}`,
      }
    }
  }
  // 时区名无效 / 解析不出就退回本地
  return {
    minute: d.getHours() * 60 + d.getMinutes(),
    weekday: d.getDay(),
    dayKey: localDayKey(d),
  }
}

/**
 * 这条调用落在高峰还是空闲时段。
 *
 * 没配 `peak` 的厂商没有分时价，永远返回 true（用 model.input/output/cacheRead
 * 那一套单一价）。配了 `peak` 的按那家官方原文判断：
 *   高峰 = 星期在 weekdays 里 且 不在节假日 且 落在 ranges 里
 *   其余（非工作日 / 节假日全天 / 时段外）都是空闲
 *
 * 时段用 `peak.timeZone` 声明的时区算 —— DeepSeek 是 Asia/Shanghai，
 * SiliconFlow 是 UTC，硬用本地时间会判错。
 */
function isPeakTime(ms, peak) {
  if (!peak) return true
  if (!Number.isFinite(ms) || ms <= 0) return true
  const { minute, weekday, dayKey } = partsInZone(ms, peak.timeZone)

  const weekdays = Array.isArray(peak.weekdays) ? peak.weekdays : [1, 2, 3, 4, 5]
  if (!weekdays.includes(weekday)) return false
  const holidays = Array.isArray(peak.holidays) ? peak.holidays : []
  if (holidays.includes(dayKey)) return false
  const ranges = Array.isArray(peak.ranges) ? peak.ranges : []
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length < 2) continue
    if (minute >= minutesOf(range[0]) && minute < minutesOf(range[1])) return true
  }
  return false
}

function lookupPrice(modelId) {
  const key = String(modelId || '')
  if (PRICE_INDEX.has(key)) return { price: PRICE_INDEX.get(key), alias: null }

  // 大小写不敏感：各家日志里同一条目的写法不一样（DeepSeek-V4.1-Flash / deepseek-v4.1-flash）
  const lower = key.toLowerCase()
  if (PRICE_INDEX_LOWER.has(lower)) {
    const hit = PRICE_INDEX_LOWER.get(lower)
    return { price: hit.price, alias: hit.id === key ? null : hit.id }
  }

  const alias = MODEL_ALIASES[key] || MODEL_ALIASES[lower]
  if (alias !== undefined && PRICE_INDEX.has(alias)) return { price: PRICE_INDEX.get(alias), alias }

  // 兜底：去掉日期尾巴再试一次（deepseek-v4.1-flash-1017 → deepseek-v4.1-flash）
  const trimmed = key.replace(/-\d{4}$/, '')
  if (trimmed !== key) {
    if (PRICE_INDEX.has(trimmed)) return { price: PRICE_INDEX.get(trimmed), alias: trimmed }
    const trimmedLower = trimmed.toLowerCase()
    if (PRICE_INDEX_LOWER.has(trimmedLower)) {
      const hit = PRICE_INDEX_LOWER.get(trimmedLower)
      return { price: hit.price, alias: hit.id }
    }
    const tAlias = MODEL_ALIASES[trimmed] || MODEL_ALIASES[trimmedLower]
    if (tAlias !== undefined && PRICE_INDEX.has(tAlias)) return { price: PRICE_INDEX.get(tAlias), alias: tAlias }
  }

  return { price: null, alias: null }
}

/**
 * 单条调用按它自己的时间戳算钱。
 *
 * 不能拿「这一个模型的总量」套一个价 —— 同一个模型的调用可能一半在高峰、
 * 一半在空闲，混着算会偏。所以每条单独判峰谷。
 */
function costOfOne(price, row, inPeak) {
  if (price === null) return null
  const perMillion = (tokens, unit) => (num(tokens) / 1e6) * num(unit)
  // 有分时价且落在空闲 → 用 offPeak 那一套；否则（高峰 / 没有分时价）用主价
  const unit = inPeak || price.offPeak === null ? price : price.offPeak
  return (
    perMillion(row.input, unit.input) +
    perMillion(row.output, unit.output) +
    perMillion(row.cacheRead, unit.cacheRead)
  )
}

/**
 * 单价 × 用量 → 金额（标价单位是每 100 万 tokens）。
 *
 * 三段分开算，因为它们单价不同：
 *   input     → 缓存**未命中**的输入
 *   cacheRead → 缓存**命中**的输入（便宜得多）
 *   output    → 输出
 *
 * 厂商有分时价时，peak / offPeak 两组各自按对应单价算再相加。
 * bucket 里没有 peak/offPeak 分组时（老调用路径）退回按总量算。
 */
function costOf(price, bucket) {
  if (price === null) return null
  const perMillion = (tokens, unit) => (num(tokens) / 1e6) * num(unit)
  const off = price.offPeak

  const peakPart = bucket.peak || null
  const offPart = bucket.offPeak || null

  if (off && (peakPart || offPart)) {
    const pk = peakPart || {}
    const op = offPart || {}
    return (
      perMillion(pk.input, price.input) +
      perMillion(pk.output, price.output) +
      perMillion(pk.cacheRead, price.cacheRead) +
      perMillion(op.input, off.input) +
      perMillion(op.output, off.output) +
      perMillion(op.cacheRead, off.cacheRead)
    )
  }

  return (
    perMillion(bucket.input, price.input) +
    perMillion(bucket.output, price.output) +
    perMillion(bucket.cacheRead, price.cacheRead)
  )
}

/**
 * 从搜索请求体里抠出「查了什么」，作为去重指纹的一部分。
 *
 * 同一毫秒并发发起多个搜索是正常的（一次问好几个关键词），所以时间戳不足以
 * 区分 —— 但 fork 复制过来的是**同一个事件**，查询内容必然一字不差。
 * 只取前 80 字符 + 长度，够用且不占内存。
 */
function searchTagOf(body) {
  let text = ''
  try {
    const messages = body.messages
    if (Array.isArray(messages)) {
      for (const message of messages) {
        const content = message && message.content
        if (typeof content === 'string') {
          text += content
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part && typeof part.text === 'string') text += part.text
          }
        }
      }
    }
  } catch (error) {}
  if (text === '') return ''
  return text.length + ':' + text.slice(0, 80)
}

/**
 * 云端出图 / 出视频工具（dsh-cloud-media 提供）—— 只有这几个的 tool/result 要解析。
 * `image_generate` 是本地 / 云端统一入口，靠结果里的 `车道==='在线'` 区分该不该计费。
 */
const MEDIA_TOOL_NAMES = new Set([
  'cloud_image_generate',
  'image_generate',
  'cloud_video_generate',
  'cloud_video_task',
])

/** 从 tool/result 的 message.content[0].text 里取出 JSON 对象（失败返回 null） */
function parseToolResultJson(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  for (const part of content) {
    if (part && part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
      try {
        const obj = JSON.parse(part.text)
        if (obj && typeof obj === 'object') return obj
      } catch (error) {
        return null
      }
    }
  }
  return null
}

/**
 * 把一个媒体工具的 result JSON 拆成 0..n 条计费记录。
 *
 * 生图：`出图[]` 里**每张图**一条（kind:'img'），带模型 / 尺寸 / 文件名（去重用）。
 * 生视频：只有 `状态==='succeeded'` 的任务才计费（kind:'vid'，官方口径失败不收钱），
 *         带模型 / 分辨率 / 时长 / 任务 id（去重用）。
 *
 * `at` 用 result 事件的时间戳（调用完成时刻，和 token 那边同口径）。
 */
function mediaRecordsFromResult(toolName, resultObj, at) {
  const out = []
  if (!resultObj || typeof resultObj !== 'object') return out

  // ---- 生图 ----
  if (toolName === 'cloud_image_generate' || toolName === 'image_generate') {
    if (resultObj.ok !== true) return out
    // image_generate 走本地车道不花钱；cloud_image_generate 恒为在线
    const lane = String(resultObj['车道'] || '')
    if (toolName === 'image_generate' && lane !== '在线' && lane !== 'cloud' && lane !== 'online') return out
    const model = String(resultObj['模型'] || '')
    const provider = String(resultObj['供应商'] || '')
    const defSize = String(resultObj['尺寸'] || '')
    const imgs = Array.isArray(resultObj['出图']) ? resultObj['出图'] : []
    for (const img of imgs) {
      if (!img || typeof img !== 'object') continue
      out.push({
        kind: 'img',
        at,
        model,
        provider,
        size: String(img['尺寸'] || defSize || ''),
        file: String(img['文件'] || img['路径'] || ''),
      })
    }
    return out
  }

  // ---- 生视频 ----
  if (toolName === 'cloud_video_task' || toolName === 'cloud_video_generate') {
    const tasks = Array.isArray(resultObj['任务']) ? resultObj['任务'] : []
    for (const t of tasks) {
      if (!t || typeof t !== 'object') continue
      if (String(t['状态'] || '') !== 'succeeded') continue
      out.push({
        kind: 'vid',
        at: Date.parse(String(t['创建时间'] || '')) || at,
        model: String(t['模型'] || ''),
        provider: String(t['供应商'] || ''),
        resolution: String(t['分辨率'] || ''),
        duration: Number(t['时长']) || 0,
        file: String(t['文件'] || ''),
        id: String(t.id || ''),
      })
    }
    return out
  }

  return out
}

/**
 * 扫一个会话日志文件，只留带 usage 的那两种事件
 */
async function scanFile(filePath) {
  let text

  try {
    text = await decompressAll(await readFile(filePath))
  } catch (error) {
    return {
      rows: [],
      extras: [],
      media: [],
      messages: 0,
      meta: null,
      error: String((error && error.message) || error),
    }
  }

  const rows = []
  const extras = []
  // 云端出图 / 出视频记录（tool/call 给工具名，tool/result 给产物 —— 按 callId 配对）
  const media = []
  const callTools = new Map()
  let messages = 0

  // 会话元信息：`session` 事件给 id / cwd / origin / parentSession，
  // `session/title` 给人类可读标题 —— 时间轴视图靠这几个才能分行
  let meta = null
  let title = null
  for (const line of text.split('\n')) {
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch (error) {
      continue
    }

    if (event.type === 'session') {
      meta = {
        id: typeof event.id === 'string' ? event.id : null,
        cwd: typeof event.cwd === 'string' ? event.cwd : null,
        origin: typeof event.origin === 'string' ? event.origin : null,
        parent: typeof event.parentSession === 'string' ? event.parentSession : null,
        createdAt: num(event.createdAt),
        depth: typeof event.delegationDepth === 'number' ? event.delegationDepth : 0,
      }
      continue
    }
    if (event.type === 'session/title') {
      const data = event.data || {}
      if (typeof data.title === 'string' && data.title.trim() !== '') title = data.title.trim()
      continue
    }

    // ---- 云端出图 / 出视频：tool/call 记工具名，tool/result 配对后解析产物 ----
    if (event.type === 'tool/call') {
      const data = event.data || {}
      if (typeof data.callId === 'string' && MEDIA_TOOL_NAMES.has(data.name)) {
        callTools.set(data.callId, data.name)
      }
      continue
    }
    if (event.type === 'tool/result') {
      const message = (event.data && event.data.message) || {}
      const callId = message.toolCallId || (message.source && message.source.callId) || ''
      const toolName = callId ? callTools.get(callId) : null
      if (toolName) {
        callTools.delete(callId)
        // 出错的调用不计费（ok!==true / isError 都会在解析里被挡掉）
        if (message.isError !== true) {
          const obj = parseToolResultJson(message)
          for (const rec of mediaRecordsFromResult(toolName, obj, num(event.time))) media.push(rec)
        }
      }
      continue
    }

    let provider = null

    let model = null
    let usage = null
    let at = 0

    /**
     * 有几类 LLM 调用**不产生 assistant/message**，所以日志里没有 usage，
     * 但官方请求数是算它们的（实测某台机子 30 天：搜索 131 次、标题 24 次）。
     * 这里只记「次数」，token 拿不到 —— 用来把调用次数对齐，不参与算钱。
     */
    if (event.type === 'web/deepseek-search-llm-request') {
      const body = (event.data && event.data.body) || {}
      // 记下查询内容：同一毫秒可能并发发起多个搜索（各查不同关键词），
      // 光靠时间戳会把它们当成重复 —— 只有内容也一致才是 fork 复制。
      extras.push({
        provider: 'deepseek-official',
        kind: 'search',
        at: num(event.time),
        model: body.model || null,
        tag: searchTagOf(body),
      })
      continue
    }
    if (event.type === 'session/title-llm-request') {
      const route = (event.data && event.data.route) || {}
      if (route.provider) {
        extras.push({ provider: route.provider, kind: 'title', at: num(event.time), model: route.model || null })
      }
      continue
    }

    if (event.type === 'assistant/message') {
      const data = event.data || {}
      const source = (data.message && data.message.source) || {}
      if (source.kind !== undefined && source.kind !== 'model') continue
      provider = source.provider || null
      model = source.model || null
      usage = data.usage || null
      at = num(event.time)
    } else if (event.type === 'compaction/summary') {
      const data = event.data || {}
      provider = data.provider || null
      model = data.model || null
      usage = data.usage || null
      at = num(event.time)
    } else {
      continue
    }

    if (usage === null || provider === null || model === null) continue
    messages += 1
    const input = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
    const reportedTotal = num(usage.totalTokens)
    // 有的线路（硅基流动那类转发）日志里 totalTokens 是 0 或没给，
    // 这时按三项之和兜底 —— 否则合计显示 0、排序也会把它压到最底。
    const sum = input + output + cacheRead + cacheWrite
    rows.push({
      provider,
      model,
      at,
      input,
      output,
      cacheRead,
      cacheWrite,
      total: reportedTotal > 0 ? reportedTotal : sum,
    })
  }

  // 会话 id 也可能只出现在文件名里（极老的日志没有 session 事件），这时用目录名兜底
  if (meta === null) {
    meta = { id: null, cwd: null, origin: null, parent: null, createdAt: 0, depth: 0 }
  }
  if (title !== null) meta.title = title

  return { rows, extras, media, messages, meta, error: null }
}

/**
 * 读本机的 DeepSeek **实际扣费**账本。
 *
 * 官方没有消费明细 API（`/user/balance` 只给余额，`/user/usage`、`/user/billing`
 * 都是 404），所以「实际花了多少钱」只能靠余额差分：本机另一个插件
 * （`.dshw-usage.json`）一直在采 DeepSeek 余额，把每天的净扣减记成 `history`。
 *
 * 这里**只读**它，不写。文件不在 / 格式变了就返回 null，绝不影响折算金额那套。
 * 注意这只是 DeepSeek 一个账号的口径，别的渠道（硅基 / 火山）不在里面。
 */
async function readActualSpend(home) {
  try {
    const raw = await readFile(join(home, '.dshw-usage.json'), 'utf8')
    const json = JSON.parse(raw)
    const history = json && typeof json.history === 'object' && json.history !== null ? json.history : {}
    const days = {}
    let newest = null
    for (const [day, value] of Object.entries(history)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      const n = num(value)
      if (!(n >= 0)) continue
      days[day] = n
      if (newest === null || day > newest) newest = day
    }
    const lastBalance = num(json.lastBalance)
    return { days, newest, lastBalance }
  } catch (error) {
    return null
  }
}

/** 会话日志根目录（$DSH_HOME/sessions/<工作区>/<会话>/session.v4.jsonl.zstd） */async function sessionFiles(home) {
  const root = join(home, 'sessions')
  const out = []
  let workspaces = []
  try {
    workspaces = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory())
  } catch (error) {
    return out
  }
  for (const workspace of workspaces) {
    const workspaceDir = join(root, workspace.name)
    let sessions = []
    try {
      sessions = (await readdir(workspaceDir, { withFileTypes: true })).filter((entry) => entry.isDirectory())
    } catch (error) {
      continue
    }
    for (const session of sessions) {
      const sessionDir = join(workspaceDir, session.name)
      let files = []
      try {
        files = (await readdir(sessionDir, { withFileTypes: true })).filter((entry) => entry.isFile())
      } catch (error) {
        continue
      }
      for (const file of files) {
        if (!file.name.endsWith('.jsonl.zstd')) continue
        out.push(join(sessionDir, file.name))
      }
    }
  }
  return out
}

/** 文件级缓存：mtime + size 没变就不重扫 */
const fileCache = new Map()

/**
 * 磁盘缓存：让插件重载 / DSH 重启后不用重新解压 128MB 日志。
 *
 * 内存 Map 一重载就没了，冷启动要把 79 个 zstd 文件全解一遍（实测 8.9 秒）。
 * 这里把每个文件的扫描结果落盘，键是「路径 + mtime + size」—— 文件没变就直接
 * 复用，只重扫真正变过的那个（通常就是当前会话，1 个）。
 *
 * 用紧凑数组存（而不是对象），体积约减半。写盘异步，不挡请求。
 */
const DISK_CACHE_VERSION = 5
const DISK_CACHE_MS = 7 * 24 * 60 * 60 * 1000
let diskLoaded = false
let diskDirty = false
let diskWriting = null

const packRow = (r) => [r.provider, r.model, r.at, r.input, r.output, r.cacheRead, r.cacheWrite, r.total]
const unpackRow = (a) => ({
  provider: a[0],
  model: a[1],
  at: a[2],
  input: a[3],
  output: a[4],
  cacheRead: a[5],
  cacheWrite: a[6],
  total: a[7],
})
const packExtra = (e) => [e.provider, e.kind, e.at, e.model, e.tag || '']
const unpackExtra = (a) => ({ provider: a[0], kind: a[1], at: a[2], model: a[3], tag: a[4] || '' })
// 媒体记录用紧凑数组存：[kind, at, model, provider, file, size/resolution, duration, id]
const packMedia = (m) => [
  m.kind,
  m.at,
  m.model,
  m.provider || '',
  m.file || '',
  m.kind === 'vid' ? m.resolution || '' : m.size || '',
  m.kind === 'vid' ? m.duration || 0 : 0,
  m.kind === 'vid' ? m.id || '' : '',
]
const unpackMedia = (a) =>
  a[0] === 'vid'
    ? { kind: 'vid', at: a[1], model: a[2], provider: a[3], file: a[4], resolution: a[5], duration: a[6], id: a[7] }
    : { kind: 'img', at: a[1], model: a[2], provider: a[3], file: a[4], size: a[5] }


async function loadDiskCache(home) {
  if (diskLoaded) return
  diskLoaded = true
  const file = join(home, 'ai-credits', 'usage-cache.json')
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    return
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return
  }
  if (!json || json.version !== DISK_CACHE_VERSION) return
  if (typeof json.at !== 'number' || Date.now() - json.at > DISK_CACHE_MS) return
  const entries = json.entries && typeof json.entries === 'object' ? json.entries : {}
  for (const [filePath, entry] of Object.entries(entries)) {
    if (!entry || !Array.isArray(entry.rows)) continue
    fileCache.set(filePath, {
      mtimeMs: num(entry.mtimeMs),
      size: num(entry.size),
      messages: num(entry.messages),
      meta: entry.meta && typeof entry.meta === 'object' ? entry.meta : null,
      rows: entry.rows.map(unpackRow),
      extras: Array.isArray(entry.extras) ? entry.extras.map(unpackExtra) : [],
      media: Array.isArray(entry.media) ? entry.media.map(unpackMedia) : [],
    })
  }
}

/** 把内存缓存写回磁盘（异步，失败就算了） */
function scheduleDiskWrite(home) {
  if (!diskDirty) return null
  if (diskWriting !== null) return diskWriting
  const file = join(home, 'ai-credits', 'usage-cache.json')
  const entries = {}
  for (const [filePath, entry] of fileCache) {
    entries[filePath] = {
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      messages: entry.messages,
      meta: entry.meta || null,
      rows: entry.rows.map(packRow),
      extras: (entry.extras || []).map(packExtra),
      media: (entry.media || []).map(packMedia),
    }
  }
  const payload = JSON.stringify({ version: DISK_CACHE_VERSION, at: Date.now(), entries })
  diskDirty = false
  diskWriting = writeFile(file, payload, 'utf8')
    .catch(() => {})
    .finally(() => {
      diskWriting = null
    })
  return diskWriting
}

async function scanCached(filePath) {
  let info
  try {
    info = await stat(filePath)
  } catch (error) {
    return { rows: [], extras: [], media: [], messages: 0, meta: null, error: null }
  }
  const hit = fileCache.get(filePath)
  if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
    return {
      rows: hit.rows,
      extras: hit.extras || [],
      media: hit.media || [],
      messages: hit.messages,
      meta: hit.meta || null,
      error: null,
    }
  }
  const result = await scanFile(filePath)
  fileCache.set(filePath, {
    mtimeMs: info.mtimeMs,
    size: info.size,
    rows: result.rows,
    extras: result.extras || [],
    media: result.media || [],
    messages: result.messages,
    meta: result.meta || null,
  })
  diskDirty = true
  return result
}


/**
 * 会话 id 归一化。
 *
 * 日志里同一个会话会有两种写法：`session` 事件里是裸 UUID
 * （`10cc61f0-ae84-…`），而 `parentSession` 和目录名带 `session-` 前缀
 * （`session-10cc61f0-…`）。不统一就没法把父子关系对上，时间轴会全是平级。
 */
const normalizeSessionId = (value) =>
  String(value || '')
    .trim()
    .replace(/^session-/, '')

const dayOf = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return null
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 线路分类。
 * - `token`：按 token 明码标价，用量 × 标价 = 真金白银（DeepSeek 官方那两条）。
 * - `credits`：订阅 / 套餐制，消耗的是积分或额度，不能折成现金 —— 只报 token 和积分。
 *
 * 订阅制线路的积分没有统一的「每 token 多少积分」公开换算，模型名里的 `x0.06`
 * 是相对系数、不是绝对单价（实测 trae 的官方消耗与 token×倍率对不上），
 * 所以这里不去推算消耗了多少积分 —— 只报官方接口给的**剩余积分**，那是权威数。
 */
/**
 * 线路分类。
 *
 * **只有真正按 token 后付费、扣现金的渠道才折金额。** 其余一律不折 ——
 * 套餐 / 订阅渠道消耗的是额度，套官方标价会得出「看起来花了 ¥22、其实一分没扣」
 * 的假数字。
 *
 * 白名单之外的一律不折钱：宁可只报 token，也不拿别人家的价去估。
 */
const TOKEN_BILLED = new Set([
  'deepseek-official', // DeepSeek 官方 API（DEEPSEEK_API_KEY，按量后付费）
  'deepseek-account', // DeepSeek 账户余额（按量扣余额）
  'siliconflow', // 硅基流动（按量，另有免费额度）
  'volcengine', // 火山方舟按量
  'ark-cn', // Ark 后付费
  'ark-byteplus', // Ark BytePlus 后付费
  'tokenplus', // TokenPlus 按量（官网：「充值后按实际调用量计费」）
])

/**
 * 按量家族的**兜底识别**（2.7.1）。
 *
 * 白名单是写死的，同一家新开的通道（火山方舟 live、byteplus 的别的区、
 * 以后再加的 ark-xxx）不在名单里就会掉进「安全默认 = 订阅」，
 * 于是一条直接按量扣费的生图通道被显示成订阅。
 *
 * 这里按 id 的形状 + 已知的按量家族补一层判断：
 *   · 精确在 TOKEN_BILLED 里 → 按量
 *   · `<已知按量家族>-<后缀>`（volcengine-live / ark-cn-jp / siliconflow-xx）→ 按量
 *   · 但**带 plan 字样的一律不算**（ark-agent-plan-cn / ark-coding-plan-cn 是套餐）
 *
 * 只影响「自动判定」，用户手选永远优先。
 */
const TOKEN_BILLED_FAMILIES = ['volcengine', 'ark', 'siliconflow', 'deepseek', 'tokenplus']
function looksTokenBilled(provider) {
  if (typeof provider !== 'string' || provider === '') return false
  if (TOKEN_BILLED.has(provider)) return true
  if (/plan|subscription|member|vip/i.test(provider)) return false
  return TOKEN_BILLED_FAMILIES.some((family) => provider.startsWith(family + '-'))
}

/**
 * 订阅 / 套餐制，但仍然**折一个等价金额**给人看。
 *
 * 这些渠道卖的也是 DeepSeek 模型，按月付 / 积分包，不按 token 扣现金 ——
 * 所以这个金额不是账单，只是「这些 token 拿官方价买要多少钱」的参考尺子。
 * 界面上会明确标成「等价」。
 */
const ESTIMATE_ROUTES = new Set([
  'qwen-token-plan', // 阿里云百炼 Token Plan（积分套餐）
  'opencode-go', // OpenCode Go 订阅（$10/$40 三档，按模型月度额度）
])

/**
 * 本地 CLI agent（2.7.2）—— Claude Code / Codex CLI / Gemini CLI 这类。
 *
 * ⚠ 这些**不是 DSH 买的订阅**，是「本机装了某个命令行 agent，DSH 能驱动它」。
 * 它自己怎么认证、有没有订阅，DSH 一概不知道：
 *   · 可能是 OAuth 登录 + Pro/Max 订阅（那才算订阅）
 *   · 可能是 ANTHROPIC_API_KEY / OPENAI_API_KEY 按量付费
 *   · 也可能压根没登录（本机就是这种：~/.claude/.credentials.json 和
 *     ~/.codex/auth.json 都不存在）
 *
 * 2.7.2 之前这些 id 被硬编码进 CREDIT_ROUTES，于是**没订阅也显示成「订阅」**。
 * 现在改成：先探本机有没有登录凭据，探不到就不当订阅（也不当未配置以外的任何计费身份），
 * 由用户自己确认订阅后再手标。
 *
 * `credFiles` 是各家 CLI 存登录态的地方（照 ds-bot 的 engines.js 口径），
 * **只看文件在不在，绝不读内容**。
 */
const LOCAL_CLI_AGENTS = {
  'local-claude-code': { label: 'Claude Code', credFiles: [['.claude', '.credentials.json']], envKeys: ['ANTHROPIC_API_KEY'] },
  'local-codex-cli': { label: 'Codex CLI', credFiles: [['.codex', 'auth.json']], envKeys: ['OPENAI_API_KEY'] },
  'local-gemini-cli': { label: 'Gemini CLI', credFiles: [['.gemini', 'oauth_creds.json']], envKeys: ['GEMINI_API_KEY'] },
  'local-qwen-code': { label: 'Qwen Code', credFiles: [['.qwen', 'oauth_creds.json']], envKeys: ['DASHSCOPE_API_KEY'] },
}

/** id 是不是本地 CLI agent（含没在上表里登记的新 agent） */
const isLocalCliAgent = (provider) =>
  typeof provider === 'string' && (provider.startsWith('local-') || LOCAL_CLI_AGENTS[provider] !== undefined)

/**
 * 探本机这个 CLI 有没有登录凭据 / API key。
 * @returns {{ signedIn:boolean|null, via:string|null }} signedIn=null 表示探不出来
 */
function probeLocalCliAuth(provider) {
  const meta = LOCAL_CLI_AGENTS[provider]
  if (meta === undefined) return { signedIn: null, via: null }
  const home = homedir()
  for (const parts of meta.credFiles) {
    try {
      if (existsSync(join(home, ...parts))) return { signedIn: true, via: 'credfile' }
    } catch (error) {}
  }
  for (const key of meta.envKeys) {
    if (typeof process.env[key] === 'string' && process.env[key] !== '') return { signedIn: true, via: 'apikey' }
  }
  // 上表登记过的、文件和 env 都没有 → 明确没登录（不是「探不出来」）
  return { signedIn: false, via: null }
}

/**
 * 套餐 / 订阅制线路。
 * `endpoint` 指向那家连接器自己的 `/usage`，能问到积分账；
 * `null` 表示这家没有积分查询接口，只报 token。
 */
const CREDIT_ROUTES = {
  trae: { endpoint: 'dsh-connect-trae', label: 'Trae' },
  qoder: { endpoint: 'dsh-connect-qoder', label: 'Qoder' },
  'qoder-global': { endpoint: 'dsh-connect-qoder', label: 'Qoder Global' },
  workbuddy: { endpoint: 'dsh-connect-workbuddy', label: 'WorkBuddy' },
  codearts: { endpoint: null, label: 'CodeArts' },
  // 下面这些是套餐制，但连接器没开积分查询接口，只报 token
  'qwen-token-plan': { endpoint: null, label: '通义 Token Plan' },
  'ark-agent-plan-cn': { endpoint: null, label: 'Ark Agent Plan' },
  'ark-coding-plan-cn': { endpoint: null, label: 'Ark Coding Plan' },
  'ark-coding-plan-byteplus': { endpoint: null, label: 'Ark Coding Plan (BytePlus)' },
  'opencode-go': { endpoint: null, label: 'opencode-go' },
  tokenplus: { endpoint: null, label: 'TokenPlus' },
  // 本地 CLI agent 不在这里写死了 —— 见 LOCAL_CLI_AGENTS，按本机登录态动态判定
}

/**
 * 订阅线路 → 订阅表（plans.js 快照）里那几个套餐。
 *
 * 用来给「订阅 + 折算」算出来的等价月费找个比较对象：等价月费（这些 token 按
 * 官方标价买要多少钱）对上你实际付的月费，就知道这个套餐值不值。对不上的线路
 * （CodeArts / TokenPlus / 自建）界面上留一个手填月费的输入框。
 */
const SUBSCRIPTION_PLAN_HINTS = {
  trae: ['trae-lite', 'trae-pro'],
  qoder: ['qoder-lite', 'qoder-pro', 'qoder-pro-plus'],
  'qoder-global': ['qoder-lite', 'qoder-pro', 'qoder-pro-plus'],
  workbuddy: ['workbuddy-pro', 'workbuddy-team'],
  'ark-agent-plan-cn': ['volcengine-agent-small', 'volcengine-agent-medium', 'volcengine-agent-large'],
  'ark-coding-plan-cn': ['volcengine-coding-lite', 'volcengine-coding-pro'],
  'ark-coding-plan-byteplus': ['volcengine-coding-lite', 'volcengine-coding-pro'],
  'qwen-token-plan': ['aliyun-token-lite', 'aliyun-token-essential', 'aliyun-token-standard', 'aliyun-token-pro'],
  'local-claude-code': ['claude-pro', 'claude-max'],
  'local-codex-cli': ['chatgpt-plus', 'chatgpt-pro-100'],
}

/**
 * 美元套餐折人民币的参考汇率。
 *
 * 只在「参考月费」这一处用 —— 等价金额自己的币种不动。写死一个近似值而不是
 * 走实时汇率：这不是账，是拿来做「值不值」的判断，差几个点不影响结论，
 * 界面上也会把「按 $1≈¥X 折」写出来。
 */
const USD_TO_CNY = 7.2

/**
 * 这条订阅线路的参考月费（人民币）。
 *
 * 优先级（2.7.4）：
 *   1. 用户选定的**国内官方档位**（planTier）→ 该档官方月付原价（CNY），单点不是区间
 *   2. plans.js 套餐表候选（老路，国际版 USD 折 ¥7.2）
 * 都没有 → null，界面退回手填。
 */
function subscriptionPlanRef(provider, planTierId) {
  // 官方档位优先：国内账号按国内价，别拿国际版美元价折
  if (typeof planTierId === 'string' && planTierId !== '') {
    const tier = cnTierById(planTierId)
    if (tier !== null && typeof tier.monthlyCNY === 'number') {
      return {
        minCNY: tier.monthlyCNY,
        maxCNY: tier.monthlyCNY,
        plans: [{ id: tier.id, title: tier.providerLabel + ' ' + tier.official, price: tier.monthlyCNY, currency: 'CNY' }],
        snapshotAt: CN_TIERS_SNAPSHOT_AT,
        usdToCny: USD_TO_CNY,
        tierSource: 'cn-official',
        tier,
      }
    }
  }
  const ids = SUBSCRIPTION_PLAN_HINTS[provider]
  if (!Array.isArray(ids) || ids.length === 0) return null
  const picked = CODING_PLANS.filter((plan) => ids.includes(plan.id) && typeof plan.price === 'number')
  if (picked.length === 0) return null
  let minCNY = Infinity
  let maxCNY = 0
  const names = []
  for (const plan of picked) {
    const cny = plan.currency === 'USD' ? plan.price * USD_TO_CNY : plan.price
    if (cny < minCNY) minCNY = cny
    if (cny > maxCNY) maxCNY = cny
    names.push({ id: plan.id, title: plan.title, price: plan.price, currency: plan.currency })
  }
  return {
    minCNY: Number(minCNY.toFixed(2)),
    maxCNY: Number(maxCNY.toFixed(2)),
    plans: names,
    snapshotAt: PLAN_SNAPSHOT_AT,
    usdToCny: USD_TO_CNY,
    tierSource: 'plans-snapshot',
  }
}



/** 这条线路要不要按「真实花费」折钱（白名单 + 按量家族兜底，2.7.1 起） */
const isTokenBilled = (provider) => looksTokenBilled(provider)

/** 这条线路要不要折一个等价金额（套餐渠道，标「等价」） */
const isEstimateBilled = (provider) => ESTIMATE_ROUTES.has(provider)

/**
 * 三条分类规则：按量折钱 / 套餐折等价 / 纯订阅只报 token。
 *
 * 自动判定靠上面两张白名单，但白名单总会漏 —— 新线路、自建线路、连接器内部 id
 * 都可能不在里面，落进「纯订阅」只报 token（安全默认，但可能判错）。
 * 所以允许 `options.billing` 传一张覆盖表（用户在「本机接入」栏手选的），
 * 覆盖优先于白名单。
 */
const BILLING_MODES = ['token', 'estimate', 'credits']

const BILLING_LABELS = {
  token: 'API 按量',
  estimate: '套餐 · 折算',
  credits: '订阅 · 不折钱',
  /**
   * 2.7.2：本地 CLI agent 没探到登录凭据 —— **既不算订阅也不折钱**。
   * 它不是手选档位（BILLING_MODES 里没有），只是自动判定的一个「未确认」出口。
   */
  unknown: '未确认',
}

/** 订阅线路也打开折算时的那一档 —— 它不是第四种模式，是「订阅 + 折钱」的组合 */
const BILLING_LABEL_FOLDED = '订阅 · 折算'

/**
 * 订阅形式（planType）：只在「订阅 / credits」这条线路上有意义，是个**描述性标签**，
 * 不改计费判定（判定还是 mode 那一套）。记下来是为了：
 *   1. 知道这条订阅到底是哪种套餐，好去 plans.js 里对上参考档；
 *   2. 配合订阅时间 / 优惠说明，算清楚「这次到底花了多少、优惠还在不在」。
 *
 * `token-pack` 是预付 token 包（火山方舟那种「40 块买 80 块的量」），不是按月订阅，
 * 单独留一档；`quota-pool` 是**额度池订阅**（OpenCode Go 那种：付 $10，各家模型
 * 各给一笔美元额度，用掉的按比例折回那 $10 上扣）；`other` 兜住没归进上面几类的。
 */
const PLAN_TYPES = ['agent-plan', 'token-plan', 'coding-plan', 'token-pack', 'quota-pool', 'other']

const PLAN_TYPE_LABELS = {
  'agent-plan': 'Agent Plan',
  'token-plan': 'Token Plan',
  'coding-plan': 'Coding Plan',
  'token-pack': '特价 token 包',
  'quota-pool': '额度池订阅',
  other: '其他订阅',
}

/**
 * 订阅形式 → 关键词。挑参考档时对套餐的 **id + 标题** 一起匹配（只看标题不够：
 * trae 的标题是「TRAE 会员 Pro」、火山的 id 是 volcengine-agent-* 而标题写「Token Plan」）。
 * 过滤完空了就退回全部候选（matched:false，宁可多摆几档，也别让用户没参考）。
 */
const PLAN_TYPE_KEYWORDS = {
  'agent-plan': ['agent', '智能体'],
  'coding-plan': ['coding', '编程', 'code'],
  'token-plan': ['token', '积分'],
}

/**
 * 给一条订阅线路挑参考套餐档（「订阅形式」和套餐表联动的那一步）。
 * @returns {{ planType:string|null, plans:Array, minCNY:number|null, maxCNY:number|null, matched:boolean }|null}
 */
function suggestPlanRef(provider, planType, planTierId) {
  const base = subscriptionPlanRef(provider, planTierId)
  if (base === null) return null
  const keywords = planType ? PLAN_TYPE_KEYWORDS[planType] : null
  if (!Array.isArray(keywords) || keywords.length === 0 || base.tierSource === 'cn-official') {
    // 选了官方档位就不再按关键词过滤 —— 用户已经明确指定了哪一档
    return { planType: planType || null, plans: base.plans, minCNY: base.minCNY, maxCNY: base.maxCNY, matched: base.tierSource === 'cn-official', snapshotAt: base.snapshotAt, tierSource: base.tierSource }
  }
  const picked = base.plans.filter((p) => {
    const hay = (String(p.id || '') + ' ' + String(p.title || '')).toLowerCase()
    return keywords.some((k) => hay.includes(k))
  })
  if (picked.length === 0) {
    return { planType: planType, plans: base.plans, minCNY: base.minCNY, maxCNY: base.maxCNY, matched: false, snapshotAt: base.snapshotAt }
  }
  let minCNY = Infinity
  let maxCNY = 0
  for (const p of picked) {
    const cny = p.currency === 'USD' ? p.price * USD_TO_CNY : p.price
    if (cny < minCNY) minCNY = cny
    if (cny > maxCNY) maxCNY = cny
  }
  return {
    planType,
    plans: picked,
    minCNY: Number(minCNY.toFixed(2)),
    maxCNY: Number(maxCNY.toFixed(2)),
    matched: true,
    snapshotAt: base.snapshotAt,
  }
}

/**
 * 额度池订阅的折算（2.7.1）—— OpenCode Go 那种。
 *
 * 玩法：付 **$10 基础价**，各家模型各给一笔美元额度（DeepSeek $100、Kimi K3 $15…）。
 * 用掉某个模型的额度，就按「用掉的 / 这个模型的额度」这个比例，从基础价里扣掉对应的钱。
 *
 *   例：基础价 $10，DeepSeek 额度 $100 用了 $20 → 消耗 20% → 折 $2
 *       Kimi K3 额度 $15 用了 $3      → 消耗 20% → 折 $2
 *       合计已消耗 $4，基础价还剩 $6
 *
 * ⚠ 这里的「用掉多少额度」得有数据来源。两条：
 *   1. `usedByModel`：调用方按模型给的**已用额度**（美元），最准；
 *   2. 没有就退回按 token 折官方价当已用额度（`costByModel`，也是美元），
 *      这是估算 —— 官方价 ≠ 这家的额度扣减口径，界面要标清楚。
 *
 * 单个模型的消耗比例**钳在 100%**：额度用超了（超额继续用 / 口径不一致）
 * 不该把基础价扣成负数。
 *
 * @param {{basePrice:number, baseCurrency:string, pools:Array<{model:string,quota:number}>}} pool
 * @param {Object<string,number>} usedByModel 模型 id → 已用额度（美元）
 * @returns {{ basePrice, baseCurrency, baseCNY, rows, usedTotal, usedCNY, leftCNY, usedPct, matched }|null}
 */
export function quotaPoolSpend(pool, usedByModel) {
  if (!pool || typeof pool !== 'object') return null
  const basePrice = typeof pool.basePrice === 'number' && pool.basePrice > 0 ? pool.basePrice : null
  const pools = Array.isArray(pool.pools) ? pool.pools : []
  if (basePrice === null || pools.length === 0) return null
  const baseCurrency = pool.baseCurrency === 'CNY' ? 'CNY' : 'USD'
  const baseCNY = baseCurrency === 'USD' ? basePrice * USD_TO_CNY : basePrice
  const used = usedByModel && typeof usedByModel === 'object' ? usedByModel : {}
  const rows = []
  let usedTotal = 0
  for (const item of pools) {
    if (!item || typeof item.model !== 'string' || !(item.quota > 0)) continue
    const raw = used[item.model]
    const usedQuota = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
    const ratio = Math.min(1, usedQuota / item.quota) // 钳 100%，不让基础价扣成负
    const cost = basePrice * ratio
    usedTotal += cost
    rows.push({
      model: item.model,
      quota: item.quota,
      usedQuota: Number(usedQuota.toFixed(4)),
      ratio: Number(ratio.toFixed(6)),
      cost: Number(cost.toFixed(4)),
      costCNY: Number((baseCurrency === 'USD' ? cost * USD_TO_CNY : cost).toFixed(4)),
      capped: usedQuota > item.quota, // 用超了：界面提示「已超额，按 100% 计」
    })
  }
  if (rows.length === 0) return null
  /**
   * 总消耗**封顶在基础价**：各模型比例各自钳 100% 后，合计仍可能超过基础价
   * （两个模型都用超时 $10+$10=$20 > $10）。基础价就那么多钱，扣不出更多 ——
   * 超了按比例缩回去，让「已消耗 + 剩余 = 基础价」始终成立。
   */
  const overCap = usedTotal > basePrice
  if (overCap) {
    const scale = basePrice / usedTotal
    for (const row of rows) {
      row.cost = Number((row.cost * scale).toFixed(4))
      row.costCNY = Number((baseCurrency === 'USD' ? row.cost * USD_TO_CNY : row.cost).toFixed(4))
      row.scaledDown = true // 界面提示「多个模型超额，已按比例缩到基础价」
    }
    usedTotal = basePrice
  }
  const usedPct = basePrice > 0 ? Math.min(1, usedTotal / basePrice) : 0
  return {
    basePrice,
    baseCurrency,
    baseCNY: Number(baseCNY.toFixed(4)),
    rows,
    usedTotal: Number(usedTotal.toFixed(4)),
    usedCNY: Number((baseCurrency === 'USD' ? usedTotal * USD_TO_CNY : usedTotal).toFixed(4)),
    leftCNY: Number((baseCNY * (1 - usedPct)).toFixed(4)),
    usedPct: Number((usedPct * 100).toFixed(2)),
    overCap,
    // 有几个模型真的对上了用量（一个都没对上说明这份账是空的，界面别摆个 0 骗人）
    matched: rows.filter((r) => r.usedQuota > 0).length,
  }
}

/**
 * 订阅周期账：从**首次订阅日**算到今天，第几个计费周期、当前周期从哪天到哪天。
 * 用来判断「首月优惠」还在不在第一期：subscribedAt + paidPrice + promoNote 三件套齐了才有意义。
 *
 * **termMonths = 一个付费周期几个月**（2.7.1）。不填按 1 个月算（老行为）；
 * 填 12 就是年付：一个周期跨 12 个月，年费要除以 12 才是「等价月付金额」，
 * 拿年费直接跟等价月费比会得出「贵了 12 倍」的假结论。
 *
 * **autoRenew（2.7.5）= 到期自动对齐到最新一期**：
 *   true（默认）  连续包月/包季/包年、一直续着的订阅 —— 本期 = 包含今天的这一期，
 *                 到期日 = 本期结束，永远不用手改日期；
 *   false         一次买 N 个月、到期不续的 —— 到期日 = 首次订阅 + N 个月（老口径），
 *                 过期就如实标过期。
 *
 * 月末订阅（1-31）各期钳到当月最后一天（2-28、4-30…）。**从起点按月数直接算**，
 * 不做「逐月 +1 推进」—— 推进式在钳过月末后 day 变了（31→28），下一轮再钳会原地踏步死循环。
 * @returns {{ periodIndex:number, periodStart:string, periodEnd:string, daysSince:number,
 *             termMonths:number, expiresAt:string, daysLeft:number, expired:boolean,
 *             autoRenew:boolean }|null}
 */
export function subscriptionPeriod(subscribedAt, nowMs, termMonths, autoRenew) {
  if (typeof subscribedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(subscribedAt)) return null
  const start = new Date(subscribedAt + 'T00:00:00')
  if (Number.isNaN(start.getTime())) return null
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now())
  if (now < start) return null
  // 时长：正整数月，1~120（十年）。非法 / 没填都退回 1 个月
  const term =
    typeof termMonths === 'number' && Number.isFinite(termMonths) && termMonths >= 1 && termMonths <= 120
      ? Math.floor(termMonths)
      : 1
  const renew = autoRenew !== false
  /** 起点 + n 个月，日期钳到目标月最后一天 */
  const addMonths = (n) => {
    const d = new Date(start.getFullYear(), start.getMonth() + n, 1)
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    d.setDate(Math.min(start.getDate(), lastDay))
    return d
  }
  let idx = 0
  while (idx < 1200 && addMonths((idx + 1) * term) <= now) idx += 1
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  // 自动续费：到期 = 当前这一期结束；一次性购买：到期 = 首次订阅 + term（第 1 期结束）
  const termEnd = renew ? addMonths((idx + 1) * term) : addMonths(term)
  return {
    periodIndex: idx + 1, // 第 1 期 = 首次订阅那一期
    periodStart: fmt(addMonths(idx * term)),
    periodEnd: fmt(addMonths((idx + 1) * term)),
    daysSince: Math.floor((now - start) / 86400000),
    termMonths: term,
    // 本期到哪天为止 + 还剩几天（负数 = 已过期几天）
    expiresAt: fmt(termEnd),
    daysLeft: Math.ceil((termEnd - now) / 86400000),
    expired: termEnd <= now,
    autoRenew: renew,
  }
}

/**
 * 覆盖表一条记录的真身。
 *
 * 历史写法是 `{ 线路id: 'token' }`（纯字符串），2.4.8 起允许
 * `{ 线路id: { mode, estimate, monthlyCNY } }` —— 因为「订阅」和「折算」可以是
 * 两个独立的开关同时按下（订阅线路也想知道「这些 token 按官方价买要多少钱」，
 * 好判断这个套餐值不值）。字符串写法继续兼容，读进来就归一成这个结构。
 */
function normalizeOverrideEntry(value) {
  if (typeof value === 'string') {
    if (!BILLING_MODES.includes(value)) return null
    // 老的 'estimate' 本身就是「折钱」，但 foldCredit 只对 credits 生效，不受影响
    return {
      mode: value, estimate: value === 'estimate', monthlyCNY: null, planType: null,
      subscribedAt: null, promoNote: null, termMonths: null, paidTotal: null, paidCurrency: null,
      basePrice: null, baseCurrency: null, quotaPools: null, planTier: null,
      autoRenew: null, accountPlan: null, accountSyncedAt: null,
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const mode = BILLING_MODES.includes(value.mode) ? value.mode : null
  const estimate = value.estimate === true
  const posNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
  const monthlyCNY = posNum(value.monthlyCNY)
  // 订阅形式：只认枚举里的值，其余当没填
  const planType = PLAN_TYPES.includes(value.planType) ? value.planType : null
  // 订阅时间：'YYYY-MM-DD' 字符串，归一成它；解析不出就丢
  let subscribedAt = null
  if (typeof value.subscribedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.subscribedAt.trim())) {
    const d = new Date(value.subscribedAt.trim() + 'T00:00:00')
    if (!Number.isNaN(d.getTime())) subscribedAt = value.subscribedAt.trim()
  }
  // 优惠说明：首月半价 / 假日活动之类，纯文本，截断防滥用
  const promoNote =
    typeof value.promoNote === 'string' && value.promoNote.trim() !== ''
      ? value.promoNote.trim().slice(0, 80)
      : null
  // 这一次订阅了多久（月）：1~120 的整数；null = 没填，周期账按 1 个月算
  let termMonths = null
  if (typeof value.termMonths === 'number' && Number.isFinite(value.termMonths)) {
    const t = Math.floor(value.termMonths)
    if (t >= 1 && t <= 120) termMonths = t
  }
  // 本次实付总额 + 币种：年付 120 就是 120，不是每月 120
  const paidTotal = posNum(value.paidTotal)
  const currencyOf = (v) => (v === 'USD' || v === 'CNY' ? v : null)
  const paidCurrency = paidTotal === null ? null : currencyOf(value.paidCurrency) || 'CNY'
  // 额度池订阅（quota-pool）：基础价 + 每个模型各给多少额度
  const basePrice = posNum(value.basePrice)
  const baseCurrency = basePrice === null ? null : currencyOf(value.baseCurrency) || 'USD'
  let quotaPools = null
  if (Array.isArray(value.quotaPools)) {
    const rows = []
    for (const row of value.quotaPools) {
      if (!row || typeof row !== 'object') continue
      const model = typeof row.model === 'string' ? row.model.trim().slice(0, 80) : ''
      const quota = posNum(row.quota)
      if (model === '' || quota === null) continue
      rows.push({ model, quota })
      if (rows.length >= 40) break // 防滥用：一条订阅最多记 40 个模型的额度
    }
    if (rows.length > 0) quotaPools = rows
  }
  // 官方档位（2.7.4）：国内官方档位表的 id（cn-tiers.js），选了它参考价就按官方月付原价
  const planTier =
    typeof value.planTier === 'string' && cnTierById(value.planTier) !== null ? value.planTier : null
  // 自动续费（2.7.5）：true = 连续包月/包年，周期自动对齐到最新一期；false = 一次买 N 个月。
  // null = 没设置，按 true 算（大多数订阅是续着的）
  const autoRenew = typeof value.autoRenew === 'boolean' ? value.autoRenew : null
  // 从账户读到的订阅快照（2.7.5）：{ name, planName, planTier, expiresAt, source, atMs }
  // 只留展示要用的公开字段，金额账户里没有 —— 实付永远手填
  let accountPlan = null
  if (value.accountPlan && typeof value.accountPlan === 'object' && !Array.isArray(value.accountPlan)) {
    const ap = value.accountPlan
    const str = (v, max) => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null)
    const name = str(ap.name, 60)
    const planName = str(ap.planName, 60)
    const expiresAt =
      typeof ap.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ap.expiresAt) ? ap.expiresAt : null
    if (name !== null || planName !== null || expiresAt !== null) {
      accountPlan = {
        name,
        planName,
        planTier: str(ap.planTier, 60),
        expiresAt,
        periodStart: typeof ap.periodStart === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ap.periodStart) ? ap.periodStart : null,
        source: str(ap.source, 40) || 'connector',
        atMs: typeof ap.atMs === 'number' && Number.isFinite(ap.atMs) ? ap.atMs : null,
      }
    }
  }
  // 账户对齐的时间戳（毫秒）
  const accountSyncedAt =
    typeof value.accountSyncedAt === 'number' && Number.isFinite(value.accountSyncedAt) && value.accountSyncedAt > 0
      ? value.accountSyncedAt
      : null
  const empty =
    mode === null && estimate === false && monthlyCNY === null && planType === null &&
    subscribedAt === null && promoNote === null && termMonths === null && paidTotal === null &&
    basePrice === null && quotaPools === null && planTier === null &&
    autoRenew === null && accountPlan === null && accountSyncedAt === null
  if (empty) return null
  return {
    mode, estimate, monthlyCNY, planType, subscribedAt, promoNote,
    termMonths, paidTotal, paidCurrency, basePrice, baseCurrency, quotaPools, planTier,
    autoRenew, accountPlan, accountSyncedAt,
  }
}

function billingRules(overrides) {
  const map = new Map()
  if (overrides && typeof overrides === 'object') {
    for (const [provider, value] of Object.entries(overrides)) {
      if (typeof provider !== 'string' || provider === '') continue
      const entry = normalizeOverrideEntry(value)
      if (entry !== null) map.set(provider, entry)
    }
  }
  const auto = (provider) => {
    if (isTokenBilled(provider)) return 'token'
    if (isEstimateBilled(provider)) return 'estimate'
    /**
     * 本地 CLI agent（2.7.2）：**没探到登录凭据就不算订阅**。
     *
     * 这些 id 原来硬编码在 CREDIT_ROUTES 里，于是本机压根没登录的
     * Claude Code / Codex CLI 也被显示成「订阅」。登录 ≠ 订阅，没登录更不算 ——
     * 探不到就落进 unknown（界面标「未确认」，既不算订阅也不折钱），
     * 用户确认自己确实订阅了再手标成订阅。
     */
    if (isLocalCliAgent(provider)) {
      const auth = probeLocalCliAuth(provider)
      return auth.signedIn === true ? 'credits' : 'unknown'
    }
    return 'credits'
  }
  const entryOf = (provider) => map.get(provider) || null
  const effective = (provider) => {
    const entry = entryOf(provider)
    return (entry && entry.mode) || auto(provider)
  }
  const modeOf = effective
  /** 订阅线路额外打开了折算：这一类要照官方价折一个等价金额，但不改「订阅」这个身份 */
  const foldCredit = (provider) => modeOf(provider) === 'credits' && entryOf(provider) !== null && entryOf(provider).estimate === true
  return {
    /** 用户手选的模式，没有就是 null（只钉「折算」开关时也是 null） */
    override: (provider) => {
      const entry = entryOf(provider)
      return (entry && entry.mode) || null
    },
    /** 自动判定出来的模式 */
    auto,
    /** 最终生效的模式：覆盖优先 */
    effective,
    token: (provider) => effective(provider) === 'token',
    estimate: (provider) => effective(provider) === 'estimate',
    /** 订阅身份 + 折算开关同时成立 */
    foldCredit,
    /** 折算开关本身是开是关（订阅和套餐两档都算，界面按钮状态用） */
    estimateFlag: (provider) => {
      const entry = entryOf(provider)
      if (effective(provider) === 'estimate') return true
      return entry !== null && entry.estimate === true
    },
    /** 用户填的参考月费（人民币），没有就是 null */
    monthlyCNY: (provider) => {
      const entry = entryOf(provider)
      return entry === null ? null : entry.monthlyCNY
    },
    /** 订阅形式（planType 枚举），没填 null */
    planType: (provider) => {
      const entry = entryOf(provider)
      return entry === null ? null : entry.planType
    },
    /** 订阅时间 'YYYY-MM-DD'，没填 null */
    subscribedAt: (provider) => {
      const entry = entryOf(provider)
      return entry === null ? null : entry.subscribedAt
    },
    /** 优惠说明文本（首月半价 / 假日活动等），没填 null */
    promoNote: (provider) => {
      const entry = entryOf(provider)
      return entry === null ? null : entry.promoNote
    },
    /** 这一次订阅了多久（月），没填 null（周期账按 1 个月算） */
    termMonths: (provider) => {
      const entry = entryOf(provider)
      return entry === null ? null : entry.termMonths
    },
    /** 本次实付总额 + 币种（年付就是年费，不是月费） */
    paid: (provider) => {
      const entry = entryOf(provider)
      if (entry === null || entry.paidTotal === null) return null
      return { total: entry.paidTotal, currency: entry.paidCurrency }
    },
    /**
     * 折合月费：本次实付 ÷ 订阅月数。
     * 年付 ¥120 / 12 个月 = ¥10/月 —— 拿年费直接跟等价月费比会得出「贵 12 倍」的假结论。
     * 没填实付总额就退回 monthlyCNY（老字段，按月填的那种）。
     */
    effectiveMonthlyCNY: (provider) => {
      const entry = entryOf(provider)
      if (entry === null) return null
      if (entry.paidTotal !== null) {
        const term = entry.termMonths === null ? 1 : entry.termMonths
        const cny = entry.paidCurrency === 'USD' ? entry.paidTotal * USD_TO_CNY : entry.paidTotal
        return Number((cny / term).toFixed(4))
      }
      return entry.monthlyCNY
    },
    /** 额度池订阅的原始配置：基础价 + 每模型额度，没配 null */
    quotaPool: (provider) => {
      const entry = entryOf(provider)
      if (entry === null || entry.basePrice === null || entry.quotaPools === null) return null
      return {
        basePrice: entry.basePrice,
        baseCurrency: entry.baseCurrency,
        pools: entry.quotaPools.slice(),
      }
    },
    /** 选定的官方档位 id（2.7.4），没选 null */
    planTier: (provider) => {
      const entry = entryOf(provider)
      return entry === null ? null : entry.planTier
    },
    /** 自动续费开关（2.7.5）：null = 没设置（按自动续费算） */
    autoRenew: (provider) => {
      const entry = entryOf(provider)
      return entry === null ? null : entry.autoRenew
    },
    /** 从账户读到的订阅快照（2.7.5），没同步过 null */
    accountPlan: (provider) => {
      const entry = entryOf(provider)
      return entry === null ? null : entry.accountPlan
    },
    /** 上次账户对齐时间（毫秒），没同步过 null */
    accountSyncedAt: (provider) => {
      const entry = entryOf(provider)
      return entry === null ? null : entry.accountSyncedAt
    },
    /**
     * 「自动」按钮要不要出现（2.7.5）：有**用户意图**才出现。
     *
     * 老口径 touched = 表里有没有这一条 —— 于是只点过「一键填额度」/ 快捷时长的
     * opencode-go / ark / qoder，记录里只有额度池 / termMonths，跟自动判定完全一致，
     * 「自动」按钮却赖着不走。新口径：
     *   · 手选了模式（mode 非空）→ 出现（点它退回自动判定）
     *   · 订阅档开了折算 → 出现（点它连折算一起清）
     *   · 只有订阅信息（时间 / 实付 / 档位 / 额度池 / 账户快照）→ 不出现 ——
     *     那些不是「口径覆盖」，没有可退的；要清信息用订阅行里的「清空订阅信息」。
     */
    resettable: (provider) => {
      const entry = entryOf(provider)
      if (entry === null) return false
      if (entry.mode !== null) return true
      return effective(provider) === 'credits' && entry.estimate === true
    },
    /** 计费挡位：月付 / 多月包 / 年付。一次买俩月的限时优惠仍归月付挡 */
    billingClass: (provider) => {
      const entry = entryOf(provider)
      return billingClassOfTerm(entry === null ? null : entry.termMonths)
    },
    /** 这条线路的国内官方档位表（下拉用），没有 null */
    cnTiers: (provider) => cnTiersOf(provider),
    /** 整条覆盖记录（所有字段都要时用） */
    entry: (provider) => entryOf(provider),
    /** 要不要查价、要不要算钱（按量 / 套餐折算 / 订阅+折算 三种都算） */
    /**
     * 要不要查价、要不要算钱。
     * ⚠ 用**白名单**而不是「!== credits」：2.7.2 加了 unknown 档（本地 CLI 没探到登录），
     * 排除法会把 unknown 也当成要折钱，凭空多出一笔假花费。
     */
    priced: (provider) => {
      const mode = effective(provider)
      return mode === 'token' || mode === 'estimate' || foldCredit(provider)
    },
    /** 显示文案：订阅+折算 单独一档 */
    label: (provider) => (foldCredit(provider) ? BILLING_LABEL_FOLDED : BILLING_LABELS[effective(provider)]),
    /** 是否由用户手动指定模式（界面标「手选」用） */
    manual: (provider) => map.has(provider) && (entryOf(provider).mode || null) !== null,
    /** 表里有没有这一条（任何开关都算），界面「自动」按钮用 */
    touched: (provider) => map.has(provider),
  }
}

/**
 * 时间窗：一天 / 一周 / 一月
 */
const WINDOWS = {
  day: { label: '今天', days: 1 },
  week: { label: '近 7 天', days: 7 },
  month: { label: '近 30 天', days: 30 },
}

const WINDOW_KEYS = Object.keys(WINDOWS)

/** 本地零点，避免用 UTC 切天导致「今天」差 8 小时 */
function startOfLocalDay(nowMs, backDays) {
  const d = new Date(nowMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime() - backDays * 86400000
}

/**
 * 收集用量与花费。
 * @param ctx - 宿主上下文。
 * @param options - `{ force: true }` 忽略缓存重算；`{ window: 'day'|'week'|'month' }` 选时间窗。
 */
/**
 * 给「本机接入」栏用的分类接口：一条线路现在算哪种计费、是自动判的还是手选的。
 * 只读常量 + 覆盖表，不碰日志，所以 dsh-api.js 可以直接调用。
 */
export function describeBilling(overrides) {
  const rules = billingRules(overrides)
  return {
    /** 三种模式的显示文案（外加「订阅 · 折算」这一档） */
    labels: { ...BILLING_LABELS },
    foldedLabel: BILLING_LABEL_FOLDED,
    modes: BILLING_MODES.slice(),
    /** 订阅形式枚举与显示名（前端下拉用） */
    planTypes: PLAN_TYPES.slice(),
    planTypeLabels: { ...PLAN_TYPE_LABELS },
    auto: (provider) => rules.auto(provider),
    effective: (provider) => rules.effective(provider),
    override: (provider) => rules.override(provider),
    manual: (provider) => rules.manual(provider),
    touched: (provider) => rules.touched(provider),
    /** 是否「订阅 + 折算」：算等价金额但不改订阅身份 */
    foldCredit: (provider) => rules.foldCredit(provider),
    /** 折算开关状态（按钮高亮用） */
    estimateFlag: (provider) => rules.estimateFlag(provider),
    /** 用户填的参考月费 */
    monthlyCNY: (provider) => rules.monthlyCNY(provider),
    /** 订阅形式 / 订阅时间 / 优惠说明 */
    planType: (provider) => rules.planType(provider),
    subscribedAt: (provider) => rules.subscribedAt(provider),
    promoNote: (provider) => rules.promoNote(provider),
    /** 订阅时长（月）/ 本次实付 / 折合月费 / 额度池配置 */
    termMonths: (provider) => rules.termMonths(provider),
    paid: (provider) => rules.paid(provider),
    effectiveMonthlyCNY: (provider) => rules.effectiveMonthlyCNY(provider),
    quotaPool: (provider) => rules.quotaPool(provider),
    /** 按订阅形式从套餐表挑的参考档（联动 plans.js / 国内官方档位） */
    planSuggestion: (provider) => suggestPlanRef(provider, rules.planType(provider), rules.planTier(provider)),
    /** 官方档位 / 计费挡位 / 国内档位表（2.7.4） */
    planTier: (provider) => rules.planTier(provider),
    billingClass: (provider) => rules.billingClass(provider),
    cnTiers: (provider) => rules.cnTiers(provider),
    /** 自动续费 / 账户订阅快照 / 上次对齐时间 / 「自动」按钮条件（2.7.5） */
    autoRenew: (provider) => rules.autoRenew(provider),
    accountPlan: (provider) => rules.accountPlan(provider),
    accountSyncedAt: (provider) => rules.accountSyncedAt(provider),
    resettable: (provider) => rules.resettable(provider),
    /** 本地 CLI agent 的本机登录态（2.7.2）；不是这类线路返回 null */
    localCli: (provider) => {
      if (!isLocalCliAgent(provider)) return null
      const meta = LOCAL_CLI_AGENTS[provider] || null
      const auth = probeLocalCliAuth(provider)
      return {
        label: meta ? meta.label : provider,
        known: meta !== null,
        signedIn: auth.signedIn,
        via: auth.via,
      }
    },
    /**
     * opencode-go 的官方额度池建议（2.7.2）：拿这条线路实际有的模型逐个对官方额度表。
     * 传进来的 modelIds 由调用方给（dsh-api 有线路的模型清单）。
     */
    goPoolSuggestion: (modelIds, tier) => buildGoPool(modelIds, tier),
    label: (provider) => rules.label(provider),
    /** 这条线路在订阅白名单里有没有积分查询端点 */
    creditEndpoint: (provider) => {
      const meta = CREDIT_ROUTES[provider]
      return meta && meta.endpoint ? meta.endpoint : null
    },
  }
}

export async function collectUsage(ctx, options) {
  // 宿主进程里 DSH_HOME 不一定是环境变量（桌面版就没有），跟 index.js 用同一套兜底
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const windowKey = options && WINDOWS[options.window] ? options.window : 'month'
  // 官网实时价（宿主拉好传进来）；没有就用 prices.js 的快照
  const official = options && options.official ? options.official : null
  // 官方导出的用量账单（CSV）—— 用来把官方金额摆到对应渠道旁边
  const officialUsage =
    options && options.officialUsage && options.officialUsage.ok === true ? options.officialUsage : null
  // 官方账单 key 名 → 线路 id 的映射：配置优先，自动探测兜底，最后退回本机写死那份
  const keyMap =
    options && options.keyMap && typeof options.keyMap === 'object' && Object.keys(options.keyMap).length > 0
      ? options.keyMap
      : PROVIDER_KEY_MAP
  const windowMeta = WINDOWS[windowKey]

  // 线路计费方式：白名单自动判定，用户在「本机接入」栏手选的覆盖优先
  const billing = billingRules(options && options.billing)

  const empty = {
    ok: false,
    at: new Date().toISOString(),
    error: '拿不到 DSH_HOME，读不到会话日志',
    window: windowKey,
    windowLabel: windowMeta.label,
    totals: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, costCNY: 0, costUSD: 0 },
    bySource: [],
    byDay: [],
    creditBalances: {},
    media: null,
  }
  if (home === '') return empty

  const startedAt = Date.now()
  // 先把上次的扫描结果从磁盘捞回来 —— 重载后免得把 128MB 日志重解一遍
  await loadDiskCache(home)
  const files = await sessionFiles(home)

  const nowMs = Date.now()
  const cutoff = startOfLocalDay(nowMs, windowMeta.days - 1)

  const sources = new Map()
  const days = new Map()
  /**
   * 订阅 + 折算线路的按天等价金额：provider → day → { CNY, USD }
   *
   * 「订阅划算吗」那一栏点开一条线路要能看出「哪几天用得凶」，所以按线路按天记一份。
   * 跟 days 里的 worthCNY（全体合计）分开存，互不影响。
   */
  const worthDays = new Map()
  // 有请求但没 usage 的调用（搜索 / 标题生成）—— 只用于对齐请求数
  const extraCallsByProvider = new Map()
  /**
   * 时间轴：provider → sessionKey → { 分桶累计 }
   *
   * 分桶粒度随窗口自适应（见下面 bucketMs），只保留**有数据的桶**（稀疏数组），
   * 否则 30 天 × 几十个会话 × 每小时就是几万个空格子。
   */
  const timelines = new Map()
  const sessionMeta = new Map()
  let messages = 0
  let fileErrors = 0
  let skippedByWindow = 0
  // fork / 分支会话复制的历史事件（见下面去重逻辑）
  const seenFingerprints = new Set()
  let duplicateCalls = 0
  let duplicateTokens = 0
  const duplicateByProvider = new Map()

  // 分桶宽度：窗口越长，桶越粗 —— 图上一格 15 分钟 ~ 1 小时就够看了
  const bucketMs = windowKey === 'day' ? 15 * 60 * 1000 : 60 * 60 * 1000

  /**
   * 扫描顺序很重要：**复制方必须排在原始方后面**。
   *
   * fork / 分支会话原样复制父会话的事件，两者指纹相同，去重时保留先遇到的那条。
   * 如果 fork 先被扫到，父会话反而会被当成重复丢掉 —— 总量对得上，但时间轴上
   * 这段历史会被记到 fork 名下，归属就错了。
   *
   * 判据：有 parentSession 且 origin 不是 subagent（subagent 是独立干活，不复制）。
   * 先按是否复制方分组，再保持原顺序，稳定排序。
   */
  const ordered = []
  for (const filePath of files) {
    const scanned = await scanCached(filePath)
    const meta = scanned.meta || null
    const origin = String((meta && meta.origin) || '')
    const hasParent = Boolean(meta && meta.parent)
    const isCopier = hasParent && origin !== 'subagent'
    // 会话标识在这里一次算好：优先 session.id，老日志退回目录名
    const sessionId = normalizeSessionId(
      (meta && meta.id) || String(filePath).split(/[\\/]/).slice(-2, -1)[0] || 'unknown',
    )
    ordered.push({ filePath, scanned, meta, sessionId, isCopier })
  }
  ordered.sort((a, b) => Number(a.isCopier) - Number(b.isCopier))

  for (const { sessionId, meta, scanned } of ordered) {
    if (scanned.error !== null) fileErrors += 1
    messages += scanned.messages
    if (!sessionMeta.has(sessionId)) {
      sessionMeta.set(sessionId, {
        id: sessionId,
        title: (meta && meta.title) || null,
        cwd: (meta && meta.cwd) || null,
        origin: (meta && meta.origin) || null,
        parent: meta && meta.parent ? normalizeSessionId(meta.parent) : null,
      })
    }
    // 无 usage 的调用（搜索 / 标题）—— 只数次数，用来对齐官方的请求数
    // 同样要防 fork 复制：同一时刻同类请求只算一次
    for (const extra of scanned.extras || []) {
      if (!(extra.at >= cutoff)) continue
      const extraFp = `x|${extra.at}|${extra.provider}|${extra.kind}|${extra.tag || ''}`
      if (seenFingerprints.has(extraFp)) {
        duplicateCalls += 1
        continue
      }
      seenFingerprints.add(extraFp)
      const bucket2 = extraCallsByProvider.get(extra.provider) || { total: 0, search: 0, title: 0 }
      bucket2.total += 1
      if (extra.kind === 'search') bucket2.search += 1
      else if (extra.kind === 'title') bucket2.title += 1
      extraCallsByProvider.set(extra.provider, bucket2)
    }
    for (const row of scanned.rows) {
      /**
       * 去重：fork / 分支会话会把父会话的 `assistant/message` 事件**原样复制**过来
       * （时间戳、usage、模型全一样），不去重就会把父会话那段历史算两遍。
       *
       * 指纹用「时间戳 + 渠道 + 模型 + 四类 token」八个字段 —— 复制出来的必然完全一致；
       * 两次真实调用撞在同一毫秒、且 token 数分毫不差，概率可以忽略。
       *
       * 只按内容判，不看会话归属：fork 的复制事件和原事件内容相同，天生对齐。
       */
      const fingerprint = `${row.at}|${row.provider}|${row.model}|${row.input}|${row.output}|${row.cacheRead}|${row.cacheWrite}|${row.total}`
      if (seenFingerprints.has(fingerprint)) {
        duplicateCalls += 1
        duplicateTokens += row.total
        duplicateByProvider.set(row.provider, (duplicateByProvider.get(row.provider) || 0) + 1)
        continue
      }
      seenFingerprints.add(fingerprint)

      // 时间窗外的直接跳过 —— 但 day 视图要保留按天明细，所以窗口外仍记进 days
      const inWindow = row.at >= cutoff
      if (!inWindow) skippedByWindow += 1

      const day = dayOf(row.at)
      const price = withOfficial(lookupPrice(row.model).price, official)
      const isCreditRoute = !billing.token(row.provider)
      // 订阅线路也把「折算」打开时照样查价算钱 —— 算的是等价金额，用来判断套餐值不值
      const priced = billing.priced(row.provider)

      // 单条按它自己的时间戳判峰谷 —— 跨峰谷的批次不能拿总量套一个价
      const inPeak = price === null ? true : isPeakTime(row.at, price.peak)
      const rowCost = priced ? costOfOne(price, row, inPeak) : null

      // 时间轴只统计窗口内的（窗口外的不上图）
      if (inWindow && row.at > 0) {
        let byProvider = timelines.get(row.provider)
        if (byProvider === undefined) {
          byProvider = new Map()
          timelines.set(row.provider, byProvider)
        }
        let entry = byProvider.get(sessionId)
        if (entry === undefined) {
          entry = { from: row.at, to: row.at, calls: 0, tokens: 0, points: new Map() }
          byProvider.set(sessionId, entry)
        }
        const bucketAt = Math.floor(row.at / bucketMs) * bucketMs
        if (row.at < entry.from) entry.from = row.at
        if (row.at > entry.to) entry.to = row.at
        entry.calls += 1
        entry.tokens += row.total
        const point = entry.points.get(bucketAt) || { tokens: 0, calls: 0 }
        point.tokens += row.total
        point.calls += 1
        entry.points.set(bucketAt, point)
      }

      if (day !== null) {
        let dayBucket = days.get(day)
        if (dayBucket === undefined) {
          dayBucket = {
            day,
            calls: 0,
            totalTokens: 0,
            costCNY: 0,
            costUSD: 0,
            unpricedTokens: 0,
            creditTokens: 0,
            // 订阅线路打开折算后的等价金额（不是账单）
            worthCNY: 0,
            worthUSD: 0,
            costCNYPeak: 0,
            costCNYOffPeak: 0,
            tokensPeak: 0,
            tokensOffPeak: 0,
            // 只算 DeepSeek 系（official + account）—— 只有这两个能跟余额差分对账
            costCNYDeepSeek: 0,
          }
          days.set(day, dayBucket)
        }
        dayBucket.calls += 1
        dayBucket.totalTokens += row.total
        if (isCreditRoute) {
          dayBucket.creditTokens += row.total
          // 订阅 + 折算：这一天的等价金额，跟「实际花费」分开记
          if (rowCost !== null) {
            if (price.currency === 'USD') dayBucket.worthUSD += rowCost
            else dayBucket.worthCNY += rowCost
            // 再按线路记一份，展开明细时画「哪几天用得凶」
            let byDay = worthDays.get(row.provider)
            if (byDay === undefined) {
              byDay = new Map()
              worthDays.set(row.provider, byDay)
            }
            const slot = byDay.get(day) || { cny: 0, usd: 0, tokens: 0, calls: 0 }
            if (price.currency === 'USD') slot.usd += rowCost
            else slot.cny += rowCost
            slot.tokens += row.total
            slot.calls += 1
            byDay.set(day, slot)
          }
        } else if (rowCost === null) {
          dayBucket.unpricedTokens += row.total
        } else if (price.currency === 'USD') {
          dayBucket.costUSD += rowCost
        } else {
          dayBucket.costCNY += rowCost
          // 只有 DeepSeek 系能跟余额差分对账，别的平台的钱不进那个余额
          if (row.provider === 'deepseek-official' || row.provider === 'deepseek-account') {
            dayBucket.costCNYDeepSeek += rowCost
          }
          if (inPeak) {
            dayBucket.costCNYPeak += rowCost
            dayBucket.tokensPeak += row.total
          } else {
            dayBucket.costCNYOffPeak += rowCost
            dayBucket.tokensOffPeak += row.total
          }
        }
      }

      if (!inWindow) continue

      const key = row.provider + '|' + row.model
      let bucket = sources.get(key)
      if (bucket === undefined) {
        bucket = {
          provider: row.provider,
          model: row.model,
          calls: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          peak: { input: 0, output: 0, cacheRead: 0 },
          offPeak: { input: 0, output: 0, cacheRead: 0 },
        }
        sources.set(key, bucket)
      }
      bucket.calls += 1
      bucket.input += row.input
      bucket.output += row.output
      bucket.cacheRead += row.cacheRead
      bucket.cacheWrite += row.cacheWrite
      bucket.total += row.total

      const side = inPeak ? bucket.peak : bucket.offPeak
      side.input += row.input
      side.output += row.output
      side.cacheRead += row.cacheRead
    }
  }

  /**
   * ================================================================
   * 云端出图 / 出视频花费（和 token 折算完全分开的一套）
   * ================================================================
   * 数据两处来：会话日志里 Agent 调工具的 tool/result（scanFile 已捞进 scanned.media），
   * 加影像工坊面板侧账本（UI 日志 + 视频任务状态文件，readCloudMediaLedger）。
   * 两边用**产物文件名 / 任务 id** 去重，同一张图不会算两次。
   * 按官方媒体单价折算：生图按张（部分按像素分档）、生视频按 token 估算公式。
   */
  const mediaSeen = new Set()
  const mediaByModel = new Map()
  const mediaDays = new Map()
  const mediaTotals = {
    images: 0,
    videos: 0,
    imageCNY: 0,
    videoCNY: 0,
    imageUSD: 0,
    videoUSD: 0,
    unpricedImages: 0,
    unpricedVideos: 0,
  }
  let mediaDeduped = 0
  let mediaSkippedByWindow = 0

  const addMediaRecord = (rec) => {
    if (!rec || typeof rec !== 'object') return
    // 去重键：优先产物文件名 / 任务 id（跨来源、跨 fork 都稳）；没有才退回内容指纹
    const dedupKey =
      rec.kind === 'vid'
        ? `v|${rec.id || rec.file || ''}|${rec.at}|${rec.model}|${rec.resolution}|${rec.duration}`
        : `i|${rec.file || ''}|${rec.at}|${rec.model}|${rec.size}`
    if (mediaSeen.has(dedupKey)) {
      mediaDeduped += 1
      return
    }
    mediaSeen.add(dedupKey)
    if (!(rec.at >= cutoff)) {
      mediaSkippedByWindow += 1
      return
    }

    // 折算金额（原币种 + 折人民币）
    let cost = null // { value, currency, unit, note, url, provider }
    if (rec.kind === 'img') {
      const p = imageUnitPrice(rec.model, rec.size)
      if (p !== null) {
        cost = { value: p.unit, currency: p.currency, unit: p.unit, note: p.note, url: p.url, provider: p.provider, tier: p.tier, pixels: p.pixels }
      }
    } else {
      const v = videoCost(rec.model, { resolution: rec.resolution, durationSec: rec.duration })
      if (v !== null) {
        cost = { value: v.cny, currency: v.currency, unit: v.rate, note: v.note, url: v.url, provider: v.provider, tokens: v.tokens, res: v.res }
      }
    }
    const cny = cost === null ? 0 : cost.currency === 'USD' ? cost.value * USD_TO_CNY : cost.value
    const usd = cost === null ? 0 : cost.currency === 'USD' ? cost.value : cost.value / USD_TO_CNY

    if (rec.kind === 'img') {
      mediaTotals.images += 1
      if (cost === null) mediaTotals.unpricedImages += 1
      else {
        mediaTotals.imageCNY += cny
        mediaTotals.imageUSD += usd
      }
    } else {
      mediaTotals.videos += 1
      if (cost === null) mediaTotals.unpricedVideos += 1
      else {
        mediaTotals.videoCNY += cny
        mediaTotals.videoUSD += usd
      }
    }

    // 按模型聚合
    const mKey = `${rec.kind}|${rec.model}`
    let mb = mediaByModel.get(mKey)
    if (mb === undefined) {
      mb = {
        kind: rec.kind,
        model: rec.model,
        // 面板账本没有供应商名，退回价格表里那家的短名
        provider: shortProvider(rec.provider) || (cost ? shortProvider(cost.provider) : '') || rec.model,
        count: 0,
        cny: 0,
        usd: 0,
        unpriced: 0,
        unit: cost ? cost.unit : null,
        currency: cost ? cost.currency : null,
        note: cost ? cost.note : '',
        url: cost ? cost.url : '',
        // 生视频估算的 token / 分辨率；生图的像素档
        detail: cost ? (rec.kind === 'vid' ? { res: cost.res, tokens: cost.tokens } : { tier: cost.tier }) : null,
      }
      mediaByModel.set(mKey, mb)
    }
    mb.count += 1
    if (cost === null) mb.unpriced += 1
    else {
      mb.cny += cny
      mb.usd += usd
    }

    // 按天
    const day = dayOf(rec.at)
    if (day !== null) {
      let db = mediaDays.get(day)
      if (db === undefined) {
        db = { day, images: 0, videos: 0, cny: 0 }
        mediaDays.set(day, db)
      }
      if (rec.kind === 'img') db.images += 1
      else db.videos += 1
      db.cny += cny
    }
  }

  // 1) 会话日志里的媒体工具调用
  for (const { scanned } of ordered) {
    for (const rec of scanned.media || []) addMediaRecord(rec)
  }
  // 2) 影像工坊面板侧账本（网页手动操作那条道 + 视频任务状态）
  const mediaLedger = await readCloudMediaLedger(home).catch(() => ({ images: [], videos: [], dirsFound: [] }))
  for (const rec of mediaLedger.images) addMediaRecord(rec)
  for (const rec of mediaLedger.videos) addMediaRecord(rec)

  const byMediaModel = [...mediaByModel.values()]
    .map((mb) => ({
      kind: mb.kind,
      model: mb.model,
      provider: mb.provider,
      count: mb.count,
      unpriced: mb.unpriced,
      cny: Number(mb.cny.toFixed(4)),
      usd: Number(mb.usd.toFixed(4)),
      unit: mb.unit,
      currency: mb.currency,
      note: mb.note,
      url: mb.url,
      detail: mb.detail,
    }))
    .sort((a, b) => b.cny - a.cny || b.count - a.count)

  const mediaByDay = [...mediaDays.values()]
    .filter((d) => d.day >= dayOf(cutoff))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, 31)
    .map((d) => ({ day: d.day, images: d.images, videos: d.videos, cny: Number(d.cny.toFixed(4)) }))

  const media = {
    totals: {
      images: mediaTotals.images,
      videos: mediaTotals.videos,
      count: mediaTotals.images + mediaTotals.videos,
      imageCNY: Number(mediaTotals.imageCNY.toFixed(2)),
      videoCNY: Number(mediaTotals.videoCNY.toFixed(2)),
      totalCNY: Number((mediaTotals.imageCNY + mediaTotals.videoCNY).toFixed(2)),
      totalUSD: Number((mediaTotals.imageUSD + mediaTotals.videoUSD).toFixed(2)),
      unpricedImages: mediaTotals.unpricedImages,
      unpricedVideos: mediaTotals.unpricedVideos,
      deduped: mediaDeduped,
      skippedByWindow: mediaSkippedByWindow,
    },
    byModel: byMediaModel,
    byDay: mediaByDay,
    ledgerDirs: mediaLedger.dirsFound || [],
    snapshotAt: MEDIA_PRICE_SNAPSHOT_AT,
  }

  const creditBalances = {}


  // 扫过新内容就把结果写盘，下次重载直接复用（异步，不挡本次响应）
  scheduleDiskWrite(home)
  // 实际扣费（DeepSeek 余额差分，只读别家账本）——按当前时间窗汇总
  const actual = await readActualSpend(home)
  let actualCNY = 0
  let actualDays = 0
  let actualNewest = null
  const actualByDay = {}
  if (actual !== null) {
    for (const [day, value] of Object.entries(actual.days)) {
      if (day < dayOf(cutoff)) continue
      actualByDay[day] = value
      actualCNY += value
      actualDays += 1
    }
    actualNewest = actual.newest
  }

  let costCNY = 0
  let costUSD = 0
  let unknownTokens = 0
  let unknownCalls = 0
  let creditTokens = 0
  let creditCalls = 0
  // 套餐渠道按官方价折出来的「等价金额」——单独一栏，不混进实际花费
  let estimateCNY = 0
  let estimateUSD = 0
  // 其中「订阅 + 折算」那一部分（estimateCNY 的子集），单独给「值不值」那张表用
  let worthCNY = 0
  let worthUSD = 0

  /**
   * 把官方账单里对应那个 key 的数字找出来，挂到渠道行上。
   * 让界面能直接显示「官方 ¥X / 折算 ¥Y」，而不是让人自己推算差额。
   *
   * `keyMap` 由调用方给（配置优先、自动探测兜底）；没给就退回本机那份写死的表。
   */
  const officialKeyFor = (provider) => {
    if (officialUsage === null) return null
    const keyName = keyMap[provider]
    if (!keyName) return null
    const found = (officialUsage.byKey || []).find((k) => k.name === keyName)
    if (!found) return null
    return {
      key: keyName,
      cost: found.cost,
      requests: found.requests,
      hit: found.hit,
      miss: found.miss,
      out: found.out,
      fnCalls: found.fnCalls,
      days: found.days,
    }
  }

  const bySource = [...sources.values()]
    .map((bucket) => {
      const meta = CREDIT_ROUTES[bucket.provider] || null
      const realBilled = billing.token(bucket.provider)
      const estimate = billing.estimate(bucket.provider)
      const folded = billing.foldCredit(bucket.provider)
      // 2.7.2：本地 CLI agent 没探到登录凭据 → unknown，既不算订阅也不折钱
      const unconfirmed = billing.effective(bucket.provider) === 'unknown'
      // 按量的查价；套餐里那几个（通义 Token Plan / opencode-go）也查，用来折算等价金额；
      // 订阅线路打开了「折算」开关的同样查 —— 算等价金额，给「这个套餐值不值」当尺子；
      // 其余订阅渠道不查 —— 没公开价的硬编会编出错的数
      const looked = realBilled || estimate || folded
        ? lookupPrice(bucket.model)
        : { price: null, alias: null }
      const price = withOfficial(looked.price, official)
      const alias = looked.alias

      if (!realBilled && !estimate) {
        // 纯套餐 / 订阅线路：只报 token 和（能拿到的）积分，不折金额。
        // 打开折算开关的线路照样算一个等价金额，但它仍然是「订阅」这一档。
        // ⚠ unknown（本地 CLI 没登录）不进订阅账 —— 那会凭空多出一笔「订阅用量」。
        if (!unconfirmed) {
          creditTokens += bucket.total
          creditCalls += bucket.calls
        }
        const balance = creditBalances[bucket.provider] || null
        const cost = folded ? costOf(price, bucket) : null
        if (cost !== null) {
          if (price.currency === 'USD') {
            estimateUSD += cost
            worthUSD += cost
          } else {
            estimateCNY += cost
            worthCNY += cost
          }
        }
        const monthly = (value) =>
          value === null || !Number.isFinite(value) ? null : Number((value * (30 / windowMeta.days)).toFixed(2))
        return {
          provider: bucket.provider,
          model: bucket.model,
          billing: 'credits',
          billingManual: billing.manual(bucket.provider),
          // 订阅线路额外打开了折算：带着等价金额和折合月费出来
          worth:
            cost === null
              ? null
              : {
                  cost: Number(cost.toFixed(4)),
                  currency: price.currency,
                  monthly: monthly(cost),
                  monthlyCNY: price.currency === 'USD' ? monthly(cost * USD_TO_CNY) : monthly(cost),
                  priceProvider: price.providerTitle,
                  priceInput: price.input,
                  priceOutput: price.output,
                  priceCacheRead: Number(price.cacheRead.toFixed(4)),
                  pricingUrl: price.pricingUrl,
                  priceDate: price.sourceDate,
                  alias,
                },
          calls: bucket.calls,
          inputTokens: bucket.input,
          outputTokens: bucket.output,
          cacheReadTokens: bucket.cacheRead,
          cacheWriteTokens: bucket.cacheWrite,
          totalTokens: bucket.total,
          cost: null,
          currency: null,
          creditRemaining: balance === null ? null : Number(balance.remaining.toFixed(2)),
          creditAccount: balance === null ? null : balance.accountName,
          creditSupported: meta !== null && meta.endpoint !== null,
          routeLabel: meta === null ? bucket.provider : meta.label,
          priceProvider: null,
          priceInput: null,
          priceOutput: null,
          priceCacheRead: null,
          cacheReadFromNote: null,
          pricingUrl: null,
          priceDate: null,
          alias: null,
        }
      }

      const cost = costOf(price, bucket)
      // 等价金额单独累加，绝不混进「实际花费」那个数
      if (!realBilled) {
        // unknown 不进订阅账（同上）
        if (!unconfirmed) {
          creditTokens += bucket.total
          creditCalls += bucket.calls
        }
      } else if (cost === null) {
        unknownTokens += bucket.total
        unknownCalls += bucket.calls
      } else if (price.currency === 'USD') {
        costUSD += cost
      } else {
        costCNY += cost
      }
      if (!realBilled && cost !== null) {
        if (price.currency === 'USD') estimateUSD += cost
        else estimateCNY += cost
      }

      // 峰谷各占多少：把两组 token 分别套对应单价，给界面拆开看
      let costPeak = null
      let costOffPeak = null
      if (price !== null && cost !== null) {
        costPeak = costOf(price, { ...bucket, peak: bucket.peak, offPeak: { input: 0, output: 0, cacheRead: 0 } })
        costOffPeak =
          price.offPeak === null
            ? 0
            : costOf(price, { ...bucket, peak: { input: 0, output: 0, cacheRead: 0 }, offPeak: bucket.offPeak })
        if (price.offPeak === null) costPeak = cost
      }
      const peakTokens = bucket.peak.input + bucket.peak.output + bucket.peak.cacheRead
      const offPeakTokens = bucket.offPeak.input + bucket.offPeak.output + bucket.offPeak.cacheRead

      return {
        provider: bucket.provider,
        model: bucket.model,
        // 'token' 是按量真花钱；'estimate' 是套餐渠道按官方价折的等价参考
        billing: realBilled ? 'token' : 'estimate',
        // 这个分类是不是用户在手选里定的（界面标「手选」）；null 表示按自动判定
        billingManual: billing.manual(bucket.provider),
        calls: bucket.calls,
        inputTokens: bucket.input,
        outputTokens: bucket.output,
        cacheReadTokens: bucket.cacheRead,
        cacheWriteTokens: bucket.cacheWrite,
        totalTokens: bucket.total,
        cost: cost === null ? null : Number(cost.toFixed(4)),
        currency: price ? price.currency : null,
        creditRemaining: null,
        creditAccount: null,
        creditSupported: false,
        routeLabel: null,
        priceProvider: price ? price.providerTitle : null,
        priceInput: price ? price.input : null,
        priceOutput: price ? price.output : null,
        priceCacheRead: price ? Number(price.cacheRead.toFixed(4)) : null,
        cacheReadFromNote: price ? price.cacheReadFromNote : null,
        pricingUrl: price ? price.pricingUrl : null,
        priceDate: price ? price.sourceDate : null,
        alias,
        // 峰谷计价（只有分时价的厂商才有值）
        hasPeakPricing: price !== null && price.offPeak !== null,
        // 这家的时段规则原文 —— 各家不一样（硅基低峰只有凌晨 2-8 点），界面要照它显示
        peakNote: price && price.peak && price.peak.note ? price.peak.note : null,
        // 官方账单里这条渠道对应的 key（有就带出来，给界面做对比）
        officialKey: officialKeyFor(bucket.provider),
        // 有请求但日志无 usage 的调用（搜索 / 标题生成）：次数能对上，token 拿不到
        extraCalls: extraCallsByProvider.get(bucket.provider) || null,
        priceInputOffPeak: price && price.offPeak ? price.offPeak.input : null,
        priceOutputOffPeak: price && price.offPeak ? price.offPeak.output : null,
        priceCacheReadOffPeak: price && price.offPeak ? Number(price.offPeak.cacheRead.toFixed(4)) : null,
        peakTokens,
        offPeakTokens,
        costPeak: costPeak === null ? null : Number(costPeak.toFixed(4)),
        costOffPeak: costOffPeak === null ? null : Number(costOffPeak.toFixed(4)),
      }
    })
    // 计费线路按金额排，订阅线路按 token 排，两组各自有序
    .sort((a, b) => {
      if (a.billing !== b.billing) return a.billing === 'token' ? -1 : 1
      if (a.billing === 'token') {
        return (b.cost === null ? -1 : b.cost) - (a.cost === null ? -1 : a.cost) || b.totalTokens - a.totalTokens
      }
      return b.totalTokens - a.totalTokens
    })

  /**
   * 「订阅划算吗」。
   *
   * 订阅线路把折算开关打开以后，会算出「这些 token 按官方标价买要多少钱」（等价金额）。
   * 这里按线路聚合，再把这个时间窗的等价金额按天折成月：等价月费 ≈ 一个月这么用要花多少钱。
   * 拿它跟你实际付的月费（套餐表里的参考价，或者你自己填的）比：
   *
   *   worth      等价月费 ≥ 最低档月费 —— 继续订是值的
   *   near       0.6 ~ 1 倍 —— 差不多，看你还用不用得上别的权益
   *   light      < 0.6 倍 —— 这套餐用得少，可能不如按量买
   *
   * 参考价都没有的线路，结论留空，只把等价月费摆出来。
   */
  const worthAgg = new Map()
  for (const row of bySource) {
    if (row.billing !== 'credits' || !row.worth) continue
    let agg = worthAgg.get(row.provider)
    if (agg === undefined) {
      agg = {
        provider: row.provider,
        routeLabel: row.routeLabel || row.provider,
        calls: 0,
        totalTokens: 0,
        costCNY: 0,
        costUSD: 0,
        models: 0,
        // 展开明细用：每个模型一条，带各自单价
        modelRows: [],
      }
      worthAgg.set(row.provider, agg)
    }
    agg.calls += row.calls
    agg.totalTokens += row.totalTokens
    agg.models += 1
    if (row.worth.currency === 'USD') agg.costUSD += row.worth.cost
    else agg.costCNY += row.worth.cost
    agg.modelRows.push({
      model: row.model,
      calls: row.calls,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      totalTokens: row.totalTokens,
      cost: Number(row.worth.cost.toFixed(4)),
      currency: row.worth.currency,
      // 单价：折算是拿这些数乘出来的，展开后要能一眼核对
      priceProvider: row.worth.priceProvider,
      priceInput: row.worth.priceInput,
      priceOutput: row.worth.priceOutput,
      priceCacheRead: row.worth.priceCacheRead,
      pricingUrl: row.worth.pricingUrl,
      priceDate: row.worth.priceDate,
      alias: row.worth.alias,
    })
  }

  const monthlyScale = 30 / windowMeta.days
  const subscriptionWorth = [...worthAgg.values()]
    .map((agg) => {
      const monthlyCNY = Number(((agg.costCNY + agg.costUSD * USD_TO_CNY) * monthlyScale).toFixed(2))
      const planTierId = billing.planTier(agg.provider)
      const planRef = subscriptionPlanRef(agg.provider, planTierId)
      // 参考月费（2.7.4 优先级）：官方档位（国内价）> 本次实付÷月数 > 手填月费 > plans.js 候选
      const manualMonthly = billing.effectiveMonthlyCNY(agg.provider)
      const paid = billing.paid(agg.provider)
      const officialTier = planRef !== null && planRef.tierSource === 'cn-official' ? planRef : null
      const refMin = officialTier !== null ? officialTier.minCNY : manualMonthly !== null ? manualMonthly : planRef === null ? null : planRef.minCNY
      const refMax = officialTier !== null ? officialTier.maxCNY : manualMonthly !== null ? manualMonthly : planRef === null ? null : planRef.maxCNY
      const refSource =
        officialTier !== null ? 'tier' : manualMonthly !== null ? (paid !== null ? 'paid' : 'manual') : planRef === null ? null : 'plan'
      /**
       * 额度池订阅（quota-pool）：按「用掉的额度 / 该模型额度」的比例，从基础价里扣。
       *
       * 「用掉多少额度」两条口径，**优先官方**：
       *   1. opencode-go：用**这家自己的官方单价**（opencode-go.js 快照，来自公开
       *      models 端点）把 token 折成美元。官方文档明确「$1.5 用量 / $15 额度 = 10%」，
       *      拿原厂价（DeepSeek / 月之暗面）去折会算错 —— 这是 2.7.2 修掉的偏差。
       *   2. 其他家：没有官方单价表，退回按原厂价折出的金额当近似，标 estimated。
       */
      const poolCfg = billing.quotaPool(agg.provider)
      let quotaPool = null
      if (poolCfg !== null) {
        const useGoPrices = agg.provider === 'opencode-go'
        const usedByModel = {}
        let goPriced = 0
        for (const m of agg.modelRows) {
          let usd = null
          if (useGoPrices) {
            usd = goUsageUSD(m.model, {
              inputTokens: m.inputTokens,
              outputTokens: m.outputTokens,
              cacheReadTokens: m.cacheReadTokens,
            })
            if (usd !== null) goPriced += 1
          }
          if (usd === null) usd = m.currency === 'USD' ? m.cost : m.cost / USD_TO_CNY
          usedByModel[m.model] = (usedByModel[m.model] || 0) + usd
        }
        const calc = quotaPoolSpend(poolCfg, usedByModel)
        if (calc !== null) {
          quotaPool = {
            ...calc,
            // 全部模型都用上官方单价 → 不是估算
            estimated: !(useGoPrices && goPriced === agg.modelRows.length && goPriced > 0),
            priceSource: useGoPrices && goPriced > 0 ? 'opencode-official' : 'vendor-estimate',
            goSnapshotAt: useGoPrices ? OPENCODE_GO_SNAPSHOT_AT : null,
            windowDays: windowMeta.days,
          }
        }
      }
      let verdict = null
      let ratio = null
      if (refMin !== null && refMin > 0 && monthlyCNY > 0) {
        ratio = Number((monthlyCNY / refMin).toFixed(2))
        verdict = ratio >= 1 ? 'worth' : ratio >= 0.6 ? 'near' : 'light'
      }
      // 按天：越新的排前面，最多留 31 天（跟 byDay 同一个上限）
      const dayMap = worthDays.get(agg.provider)
      const byDay =
        dayMap === undefined
          ? []
          : [...dayMap.entries()]
              .map(([day, slot]) => ({
                day,
                costCNY: Number((slot.cny + slot.usd * USD_TO_CNY).toFixed(4)),
                tokens: slot.tokens,
                calls: slot.calls,
              }))
              .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
              .slice(0, 31)
      return {
        provider: agg.provider,
        routeLabel: agg.routeLabel,
        calls: agg.calls,
        totalTokens: agg.totalTokens,
        models: agg.models,
        // 这个时间窗里按官方价买要多少钱
        costCNY: Number(agg.costCNY.toFixed(2)),
        costUSD: Number(agg.costUSD.toFixed(2)),
        // 折合月（30 天口径）
        monthlyCNY,
        refMin,
        refMax,
        refSource,
        ratio,
        verdict,
        planRef,
        // 额度池订阅的按比例折算（没配就是 null）
        quotaPool,
        // 订阅时长 / 到期（界面「本期」那行用）
        termMonths: billing.termMonths(agg.provider),
        paid,
        // 官方档位与计费挡位（2.7.4）：月付挡含「一次买俩月」的限时优惠
        planTier: planTierId,
        billingClass: billing.billingClass(agg.provider),
        // 展开明细：每个模型的等价金额（统一折成人民币）+ 折合月
        modelRows: agg.modelRows
          .slice()
          .sort((a, b) => b.cost - a.cost)
          .map((m) => {
            const cny = m.currency === 'USD' ? m.cost * USD_TO_CNY : m.cost
            return {
              ...m,
              costCNY: Number(cny.toFixed(4)),
              monthlyCNY: Number((cny * monthlyScale).toFixed(2)),
            }
          }),
        byDay,
      }
    })
    .sort((a, b) => b.monthlyCNY - a.monthlyCNY)

  /**
   * 组装时间轴（按会话分段）。
   *
   * 层级：一个会话可能是另一个的子会话（subagent 派生的 Task）。
   * 上一层出现在同一 provider 的行里就缩进，否则单独成根 —— 这样图既像时间轴
   * 又保留了「谁是谁派出来的」这层关系。
   */
  const TIMELINE_ROW_LIMIT = 80
  const timeline = { bucketMs, providers: {} }
  for (const [provider, bySession] of timelines) {
    const ids = [...bySession.keys()]
    const idSet = new Set(ids)
    const parentOf = new Map()
    const childrenOf = new Map()
    for (const id of ids) {
      const m = sessionMeta.get(id)
      const rawParent = m && m.parent ? m.parent : null
      // 父会话也在这个 provider 里才挂上去，否则当根
      const parent = rawParent !== null && idSet.has(rawParent) ? rawParent : null
      parentOf.set(id, parent)
      if (parent !== null) {
        const arr = childrenOf.get(parent) || []
        arr.push(id)
        childrenOf.set(parent, arr)
      }
    }
    const byFrom = (a, b) => bySession.get(a).from - bySession.get(b).from
    const roots = ids.filter((id) => parentOf.get(id) === null).sort(byFrom)
    for (const arr of childrenOf.values()) arr.sort(byFrom)

    const rows = []
    let from = Infinity
    let to = 0
    let truncated = 0
    const walk = (id, depth) => {
      const entry = bySession.get(id)
      if (entry.from < from) from = entry.from
      if (entry.to > to) to = entry.to
      if (rows.length >= TIMELINE_ROW_LIMIT) {
        truncated += 1
        return
      }
      const meta = sessionMeta.get(id) || {}
      rows.push({
        sessionId: id,
        title: meta.title || null,
        cwd: meta.cwd || null,
        origin: meta.origin || null,
        depth,
        from: entry.from,
        to: entry.to,
        calls: entry.calls,
        tokens: entry.tokens,
        // 稀疏桶：[起点毫秒, tokens, 调用次数]
        points: [...entry.points.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([t, v]) => [t, v.tokens, v.calls]),
      })
      for (const child of childrenOf.get(id) || []) walk(child, depth + 1)
    }
    for (const id of roots) walk(id, 0)

    if (rows.length > 0) {
      timeline.providers[provider] = {
        from: Number.isFinite(from) ? from : 0,
        to: to > 0 ? to : 0,
        rows,
        sessions: ids.length,
        truncated,
      }
    }
  }

  const byDay = [...days.values()]
    .filter((bucket) => bucket.day >= dayOf(cutoff))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .slice(0, 31)
    .map((bucket) => ({
      day: bucket.day,
      calls: bucket.calls,
      totalTokens: bucket.totalTokens,
      costCNY: Number(bucket.costCNY.toFixed(4)),
      costUSD: Number(bucket.costUSD.toFixed(4)),
      unpricedTokens: bucket.unpricedTokens,
      creditTokens: bucket.creditTokens,
      // 订阅 + 折算那部分等价金额（和实际花费分开）
      worthCNY: Number(bucket.worthCNY.toFixed(4)),
      worthUSD: Number(bucket.worthUSD.toFixed(4)),
      // 峰谷拆分（只有分时价的厂商会填）
      costCNYPeak: Number(bucket.costCNYPeak.toFixed(4)),
      costCNYOffPeak: Number(bucket.costCNYOffPeak.toFixed(4)),      tokensPeak: bucket.tokensPeak,
      tokensOffPeak: bucket.tokensOffPeak,
      // 只算 DeepSeek 系 —— 界面上「实际扣费」那一列只跟它比才同口径
      costCNYDeepSeek: Number(bucket.costCNYDeepSeek.toFixed(4)),
    }))

  const totals = bySource.reduce(
    (acc, row) => ({
      calls: acc.calls + row.calls,
      inputTokens: acc.inputTokens + row.inputTokens,
      outputTokens: acc.outputTokens + row.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
      cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
      totalTokens: acc.totalTokens + row.totalTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
  )

  const result = {
    ok: true,
    at: new Date().toISOString(),
    error: fileErrors > 0 ? `${fileErrors} 个日志文件没解开，下面的数可能偏小` : null,
    window: windowKey,
    windowLabel: windowMeta.label,
    windows: WINDOW_KEYS.map((key) => ({ key, label: WINDOWS[key].label, days: WINDOWS[key].days })),
    scannedFiles: files.length,
    scannedMessages: messages,
    scanMs: Date.now() - startedAt,
    totals: {
      ...totals,
      costCNY: Number(costCNY.toFixed(2)),
      costUSD: Number(costUSD.toFixed(2)),
      unknownCalls,
      unknownTokens,
      creditTokens,
      creditCalls,
      // fork / 分支会话复制的历史事件（已从上面所有统计里剔除）
      dedupedCalls: duplicateCalls,
      dedupedTokens: duplicateTokens,
      // 套餐渠道的等价金额（按官方价折，不是账单）；含「订阅 + 折算」那部分
      estimateCNY: Number(estimateCNY.toFixed(2)),
      estimateUSD: Number(estimateUSD.toFixed(2)),
      // 其中订阅线路（打开折算）的等价金额
      worthCNY: Number(worthCNY.toFixed(2)),
      worthUSD: Number(worthUSD.toFixed(2)),
      // 实际扣费（DeepSeek 余额差分）—— 拿不到就是 null，别当成 0
      actualCNY: actual === null ? null : Number(actualCNY.toFixed(2)),
      actualDays,
      actualNewest,
      actualLastBalance: actual === null ? null : actual.lastBalance,
    },
    actualByDay,
    bySource,
    byDay,
    // 「订阅划算吗」：打开了折算的订阅线路，等价月费 vs 参考月费
    subscriptionWorth,
    worthMeta: {
      windowDays: windowMeta.days,
      usdToCny: USD_TO_CNY,
      planSnapshotAt: PLAN_SNAPSHOT_AT,
    },
    creditBalances,
    timeline,
    // 云端出图 / 出视频花费（独立小节，不并入上面的 token 折算）
    media,
  }

  return result
}
