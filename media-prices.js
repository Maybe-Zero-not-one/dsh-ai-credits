/**
 * ai-credits · 媒体生成价格快照（生图 / 生视频）
 * ============================================================================
 * 这里放的是**云端出图 / 出视频**的官方公开标价 —— 跟 prices.js（按 token 的
 * LLM 单价）是两套完全不同的计费口径：
 *
 *   · 生图：按「每张输出图」计价，部分模型再按输出图像素分档（元/张）。
 *   · 生视频：按 token 计价，token 用量 = (输入视频时长+输出时长) × 宽 × 高
 *             × 帧率 / 1024，再乘「元/M token」单价（随分辨率档变化）。
 *             纯文生视频 / 图生视频没有「输入视频」，那一项按 0 算。
 *
 * ⚠ 和 prices.js 一样，这些数字**不自动爬取**，是人工核对的官网标价；改价时
 *   手动改这里并把 MEDIA_PRICE_SNAPSHOT_AT 改成核对日期。视频 token 用量是
 *   **估算值**（官方原话「准确 token 用量以 API 返回的 usage.completion_tokens
 *   为准」），本机拿不到那个字段，所以用官方给的估算公式。
 *
 * 币种：国内厂商一律 CNY；个别只有海外价的标 USD，usage.js 折算时按 USD_TO_CNY 换。
 *
 * 来源：
 *   火山方舟  https://www.volcengine.com/docs/82379/1544106 （Seedream 生图 / Seedance 生视频）
 *   硅基流动  https://www.siliconflow.cn/models/Qwen%2FQwen-Image
 *   阿里百炼  https://help.aliyun.com/zh/model-studio/wan2-7-image ；developer.aliyun.com/article/1763163
 */
export const MEDIA_PRICE_SNAPSHOT_AT = '2026-11-25'

/**
 * 模型 id 归一：官方 id 常带日期后缀（doubao-seedream-5-0-pro-260628），
 * 价格表按「基础名」建键，查的时候先把尾巴的 -<6~8位数字> 去掉。
 */
export function normalizeMediaModel(id) {
  return String(id || '')
    .trim()
    .toLowerCase()
    .replace(/-\d{6,8}$/, '')
}

/** 从「供应商」显示名里取一个短名（截到第一个全角括号 / 斜杠前） */
export function shortProvider(name) {
  const s = String(name || '').trim()
  if (s === '') return ''
  const cut = s.split(/[（(/]/)[0].trim()
  return cut || s
}

// ---------------------------------------------------------------- 生图价格
// tiers：按输出图**总像素**分档（升序，命中第一个 pixels <= maxPx 的档）；
//        没有 tiers 就用 price（单一价）。
export const IMAGE_PRICES = {
  'doubao-seedream-5-5': {
    provider: '火山方舟',
    currency: 'CNY',
    tiers: [
      { maxPx: 2_610_000, price: 0.13 },
      { maxPx: 4_630_000, price: 0.23 },
    ],
    note: '输出图按像素分档；输入图另计 0.05/张（文生视频无输入图）',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
  'doubao-seedream-5-0-pro': {
    provider: '火山方舟',
    currency: 'CNY',
    tiers: [
      { maxPx: 2_610_000, price: 0.3 },
      { maxPx: Infinity, price: 0.6 },
    ],
    note: '单图生成价；输入图首张免费、第 2 张起 0.02/张',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
  'doubao-seedream-5-0-flash': {
    provider: '火山方舟',
    currency: 'CNY',
    price: 0.12,
    note: '输入免费；各分辨率同价',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
  'doubao-seedream-4-5': {
    provider: '火山方舟',
    currency: 'CNY',
    price: 0.25,
    note: '文生图 / 图生图同价',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
  'doubao-seedream-4-0': {
    provider: '火山方舟',
    currency: 'CNY',
    price: 0.2,
    note: '输入免费；组图按实际张数计',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
  'qwen/qwen-image': {
    provider: '硅基流动',
    currency: 'CNY',
    price: 0.3,
    note: '按张计费',
    url: 'https://www.siliconflow.cn/models/Qwen%2FQwen-Image',
  },
  'wan2.7-image': {
    provider: '阿里百炼',
    currency: 'CNY',
    price: 0.2,
    note: '按张计费',
    url: 'https://help.aliyun.com/zh/model-studio/wan2-7-image',
  },
  'wan2.7-image-pro': {
    provider: '阿里百炼',
    currency: 'CNY',
    price: 0.5,
    note: '按张计费',
    url: 'https://help.aliyun.com/zh/model-studio/wan2-7-image-pro',
  },
  'qwen-image-3.0-pro': {
    provider: '阿里百炼',
    currency: 'CNY',
    price: 0.25,
    note: '1K 图 0.25/张；2K 图 0.5/张（按分辨率档，此处未细分，按 1K 估）',
    url: 'https://developer.aliyun.com/article/1763163',
  },
}

// ---------------------------------------------------------------- 生视频价格
// byRes：分辨率档 → 元/M token（输入不含视频价；含视频输入更便宜，此处不区分）。
// 未知 / 缺档退回 fallbackRes。
export const VIDEO_PRICES = {
  'doubao-seedance-2-5': {
    provider: '火山方舟',
    currency: 'CNY',
    fps: 24,
    byRes: { '480p': 70, '720p': 70, '1080p': 77, '4k': 31 },
    fallbackRes: '720p',
    note: '元/M token（输入不含视频）；含视频输入价更低',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
  'doubao-seedance-2-5-flash': {
    provider: '火山方舟',
    currency: 'CNY',
    fps: 24,
    byRes: { '480p': 46, '720p': 46 },
    fallbackRes: '720p',
    note: '仅支持 480p / 720p',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
  'doubao-seedance-2-0': {
    provider: '火山方舟',
    currency: 'CNY',
    fps: 24,
    byRes: { '480p': 46, '720p': 46, '1080p': 51, '4k': 26 },
    fallbackRes: '720p',
    note: '元/M token（输入不含视频）',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
  'doubao-seedance-2-0-fast': {
    provider: '火山方舟',
    currency: 'CNY',
    fps: 24,
    byRes: { '480p': 37, '720p': 37 },
    fallbackRes: '720p',
    note: '仅支持 480p / 720p',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
  'doubao-seedance-2-0-mini': {
    provider: '火山方舟',
    currency: 'CNY',
    fps: 24,
    byRes: { '480p': 23, '720p': 23 },
    fallbackRes: '720p',
    note: '仅支持 480p / 720p',
    url: 'https://www.volcengine.com/docs/82379/1544106',
  },
}

/** 分辨率档 → 单帧像素数（宽×高，16:9 基准；官方估算示例反推得出） */
const RES_PIXELS = {
  '480p': 409_600, // ≈854×480
  '720p': 921_600, // 1280×720
  '1080p': 2_073_600, // 1920×1080
  '4k': 8_294_400, // 3840×2160
}

/** 归一分辨率字符串：'720P'/'720p'/' 720p ' → '720p'；'2160p'→'4k' */
export function normalizeRes(res) {
  const s = String(res || '').trim().toLowerCase()
  if (s === '2160p' || s === '4k' || s === 'uhd') return '4k'
  if (s.includes('1080')) return '1080p'
  if (s.includes('720')) return '720p'
  if (s.includes('480')) return '480p'
  return s
}

/** "1024x1792" / "1024×1792" → 1835008；解析不出返回 null */
export function parsePixels(sizeStr) {
  const m = /(\d{2,5})\s*[x×*]\s*(\d{2,5})/i.exec(String(sizeStr || ''))
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return w * h
}

export function lookupImagePrice(model) {
  return IMAGE_PRICES[normalizeMediaModel(model)] || null
}

export function lookupVideoPrice(model) {
  return VIDEO_PRICES[normalizeMediaModel(model)] || null
}

/**
 * 单张输出图的价钱（原币种）。命中分档就用分档，否则用单价。
 * @returns {{ unit:number, currency:string, provider:string, note:string, url:string, pixels:number|null, tier:boolean }|null}
 */
export function imageUnitPrice(model, sizeStr) {
  const p = lookupImagePrice(model)
  if (p === null) return null
  const pixels = parsePixels(sizeStr)
  let unit = typeof p.price === 'number' ? p.price : null
  let tier = false
  if (Array.isArray(p.tiers)) {
    tier = true
    if (pixels === null) {
      // 尺寸未知：取最低档，避免高估
      unit = p.tiers[0].price
    } else {
      const hit = p.tiers.find((t) => pixels <= t.maxPx)
      unit = hit ? hit.price : p.tiers[p.tiers.length - 1].price
    }
  }
  if (unit === null) return null
  return {
    unit,
    currency: p.currency || 'CNY',
    provider: p.provider || '',
    note: p.note || '',
    url: p.url || '',
    pixels,
    tier,
  }
}

/**
 * 一条视频的价钱（原币种），按官方 token 估算公式。
 * @param model 模型 id
 * @param opts { resolution, durationSec, inputVideoSec }
 * @returns {{ cny:number, tokens:number, rate:number, currency:string, provider:string, note:string, url:string, res:string, fps:number }|null}
 */
export function videoCost(model, opts) {
  const v = lookupVideoPrice(model)
  if (v === null) return null
  const o = opts || {}
  const res = normalizeRes(o.resolution) || v.fallbackRes || '720p'
  const rate = Number.isFinite(v.byRes[res]) ? v.byRes[res] : v.byRes[v.fallbackRes]
  if (!Number.isFinite(rate)) return null
  const pixels = RES_PIXELS[res] || RES_PIXELS['720p']
  const fps = Number.isFinite(v.fps) ? v.fps : 24
  const dur = Number.isFinite(Number(o.durationSec)) && Number(o.durationSec) > 0 ? Number(o.durationSec) : 5
  const inDur = Number.isFinite(Number(o.inputVideoSec)) && Number(o.inputVideoSec) > 0 ? Number(o.inputVideoSec) : 0
  // 官方估算公式：token = (输入视频时长 + 输出时长) × 宽 × 高 × 帧率 / 1024
  const tokens = ((inDur + dur) * pixels * fps) / 1024
  const cny = (tokens * rate) / 1e6
  return {
    cny,
    tokens,
    rate,
    currency: v.currency || 'CNY',
    provider: v.provider || '',
    note: v.note || '',
    url: v.url || '',
    res,
    fps,
  }
}
