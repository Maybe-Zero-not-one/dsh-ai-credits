/**
 * ai-credits · 国内官方订阅档位表（2.7.4）
 * ============================================================================
 * 为什么单独一张表：plans.js 里 Qoder / WorkBuddy 的条目是**国际版 USD 价**
 * （$10/$20/$60、$10 Pro），本机账号全是国内账号，拿美元价折人民币当参考
 * 会得出错误的「值不值」结论。这张表只收**国内官方口径**（CNY），四家：
 *
 *   Qoder CN     https://qoder.com.cn/pricing        （2026-11-27 核对）
 *   TRAE 国内版  https://www.trae.cn/pricing          （2026-11-27 核对）
 *   WorkBuddy    https://www.workbuddy.cn/docs/workbuddy/Pricing（2026-11-27 核对）
 *   华为云码道   https://codearts.huaweicloud.com/pricing.html +
 *                https://support.huaweicloud.com/price-codeartsagent/codeartsagent_billing_0029.html
 *
 * 每家给「官方档位下拉」用：id / 官方名称 / 月付原价（CNY）/ 首月或促销价 / 积分。
 * **参考价一律以月付原价为主**；促销价（promoCNY）只做展示，用户实付另记。
 *
 * ⚠ 档位（billingClass）只有两挡：
 *   monthly  月付挡 —— 含「一次买两个月」的限时优惠（本质还是按月订阅，
 *            只是优惠期买了俩月，不归季付/年付）
 *   yearly   年付挡 —— 连续包年 / 按年订购
 * 连续包月（7 折那种）也是 monthly。
 */

export const CN_TIERS_SNAPSHOT_AT = '2026-11-27'

/**
 * provider → 官方档位数组（从低到高）。
 * `official` 是官方页面上的名称原样；`promoCNY` 是当前限时/首月价（没有就 null）；
 * `promoNote` 说明促销口径；`credits` 每月基础积分。
 */
export const CN_PLAN_TIERS = {
  qoder: {
    label: 'Qoder CN',
    url: 'https://qoder.com.cn/pricing',
    tiers: [
      { id: 'qoder-cn-free', official: '体验版', monthlyCNY: 0, promoCNY: null, promoNote: '2 周专业版试用 + 300 Credits', credits: 0 },
      { id: 'qoder-cn-pro', official: '专业版', monthlyCNY: 59, promoCNY: 19.9, promoNote: '双11新客首订 ¥19.9（原价 ¥59），续费送 1,000 Qwen Credits', credits: 2000 },
      { id: 'qoder-cn-advanced', official: '高级版', monthlyCNY: 169, promoCNY: null, promoNote: '新客首订送 6,000 Qwen Credits', credits: 6000 },
      { id: 'qoder-cn-ultra', official: '旗舰版', monthlyCNY: 559, promoCNY: null, promoNote: '续费送 3,000 Qwen Credits', credits: 20000 },
    ],
  },
  'qoder-global': {
    // 国际版账号才用美元档；本机是国内账号，默认不走这份
    label: 'Qoder（国际版）',
    url: 'https://qoder.com/pricing',
    tiers: [
      { id: 'qoder-lite', official: 'Lite', monthlyCNY: null, usd: 10, credits: 1000 },
      { id: 'qoder-pro', official: 'Pro', monthlyCNY: null, usd: 20, credits: 2000 },
      { id: 'qoder-pro-plus', official: 'Pro+', monthlyCNY: null, usd: 60, credits: 6000 },
      { id: 'qoder-ultra', official: 'Ultra', monthlyCNY: null, usd: 200, credits: 20000 },
    ],
  },
  trae: {
    label: 'TRAE 国内版',
    url: 'https://www.trae.cn/pricing',
    tiers: [
      { id: 'trae-cn-free', official: '免费 Free（体验版）', monthlyCNY: 0, promoCNY: null, promoNote: '每月 500 积分，所有功能可用', credits: 500 },
      { id: 'trae-cn-lite', official: '会员 Lite', monthlyCNY: 49, promoCNY: 39, promoNote: '首月低至 ¥39', credits: 2000 },
      { id: 'trae-cn-pro', official: '会员 Pro', monthlyCNY: 99, promoCNY: 69, promoNote: '首月低至 ¥69', credits: 4000 },
      { id: 'trae-cn-pro-plus', official: '会员 Pro+', monthlyCNY: 239, promoCNY: 219, promoNote: '低至 ¥219/月', credits: 12000 },
      { id: 'trae-cn-ultra', official: '会员 Ultra', monthlyCNY: 699, promoCNY: 629, promoNote: '低至 ¥629/月', credits: 40000 },
    ],
  },
  workbuddy: {
    label: '腾讯 WorkBuddy（国内）',
    url: 'https://www.workbuddy.cn/docs/workbuddy/Pricing',
    tiers: [
      { id: 'wb-cn-free', official: '体验版', monthlyCNY: 0, promoCNY: null, promoNote: '每月 500 积分；补全限免无限次', credits: 500 },
      { id: 'wb-cn-standard', official: '标准版', monthlyCNY: 99, promoCNY: 70, promoNote: '连续包月 7 折 ¥70/月；限时加赠后每月实得 4,000 积分', credits: 2000 },
      { id: 'wb-cn-advanced', official: '高级版', monthlyCNY: 199, promoCNY: 140, promoNote: '连续包月 7 折 ¥140/月；限时实得 9,000 积分', credits: 4000 },
      { id: 'wb-cn-flagship', official: '旗舰版', monthlyCNY: 999, promoCNY: 700, promoNote: '连续包月 7 折 ¥700/月；限时实得 50,000 积分', credits: 20000 },
    ],
  },
  codearts: {
    label: '华为云码道 CodeArts',
    url: 'https://codearts.huaweicloud.com/pricing.html',
    tiers: [
      { id: 'codearts-doer-free', official: '个人体验版', monthlyCNY: 0, promoCNY: null, promoNote: '每月 500 积分；限时每日签到领 100 积分', credits: 500 },
      { id: 'codearts-doer-standard', official: '个人标准版', monthlyCNY: 98, promoCNY: null, promoNote: '包年 ¥823.2（约 ¥68.6/月）；每日签到 150 积分', credits: 2000 },
      { id: 'codearts-doer-advanced', official: '个人高级版', monthlyCNY: 198, promoCNY: null, promoNote: '包年 ¥1,663.2；每日签到 200 积分', credits: 4000 },
      { id: 'codearts-doer-flagship', official: '个人旗舰版', monthlyCNY: 498, promoCNY: null, promoNote: '包年 ¥4,183.2；每日签到 200 积分', credits: 10000 },
    ],
  },
}

/** 这条线路有没有国内官方档位表 */
export function cnTiersOf(provider) {
  const entry = CN_PLAN_TIERS[provider]
  return entry === undefined ? null : entry
}

/** 按档位 id 找官方档位（跨 provider 也行，id 全局唯一） */
export function cnTierById(tierId) {
  if (typeof tierId !== 'string' || tierId === '') return null
  for (const [provider, entry] of Object.entries(CN_PLAN_TIERS)) {
    const tier = entry.tiers.find((t) => t.id === tierId)
    if (tier !== undefined) return { ...tier, provider, providerLabel: entry.label, url: entry.url }
  }
  return null
}

/**
 * 时长 → 计费挡位。**一次买两个月的限时优惠仍归月付挡**（2.7.4）：
 * 那不是季付/年付订阅，只是月付优惠期买了俩月。
 *   1~2 个月 → monthly；3~11 → quarterly（季付/多月包）；12+ → yearly
 */
export function billingClassOfTerm(termMonths) {
  const t = typeof termMonths === 'number' && Number.isFinite(termMonths) ? Math.floor(termMonths) : 1
  if (t <= 2) return 'monthly'
  if (t < 12) return 'quarterly'
  return 'yearly'
}

export const BILLING_CLASS_LABELS = {
  monthly: '月付挡',
  quarterly: '多月包挡',
  yearly: '年付挡',
}
