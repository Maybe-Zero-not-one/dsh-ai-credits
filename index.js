/**
 * ai-credits · 宿主半边
 * ============================================================================
 * 干三件事：
 *   1. 内置一份「能领 AI 免费额度 / 积分」的官方入口清单（种子）
 *   2. 每天（默认 9 点）把每个入口实际请求一遍，记下能不能打开、什么时候查的
 *   3. 再通过宿主已有的联网搜索服务找一批新的候选页，塞进「每日新发现」
 *
 * 数据存在 $DSH_HOME/ai-credits/catalog.json，只在本机，不上传。
 * 页面（Client 半边）通过 /ai-credits/list 读、/ai-credits/refresh 触发刷新。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { PRICE_PROVIDERS, PRICE_SNAPSHOT_AT } from './prices.js'
import { CODING_PLANS, PLAN_SNAPSHOT_AT } from './plans.js'
import {
  AGGREGATOR_ENDPOINTS,
  AGGREGATOR_LABEL,
  AGGREGATOR_TTL_MS,
  cachedAggregator,
  collectAggregatorPlans,
  probeAggregator,
} from './codingplan.js'
import { collectDshApi } from './dsh-api.js'
import { collectUsage, describeBilling } from './usage.js'
import { fetchOfficialPricing } from './pricing-sync.js'
import { collectOfficialUsage, resolveKeyMap, importOfficialFiles } from './official-usage.js'

export const inject = ['webServer', 'timer']

const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')
const DATA_DIR = join(CFG_DIR, 'ai-credits')
const STORE_FILE = join(DATA_DIR, 'catalog.json')
/**
 * 线路计费方式的手选覆盖表：`{ 线路id: { mode, estimate, monthlyCNY } }`。
 * 白名单自动判定总会漏（新线路 / 自建线路 / 连接器内部 id），漏了就只报 token 不折钱。
 * 这张表让用户在「本机接入」栏自己标，比硬编白名单可靠。
 *
 * 2.4.8 起一条记录是个对象：
 *   mode        'token' | 'estimate' | 'credits' | null（null = 不钉模式，跟自动判定）
 *   estimate    订阅线路也打开折算（算等价金额，判断套餐值不值）
 *   monthlyCNY  你实际付的月费，用来跟等价月费比；没有就用套餐表里的参考价
 * 老写法（直接一个字符串）照样能读，进来就归一成这个结构。
 */
const BILLING_FILE = join(DATA_DIR, 'billing.json')
const BILLING_MODES = ['token', 'estimate', 'credits']

function normalizeBillingEntry(value) {
  if (typeof value === 'string') {
    if (!BILLING_MODES.includes(value)) return null
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

function loadBillingOverrides() {
  try {
    if (!existsSync(BILLING_FILE)) return {}
    // 别用 JSON.parse 直接吃原文：Windows 上不少工具写 JSON 会带 UTF-8 BOM，
    // JSON.parse 遇到 BOM 直接抛错，整张表就静默读成空的了。先剥掉。
    const text = readFileSync(BILLING_FILE, 'utf8').replace(/^\uFEFF/, '')
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out = {}
    for (const [provider, value] of Object.entries(raw)) {
      if (typeof provider !== 'string' || provider === '') continue
      const entry = normalizeBillingEntry(value)
      if (entry !== null) out[provider] = entry
    }
    return out
  } catch (error) {
    return {}
  }
}

function saveBillingOverrides(overrides) {
  mkdirSync(DATA_DIR, { recursive: true })
  // 写出去的形状保持紧凑：只有 mode 就只写 mode，别塞一堆 null
  const compact = {}
  for (const [provider, entry] of Object.entries(overrides)) {
    const value = {}
    if (entry.mode) value.mode = entry.mode
    if (entry.estimate) value.estimate = true
    if (entry.monthlyCNY !== null && entry.monthlyCNY !== undefined) value.monthlyCNY = entry.monthlyCNY
    if (Object.keys(value).length > 0) compact[provider] = value
  }
  const tmp = BILLING_FILE + '.' + process.pid + '.' + Date.now() + '.tmp'
  writeFileSync(tmp, JSON.stringify(compact, null, 2), 'utf8')
  renameSync(tmp, BILLING_FILE)
}

/**
 * 刷新时把「自动判定是订阅、却被手选成别的口径」的那几条退回自动。
 *
 * 为什么要这样：白名单里那几家（Trae / Qoder / WorkBuddy / 各家 Coding Plan）是**确定**的
 * 套餐制，自动判成订阅就是对的。手选把它们改成「按量」只会让用量栏凭空多出一笔假花费，
 * 所以刷新这一下让自动判定压过手选 —— 但你手动给它加的「折算」「月费」不动：
 * 那是订阅线路上的另一个开关，跟「这条是不是订阅」不是一回事。
 *
 * 只改 mode，不碰 estimate / monthlyCNY。清完如果一条记录空了就整条删掉。
 * @returns {{overrides: object, cleared: string[], changed: boolean}}
 */
function reconcileBillingOverrides(overrides) {
  const auto = describeBilling({}).auto
  const next = {}
  const cleared = []
  for (const [provider, entry] of Object.entries(overrides)) {
    if (entry.mode && entry.mode !== 'credits' && auto(provider) === 'credits') {
      cleared.push(provider)
      const kept = { mode: null, estimate: entry.estimate, monthlyCNY: entry.monthlyCNY }
      if (kept.estimate === false && kept.monthlyCNY === null) continue
      next[provider] = kept
      continue
    }
    next[provider] = entry
  }
  return { overrides: next, cleared, changed: cleared.length > 0 }
}

const CATEGORY_ORDER = ['国内 API', '海外 API', '消费级应用', '学生与开发者', '每日新发现']
/** 价格页的核对节奏（小时）。数字快照不自动抓，只有官网价格页的可访问性按这个节奏探 */
const PRICE_CHECK_HOURS = 20
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 DSH-AI-Credits/1.0'

/**
 * 种子清单。
 * ⚠ 只写「大概怎么领」，不写死金额 / 次数 —— 活动随时会变，
 *   写死了就会过期，反而误导。每天巡检会把它标成「能打开 / 打不开」。
 */
const SEEDS = [
  // ---------- 国内 API ----------
  {
    id: 'siliconflow',
    title: '硅基流动 SiliconFlow',
    category: '国内 API',
    url: 'https://cloud.siliconflow.cn',
    claim: '注册后在控制台领体验金；一批小模型常年免费调用。',
    tags: ['注册送', 'API'],
  },
  {
    id: 'bailian',
    title: '阿里云百炼',
    category: '国内 API',
    url: 'https://bailian.console.aliyun.com',
    claim: '新用户每个通义模型有一批免费 token，开通后直接到账。',
    tags: ['免费额度', '通义'],
  },
  {
    id: 'bigmodel',
    title: '智谱 BigModel',
    category: '国内 API',
    url: 'https://bigmodel.cn',
    claim: '注册送资源包，GLM 系列里有免费档模型可以一直调。',
    tags: ['注册送', 'GLM'],
  },
  {
    id: 'moonshot',
    title: 'Kimi 开放平台',
    category: '国内 API',
    url: 'https://platform.kimi.com',
    claim: '新用户有体验金，去控制台「费用中心」看余额和领取入口。',
    tags: ['体验金', 'Kimi'],
  },
  {
    id: 'ark',
    title: '火山引擎 · 方舟',
    category: '国内 API',
    url: 'https://console.volcengine.com/ark',
    claim: '豆包系列有赠送 token / 新用户免费额度，开通模型即送。',
    tags: ['赠送令牌', '豆包'],
  },
  {
    id: 'qianfan',
    title: '百度千帆',
    category: '国内 API',
    url: 'https://qianfan.cloud.baidu.com',
    claim: '新用户代金券 + 文心模型免费额度，开通后按控制台提示领。',
    tags: ['代金券', '文心'],
  },
  {
    id: 'hunyuan',
    title: '腾讯混元',
    category: '国内 API',
    url: 'https://cloud.tencent.com/product/hunyuan',
    claim: '新用户免费体验额度，控制台开通混元后领取。',
    tags: ['免费额度', '混元'],
  },
  {
    id: 'xinghuo',
    title: '讯飞星火',
    category: '国内 API',
    url: 'https://xinghuo.xfyun.cn',
    claim: '注册送 API 免费额度，Lite 档长期免费。',
    tags: ['免费额度', '星火'],
  },
  {
    id: 'minimax',
    title: 'MiniMax 开放平台',
    category: '国内 API',
    url: 'https://platform.minimaxi.com',
    claim: '新用户注册有赠送额度，文本 / 语音 / 视频模型都在里面。',
    tags: ['注册送', '语音'],
  },
  {
    id: 'stepfun',
    title: '阶跃星辰 StepFun',
    category: '国内 API',
    url: 'https://platform.stepfun.com',
    claim: '注册后控制台领取体验金，多模态模型可用。',
    tags: ['体验金'],
  },
  {
    id: 'sensenova',
    title: '商汤日日新',
    category: '国内 API',
    url: 'https://platform.sensenova.cn',
    claim: '新用户有免费调用额度，控制台申请即可。',
    tags: ['免费额度'],
  },
  {
    id: 'modelscope',
    title: '魔搭 ModelScope',
    category: '国内 API',
    url: 'https://modelscope.cn',
    claim: '每日免费推理额度，API-Inference 可直接调开源模型。',
    tags: ['每日免费', '开源模型'],
  },

  // ---------- 海外 API ----------
  {
    id: 'aistudio',
    title: 'Google AI Studio',
    category: '海外 API',
    url: 'https://aistudio.google.com',
    claim: 'Gemini 有免费层，按分钟 / 每天限速，不绑卡也能调。',
    overseas: true,
    tags: ['免费层', 'Gemini'],
  },
  {
    id: 'groq',
    title: 'Groq Console',
    category: '海外 API',
    url: 'https://console.groq.com',
    claim: '免费层跑开源模型，速度很快，限速内不额外收费。',
    overseas: true,
    tags: ['免费层', '高速'],
  },
  {
    id: 'mistral',
    title: 'Mistral Console',
    category: '海外 API',
    url: 'https://console.mistral.ai',
    claim: '免费实验层（Experiment），个人开发基本够用。',
    overseas: true,
    tags: ['免费层'],
  },
  {
    id: 'cohere',
    title: 'Cohere Dashboard',
    category: '海外 API',
    url: 'https://dashboard.cohere.com',
    claim: '注册拿试用 key，Chat / Embed 都有一定额度。',
    tags: ['试用 key'],
  },
  {
    id: 'openrouter',
    title: 'OpenRouter',
    category: '海外 API',
    url: 'https://openrouter.ai/models?max_price=0',
    claim: '一批带 :free 后缀的模型，注册就能用，按天限次。',
    tags: ['免费模型', '聚合'],
  },
  {
    id: 'githubmodels',
    title: 'GitHub Models',
    category: '海外 API',
    url: 'https://github.com/marketplace?type=models',
    claim: 'GitHub 账号直接调各家模型，免费速率限制。',
    tags: ['免费限速', 'GitHub'],
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare Workers AI',
    category: '海外 API',
    url: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    claim: '每天免费 neurons 额度，绑卡也不会自动扣费。',
    tags: ['每日免费', '边缘'],
  },
  {
    id: 'nvidia',
    title: 'NVIDIA NIM',
    category: '海外 API',
    url: 'https://build.nvidia.com',
    claim: '注册送 API credits，试模型和托管推理都能用。',
    tags: ['credits'],
  },
  {
    id: 'cerebras',
    title: 'Cerebras Cloud',
    category: '海外 API',
    url: 'https://cloud.cerebras.ai',
    claim: '免费层，推理极快，注册即用。',
    overseas: true,
    tags: ['免费层'],
  },
  {
    id: 'sambanova',
    title: 'SambaNova Cloud',
    category: '海外 API',
    url: 'https://cloud.sambanova.ai',
    claim: '免费层额度，可以跑开源大模型。',
    tags: ['免费层'],
  },
  {
    id: 'together',
    title: 'Together AI',
    category: '海外 API',
    url: 'https://api.together.ai',
    claim: '注册送少量额度，适合跑开源模型。',
    overseas: true,
    tags: ['注册送'],
  },
  {
    id: 'fireworks',
    title: 'Fireworks AI',
    category: '海外 API',
    url: 'https://fireworks.ai',
    claim: '注册送试用额度，微调 / 推理都能抵。',
    overseas: true,
    tags: ['试用额度'],
  },
  {
    id: 'huggingface',
    title: 'Hugging Face',
    category: '海外 API',
    url: 'https://huggingface.co/pricing',
    claim: '免费账号每月有 Inference credits，社区模型随便试。',
    overseas: true,
    tags: ['每月额度'],
  },
  {
    id: 'vercel',
    title: 'Vercel AI Gateway',
    category: '海外 API',
    url: 'https://vercel.com/ai-gateway',
    claim: '新账号有免费额度，一个 key 转发多家模型。',
    tags: ['免费额度', '网关'],
  },

  // ---------- 消费级应用 ----------
  {
    id: 'jimeng',
    title: '即梦 AI',
    category: '消费级应用',
    url: 'https://jimeng.jianying.com',
    claim: '每天签到 / 做任务送积分，出图出视频都能抵。',
    tags: ['每日签到', '积分'],
  },
  {
    id: 'doubao',
    title: '豆包',
    category: '消费级应用',
    url: 'https://www.doubao.com',
    claim: '日常免费用，活动页经常发体验积分。',
    tags: ['免费', '活动'],
  },
  {
    id: 'tongyi',
    title: '通义千问',
    category: '消费级应用',
    url: 'https://tongyi.aliyun.com',
    claim: '免费额度，万相出图也有赠送次数。',
    tags: ['免费额度'],
  },
  {
    id: 'yuanbao',
    title: '腾讯元宝',
    category: '消费级应用',
    url: 'https://yuanbao.tencent.com',
    claim: '免费使用混元 / DeepSeek，活动送额度。',
    tags: ['免费'],
  },
  {
    id: 'chatglm',
    title: '智谱清言',
    category: '消费级应用',
    url: 'https://chatglm.cn',
    claim: '免费档模型随便用，活动送体验次数。',
    tags: ['免费档'],
  },
  {
    id: 'yiyan',
    title: '文心一言',
    category: '消费级应用',
    url: 'https://wenxin.baidu.com',
    claim: '免费档 + 活动积分。',
    tags: ['免费', '活动'],
  },

  // ---------- 学生与开发者 ----------
  {
    id: 'ghstudent',
    title: 'GitHub Student Pack',
    category: '学生与开发者',
    url: 'https://education.github.com/pack',
    claim: '学生认证后白拿 Copilot、云额度、一堆 API 试用。',
    tags: ['学生认证', '大礼包'],
  },
  {
    id: 'azurestudent',
    title: 'Azure for Students',
    category: '学生与开发者',
    url: 'https://azure.microsoft.com/free/students',
    claim: '学生认证送 $100 额度，Azure OpenAI 也能用。',
    overseas: true,
    tags: ['学生认证', '$100'],
  },
  {
    id: 'gcloudfree',
    title: 'Google Cloud Free',
    category: '学生与开发者',
    url: 'https://cloud.google.com/free',
    claim: '新账号 $300 试用金，Gemini API 可以抵。',
    overseas: true,
    tags: ['$300', '试用'],
  },
  {
    id: 'copilotfree',
    title: 'GitHub Copilot Free',
    category: '学生与开发者',
    url: 'https://github.com/features/copilot',
    claim: '免费版每月给补全和对话次数，写代码够用。',
    tags: ['免费版', '补全'],
  },
  {
    id: 'colab',
    title: 'Google Colab',
    category: '学生与开发者',
    url: 'https://colab.research.google.com',
    claim: '免费 GPU 时长，跑开源模型 / 微调够用。',
    overseas: true,
    tags: ['免费 GPU'],
  },
  {
    id: 'kaggle',
    title: 'Kaggle',
    category: '学生与开发者',
    url: 'https://www.kaggle.com',
    claim: '每周免费 GPU / TPU 时长，跑 notebook 不花钱。',
    tags: ['免费 GPU'],
  },
]

/** 每天拿这几句去搜新入口。搜不到 / 搜索源没配好都不影响已有清单。 */
const SEARCH_QUERIES = [
  '免费 AI API 额度 领取 新用户',
  'free AI credits free tier API',
  '大模型 免费额度 赠送 活动',
  'free LLM API trial credits',
]

// ---------------------------------------------------------------- 小工具

const nowIso = () => new Date().toISOString()

const clampInt = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

const dayKey = (date) => {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

const normalizeUrl = (raw) => {
  try {
    const u = new URL(String(raw || '').trim())
    u.hash = ''
    let out = u.toString()
    if (out.endsWith('/')) out = out.slice(0, -1)
    return out
  } catch {
    return String(raw || '').trim()
  }
}

const hostOf = (raw) => {
  try {
    return new URL(raw).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const shortHash = (text) => {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

// ---------------------------------------------------------------- 存取

function loadState() {
  try {
    if (!existsSync(STORE_FILE)) return null
    const raw = JSON.parse(readFileSync(STORE_FILE, 'utf8'))
    if (!raw || !Array.isArray(raw.sources)) return null
    return raw
  } catch (error) {
    return null
  }
}

function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = STORE_FILE + '.' + process.pid + '.' + Date.now() + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, STORE_FILE)
}

function blankState() {
  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: null,
    checkedAt: null,
    lastReason: null,
    search: null,
    sources: [],
    pricesCheckedAt: null,
    priceChecks: {},
    plansCheckedAt: null,
    planChecks: {},
    aggregatorChecks: [],
    // 手动删掉的入口：留档，种子不会因为 mergeSeeds 复活，联网再搜到也只记「存疑」
    removed: [],
  }
}

/** 已删除链接的索引：归一化 URL → 记录。删过的东西靠它挡住种子复活和搜索结果复现。 */
function removedMap(state) {
  if (!Array.isArray(state.removed)) state.removed = []
  const map = new Map()
  for (const item of state.removed) {
    if (item && typeof item.url === 'string') map.set(normalizeUrl(item.url), item)
  }
  return map
}

/**
 * 把内置种子并进已有数据。
 * ⚠ 按 id 合并（不是按 URL）：种子的链接以后改了，同一条要跟着换地址，
 *   而不是多出一条旧的。巡检结果（checkedAt / httpStatus / reachable）一定保留。
 * ⚠ 用户手动删掉的（state.removed）不再补回来 —— 否则每读一次状态就复活一次。
 */
function mergeSeeds(state) {
  if (!Array.isArray(state.sources)) state.sources = []
  const removed = removedMap(state)
  const byId = new Map()
  const byUrl = new Map()
  for (const item of state.sources) {
    if (item && item.origin !== 'web' && item.id) byId.set(item.id, item)
    if (item && item.url) byUrl.set(normalizeUrl(item.url), item)
  }
  for (const seed of SEEDS) {
    if (removed.has(normalizeUrl(seed.url))) continue
    let current = byId.get(seed.id)
    if (current === undefined) {
      const hit = byUrl.get(normalizeUrl(seed.url))
      current = hit && hit.origin !== 'web' ? hit : undefined
    }
    if (current === undefined) {
      const fresh = {
        ...seed,
        origin: 'seed',
        checkedAt: null,
        httpStatus: null,
        reachable: null,
      }
      state.sources.push(fresh)
      byId.set(seed.id, fresh)
      byUrl.set(normalizeUrl(seed.url), fresh)
    } else {
      current.id = seed.id
      current.title = seed.title
      current.category = seed.category
      current.url = seed.url
      current.claim = seed.claim
      current.tags = seed.tags
      current.overseas = seed.overseas === true
      current.origin = 'seed'
      byUrl.set(normalizeUrl(seed.url), current)
    }
  }
  return state
}

function sortSources(list) {
  const rank = (item) => {
    if (item.origin === 'web') return CATEGORY_ORDER.length
    const index = CATEGORY_ORDER.indexOf(item.category)
    return index >= 0 ? index : CATEGORY_ORDER.length - 1
  }
  return list.slice().sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN')
  })
}

function publicSources(state) {
  return sortSources(state.sources).map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    url: item.url,
    claim: item.claim || '',
    tags: Array.isArray(item.tags) ? item.tags : [],
    origin: item.origin || 'seed',
    overseas: item.overseas === true,
    checkedAt: item.checkedAt || null,
    httpStatus: typeof item.httpStatus === 'number' ? item.httpStatus : null,
    reachable: typeof item.reachable === 'boolean' ? item.reachable : null,
    discoveredAt: item.discoveredAt || null,
  }))
}

/** 已删除链接发出去的样子（最近删的排前面） */
function publicRemoved(state) {
  const list = Array.isArray(state.removed) ? state.removed : []
  return list
    .filter((item) => item && item.url)
    .slice()
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .map((item) => ({
      url: item.url,
      host: item.host || hostOf(item.url),
      title: item.title || hostOf(item.url),
      category: item.category || '',
      at: item.at || null,
      httpStatus: typeof item.httpStatus === 'number' ? item.httpStatus : null,
      reachable: typeof item.reachable === 'boolean' ? item.reachable : null,
      hits: typeof item.hits === 'number' ? item.hits : 0,
      suspect: item.suspect === true,
      reseenAt: item.reseenAt || null,
    }))
}

/**
 * 删掉一条入口，并留档。
 * 留档是为了两件事：种子不会再被 mergeSeeds 补回来；联网发现再撞上同一条链接时
 * 只把记录标成「存疑」而不是重新加回清单。
 */
function removeSource(state, input) {
  if (!Array.isArray(state.sources)) state.sources = []
  const id = input && typeof input.id === 'string' ? input.id : null
  const rawUrl = input && typeof input.url === 'string' ? input.url : null
  if (id === null && rawUrl === null) return { ok: false, error: '要删哪一条？' }

  const index = state.sources.findIndex((item) => {
    if (!item) return false
    if (id !== null && item.id === id) return true
    if (rawUrl !== null && item.url && normalizeUrl(item.url) === normalizeUrl(rawUrl)) return true
    return false
  })
  if (index < 0) return { ok: false, error: '清单里已经没有这条了' }

  const item = state.sources[index]
  state.sources.splice(index, 1)

  const key = normalizeUrl(item.url)
  const removed = removedMap(state)
  const existing = removed.get(key)
  if (existing) {
    existing.at = nowIso()
    existing.httpStatus = typeof item.httpStatus === 'number' ? item.httpStatus : existing.httpStatus
    existing.reachable = typeof item.reachable === 'boolean' ? item.reachable : existing.reachable
    return { ok: true, url: item.url, title: item.title || hostOf(item.url) }
  }

  state.removed.push({
    url: item.url,
    host: hostOf(item.url),
    title: item.title || hostOf(item.url),
    category: item.category || '',
    origin: item.origin || 'seed',
    httpStatus: typeof item.httpStatus === 'number' ? item.httpStatus : null,
    reachable: typeof item.reachable === 'boolean' ? item.reachable : null,
    at: nowIso(),
    hits: 0,
    suspect: false,
    reseenAt: null,
  })
  return { ok: true, url: item.url, title: item.title || hostOf(item.url) }
}

/** 从已删除档里恢复一条：种子交给 mergeSeeds 补，联网发现的当场放回去 */
function restoreSource(state, url) {
  const key = normalizeUrl(url || '')
  const removed = removedMap(state)
  const record = removed.get(key)
  if (!record) return { ok: false, error: '这条不在已删除列表里' }

  state.removed = state.removed.filter((item) => !(item && normalizeUrl(item.url) === key))

  if (SEEDS.some((seed) => normalizeUrl(seed.url) === key)) {
    mergeSeeds(state)
    return { ok: true, url, restored: true }
  }
  if (!Array.isArray(state.sources)) state.sources = []
  if (!state.sources.some((item) => item && normalizeUrl(item.url) === key)) {
    state.sources.push({
      id: 'web-' + shortHash(record.url),
      title: record.title || hostOf(record.url),
      category: record.category || '每日新发现',
      url: record.url,
      claim: '从已删除里恢复的页面，点开再确认一次。',
      tags: ['联网发现'],
      origin: 'web',
      discoveredAt: nowIso(),
      checkedAt: null,
      httpStatus: null,
      reachable: null,
    })
  }
  return { ok: true, url, restored: true }
}

/**
 * 价格表要发出去的样子。
 * 价格数字（input/output）来自 prices.js 的快照；checkedAt / reachable 是每天巡检
 * 各官网价格页的结果 —— 只代表「页面今天能不能打开」，不代表价格数字是今天抓的。
 */
function publicPrices(state) {
  const checks = state.priceChecks && typeof state.priceChecks === 'object' ? state.priceChecks : {}
  return PRICE_PROVIDERS.map((provider) => {
    const check = checks[provider.id] || {}
    return {
      id: provider.id,
      title: provider.title,
      region: provider.region,
      currency: provider.currency,
      pricingUrl: provider.pricingUrl,
      sourceDate: provider.sourceDate || null,
      source: provider.source || 'official',
      note: provider.note || '',
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextK: typeof model.contextK === 'number' ? model.contextK : null,
        input: typeof model.input === 'number' ? model.input : null,
        output: typeof model.output === 'number' ? model.output : null,
        note: model.note || '',
      })),
      checkedAt: check.checkedAt || null,
      httpStatus: typeof check.httpStatus === 'number' ? check.httpStatus : null,
      reachable: typeof check.reachable === 'boolean' ? check.reachable : null,
    }
  })
}

/**
 * 编程订阅（coding plan）发出去的样子。
 *
 * 数据源两级：
 *   1. codingplan.fyi 聚合（145 条 / 40 个平台）—— 主源，6 小时缓存
 *   2. plans.js 本地快照（65 条）—— 聚合站拿不到时的备用，界面会标「快照」
 * checkedAt / reachable 仍然是每天探页面得来的，跟数字来源无关。
 */
function publicPlans(state) {
  const checks = state.planChecks && typeof state.planChecks === 'object' ? state.planChecks : {}
  const aggregated = cachedAggregator(CFG_DIR)
  const useAggregator = Boolean(aggregated && aggregated.ok === true && Array.isArray(aggregated.plans) && aggregated.plans.length > 0)

  // 聚合模式下，145 条套餐共用同一次端点巡检结果 —— 它们同源，健康状态就是端点的健康状态
  // （早期版本存成对象、现在存成数组，两种都认，免得旧 catalog.json 读不出来）
  const rawChecks = state.aggregatorChecks
  const endpointList = Array.isArray(rawChecks)
    ? rawChecks
    : rawChecks && typeof rawChecks === 'object'
      ? Object.values(rawChecks)
      : []
  const endpointChecks = endpointList.filter((item) => item && item.checkedAt)
  const aggHealth = (() => {
    if (endpointChecks.length === 0) return null
    const reachable = endpointChecks.filter((item) => item.reachable === true).length
    return {
      checkedAt: endpointChecks.map((item) => item.checkedAt).sort()[0] || null,
      httpStatus: reachable === endpointChecks.length ? 200 : endpointChecks.find((item) => item.httpStatus)?.httpStatus ?? 0,
      reachable: reachable === endpointChecks.length,
    }
  })()

  const sourceOf = (item, mode) => {
    const check = mode === 'aggregator' ? aggHealth || {} : checks[item.id] || {}
    return {
      id: item.id,
      title: item.title,
      provider: item.provider,
      region: item.region,
      currency: item.currency,
      category: ['general', 'coding'].includes(item.category) ? item.category : 'coding',
      kind: item.kind === 'agent' ? 'agent' : 'plan',
      checkUrl: item.checkUrl || item.url,
      price: typeof item.price === 'number' ? item.price : null,
      period: item.period || 'monthly',
      priceNote: item.priceNote || '',
      quota: item.quota || '',
      benefits: Array.isArray(item.benefits) ? item.benefits : [],
      url: item.url,
      sourceDate: item.sourceDate || null,
      source: item.source || 'official',
      sourceLabel: item.sourceLabel || null,
      planStatus: item.planStatus || 'open',
      note: item.note || '',
      origin: mode,
      checkedAt: check.checkedAt || null,
      httpStatus: typeof check.httpStatus === 'number' ? check.httpStatus : null,
      reachable: typeof check.reachable === 'boolean' ? check.reachable : null,
    }
  }

  const items = useAggregator
    ? aggregated.plans.map((item) => sourceOf(item, 'aggregator'))
    : CODING_PLANS.map((item) => sourceOf(item, 'snapshot'))

  const source = {
    mode: useAggregator ? 'aggregator' : 'snapshot',
    label: useAggregator ? AGGREGATOR_LABEL : '本地快照',
    home: useAggregator ? aggregated.home : null,
    at: useAggregator ? aggregated.at : null,
    dataDate: useAggregator ? aggregated.sourceDate : PLAN_SNAPSHOT_AT,
    ttlHours: Math.round(AGGREGATOR_TTL_MS / 3600000),
    error: useAggregator ? null : (aggregated && aggregated.error) || null,
    stats: useAggregator ? aggregated.stats : null,
    endpoints:
      endpointList.length > 0
        ? endpointList
        : AGGREGATOR_ENDPOINTS.map((endpoint) => ({ key: endpoint.key, url: endpoint.url })),
    fallback: useAggregator ? null : 'plans.js',
  }
  return { items, source }
}

// ---------------------------------------------------------------- 巡检

async function probe(url, timeoutMs) {
  const attempt = async (method) => {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(method === 'GET' ? { range: 'bytes=0-0' } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.body !== null && method === 'GET') {
      try {
        await response.body.cancel()
      } catch (error) {}
    }
    return response
  }

  try {
    let response
    try {
      response = await attempt('HEAD')
    } catch (error) {
      response = await attempt('GET')
    }
    // HEAD 不靠谱：不少站点对 HEAD 回 404 / 403 / 405，换 GET 再问一次再下结论
    if (response.status >= 400) {
      try {
        response = await attempt('GET')
      } catch (error) {}
    }
    const status = response.status
    return {
      httpStatus: status,
      reachable: status > 0 && status < 400,
      checkedAt: nowIso(),
      note: null,
    }
  } catch (error) {
    return {
      httpStatus: 0,
      reachable: false,
      checkedAt: nowIso(),
      note: '请求失败：' + String((error && error.message) || error).slice(0, 120),
    }
  }
}

const LOOKS_LIKE_OFFER = /(免费|白嫖|额度|赠送|积分|体验金|试用|领取|free|credit|trial|quota|grant|giveaway)/i

/** 每天把各家官网的价格页也探一遍：不需要抓数字，只要知道页面今天还能不能打开 */
async function runPriceCheck(state, timeoutMs) {
  const checks = state.priceChecks && typeof state.priceChecks === 'object' ? state.priceChecks : {}
  await mapLimit(PRICE_PROVIDERS, 4, async (provider) => {
    const result = await probe(provider.pricingUrl, timeoutMs)
    checks[provider.id] = {
      checkedAt: result.checkedAt,
      httpStatus: result.httpStatus,
      reachable: result.reachable,
      note: result.note,
    }
  })
  state.priceChecks = checks
  state.pricesCheckedAt = nowIso()
}

/**
 * 订阅页巡检，改成两级：
 *
 *   主源：只在 codingplan.fyi 的 3 个端点上一问（plans / platforms / config）
 *   备用：每个厂商留 1 个官网订阅页（约 15 条），聚合站挂了时还能看出「官网今天通不通」
 *
 * 以前是把 65 条套餐的官网逐个探一遍 —— 一天 65 次请求换一句「页面能打开」，
 * 换成聚合源后请求数从 65 降到 18，而且主源拿到的是真数据不是心跳。
 */
async function runPlanCheck(state, timeoutMs) {
  const checks = state.planChecks && typeof state.planChecks === 'object' ? state.planChecks : {}

  // 主源：3 个端点
  try {
    state.aggregatorChecks = await probeAggregator(probe, timeoutMs)
  } catch (error) {
    state.aggregatorChecks = AGGREGATOR_ENDPOINTS.map((endpoint) => ({
      key: endpoint.key,
      url: endpoint.url,
      checkedAt: nowIso(),
      httpStatus: 0,
      reachable: false,
      note: String((error && error.message) || error).slice(0, 120),
    }))
  }

  // 备用：每个厂商只留一条代表页面
  const representatives = []
  const seenProvider = new Set()
  for (const plan of CODING_PLANS) {
    const key = plan.provider || plan.id
    if (seenProvider.has(key)) continue
    seenProvider.add(key)
    representatives.push(plan)
  }

  await mapLimit(representatives, 4, async (plan) => {
    const result = await probe(plan.checkUrl || plan.url, timeoutMs)
    checks[plan.id] = {
      checkedAt: result.checkedAt,
      httpStatus: result.httpStatus,
      reachable: result.reachable,
      note: result.note,
    }
  })

  state.planChecks = checks
  state.plansCheckedAt = nowIso()
}

/** 这些站搜出来多半是「攻略 / 汇总」而不是官方领取页 —— 留着，但标成攻略页，别让人以为是入口 */
const GUIDE_HOSTS = [
  'csdn.net',
  'juejin.cn',
  'zhihu.com',
  'developer.aliyun.com',
  'cloud.tencent.com',
  'cloud.tencent.cn',
  'cnblogs.com',
  'segmentfault.com',
  'bilibili.com',
  'weixin.qq.com',
  'sohu.com',
]

/** 这些站基本不会有领取入口，搜到了也别塞进来 */
const SKIP_HOSTS = ['pypi.org', 'npmjs.com', 'youtube.com', 'apps.apple.com']

function looksLikeOffer(source) {
  const haystack = [source.title, source.snippet, source.summary, source.url].filter(Boolean).join(' ')
  return LOOKS_LIKE_OFFER.test(haystack)
}

function isGuideHost(host) {
  return GUIDE_HOSTS.some((name) => host === name || host.endsWith('.' + name))
}

function isSkipHost(host) {
  return SKIP_HOSTS.some((name) => host === name || host.endsWith('.' + name))
}

const titleKey = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, '')
    .slice(0, 80)

function webErrorText(error) {
  const raw = String((error && (error.code || error.message)) || error || '')
  if (/AMBIGUOUS/i.test(raw)) {
    const match = raw.match(/\(([^)]+)\)/)
    const names = match ? match[1] : 'deepseek-official / deepseek-search-api'
    return (
      '宿主上注册了不止一个联网搜索源（' +
      names +
      '），还没选定默认的 —— 二选一（或者直接跟我说，我帮你定），这里就会每天自动找新的'
    )
  }
  if (/UNAVAILABLE/i.test(raw)) return '当前没有可用的联网搜索源'
  if (/CONFIGURED_MISSING/i.test(raw)) return '设置里指定的搜索源没装上'
  if (/auth|401|403|key/i.test(raw)) return '搜索源的密钥无效 / 过期'
  return '联网搜索失败：' + raw.slice(0, 160)
}

async function discover(ctx, state, queries, maxCandidates) {
  const web = ctx.get('web')
  if (!web || typeof web.search !== 'function') {
    return { at: nowIso(), added: 0, queries, error: '没有可用的联网搜索服务' }
  }
  const known = new Set(state.sources.map((item) => normalizeUrl(item.url)))
  const removed = removedMap(state)
  const seenTitles = new Set(
    state.sources.filter((item) => item.origin === 'web').map((item) => titleKey(item.title)),
  )
  let added = 0
  let suspects = 0
  let lastError = null
  for (const query of queries) {
    let result
    try {
      result = await web.search({ query, maxResults: 8 })
    } catch (error) {
      lastError = webErrorText(error)
      continue
    }
    const sources = Array.isArray(result && result.sources) ? result.sources : []
    for (const source of sources) {
      if (!source || !source.url) continue
      if (!looksLikeOffer(source)) continue
      const url = normalizeUrl(source.url)
      if (known.has(url)) continue
      // 这条以前被手动删掉过 —— 不加回来，只把「又搜到了」这件事记到存疑档上
      const struck = removed.get(url)
      if (struck) {
        struck.hits = (struck.hits || 0) + 1
        struck.reseenAt = nowIso()
        struck.suspect = true
        suspects += 1
        known.add(url)
        continue
      }
      const host = hostOf(url)
      if (!host || isSkipHost(host)) continue
      // 标题重了就是同一篇文章换个链接 —— 别重复占位
      const key = titleKey(source.title)
      if (key && seenTitles.has(key)) continue
      // 攻略站最多 1 条、别的站最多 2 条，免得一个聚合站刷满整页
      const sameHost = state.sources.filter((item) => item.origin === 'web' && hostOf(item.url) === host).length
      if (sameHost >= (isGuideHost(host) ? 1 : 2)) continue
      if (state.sources.length >= SEEDS.length + maxCandidates) break
      known.add(url)
      if (key) seenTitles.add(key)
      added += 1
      state.sources.push({
        id: 'web-' + shortHash(url),
        title: source.title || host,
        category: '每日新发现',
        url: source.url,
        claim: source.snippet || source.summary || '搜索发现的页面，点开确认能不能领。',
        tags: [isGuideHost(host) ? '攻略页' : '联网发现'],
        origin: 'web',
        discoveredAt: nowIso(),
        checkedAt: null,
        httpStatus: null,
        reachable: null,
      })
    }
  }
  return { at: nowIso(), added, suspects, queries, error: lastError }
}

// ---------------------------------------------------------------- 插件

/**
 * 配置项（都可选，不填就用默认值）。
 *
 * 刻意**不导出 `Config`**：那需要一个由宿主注入的 schema 构造器，拿不到时会让
 * 整个插件不激活（本机实测过：`Cannot read properties of undefined (reading 'validate')`）。
 * 这个插件的每一项都有合理默认值，为了校验多引一层依赖不值得 ——
 * 直接在这里校验并给出默认值，配错了也只是退回默认，不会让插件挂掉。
 *
 * | 键 | 默认 | 说明 |
 * |:--|:--|:--|
 * | `refreshHour` | 9 | 每天几点后自动巡检（0-23） |
 * | `dailySearch` | true | 自动巡检时要不要顺带联网发现 |
 * | `checkTimeoutMs` | 10000 | 单个入口 / 价格页 / 订阅页的超时 |
 * | `maxCandidates` | 80 | 「每日新发现」最多保留多少条 |
 * | `officialKeyMap` | 自动猜 | 官方账单 api_key_name → 线路 id，形如 `{"deepseek-official":"4"}` |
 */
export function apply(ctx, config) {
  const cfg = config || {}
  const refreshHour = clampInt(cfg.refreshHour, 0, 23, 9)
  const dailySearch = cfg.dailySearch !== false
  const timeoutMs = clampInt(cfg.checkTimeoutMs, 3000, 60000, 10000)
  const maxCandidates = clampInt(cfg.maxCandidates, 0, 300, 80)
  // 官方账单里哪个 key 对应哪条线路。没配就让 official-usage.js 按名字猜
  const configuredKeyMap =
    cfg.officialKeyMap && typeof cfg.officialKeyMap === 'object' ? cfg.officialKeyMap : null

  let inFlight = null

  function pruneCandidates(state) {
    const cutoff = Date.now() - 45 * 24 * 60 * 60 * 1000
    const keep = []
    const web = []
    for (const item of state.sources) {
      if (!item) continue
      if (item.origin !== 'web') {
        keep.push(item)
        continue
      }
      const at = Date.parse(item.discoveredAt || '')
      if (Number.isFinite(at) && at < cutoff) continue
      web.push(item)
    }
    web.sort((a, b) => Date.parse(a.discoveredAt || 0) - Date.parse(b.discoveredAt || 0))
    const overflow = web.length - maxCandidates
    const dropped = new Set(overflow > 0 ? web.slice(0, overflow) : [])
    state.sources = keep.concat(web.filter((item) => !dropped.has(item)))
    return state
  }

  function nextRefreshAt(from = new Date()) {
    const at = new Date(from)
    at.setMinutes(0, 0, 0)
    at.setHours(refreshHour)
    if (at.getTime() <= from.getTime()) at.setDate(at.getDate() + 1)
    return at.toISOString()
  }

  function dueForDaily(state) {
    if (state === null) return true
    const now = new Date()
    if (now.getHours() < refreshHour) return false
    const today = dayKey(now)
    if (!state.checkedAt || dayKey(state.checkedAt) !== today) return true
    // 今天只手动巡检过、还没跑联网发现 → 也补一次（失败也记时间，不会每 10 分钟重跑）
    if (dailySearch && (!state.search || !state.search.at || dayKey(state.search.at) !== today)) return true
    return false
  }

  /** 价格页 / 订阅页单独按 20 小时节奏核对，不跟 9 点那趟绑死 —— 白天重开也会补一次 */
  function catalogDue(state) {
    if (!state) return true
    const stale = (iso) => {
      if (!iso) return true
      const at = Date.parse(iso)
      return !Number.isFinite(at) || Date.now() - at > PRICE_CHECK_HOURS * 60 * 60 * 1000
    }
    if (stale(state.pricesCheckedAt)) return true
    if (CODING_PLANS.length > 0 && stale(state.plansCheckedAt)) return true
    // 聚合源自己有 6 小时缓存，主表过期也算「该刷了」
    const aggregated = cachedAggregator(CFG_DIR)
    if (!aggregated || Date.now() - Date.parse(aggregated.at || 0) > AGGREGATOR_TTL_MS) return true
    return false
  }

  async function refresh(reason, options) {
    if (inFlight !== null) return inFlight
    const wantSearch = options && options.search === true
    const pricesOnly = options && options.pricesOnly === true
    inFlight = (async () => {
      const state = pruneCandidates(mergeSeeds(loadState() || blankState()))
      if (!pricesOnly) {
        const sourceList = state.sources.filter((item) => item && item.url)
        const probed = await mapLimit(sourceList, 6, async (item) => {
          const result = await probe(item.url, timeoutMs)
          item.checkedAt = result.checkedAt
          item.httpStatus = result.httpStatus
          item.reachable = result.reachable
          item.note = result.note
          return item
        })
        state.sources = probed
        state.checkedAt = nowIso()
      }
      try {
        await Promise.all([
          runPriceCheck(state, timeoutMs).catch(() => {}),
          // 聚合源先拉数据（主源），runPlanCheck 里的端点巡检只是心跳
          collectAggregatorPlans(CFG_DIR, { timeoutMs: Math.max(timeoutMs, 20000) }).catch(() => {}),
          runPlanCheck(state, timeoutMs).catch(() => {}),
        ])
      } catch (error) {}
      state.updatedAt = nowIso()
      state.lastReason = reason || '手动'
      if (wantSearch) {
        try {
          state.search = await discover(ctx, state, SEARCH_QUERIES, maxCandidates)
        } catch (error) {
          state.search = {
            at: nowIso(),
            added: 0,
            queries: SEARCH_QUERIES,
            error: webErrorText(error),
          }
        }
      }
      saveState(state)
      return state
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function kick(reason, options) {
    refresh(reason, options).catch((error) => {
      try {
        console.error('[ai-credits] 刷新失败：', error && error.message)
      } catch (e2) {}
    })
  }

  function currentPayload(dshApi, usage, official, officialUsage) {
    const state = mergeSeeds(loadState() || blankState())
    const sources = publicSources(state)
    const prices = publicPrices(state)
    const plans = publicPlans(state)
    const removedList = publicRemoved(state)
    return {
      ok: true,
      now: nowIso(),
      running: inFlight !== null,
      updatedAt: state.updatedAt,
      checkedAt: state.checkedAt,
      lastReason: state.lastReason || null,
      nextRefreshAt: nextRefreshAt(),
      refreshHour,
      dailySearch,
      search: state.search || null,
      dshApi: dshApi || null,
      usage: usage || null,
      // 官网实时价核对结果（拉到 / 拉不到 / 与本地快照有没有差）
      officialPricing: official || null,
      // 官方导出的用量账单（CSV）—— 权威口径，用来跟日志折算对账
      officialUsage: officialUsage || null,
      counts: {
        total: sources.length,
        reachable: sources.filter((item) => item.reachable === true).length,
        unreachable: sources.filter((item) => item.reachable === false).length,
        candidates: sources.filter((item) => item.origin === 'web').length,
        removed: publicRemoved(state).length,
      },
      prices: {
        snapshotAt: PRICE_SNAPSHOT_AT,
        checkedAt: state.pricesCheckedAt || null,
        total: prices.length,
        reachable: prices.filter((item) => item.reachable === true).length,
        providers: prices,
      },
      plans: {
        snapshotAt: PLAN_SNAPSHOT_AT,
        checkedAt: state.plansCheckedAt || null,
        total: plans.items.length,
        reachable: plans.items.filter((item) => item.reachable === true).length,
        source: plans.source,
        items: plans.items,
      },
      sources,
      // 手动删掉的入口留档：怎么删的、什么时候、联网又搜到过几次（存疑）
      removed: {
        count: removedList.length,
        items: removedList,
      },
    }
  }

  function foreignRejection(req) {
    try {
      const connection = ctx.get('connection')
      if (connection && typeof connection.requestRejection === 'function') {
        const code = connection.requestRejection(req)
        if (code === 401 || code === 403) return code
      }
    } catch (error) {}
    return 0
  }

  const sendJson = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  /** 用量时间窗：?window=day|week|month，认不出来就用默认的 month */
  const usageWindowOf = (req) => {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1')
      const value = parsed.searchParams.get('window')
      return value === 'day' || value === 'week' || value === 'month' ? value : undefined
    } catch (error) {
      return undefined
    }
  }

  /** 这一下是不是「重新读」按钮按的（?refresh=1）—— 只有这一下让自动判定压过手选 */
  const refreshRequested = (req) => {
    try {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1')
      const value = parsed.searchParams.get('refresh')
      return value === '1' || value === 'true'
    } catch (error) {
      return false
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-credits/list',
      handler: async (req, res) => {
        try {
          // 本机接入情况和用量各自收，出任何错都只让那一栏空着，不拖垮整页
          const billing = loadBillingOverrides()
          const dshApi = await collectDshApi(ctx, { billing }).catch(() => null)
          const official = await fetchOfficialPricing().catch(() => null)
          const officialUsage = await collectOfficialUsage(CFG_DIR).catch(() => null)
          const usage = await collectUsage(ctx, { window: usageWindowOf(req), official, officialUsage, billing, keyMap: resolveKeyMap(configuredKeyMap, officialUsage && officialUsage.byKey) }).catch(() => null)
          sendJson(res, 200, currentPayload(dshApi, usage, official, officialUsage))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  // 本机接入单独一个口：点「重新读」时绕开 30 秒缓存，立刻问一遍宿主
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-credits/dsh',
      handler: async (req, res) => {
        try {
          let billing = loadBillingOverrides()
          /**
           * 点「重新读」才会带 refresh=1。
           * 这一下让**自动判定压过手选**：白名单判成订阅的那几条，如果被手选改成了
           * 「按量」/「套餐折算」，退回订阅（否则用量栏会凭空多一笔假花费）。
           * 手填的「折算」开关和「月费」不跟着退 —— 它们不是「这条算什么」。
           */
          let billingRefresh = null
          if (refreshRequested(req)) {
            const reconciled = reconcileBillingOverrides(billing)
            if (reconciled.changed) {
              saveBillingOverrides(reconciled.overrides)
              billing = reconciled.overrides
            }
            billingRefresh = { cleared: reconciled.cleared, at: new Date().toISOString() }
          }
          const dshApi = await collectDshApi(ctx, { force: true, billing })
          const official = await fetchOfficialPricing({ force: true }).catch(() => null)
          const officialUsage = await collectOfficialUsage(CFG_DIR, { force: true }).catch(() => null)
          const usage = await collectUsage(ctx, { force: true, window: usageWindowOf(req), official, officialUsage, billing, keyMap: resolveKeyMap(configuredKeyMap, officialUsage && officialUsage.byKey) }).catch(() => null)
          sendJson(res, 200, { ok: true, dshApi, usage, officialPricing: official, officialUsage, billingRefresh })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  /**
   * 导入官方用量账单。
   *
   * 页面选文件 → base64 传上来 → 宿主写进 `$DSH_HOME/ai-credits/official-usage/`。
   * 之所以走宿主：浏览器沙箱写不了那个目录，宿主进程可以。
   * 支持 .zip（官方导出的原包，宿主自己解）和 .csv（已解压的单文件）。
   */
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-credits/official-import',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        const rejected = foreignRejection(req)
        if (rejected !== 0) {
          sendJson(res, rejected, { ok: false, error: rejected === 401 ? 'authentication_required' : 'forbidden' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) body += chunk
        } catch (error) {}
        let parsed = {}
        try {
          parsed = JSON.parse(body || '{}')
        } catch (error) {
          sendJson(res, 400, { ok: false, error: '请求不是合法 JSON' })
          return
        }
        if (typeof parsed.name !== 'string' || typeof parsed.data !== 'string') {
          sendJson(res, 400, { ok: false, error: '缺少 name / data' })
          return
        }
        let buffer
        try {
          buffer = Buffer.from(parsed.data, 'base64')
        } catch (error) {
          sendJson(res, 400, { ok: false, error: 'base64 解码失败' })
          return
        }
        try {
          const result = await importOfficialFiles(CFG_DIR, parsed.name, buffer)
          // 导入成功后顺手把最新状态回给页面，省一次往返
          let officialUsage = null
          if (result.ok) {
            officialUsage = await collectOfficialUsage(CFG_DIR, { force: true }).catch(() => null)
          }
          sendJson(res, result.ok ? 200 : 400, { ...result, officialUsage })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-credits/refresh',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        const rejected = foreignRejection(req)
        if (rejected !== 0) {
          sendJson(res, rejected, { ok: false, error: rejected === 401 ? 'authentication_required' : 'forbidden' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) body += chunk
        } catch (error) {}
        let parsed = {}
        try {
          parsed = JSON.parse(body || '{}')
        } catch (error) {}
        // 不在请求里等巡检跑完：38 个站最慢要一分多钟，HTTP 等那么久容易断。
        // 立刻回当前状态（running: true），页面靠 /list 轮询 running，跑完自然会上新。
        // pricesOnly：只探各官网价格页 / 订阅页（价格栏和订阅栏的按钮用），不动领取入口的检查结果。
        try {
          kick('手动', {
            search: parsed.search === true,
            pricesOnly: parsed.pricesOnly === true && parsed.search !== true,
          })
          const billing = loadBillingOverrides()
          const dshApi = await collectDshApi(ctx, { billing }).catch(() => null)
          const official = await fetchOfficialPricing().catch(() => null)
          const officialUsage = await collectOfficialUsage(CFG_DIR).catch(() => null)
          const usage = await collectUsage(ctx, { window: usageWindowOf(req), official, officialUsage, billing, keyMap: resolveKeyMap(configuredKeyMap, officialUsage && officialUsage.byKey) }).catch(() => null)
          sendJson(res, 200, currentPayload(dshApi, usage, official, officialUsage))
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  // 手动指定某条线路的计费方式。白名单漏掉的线路（新线路 / 自建线路 / 连接器内部 id）
// 落进「纯订阅」只报 token；这里让用户自己标成 按量 / 套餐折算 / 订阅。
//   body { provider, mode }  mode 为 'token' | 'estimate' | 'credits'
//   body { provider, mode: null }  清掉这条的覆盖，退回自动判定
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-credits/billing',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        const rejected = foreignRejection(req)
        if (rejected !== 0) {
          sendJson(res, rejected, { ok: false, error: rejected === 401 ? 'authentication_required' : 'forbidden' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) body += chunk
        } catch (error) {}
        let parsed = {}
        try {
          parsed = JSON.parse(body || '{}')
        } catch (error) {}
        const provider = typeof parsed.provider === 'string' ? parsed.provider.trim() : ''
        if (provider === '') {
          sendJson(res, 400, { ok: false, error: '要改哪条线路？' })
          return
        }
        // mode 只有传了才改：null = 退回自动判定，字符串 = 手选一个口径
        const mode = parsed.mode
        const touchMode = mode !== undefined
        if (touchMode && mode !== null && !['token', 'estimate', 'credits'].includes(mode)) {
          sendJson(res, 400, { ok: false, error: 'mode 只能是 token / estimate / credits，或 null 表示恢复自动' })
          return
        }
        // estimate 是「折算」开关，跟 mode 独立：对订阅线路来说它意味着「也折个等价金额」
        const estimate = parsed.estimate
        if (estimate !== undefined && typeof estimate !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'estimate 只能是 true / false' })
          return
        }
        // monthlyCNY：你实际付的月费，用来跟等价月费比；null = 清掉
        const monthlyCNY = parsed.monthlyCNY
        if (monthlyCNY !== undefined && monthlyCNY !== null) {
          const asNumber = typeof monthlyCNY === 'number' ? monthlyCNY : Number(monthlyCNY)
          if (!Number.isFinite(asNumber) || asNumber <= 0) {
            sendJson(res, 400, { ok: false, error: 'monthlyCNY 要么是正数，要么是 null' })
            return
          }
        }
        try {
          const overrides = loadBillingOverrides()
          const current = overrides[provider] || { mode: null, estimate: false, monthlyCNY: null }
          const next = { mode: current.mode, estimate: current.estimate, monthlyCNY: current.monthlyCNY }
          if (touchMode) next.mode = mode
          if (estimate !== undefined) next.estimate = estimate
          if (monthlyCNY !== undefined) {
            next.monthlyCNY =
              monthlyCNY === null ? null : typeof monthlyCNY === 'number' ? monthlyCNY : Number(monthlyCNY)
          }
          // 三个字段都空了就把这条删掉，别留一个空壳
          if (next.mode === null && next.estimate === false && next.monthlyCNY === null) delete overrides[provider]
          else overrides[provider] = next
          saveBillingOverrides(overrides)
          sendJson(res, 200, {
            ok: true,
            provider,
            entry: overrides[provider] || null,
            overrides,
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  // 删掉一条入口（留档，种子不会复活）。回包只报结果，页面自己重读 /list
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-credits/remove',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        const rejected = foreignRejection(req)
        if (rejected !== 0) {
          sendJson(res, rejected, { ok: false, error: rejected === 401 ? 'authentication_required' : 'forbidden' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) body += chunk
        } catch (error) {}
        let parsed = {}
        try {
          parsed = JSON.parse(body || '{}')
        } catch (error) {}
        try {
          const state = mergeSeeds(loadState() || blankState())
          const result = removeSource(state, parsed)
          if (result.ok !== true) {
            sendJson(res, 400, { ok: false, error: result.error || '删除失败' })
            return
          }
          saveState(state)
          sendJson(res, 200, {
            ok: true,
            url: result.url,
            title: result.title,
            remaining: state.sources.length,
            removed: publicRemoved(state).length,
          })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  // 从已删除里恢复
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/ai-credits/restore',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' })
          return
        }
        const rejected = foreignRejection(req)
        if (rejected !== 0) {
          sendJson(res, rejected, { ok: false, error: rejected === 401 ? 'authentication_required' : 'forbidden' })
          return
        }
        let body = ''
        try {
          for await (const chunk of req) body += chunk
        } catch (error) {}
        let parsed = {}
        try {
          parsed = JSON.parse(body || '{}')
        } catch (error) {}
        try {
          const state = mergeSeeds(loadState() || blankState())
          const result = restoreSource(state, parsed.url)
          if (result.ok !== true) {
            sendJson(res, 400, { ok: false, error: result.error || '恢复失败' })
            return
          }
          saveState(state)
          sendJson(res, 200, { ok: true, url: parsed.url, total: state.sources.length })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  // 启动后如果错过了今天的巡检，补一遍（带联网发现）；否则只要价格 / 订阅页过期就先核对
  ctx.effect(() =>
    ctx.timeout(() => {
      const state = loadState()
      if (dueForDaily(state)) kick('启动补检', { search: dailySearch })
      else if (catalogDue(state)) kick('价格补检', { pricesOnly: true })
    }, 4000),
  )

  // 每 10 分钟看一眼是不是到了今天的点；没到就什么都不做
  ctx.effect(() =>
    ctx.interval(() => {
      const state = loadState()
      if (dueForDaily(state)) kick('每日巡检', { search: dailySearch })
      else if (catalogDue(state)) kick('价格补检', { pricesOnly: true })
    }, 10 * 60 * 1000),
  )

  // 兜底：万一 timer 服务没有，至少别让页面空着 —— 首次打开时读到的还是种子清单
  try {
    if (!existsSync(STORE_FILE)) {
      const seeded = mergeSeeds(blankState())
      saveState(seeded)
    }
  } catch (error) {}
}
