/**
 * ai-credits · 官方价格实时核对
 * ============================================================================
 * `prices.js` 里的数字是人工核对的快照，容易和官网脱节。这个模块直接去官网
 * 把价目表拉下来解析，回答一个问题：**本机记的价和官网现在挂的价，一样吗？**
 *
 * 只做 DeepSeek —— 它的价格页结构稳定（服务端渲染的真表格），能可靠解析；
 * 别家页面多是 JS 渲染或纯文本描述，硬解析反而会抓错。
 *
 * 设计原则：
 *   - 解析失败 → 返回 ok:false，绝不用半截数据覆盖已知价格
 *   - 解析成功但数值离谱（超出合理区间）→ 也当失败，防止官网改版抓出怪数
 *   - 宿主缓存 6 小时，别每次开页面都打人家官网
 */

const DOC_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
const CACHE_MS = 6 * 60 * 60 * 1000
const TIMEOUT_MS = 15000

/** 价格合理区间（每百万 tokens 的人民币价）——越界就当解析失败 */
const SANITY = {
  'deepseek-flash': { cacheHit: [0.001, 1], input: [0.1, 30], output: [0.1, 100] },
  'deepseek-v4-pro': { cacheHit: [0.01, 5], input: [0.5, 60], output: [1, 200] },
}

let cache = null

const num = (v) => {
  const n = Number(String(v).trim())
  return Number.isFinite(n) ? n : null
}

/** 把所有 <tr> 读成「每行一个字符串数组」（不限列数 —— rowspan 会让某些行少列） */
function parseRowsAll(html) {
  const rows = []
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g
  let m
  while ((m = trRe.exec(html)) !== null) {
    const cells = []
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g
    let t
    while ((t = tdRe.exec(m[1])) !== null) {
      cells.push(
        t[1]
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

/**
 * 从官网 HTML 抽出结构化价格。
 * 返回 null 表示解析不出可信结果。
 *
 * ⚠ 表格用了 rowspan：「功能」格子横跨两行，所以「高峰时段」那一行只有
 *   [时段, flash价, pro价] 三列，没有功能列。必须按「先记住功能、再收时段价」
 *   的顺序累积，不能一行一个功能地读。
 */
function extract(html) {
  if (typeof html !== 'string' || html.length < 2000) return null
  const rows = parseRowsAll(html)

  // feature -> { off: [flash, pro], peak: [flash, pro] }
  const bucket = { hit: {}, miss: {}, out: {} }
  let feature = null

  for (const cells of rows) {
    const line = cells.join(' ')
    // 注意顺序：「缓存未命中」里不含「缓存命中」子串，但先判断更稳妥
    if (/缓存未命中/.test(line)) feature = 'miss'
    else if (/缓存命中/.test(line)) feature = 'hit'
    else if (/tokens\s*输出/.test(line)) feature = 'out'

    const idx = cells.findIndex((c) => /空闲时段|高峰时段/.test(c))
    if (idx < 0 || feature === null) continue
    const period = /空闲/.test(cells[idx]) ? 'off' : 'peak'
    const a = num(String(cells[idx + 1] || '').replace(/[^\d.]/g, ''))
    const b = num(String(cells[idx + 2] || '').replace(/[^\d.]/g, ''))
    if (a !== null && b !== null) bucket[feature][period] = [a, b]
  }

  const need = ['hit', 'miss', 'out']
  for (const f of need) {
    if (!bucket[f].off || !bucket[f].peak) return null
  }

  // 列的顺序 = 模型顺序（DeepSeek 价目页固定先 flash 后 pro）
  const build = (i) => ({
    cacheRead: { off: bucket.hit.off[i], peak: bucket.hit.peak[i] },
    input: { off: bucket.miss.off[i], peak: bucket.miss.peak[i] },
    output: { off: bucket.out.off[i], peak: bucket.out.peak[i] },
  })

  const models = {
    'deepseek-flash': build(0),
    'deepseek-v4-pro': build(1),
  }

  // 区间校验：官网改版抓出怪数时宁可当失败
  for (const [id, price] of Object.entries(models)) {
    const limit = SANITY[id]
    if (!limit) continue
    const check = (range, label) => {
      if (!range || !Number.isFinite(range.off) || !Number.isFinite(range.peak)) return false
      if (range.off < limit[label][0] || range.off > limit[label][1]) return false
      if (range.peak < limit[label][0] || range.peak > limit[label][1]) return false
      // 官方规则：空闲 = 高峰的一半，容差放宽到 0.3~0.7 倍
      const ratio = range.off / range.peak
      if (ratio < 0.3 || ratio > 0.7) return false
      return true
    }
    if (
      !check(price.cacheRead, 'cacheHit') ||
      !check(price.input, 'input') ||
      !check(price.output, 'output')
    ) {
      return null
    }
  }

  // 时段规则原文（拿来做界面提示）
  const peakMatch = html.match(/北京时间[^<]{0,80}?高峰时段[^<]{0,60}/)
  const peakNote = peakMatch ? peakMatch[0].replace(/\s+/g, ' ').trim() : null

  return { models, peakNote }
}

/**
 * 拉官网价。带 6 小时缓存。
 * @returns { ok, at, error?, models?, peakNote?, cached? }
 */
export async function fetchOfficialPricing(options) {
  const force = options && options.force === true
  const now = Date.now()
  if (!force && cache !== null && now - cache.atMs < CACHE_MS) {
    return { ...cache.value, cached: true }
  }

  let html
  try {
    const response = await fetch(DOC_URL, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error('HTTP ' + response.status)
    }
    html = await response.text()
  } catch (error) {
    // 拉不到就返回失败，但**保留上一次成功的结果**给界面做参考
    const stale = cache !== null ? { ...cache.value, cached: true, stale: true } : null
    return {
      ok: false,
      at: new Date().toISOString(),
      error: '拉官网失败：' + String((error && error.message) || error),
      models: stale ? stale.models : null,
      peakNote: stale ? stale.peakNote : null,
    }
  }

  const extracted = extract(html)
  if (extracted === null) {
    const stale = cache !== null ? { ...cache.value, cached: true, stale: true } : null
    return {
      ok: false,
      at: new Date().toISOString(),
      error: '官网页面结构变了，解析不出可信价格（没动本地价）',
      models: stale ? stale.models : null,
      peakNote: stale ? stale.peakNote : null,
    }
  }

  const value = {
    ok: true,
    at: new Date().toISOString(),
    url: DOC_URL,
    models: extracted.models,
    peakNote: extracted.peakNote,
  }
  cache = { atMs: now, value }
  return value
}

/**
 * 拿官网价和本地 prices.js 的 DeepSeek 条目逐项对比。
 * 返回每个字段的「本地 / 官网 / 是否一致」。
 */
export function diffWithLocal(localProvider, official) {
  if (!official || official.ok !== true || !official.models) return null
  const local = new Map()
  for (const model of (localProvider && localProvider.models) || []) local.set(model.id, model)

  const rows = []
  for (const [id, price] of Object.entries(official.models)) {
    const mine = local.get(id)
    if (!mine) {
      rows.push({ model: id, field: '（本地没有这条）', local: null, official: null, same: false })
      continue
    }
    const mineOff = mine.offPeak || {}
    const pairs = [
      ['缓存命中·高峰', mine.cacheRead, price.cacheRead.peak],
      ['缓存命中·空闲', mineOff.cacheRead, price.cacheRead.off],
      ['未命中输入·高峰', mine.input, price.input.peak],
      ['未命中输入·空闲', mineOff.input, price.input.off],
      ['输出·高峰', mine.output, price.output.peak],
      ['输出·空闲', mineOff.output, price.output.off],
    ]
    for (const [field, a, b] of pairs) {
      const same = Number(a) === Number(b)
      rows.push({ model: id, field, local: a === undefined ? null : a, official: b, same })
    }
  }
  return {
    rows,
    allSame: rows.every((r) => r.same),
    mismatched: rows.filter((r) => !r.same),
  }
}
