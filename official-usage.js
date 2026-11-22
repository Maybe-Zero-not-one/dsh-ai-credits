/**
 * ai-credits · 官方用量账单（CSV 导入）
 * ============================================================================
 * DeepSeek 开放平台能导出官方用量 CSV，里面有**官方实际计费**的 token 和金额。
 * 这是唯一能拿到「官方口径」的途径 —— API 没有用量查询端点（`/user/usage` 404），
 * `platform.deepseek.com/usage` 是登录态网页，API key 进不去。
 *
 * 用法：把导出的 zip 解压到 `$DSH_HOME/ai-credits/official-usage/`，插件自动读。
 *
 * 文件格式（导出得到两个）：
 *   amount-*.csv : user_id,start_time_iso,end_time_iso,model,name,api_key_name,api_key,type,price,amount
 *                  type ∈ input_cache_hit_tokens / input_cache_miss_tokens / output_tokens /
 *                         request_count / function_call
 *                  ⚠ price 是**每 token** 的单价，不是每百万
 *   cost-*.csv   : ...,wallet_type,cost,currency   ← 每日每模型的金额小计
 *
 * amount.csv 比 cost.csv 多了 api_key_name 维度，所以按 key 拆分只能用它。
 * 两者金额应当一致（amount 的 price × amount 求和 = cost 的 cost 求和）。
 *
 * 导入方式有两种：
 *   1. 页面上点「导入官方账单」选 zip 或 csv —— 推荐，不用碰文件系统
 *   2. 手动把文件放到 `$DSH_HOME/ai-credits/official-usage/`
 * 两条路都落到同一个目录，读的时候没区别。
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const CACHE_MS = 60 * 1000
let cache = null

/** 官方账单目录 */
const usageDirOf = (home) => join(home, 'ai-credits', 'official-usage')

/** 解析结果清掉，下次读会重新扫目录 */
export function invalidateOfficialUsage() {
  cache = null
}

/**
 * 极简 ZIP 读取：只取 .csv 条目。
 *
 * 不引第三方库 —— 官方导出的 zip 只有「存储」和「deflate」两种压缩方式，
 * Node 自带 zlib 就能解。按中央目录读，别按顺序扫（顺序扫会把注释和
 * 数据描述符搞混）。
 */
function extractCsvFromZip(buffer) {
  const out = []
  // 找 EOCD（签名 0x06054b50），从尾部往前扫，最多 64KB 注释
  let eocd = -1
  const scanFrom = Math.max(0, buffer.length - 0xffff - 22)
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return out

  const count = buffer.readUInt16LE(eocd + 10)
  let ptr = buffer.readUInt32LE(eocd + 16)

  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buffer.length) break
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) break

    const method = buffer.readUInt16LE(ptr + 10)
    const compSize = buffer.readUInt32LE(ptr + 20)
    const nameLen = buffer.readUInt16LE(ptr + 28)
    const extraLen = buffer.readUInt16LE(ptr + 30)
    const commentLen = buffer.readUInt16LE(ptr + 32)
    const localOffset = buffer.readUInt32LE(ptr + 42)
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen)

    ptr += 46 + nameLen + extraLen + commentLen

    if (!name.toLowerCase().endsWith('.csv')) continue
    if (localOffset + 30 > buffer.length) continue
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue

    // 本地头的 name/extra 长度可能和中央目录不同，必须重新读
    const lNameLen = buffer.readUInt16LE(localOffset + 26)
    const lExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const dataEnd = dataStart + compSize
    if (dataEnd > buffer.length) continue

    const raw = buffer.subarray(dataStart, dataEnd)
    try {
      const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw)
      out.push({ name: basename(name), data })
    } catch (error) {
      // 单个条目坏了就跳过，别让整包失败
    }
  }
  return out
}

/** 文件名消毒：只留基名和保守字符，强制 .csv 结尾 */
function safeCsvName(name) {
  const base = basename(String(name || '')).replace(/[^A-Za-z0-9._-]/g, '_')
  if (base === '' || base === '.' || base === '..') return null
  if (!base.toLowerCase().endsWith('.csv')) return null
  return base
}

/**
 * 导入官方账单。
 *
 * @param home - $DSH_HOME
 * @param name - 上传的文件名（.zip 或 .csv）
 * @param data - Buffer
 * @returns { ok, written[], skipped[], error? }
 */
export async function importOfficialFiles(home, name, data) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    return { ok: false, error: '文件是空的', written: [], skipped: [] }
  }
  const MAX = 32 * 1024 * 1024
  if (data.length > MAX) {
    return { ok: false, error: '文件太大（限 32MB）', written: [], skipped: [] }
  }

  const lower = String(name || '').toLowerCase()
  const entries = []

  if (lower.endsWith('.zip')) {
    const found = extractCsvFromZip(data)
    if (found.length === 0) {
      return { ok: false, error: 'zip 里没找到 .csv（是不是解压过的原始导出？）', written: [], skipped: [] }
    }
    entries.push(...found)
  } else if (lower.endsWith('.csv')) {
    entries.push({ name: String(name), data })
  } else {
    return { ok: false, error: '只认 .zip 或 .csv', written: [], skipped: [] }
  }

  const dir = usageDirOf(home)
  try {
    await mkdir(dir, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      error: '建不了目录：' + String((error && error.message) || error),
      written: [],
      skipped: [],
    }
  }

  const written = []
  const skipped = []
  for (const entry of entries) {
    const safe = safeCsvName(entry.name)
    if (safe === null) {
      skipped.push(entry.name)
      continue
    }
    try {
      await writeFile(join(dir, safe), entry.data)
      written.push(safe)
    } catch (error) {
      skipped.push(safe + '（写入失败）')
    }
  }

  // 有新文件就清缓存，下一次读立刻生效
  if (written.length > 0) invalidateOfficialUsage()

  if (written.length === 0) {
    return { ok: false, error: '没有可写入的 csv', written, skipped }
  }
  return { ok: true, written, skipped, dir }
}

/**
 * 官方 key 名 → DSH 线路 id 的映射。
 *
 * 官方账单里 `api_key_name` 是用户在开放平台给 key 起的名字，DSH 里根本不叫这个。
 * 这里把「哪个 key 对应哪条线路」写死，界面才能把官方金额摆到对应渠道旁边。
 *
 * ⚠ 这张表是**本机**的 key 名，换台机器对不上 —— 所以只在配置里没给的时候兜底用。
 * 想在自己的机器上用，把 `officialKeyMap` 写进插件配置，或让下面的自动探测猜。
 */
export const PROVIDER_KEY_MAP = {
  'deepseek-account': 'DeepSeek Harness (App-managed)',
  'deepseek-official': '4',
}

/**
 * 猜「官方账单里哪个 key 是 DSH 自己的」。
 *
 * 依据只有名字，所以只做有把握的猜测，猜不准就返回空 —— 界面会隐藏对比，
 * 但那只是少一栏对照，不影响任何金额统计。
 *
 *   账号线路（deepseek-account）：名字里带 Harness / App-managed 的那个
 *   官方 API（deepseek-official）：剩下的 key 里名字最短且像编号的那个
 *      （DSH 自建 key 常被起名成 1 / 2 / 4 这种，用户自己起的）
 */
function guessKeyMap(byKey) {
  const names = (byKey || []).map((k) => String(k.name || '')).filter((n) => n !== '')
  if (names.length === 0) return {}

  const out = {}
  const managed = names.find((n) => /harness|app-managed/i.test(n))
  if (managed !== undefined) out['deepseek-account'] = managed

  // 纯数字 / 极短的名字当作「我给自己建的 API key」
  const short = names
    .filter((n) => n !== managed)
    .filter((n) => /^\d{1,3}$/.test(n) || n.length <= 2)
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  if (short.length === 1) out['deepseek-official'] = short[0]

  return out
}

/**
 * 定下这张映射表：配置优先，探测补空缺，配置里不存在的 key 名会被丢掉。
 *
 * 为什么要丢掉：这张表带着的是**本机**的 key 名。把插件打包给别人时，配置也会
 * 一起过去，里面的 `DeepSeek Harness (App-managed)` / `4` 在对方账单里根本不存在。
 * 与其让它们占着位置、让对方那栏永远空着，不如过滤掉再按对方的名字重新猜。
 */
export function resolveKeyMap(configMap, byKey) {
  const present = new Set((byKey || []).map((k) => String(k.name || '')))
  const out = {}

  if (configMap && typeof configMap === 'object') {
    for (const [provider, keyName] of Object.entries(configMap)) {
      if (typeof keyName !== 'string') continue
      const name = keyName.trim()
      // 只保留账单里真的有的 —— 换机器后旧名字自然失效，不挡着自动探测
      if (name !== '' && present.has(name)) out[provider] = name
    }
  }

  // 配置没覆盖到的线路，用名字猜
  for (const [provider, keyName] of Object.entries(guessKeyMap(byKey))) {
    if (out[provider] === undefined) out[provider] = keyName
  }

  return out
}

/** 极简 CSV 解析（支持双引号包裹与转义引号） */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 读官方用量目录并聚合。
 *
 * ⚠ 多次导出必然重叠（这次的「近 30 天」和上次的「近 30 天」大半是一样的），
 *   直接逐行累加会重复计数。本机实测：三份 CSV 共 458 行，去重后只有 247 行，
 *   金额从 308.86 虚高到实际 156.62 —— 整整多算一倍。
 *
 * 去重键（必须带 price，否则同一个峰谷价会被当成重复行砍掉一半）：
 *
 *   amount：start_time_iso | end_time_iso | model | api_key_name | type | price
 *   cost  ：start_time_iso | end_time_iso | model | wallet_type | currency
 *
 * 优先级按**文件修改时间**：后导入的覆盖先导入的。为什么按这个而不是按文件名：
 * 导出时间段还没结束时导出的那份，最后一天是残缺的。本机实测 2026-11-17 那份
 * （11-17 21:59 导出）比 11-21 导出的同日数据少了 25092 miss / 3466 output ——
 * 当时那天还没过完。所以「更晚的文件」在这类数据上就是「更准的文件」。
 *
 * 两种去重键算出来的金额必须一致（amount 按行算 vs cost 按日算），
 * 对不上就说明有一边解析错了，界面会标出来。
 *
 * @param home - $DSH_HOME
 * @returns { ok, at, error?, files[], overlaps[], dedupe, range, byDay[], byKey[], totals }
 */
export async function collectOfficialUsage(home, options) {
  const force = options && options.force === true
  const now = Date.now()
  if (!force && cache !== null && now - cache.atMs < CACHE_MS) return cached(cache.value)

  const dir = usageDirOf(home)
  const empty = {
    ok: false,
    at: new Date().toISOString(),
    error: '还没导入官方账单',
    dir,
    files: [],
    overlaps: [],
    dedupe: null,
    range: null,
    byDay: [],
    byKey: [],
    totals: null,
  }

  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    return empty
  }

  const csvNames = names.filter((n) => n.toLowerCase().endsWith('.csv'))
  if (csvNames.length === 0) {
    return { ...empty, error: '目录里没有 CSV' }
  }

  // 按 mtime 升序：后面的一定覆盖前面的
  const entries = []
  for (const name of csvNames) {
    let mtime = 0
    try {
      mtime = (await stat(join(dir, name))).mtimeMs
    } catch (error) {
      continue
    }
    entries.push({ name, mtime })
  }
  entries.sort((a, b) => a.mtime - b.mtime || String(a.name).localeCompare(String(b.name)))

  // amount 行的唯一表：键 → { 行数据, 来自哪个文件 }
  const amountRows = new Map()
  // cost 行的唯一表
  const costRows = new Map()
  // 每个文件的统计
  const fileStats = []
  // 每一天被哪些文件覆盖（用来算重叠区间）
  const daySources = new Map()

  let rawAmountRows = 0
  let rawCostRows = 0
  let parsedAmount = 0
  let parsedCost = 0
  let overwritten = 0
  let conflicts = 0
  let conflictCostDelta = 0
  // 如果逐行累加（不去重）会算出多少 —— 用来告诉用户重复导入虚高了多少
  let rawCostTotal = 0

  for (const entry of entries) {
    let text
    try {
      text = await readFile(join(dir, entry.name), 'utf8')
    } catch (error) {
      continue
    }
    const rows = parseCsv(text)
    if (rows.length < 2) continue
    const head = rows[0].map((h) => h.trim())
    const idx = (k) => head.indexOf(k)
    const iStart = idx('start_time_iso')
    const iEnd = idx('end_time_iso')
    const iModel = idx('model')
    const iType = idx('type')
    const iAmount = idx('amount')
    const iPrice = idx('price')
    const iKey = idx('api_key_name')
    const iCost = idx('cost')
    const iWallet = idx('wallet_type')
    const iCurrency = idx('currency')

    const stat0 = {
      name: entry.name,
      mtime: new Date(entry.mtime).toISOString(),
      kind: 'other',
      rows: 0,
      days: [],
    }

    // ---------- amount 表 ----------
    if (iStart >= 0 && iType >= 0 && iAmount >= 0) {
      parsedAmount += 1
      stat0.kind = 'amount'
      const days = new Set()
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r]
        if (cells.length < head.length) continue
        const day = String(cells[iStart] || '').slice(0, 10)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
        rawAmountRows += 1
        stat0.rows += 1
        days.add(day)

        const price = iPrice >= 0 ? String(cells[iPrice] || '').trim() : ''
        // 键里必须带 price：同一天同一模型在峰谷两个价档各有一行，漏了 price
        // 就会把它们判成重复、砍掉其中一半的 token
        const key = [
          String(cells[iStart] || '').trim(),
          iEnd >= 0 ? String(cells[iEnd] || '').trim() : '',
          iModel >= 0 ? String(cells[iModel] || '').trim() : '',
          iKey >= 0 ? String(cells[iKey] || '').trim() : '',
          String(cells[iType] || '').trim(),
          price,
        ].join('\u0001')

        const row = {
          day,
          type: String(cells[iType] || '').trim(),
          amount: num(cells[iAmount]),
          price: num(price),
          keyName: iKey >= 0 ? String(cells[iKey] || '').trim() || '(未命名)' : '(未命名)',
          file: entry.name,
        }
        if (row.type !== 'request_count') rawCostTotal += row.amount * row.price
        const prev = amountRows.get(key)
        if (prev !== undefined) {
          overwritten += 1
          if (prev.amount !== row.amount || prev.price !== row.price) {
            conflicts += 1
            const prevCost = prev.type === 'request_count' ? 0 : prev.amount * prev.price
            const nextCost = row.type === 'request_count' ? 0 : row.amount * row.price
            conflictCostDelta += nextCost - prevCost
          }
        }
        amountRows.set(key, row)
      }
      stat0.days = [...days].sort()
      fileStats.push(stat0)
      for (const day of days) {
        if (!daySources.has(day)) daySources.set(day, [])
        daySources.get(day).push(entry.name)
      }
      continue
    }

    // ---------- cost 表 ----------
    if (iStart >= 0 && iCost >= 0) {
      parsedCost += 1
      stat0.kind = 'cost'
      const days = new Set()
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r]
        if (cells.length < head.length) continue
        const day = String(cells[iStart] || '').slice(0, 10)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
        rawCostRows += 1
        stat0.rows += 1
        days.add(day)
        const key = [
          String(cells[iStart] || '').trim(),
          iEnd >= 0 ? String(cells[iEnd] || '').trim() : '',
          iModel >= 0 ? String(cells[iModel] || '').trim() : '',
          iWallet >= 0 ? String(cells[iWallet] || '').trim() : '',
          iCurrency >= 0 ? String(cells[iCurrency] || '').trim() : '',
        ].join('\u0001')
        costRows.set(key, {
          day,
          cost: num(cells[iCost]),
          file: entry.name,
        })
      }
      stat0.days = [...days].sort()
      fileStats.push(stat0)
      continue
    }

    fileStats.push(stat0)
  }

  if (parsedAmount === 0) {
    return { ...empty, error: 'CSV 里没有可识别的用量表（缺 start_time_iso / type / amount 列）' }
  }

  // ---------- 从去重后的表聚合 ----------
  const byDayMap = new Map()
  const byKeyMap = new Map()
  const totals = { cost: 0, hit: 0, miss: 0, out: 0, requests: 0, fnCalls: 0, fnCost: 0 }

  for (const row of amountRows.values()) {
    const { day, type, amount, price, keyName } = row
    const cost = type === 'request_count' ? 0 : amount * price

    let dayRow = byDayMap.get(day)
    if (dayRow === undefined) {
      dayRow = { day, cost: 0, hit: 0, miss: 0, out: 0, requests: 0, fnCalls: 0, fnCost: 0 }
      byDayMap.set(day, dayRow)
    }
    let keyRow = byKeyMap.get(keyName)
    if (keyRow === undefined) {
      keyRow = { name: keyName, cost: 0, hit: 0, miss: 0, out: 0, requests: 0, fnCalls: 0, days: new Set() }
      byKeyMap.set(keyName, keyRow)
    }
    keyRow.days.add(day)

    if (type === 'input_cache_hit_tokens') {
      dayRow.hit += amount
      keyRow.hit += amount
      totals.hit += amount
    } else if (type === 'input_cache_miss_tokens') {
      dayRow.miss += amount
      keyRow.miss += amount
      totals.miss += amount
    } else if (type === 'output_tokens') {
      dayRow.out += amount
      keyRow.out += amount
      totals.out += amount
    } else if (type === 'request_count') {
      dayRow.requests += amount
      keyRow.requests += amount
      totals.requests += amount
    } else if (type === 'function_call') {
      dayRow.fnCalls += amount
      dayRow.fnCost += cost
      keyRow.fnCalls += amount
      totals.fnCalls += amount
      totals.fnCost += cost
    } else {
      continue
    }
    if (type !== 'request_count') {
      dayRow.cost += cost
      keyRow.cost += cost
      totals.cost += cost
    }
  }

  // cost 表的去重总额，用来跟 amount 表交叉校验
  let costTableTotal = 0
  for (const row of costRows.values()) costTableTotal += row.cost

  // ---------- 时间节点梳理 ----------
  const daysWithData = [...byDayMap.keys()].sort()
  const today = new Date()
  const dayList = daysWithData.map((day) => ({
    day,
    sources: (daySources.get(day) || []).slice(),
    shared: (daySources.get(day) || []).length > 1,
  }))

  // 重叠区间：把连续的重叠日合并成一段，方便界面直接显示「哪几天被合并过」
  const overlaps = []
  let run = null
  for (const item of dayList) {
    if (item.shared) {
      if (run === null) {
        run = { from: item.day, to: item.day, days: 1, files: new Set(item.sources) }
      } else {
        run.to = item.day
        run.days += 1
        for (const f of item.sources) run.files.add(f)
      }
    } else if (run !== null) {
      overlaps.push({ ...run, files: [...run.files] })
      run = null
    }
  }
  if (run !== null) overlaps.push({ ...run, files: [...run.files] })

  // 区间内没有数据的天（导出时间段之间跳过的日子，不是错误，只是那几天没用量）
  const missing = []
  if (daysWithData.length > 0) {
    const from = Date.parse(daysWithData[0] + 'T00:00:00Z')
    const to = Date.parse(daysWithData[daysWithData.length - 1] + 'T00:00:00Z')
    const have = new Set(daysWithData)
    for (let t = from; t <= to; t += 86400000) {
      const key = new Date(t).toISOString().slice(0, 10)
      if (!have.has(key)) missing.push(key)
    }
  }

  const byDay = [...byDayMap.values()]
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
    .map((row) => ({
      ...row,
      cost: Number(row.cost.toFixed(4)),
      fnCost: Number(row.fnCost.toFixed(4)),
    }))

  const byKey = [...byKeyMap.values()]
    .sort((a, b) => b.cost - a.cost)
    .map((row) => ({
      name: row.name,
      cost: Number(row.cost.toFixed(4)),
      hit: row.hit,
      miss: row.miss,
      out: row.out,
      requests: row.requests,
      fnCalls: row.fnCalls,
      days: row.days.size,
    }))

  const amountTotal = Number(totals.cost.toFixed(4))
  const costTotal = Number(costTableTotal.toFixed(4))

  const value = {
    ok: true,
    at: new Date().toISOString(),
    dir,
    files: fileStats,
    // 每份文件的时间段，界面用来显示「这份覆盖了哪几天」
    overlaps,
    dedupe: {
      amountRows: rawAmountRows,
      amountUnique: amountRows.size,
      costRows: rawCostRows,
      costUnique: costRows.size,
      overwritten,
      conflicts,
      conflictCostDelta: Number(conflictCostDelta.toFixed(4)),
      files: parsedAmount + parsedCost,
    },
    range: {
      from: daysWithData[0] || null,
      to: daysWithData[daysWithData.length - 1] || null,
      days: daysWithData.length,
      missing,
    },
    byDay,
    byKey,
    totals: {
      ...totals,
      cost: amountTotal,
      fnCost: Number(totals.fnCost.toFixed(4)),
      // cost 表（按日）与 amount 表（按行）去重后必须一致
      costCsvTotal: costTotal,
      agree: Math.abs(amountTotal - costTotal) < 0.02,
      // 不去重会算成多少 / 因此虚高的部分
      rawCost: Number(rawCostTotal.toFixed(4)),
      overcount: Number((rawCostTotal - amountTotal).toFixed(4)),
    },
  }
  cache = { atMs: now, value }
  return cached(value)
}

function cached(value) {
  return value
}
