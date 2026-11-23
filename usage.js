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
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

import { PRICE_PROVIDERS } from './prices.js'
import { PROVIDER_KEY_MAP } from './official-usage.js'
import { CODING_PLANS, PLAN_SNAPSHOT_AT } from './plans.js'

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
      messages: 0,
      meta: null,
      error: String((error && error.message) || error),
    }
  }

  const rows = []
  const extras = []
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

  return { rows, extras, messages, meta, error: null }
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
const DISK_CACHE_VERSION = 4
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
    return { rows: [], extras: [], messages: 0, meta: null, error: null }
  }
  const hit = fileCache.get(filePath)
  if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
    return {
      rows: hit.rows,
      extras: hit.extras || [],
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
  'local-claude-code': { endpoint: null, label: 'Claude Code' },
  'local-codex-cli': { endpoint: null, label: 'Codex CLI' },
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
 * 这条订阅线路在套餐表里的参考月费（人民币，取最低档到最高档）。
 * 套餐表里没有对得上的 → null，界面退回手填。
 */
function subscriptionPlanRef(provider) {
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
  }
}



/** 这条线路要不要按「真实花费」折钱 */
const isTokenBilled = (provider) => TOKEN_BILLED.has(provider)

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
  token: '按量计费',
  estimate: '套餐 · 折算',
  credits: '订阅 · 不折钱',
}

/** 订阅线路也打开折算时的那一档 —— 它不是第四种模式，是「订阅 + 折钱」的组合 */
const BILLING_LABEL_FOLDED = '订阅 · 折算'

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
    return { mode: value, estimate: value === 'estimate', monthlyCNY: null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const mode = BILLING_MODES.includes(value.mode) ? value.mode : null
  const estimate = value.estimate === true
  const monthlyCNY =
    typeof value.monthlyCNY === 'number' && Number.isFinite(value.monthlyCNY) && value.monthlyCNY > 0
      ? value.monthlyCNY
      : null
  if (mode === null && estimate === false && monthlyCNY === null) return null
  return { mode, estimate, monthlyCNY }
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
    /** 要不要查价、要不要算钱（按量 / 套餐折算 / 订阅+折算 三种都算） */
    priced: (provider) => effective(provider) !== 'credits' || foldCredit(provider),
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
        creditTokens += bucket.total
        creditCalls += bucket.calls
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
        creditTokens += bucket.total
        creditCalls += bucket.calls
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
      const planRef = subscriptionPlanRef(agg.provider)
      const manualMonthly = billing.monthlyCNY(agg.provider)
      const refMin = manualMonthly !== null ? manualMonthly : planRef === null ? null : planRef.minCNY
      const refMax = manualMonthly !== null ? manualMonthly : planRef === null ? null : planRef.maxCNY
      const refSource = manualMonthly !== null ? 'manual' : planRef === null ? null : 'plan'
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
  }

  return result
}
