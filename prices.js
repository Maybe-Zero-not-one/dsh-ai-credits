/**
 * ai-credits · 价格快照
 * ============================================================================
 * 「各家价格」栏目的数字都在这里。价格是人工核对的**官方公开标价**，单位统一为
 * 每 100 万 tokens（1M tokens），区分输入 / 输出；币种按各家官网原样标注：
 *   国内厂商多为人民币（CNY），也有直接标美元（USD）的；海外厂商是美元（USD）。
 *
 * ⚠ 这些数字不会自动爬取 —— 各家定价页结构不一样（有的整页 JS 渲染），硬抓容易
 *   抓错价。宿主每天只核对下面 pricingUrl 能不能打开；改价时手动改这里，
 *   顺手把 PRICE_SNAPSHOT_AT 改成核对日期。
 *
 * source：
 *   'official'    —— 数字来自该厂商官网 / 官方文档 / 官方云价目
 *   'openrouter'  —— 官网对本机自动访问不友好（403 / 超时），数字按 OpenRouter
 *                    目录核对；页面会标「聚合价」，以官网为准
 *
 * 峰谷计价（provider 级 `peak`）：
 *   有的厂商分时段定价 —— DeepSeek 高峰价是空闲价的 2 倍。这种厂商在 provider
 *   上挂一个 `peak` 描述「什么时候算高峰」，在 model 上同时给 `input/output/
 *   cacheRead`（高峰）和 `offPeak: { input, output, cacheRead }`（空闲）。
 *   usage.js 按每条调用的真实时间戳判断落在哪边，分别计价。
 *   没有 `peak` 的厂商按单一价算。
 */
export const PRICE_SNAPSHOT_AT = '2026-11-22'

/**
 * 2026 年中国法定节假日（国务院办公厅国办发明电〔2025〕7号）。
 * 官方定价规则说「不含中国法定节假日」，这些天全天按空闲价。
 *
 * 注意：调休上班的周六 / 周日（1/4、2/14、2/28、5/9、9/20、10/10）按官方原文
 * 仍归入「周末 → 空闲时段」—— 原文是「其余时段，包括周末及中国法定节假日全天
 * 均为空闲时段」，没有为调休日开口子。
 */
export const CN_HOLIDAYS_2026 = [
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  // 清明节
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午节
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋节
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆节
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

export const PRICE_PROVIDERS = [
  // ---------------------------------------------------------------- 国内
  {
    id: 'deepseek',
    title: 'DeepSeek',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    sourceDate: '2026-11-17',
    source: 'official',
    note: '分峰谷计价：高峰价是空闲价的 2 倍；缓存命中输入更便宜',
    // 官方原文：「北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00
    // 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。」
    peak: {
      timeZone: 'Asia/Shanghai',
      weekdays: [1, 2, 3, 4, 5],
      ranges: [
        ['09:00', '12:00'],
        ['14:00', '18:00'],
      ],
      holidays: CN_HOLIDAYS_2026,
      note: '周一至周五 9:00-12:00、14:00-18:00 为高峰；其余时段（含周末与法定节假日全天）为空闲，价格减半',
    },
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        contextK: 1024,
        input: 2,
        output: 8,
        cacheRead: 0.04,
        offPeak: { input: 1, output: 4, cacheRead: 0.02 },
        note: '高峰：未命中输入 ¥2 / 输出 ¥8 / 命中输入 ¥0.04；空闲各减半（¥1 / ¥4 / ¥0.02）',
      },
      {
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        contextK: 1024,
        input: 9,
        output: 27,
        cacheRead: 0.3,
        offPeak: { input: 4.5, output: 13.5, cacheRead: 0.15 },
        note: '高峰：未命中输入 ¥9 / 输出 ¥27 / 命中输入 ¥0.30；空闲各减半（¥4.5 / ¥13.5 / ¥0.15）',
      },
    ],
  },
  {
    id: 'qwen',
    title: '阿里通义千问',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing',
    sourceDate: '2026-11-09',
    source: 'official',
    note: '百炼平台；新用户有 100 万 tokens 免费额度（90 天）',
    models: [
      { id: 'qwen3.8-max', name: 'Qwen3.8-Max', contextK: 1000, input: 12, output: 36, note: 'Batch 半价；缓存有折扣' },
      { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', contextK: 1000, input: 0.8, output: 2.7, note: '便宜档' },
      { id: 'qwen3.8-27b', name: 'Qwen3.8-27B', contextK: 1024, input: 3, output: 12, note: '开源尺寸' },
      { id: 'qwen3.8-omni-flash', name: 'Qwen3.8-Omni-Flash', contextK: 1000, input: 0.8, output: 2.7, note: '全模态；缓存命中 ¥0.1' },
      { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', contextK: 256, input: 2, output: 8, note: '页面价；限时 8 折，实际 ¥1.6 / ¥6.4' },
    ],
  },
  {
    /* 千问AI平台（qianwenai.com）—— 阿里自家的 MaaS 平台，
       和上面的「阿里通义千问（百炼）」是两个网址、两套价，别混为一谈。
       端点 cn-beijing.maas.qianwenaiapi.com，兼容 OpenAI / Anthropic 协议。 */
    id: 'qianwenai',
    title: '千问AI平台',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://www.qianwenai.com/models/qwen3.6-flash',
    sourceDate: '2026-11-22',
    source: 'official',
    note: '阿里 MaaS 平台（qianwenai.com）；新用户注册送 tokens 额度',
    models: [
      {
        id: 'qwen3.6-flash',
        name: 'Qwen3.6-Flash',
        contextK: 1000,
        input: 1.2,
        output: 7.2,
        cacheRead: 0.12,
        note:
          '上下文 1M（最大输入 991K / 输出 65K）；Batch ¥0.6 / ¥3.6；' +
          '显式缓存创建 ¥1.5、命中 ¥0.12；支持视觉输入与原生思考',
      },
    ],
  },
  {
    id: 'zhipu',
    title: '智谱 GLM',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://docs.bigmodel.cn/cn/guide/start/pricing',
    sourceDate: '2026-11-09',
    source: 'official',
    note: '缓存存储限时免费；GLM-4.7-Flash 免费',
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', contextK: 1024, input: 8, output: 28, note: '缓存命中 ¥2' },
      { id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', contextK: 1024, input: 2, output: 7, note: '缓存命中 ¥0.57' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextK: 1024, input: 0.8, output: 2.8, note: '原生多模态；缓存命中 ¥0.23' },
      { id: 'glm-4.7', name: 'GLM-4.7', contextK: 200, input: 3, output: 14, note: '≤32K 输入档；短回答档 ¥2 / ¥8' },
      { id: 'glm-4.5-air', name: 'GLM-4.5-Air', contextK: 128, input: 0.8, output: 6, note: '≤32K 输入档；短回答档 ¥0.8 / ¥2' },
      { id: 'glm-4-long', name: 'GLM-4-Long', contextK: 1024, input: 1, output: 1, note: '长上下文专用' },
    ],
  },
  {
    id: 'kimi',
    title: 'Kimi（月之暗面）',
    region: '国内',
    currency: 'USD',
    pricingUrl: 'https://platform.moonshot.ai/docs/pricing/chat',
    sourceDate: '2026-11-09',
    source: 'official',
    note: '缓存自动开启；Batch 6 折',
    models: [
      { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', contextK: 1024, input: 2, output: 10, note: '缓存命中 $0.20' },
      { id: 'kimi-k3', name: 'Kimi K3', contextK: 1024, input: 3, output: 15, note: '缓存命中 $0.30' },
    ],
  },
  {
    id: 'minimax',
    title: 'MiniMax',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://platform.minimaxi.com/document/Price',
    sourceDate: '2026-11-09',
    source: 'official',
    note: '缓存读取另算；优先服务 1.5 倍价',
    models: [
      { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', contextK: 1024, input: 1, output: 4, note: '缓存读取 ¥0.10' },
      { id: 'minimax-m3', name: 'MiniMax-M3', contextK: 1024, input: 2.1, output: 8.4, note: '≤512K 输入永久五折价' },
    ],
  },
  {
    id: 'doubao',
    title: '字节豆包（火山方舟）',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://www.volcengine.com/docs/ark/model-pricing',
    sourceDate: '2026-11-17',
    source: 'official',
    note: '方舟按输入长度分档计价，下表取 0–1024K 档；方舟托管的 DeepSeek 与官方同价、同样分峰谷',
    // 方舟托管 DeepSeek 与官方同价，峰谷规则也照官方（北京时间工作日 9-12、14-18 为高峰）
    peak: {
      timeZone: 'Asia/Shanghai',
      weekdays: [1, 2, 3, 4, 5],
      ranges: [
        ['09:00', '12:00'],
        ['14:00', '18:00'],
      ],
      holidays: CN_HOLIDAYS_2026,
      note: '与 DeepSeek 官方一致：工作日 9:00-12:00、14:00-18:00 为高峰',
    },
    models: [
      // 方舟托管的 DeepSeek V4.1 Flash（模型 id 按方舟的写法）
      {
        id: 'deepseek-v4-1-flash-261017',
        name: 'DeepSeek-V4.1-Flash（方舟）',
        contextK: 1024,
        input: 2,
        output: 8,
        cacheRead: 0.04,
        offPeak: { input: 1, output: 4, cacheRead: 0.02 },
        note: '方舟与 DeepSeek 官方同价；经济版约为常规 8 折（下表未含）',
        // 方舟托管的就是 DeepSeek 自己的模型 —— 价格跟着官网走，官网改价这里自动跟
        followsOfficial: 'deepseek-flash',
      },
      { id: 'doubao-seed-2.1-pro', name: 'Doubao-Seed-2.1-Pro', contextK: 1024, input: 6, output: 30, note: '缓存命中 ¥1.20' },
      { id: 'doubao-seed-2.1-lite', name: 'Doubao-Seed-2.1-Lite', contextK: 1024, input: 0.8, output: 2.7, note: '音频输入另计 ¥12' },
      { id: 'doubao-seed-2.1-turbo', name: 'Doubao-Seed-2.1-Turbo', contextK: 256, input: 3, output: 15, note: '' },
      { id: 'doubao-seed-2.0-pro', name: 'Doubao-Seed-2.0-Pro', contextK: 256, input: 3.2, output: 16, note: '≤32K 档；32K–128K 为 ¥4.8 / ¥24' },
    ],
  },
  {
    id: 'siliconflow',
    title: '硅基流动 SiliconFlow',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://siliconflow.cn/pricing',
    sourceDate: '2026-11-17',
    source: 'official',
    note: '按量付费；DeepSeek 系列分时定价，单价与 DeepSeek 官方一致，但时段不同（低峰 2 点~8 点）',
    // 官方价目页（「/K Tokens」口径换算成每百万 tokens）：
    //   缓存命中  2点~8点 ¥0.000020/K = ¥0.02/M   其余时段 ¥0.000040/K = ¥0.04/M
    //   输入      2点~8点 ¥0.001000/K = ¥1/M      其余时段 ¥0.002000/K = ¥2/M
    //   输出      2点~8点 ¥0.004000/K = ¥4/M      其余时段 ¥0.008000/K = ¥8/M
    // 低峰只有凌晨 2:00-8:00；0:00-2:00 和 8:00-24:00 都按高峰。无周末 / 节假日例外。
    peak: {
      timeZone: 'Asia/Shanghai',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      ranges: [
        ['00:00', '02:00'],
        ['08:00', '24:00'],
      ],
      holidays: [],
      note: '低峰仅凌晨 2:00-8:00（价格减半）；0:00-2:00 与 8:00-24:00 为高峰。全天两段，无周末例外',
    },
    models: [
      {
        // 日志里报的是 deepseek-ai/DeepSeek-V4.1-Flash（价目页标签里写成 .online 系列）
        id: 'deepseek-ai/DeepSeek-V4.1-Flash',
        name: 'DeepSeek-V4.1-Flash（硅基）',
        contextK: 1024,
        input: 2,
        output: 8,
        cacheRead: 0.04,
        offPeak: { input: 1, output: 4, cacheRead: 0.02 },
        note: '高峰（8:00-24:00、0:00-2:00）输入 ¥2 / 输出 ¥8 / 命中 ¥0.04；低峰（2:00-8:00）¥1 / ¥4 / ¥0.02',
      },
    ],
  },
  {
    id: 'baidu',
    title: '百度文心（千帆）',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://cloud.baidu.com/doc/qianfan/s/wmh4sv6ya',
    sourceDate: '2026-10-29',
    source: 'official',
    note: '页面更新 2026-10-29；输入按长度分档',
    models: [
      { id: 'ernie-5.1', name: 'ERNIE 5.1', contextK: 128, input: 4, output: 18, note: '≤32K 输入档；32K–128K 为 ¥6 / ¥22' },
    ],
  },
  {
    id: 'tencent',
    title: '腾讯混元',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://cloud.tencent.com/document/product/1729/97731',
    sourceDate: '2026-06-26',
    source: 'official',
    note: '混元能力正迁移至 TokenHub，旧平台不再新增模型',
    models: [
      { id: 'hunyuan-role-latest', name: 'Hunyuan-role-latest', contextK: null, input: 2.4, output: 9.6, note: '刊例价' },
      { id: 'hunyuan-a13b', name: 'Hunyuan-a13b', contextK: null, input: 0.5, output: 2, note: '有 100 万 tokens 免费额度（1 年有效）' },
    ],
  },
  {
    id: 'stepfun',
    title: '阶跃星辰',
    region: '国内',
    currency: 'CNY',
    pricingUrl: 'https://platform.stepfun.com/docs/zh/guides/pricing/details',
    sourceDate: '2026-11-09',
    source: 'official',
    note: '缓存命中输入另计',
    models: [
      { id: 'step-5-preview', name: 'Step 5 Preview', contextK: null, input: 7, output: 20, note: '缓存命中 ¥0.70' },
      { id: 'step-3.7-flash', name: 'Step 3.7 Flash', contextK: null, input: 1.35, output: 8.1, note: '缓存命中 ¥0.27' },
      { id: 'step-3.5-flash', name: 'Step 3.5 Flash', contextK: null, input: 0.7, output: 2.1, note: '缓存命中 ¥0.14' },
    ],
  },

  // ---------------------------------------------------------------- 海外
  {
    id: 'openai',
    title: 'OpenAI',
    region: '海外',
    currency: 'USD',
    pricingUrl: 'https://openai.com/api/pricing/',
    sourceDate: '2026-11-09',
    source: 'openrouter',
    note: '官网价格页对自动访问返回 403，数字按 OpenRouter 目录核对',
    models: [
      { id: 'gpt-6.1-sol-pro', name: 'GPT-6.1 Sol Pro', contextK: 1050, input: 2, output: 10, note: 'Batch 半价' },
      { id: 'gpt-6.1-terra-pro', name: 'GPT-6.1 Terra Pro', contextK: 1050, input: 1, output: 5, note: 'Batch 半价' },
      { id: 'gpt-6-luna-pro', name: 'GPT-6 Luna Pro', contextK: 1050, input: 0.1, output: 0.5, note: '轻量档' },
    ],
  },
  {
    id: 'anthropic',
    title: 'Anthropic Claude',
    region: '海外',
    currency: 'USD',
    pricingUrl: 'https://claude.com/pricing',
    sourceDate: '2026-11-09',
    source: 'official',
    note: 'Batch 5 折；美国境内专属推理 1.1 倍价',
    models: [
      { id: 'claude-fable-5.1', name: 'Claude Fable 5.1', contextK: 1000, input: 10, output: 50, note: '缓存读 $0.25 / 写 $12.50' },
      { id: 'claude-opus-5.5', name: 'Claude Opus 5.5', contextK: 1000, input: 4, output: 20, note: '缓存读 $0.20 / 写 $5' },
      { id: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5', contextK: 1000, input: 2, output: 10, note: '缓存读 $0.10 / 写 $2.50' },
      { id: 'claude-haiku-5.5', name: 'Claude Haiku 5.5', contextK: 1000, input: 0.1, output: 0.5, note: '≤100K 输入；更长上下文更贵' },
    ],
  },
  {
    id: 'google',
    title: 'Google Gemini',
    region: '海外',
    currency: 'USD',
    pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    sourceDate: '2026-11-09',
    source: 'openrouter',
    note: '官网价格页对本机超时，数字按 OpenRouter 目录核对',
    models: [
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', contextK: 1049, input: 2, output: 10, note: 'Batch 半价' },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextK: 1049, input: 0.825, output: 4.125, note: '' },
      { id: 'gemini-omni-1.2-flash', name: 'Gemini Omni 1.2 Flash', contextK: 131, input: 1.5, output: 9, note: '全模态' },
      { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash Lite', contextK: 1049, input: 0.3, output: 2.5, note: '轻量档' },
    ],
  },
  {
    id: 'xai',
    title: 'xAI Grok',
    region: '海外',
    currency: 'USD',
    pricingUrl: 'https://docs.x.ai/docs/models',
    sourceDate: '2026-11-09',
    source: 'openrouter',
    note: '官网价格页对本机超时，数字按 OpenRouter 目录核对',
    models: [
      { id: 'grok-4.7', name: 'Grok 4.7', contextK: 500, input: 2, output: 6, note: 'Batch 8 折' },
      { id: 'grok-4.20', name: 'Grok 4.20', contextK: 2000, input: 1.25, output: 2.5, note: '2M 上下文' },
      { id: 'grok-4.3', name: 'Grok 4.3', contextK: 1000, input: 1.25, output: 2.5, note: '' },
    ],
  },
  {
    id: 'mistral',
    title: 'Mistral',
    region: '海外',
    currency: 'USD',
    pricingUrl: 'https://mistral.ai/pricing',
    sourceDate: '2026-11-09',
    source: 'openrouter',
    note: '官网价格页对本机超时，数字按 OpenRouter 目录核对',
    models: [
      { id: 'mistral-large-4', name: 'Mistral Large 4', contextK: 1049, input: 0.7, output: 2.1, note: '' },
      { id: 'mistral-medium-3.5', name: 'Mistral Medium 3.5', contextK: 262, input: 1.5, output: 7.5, note: '' },
      { id: 'mistral-small-4', name: 'Mistral Small 4', contextK: 262, input: 0.15, output: 0.6, note: '' },
      { id: 'devstral-2', name: 'Devstral 2', contextK: 262, input: 0.4, output: 2, note: '代码模型' },
    ],
  },
  {
    id: 'cohere',
    title: 'Cohere',
    region: '海外',
    currency: 'USD',
    pricingUrl: 'https://cohere.com/pricing',
    sourceDate: '2026-11-09',
    source: 'official',
    note: '官网现主推企业版 North / Model Vault（按 GPU 小时计费），逐模型 token 价只在 FAQ 里列出',
    models: [
      { id: 'command-a-plus', name: 'Command A+', contextK: 192, input: 2.5, output: 10, note: '' },
    ],
  },
  {
    id: 'meta',
    title: 'Meta Llama（AWS Bedrock）',
    region: '海外',
    currency: 'USD',
    pricingUrl: 'https://aws.amazon.com/bedrock/pricing/',
    sourceDate: '2026-11-09',
    source: 'official',
    note: 'Meta 没有自营 API，价格按 AWS Bedrock 官方按需价（us-east-1）',
    models: [
      { id: 'llama-4-maverick', name: 'Llama 4 Maverick', contextK: 1000, input: 0.24, output: 0.97, note: 'Batch 0.12 / 0.485' },
      { id: 'llama-4-scout', name: 'Llama 4 Scout', contextK: 10000, input: 0.17, output: 0.66, note: 'Batch 0.085 / 0.33' },
    ],
  },
  {
    id: 'amazon',
    title: 'Amazon Nova',
    region: '海外',
    currency: 'USD',
    pricingUrl: 'https://aws.amazon.com/bedrock/pricing/',
    sourceDate: '2026-11-09',
    source: 'openrouter',
    note: '按 OpenRouter 目录核对；AWS Bedrock 官方价可能略有差异',
    models: [
      { id: 'nova-2-lite', name: 'Nova 2 Lite', contextK: 1000, input: 0.3, output: 2.5, note: '' },
      { id: 'nova-pro', name: 'Nova Pro', contextK: 300, input: 0.8, output: 3.2, note: '' },
      { id: 'nova-premier', name: 'Nova Premier', contextK: 1000, input: 2.5, output: 12.5, note: '' },
    ],
  },
  {
    id: 'nvidia',
    title: 'NVIDIA Nemotron',
    region: '海外',
    currency: 'USD',
    pricingUrl: 'https://build.nvidia.com',
    sourceDate: '2026-11-09',
    source: 'openrouter',
    note: '按 OpenRouter 目录核对；NIM 官方价可能略有差异',
    models: [
      { id: 'nemotron-3.5-super-vl', name: 'Nemotron 3.5 Super VL', contextK: 1049, input: 0.15, output: 0.5, note: '多模态' },
      { id: 'nemotron-3-ultra', name: 'Nemotron 3 Ultra 550B', contextK: 262, input: 0.6, output: 2.4, note: '' },
      { id: 'nemotron-3.5-lightning', name: 'Nemotron 3.5 Lightning', contextK: 262, input: 0.07, output: 0.2, note: '轻量档' },
    ],
  },
]
