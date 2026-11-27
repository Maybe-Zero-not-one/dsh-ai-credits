/**
 * ai-credits · 网页半边
 * ============================================================================
 * 侧栏「积分」那一栏（挂在自动化任务 / 插件 / MCP 这组面板按钮里，order 100），
 * 点开是一个主区页面，两个栏目：
 *   「领取入口」把宿主巡检好的免费额度入口列出来，附领取链接；
 *   「各家价格」把各家 AI 的官方 API 标价按 1M tokens 摆成表，每天核对价格页。
 *
 * 数据只管往宿主要：
 *   GET  /ai-credits/list      → 入口清单 + 巡检时间 + 价格表 + 搜索状态
 *   POST /ai-credits/refresh   → 立刻巡检（body.search=true 连联网发现；
 *                                                body.pricesOnly=true 只核对价格页）
 * 页面每 60 秒重读一次，宿主每天自动巡检一次，所以打开时看到的就是最新的。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: '@local/ai-credits',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/ai-credits'
    const CATEGORY_ORDER = ['国内 API', '海外 API', '消费级应用', '学生与开发者', '每日新发现']
    const REGION_ORDER = ['国内', '海外']

    /** 「本机接入」每条线路最多摊开几个模型名，剩下的折成「还有 N 个」 */
    const MODEL_CHIP_LIMIT = 8

    /**
     * 订阅制线路的积分消耗与余额。
     *
     * 这些连接器各自开了 `/plugins/dsh-connect-xxx/usage`，里面有官方口径的积分账：
     * - Trae：`credits.consumed` 直接给「已消耗」
     * - Qoder / WorkBuddy：只有每个套餐包的 `size`（总额）和 `remain`（剩余），
     *   消耗 = Σsize − Σremain
     *
     * 宿主进程拿不到自己的监听端口，问不了自己，所以由页面同源去问 ——
     * 页面的 origin 就是宿主，天然能过。哪家没装 / 没登录 / 超时都只是那一家没数，
     * 绝不影响用量统计本身。
     *
     * ⚠️ 这些是**累计值**，跟时间窗（今天 / 7 天 / 30 天）无关 —— 官方没给按天明细。
     */
    const CREDIT_ENDPOINTS = [
      { route: 'trae', endpoint: 'dsh-connect-trae' },
      { route: 'qoder', endpoint: 'dsh-connect-qoder' },
      { route: 'qoder-global', endpoint: 'dsh-connect-qoder' },
      { route: 'workbuddy', endpoint: 'dsh-connect-workbuddy' },
    ]

    /** 从 /usage 的 credits 块里抠出「已消耗」「剩余」「总额度」 */
    const readCreditBook = (credits) => {
      if (!credits || typeof credits !== 'object') return null
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      const remain = num(credits.available !== undefined ? credits.available : credits.total)
      let consumed = num(credits.consumed)
      let quota = num(credits.total)

      // qoder / workbuddy 没有 consumed，用 Σsize − Σremain 推；总额度也取 Σsize
      // （它们的 `total` 其实是「剩余」，不是额度上限）
      if (Array.isArray(credits.packages)) {
        let size = 0
        let left = 0
        let seen = false
        for (const pack of credits.packages) {
          if (!pack || typeof pack !== 'object') continue
          const s = num(pack.size)
          const r = num(pack.remain)
          if (s === null || r === null) continue
          size += s
          left += r
          seen = true
        }
        if (seen) {
          if (consumed === null) consumed = size - left
          if (quota === null || quota <= left) quota = size
        }
      }

      if (consumed === null && quota !== null && remain !== null) consumed = quota - remain
      if (consumed === null && remain === null) return null
      return {
        consumed: consumed === null ? null : Number(consumed.toFixed(2)),
        remaining: remain === null ? null : Number(remain.toFixed(2)),
        total: quota === null ? null : Number(quota.toFixed(2)),
      }
    }

    /**
     * 从 /usage 里读「这条渠道加了几个账号」（2.7.1，2.7.2 扩充为逐账号明细）。
     *
     * 连接器自己就把账号列表摊在 `accounts` 里，当前用的是哪个看顶层 `accountId`。
     * **逐账号的订阅状态在 `pool.accounts` 里**（2.7.2）：
     *   member            这个账号是不是会员（开了订阅）—— 多账号里可能只有部分开了
     *   credits           这个账号自己的积分余额
     *   planExpiresAtMs   套餐到期
     *   current           是不是当前在用的
     *   checkedInToday    今天签到过没
     *
     * 只取这些公开字段，不碰 token / pat 这些凭据。
     *
     * ⚠ 跟积分不同：**登出了也要报账号数**（trae 现在 signed-out 但存着 2 个账号），
     * 所以这个读取不看 status。
     */
    const readAccounts = (payload) => {
      if (!payload || !Array.isArray(payload.accounts)) return null
      // pool.accounts 按 accountId 索引，拿逐账号的会员 / 积分 / 到期
      const poolById = new Map()
      const poolRows = payload.pool && Array.isArray(payload.pool.accounts) ? payload.pool.accounts : []
      for (const row of poolRows) {
        if (row && typeof row.accountId === 'string') poolById.set(row.accountId, row)
      }
      const memberIds = new Set(
        (payload.pool && Array.isArray(payload.pool.effectiveMemberAccountIds)
          ? payload.pool.effectiveMemberAccountIds
          : payload.pool && Array.isArray(payload.pool.memberAccountIds)
            ? payload.pool.memberAccountIds
            : []
        ).filter((x) => typeof x === 'string'),
      )
      const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
      const nowMs = Date.now()
      const rows = []
      for (const item of payload.accounts) {
        if (!item || typeof item !== 'object') continue
        const id = typeof item.id === 'string' && item.id !== '' ? item.id : null
        if (id === null) continue
        const pool = poolById.get(id) || null
        // 会员判定：pool 里明说 member，或 id 在会员名单里；两样都没有就是 null（不知道）
        let member = null
        if (pool && typeof pool.member === 'boolean') member = pool.member
        else if (memberIds.size > 0) member = memberIds.has(id)
        /**
         * 套餐到期核查（2.7.3）：member 标记可能是缓存的旧状态 ——
         * planExpiresAtMs 已经过了就**不算已订阅**（标「已过期」），
         * 免得把过期账号当成还在订阅、把它的旧积分当成可用额度。
         */
        const planExp = pool ? num(pool.planExpiresAtMs) : null
        const planExpired = member === true && planExp !== null && planExp <= nowMs
        if (planExpired) member = false
        rows.push({
          id,
          name: typeof item.accountName === 'string' && item.accountName !== '' ? item.accountName : null,
          selected: item.selected === true,
          member,
          planExpired,
          credits: pool ? num(pool.credits) : null,
          planExpiresAtMs: planExp,
          nearestExpiryMs: pool ? num(pool.nearestExpiryMs) : null,
          checkedInToday: pool && typeof pool.checkedInToday === 'boolean' ? pool.checkedInToday : null,
          tokenExpiresAtMs: num(item.tokenExpiresAtMs),
          region: typeof item.region === 'string' ? item.region : null,
          enterprise: typeof item.enterprise === 'boolean' ? item.enterprise : null,
        })
        if (rows.length >= 20) break
      }
      if (rows.length === 0) return null
      const activeId = typeof payload.accountId === 'string' && payload.accountId !== '' ? payload.accountId : null
      let currentId = activeId !== null && rows.some((r) => r.id === activeId) ? activeId : null
      if (currentId === null) {
        const marked = rows.find((r) => r.selected)
        currentId = marked ? marked.id : null
      }
      const memberCount = rows.filter((r) => r.member === true).length
      const expiredCount = rows.filter((r) => r.planExpired === true).length
      const anyMemberKnown = rows.some((r) => r.member !== null)
      return { count: rows.length, currentId, accounts: rows, memberCount, expiredCount, anyMemberKnown }
    }

    const fetchCreditBalances = async () => {
      const out = {}
      await Promise.all(
        CREDIT_ENDPOINTS.map(async (item) => {
          try {
            const response = await fetch('/plugins/' + item.endpoint + '/usage', {
              cache: 'no-store',
              credentials: 'same-origin',
            })
            if (!response.ok) return
            const payload = await response.json()
            if (!payload) return
            // 账号列表：登出也报（存着几个账号是事实，跟当前能不能用无关）
            const accounts = readAccounts(payload)
            // 积分：只有登录态才有意义
            const book = payload.status === 'signed-in' ? readCreditBook(payload.credits) : null
            if (book === null && accounts === null) return
            const prev = out[item.route]
            out[item.route] = {
              consumed: book === null ? (prev ? prev.consumed : null) : book.consumed,
              remaining: book === null ? (prev ? prev.remaining : null) : book.remaining,
              total: book === null ? (prev ? prev.total : null) : book.total,
              accountName: payload.accountName || (prev ? prev.accountName : null),
              accounts,
            }
          } catch (error) {
            // 没这家连接器就算了
          }
        }),
      )
      return out
    }

    /**
     * 首屏快照缓存。
     *
     * 每次点进这一栏都要等宿主回数据（热态约 130ms，插件刚重载要几秒）。
     * 这里把上一次的完整 payload 存进 localStorage，组件初始化时直接拿来渲染 ——
     * 点进去立刻有内容，然后后台静默刷新把数字更新掉。
     *
     * 只存 payload，不存任何凭据。坏了 / 超配额都静默放弃，绝不影响正常加载。
     */
    const SNAPSHOT_KEY = 'ai-credits.snapshot.v1'
    const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000

    const saveSnapshot = (payload) => {
      try {
        window.localStorage.setItem(
          SNAPSHOT_KEY,
          JSON.stringify({ at: Date.now(), payload }),
        )
      } catch (error) {
        // 超配额 / 隐私模式禁用 localStorage —— 放弃缓存，功能照常
      }
    }

    const readSnapshot = () => {
      try {
        const raw = window.localStorage.getItem(SNAPSHOT_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.at !== 'number') return null
        // 太旧的快照不拿来首屏（免得看着像当前数据），但也不删
        if (Date.now() - parsed.at > SNAPSHOT_MAX_AGE_MS) return null
        return parsed.payload || null
      } catch (error) {
        return null
      }
    }

    const pad = (n) => String(n).padStart(2, '0')

    const fmtTime = (iso) => {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    const fmtDay = (iso) => {
      if (!iso) return ''
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return ''
      return pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    }

    /** 价格快照的日期（YYYY-MM-DD，没有时间部分）离今天多少天；解析不了就返回 null */
    const daysSince = (day) => {
      if (!day) return null
      const at = Date.parse(day + 'T00:00:00')
      if (!Number.isFinite(at)) return null
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      return Math.round((today.getTime() - at) / (24 * 60 * 60 * 1000))
    }

    const hostOf = (raw) => {
      try {
        return new URL(raw).hostname.replace(/^www\./, '')
      } catch (error) {
        return raw
      }
    }

    const statusOf = (source) => {
      if (source.reachable === true) return { key: 'ok', text: '能打开' }
      if (source.reachable === false) {
        // 海外入口连不上多数是本机出不去的网，不是链接坏了 —— 说清楚，别让人误删
        if (source.httpStatus === 0) {
          return source.overseas === true
            ? { key: 'warn', text: '需代理' }
            : { key: 'warn', text: '本机连不上' }
        }
        if (source.httpStatus === 403 || source.httpStatus === 401) return { key: 'warn', text: '拦了自动检查' }
        return { key: 'bad', text: 'HTTP ' + source.httpStatus }
      }
      return { key: 'idle', text: '待检查' }
    }

    const currencySymbol = (currency) => (currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '')

    /**
     * 领取入口按「三种状态」分栏显示：绿点能打开 / 黄红点打不开或被拦 / 灰点待检查。
     * 顺序固定，空的栏不显示 —— 旧版是混在一起按名字排，一堆死链夹在中间很难看。
     */
    const BUCKETS = [
      { key: 'ok', label: '能打开', note: '' },
      {
        key: 'dead',
        label: '打不开 / 被拦',
        note: '点不开的可以删掉；删了会留档，之后联网再搜到同一条只标「存疑」，不会自己回来。标「需代理」的是海外入口，本机出不去而已，链接本身没问题',
      },
      { key: 'idle', label: '待检查', note: '这一条还没巡检过' },
    ]

    /**
     * 线路计费方式的三种取值（「订阅」那档还能再叠一个「折算」开关）。
     * 和宿主 usage.js 的 BILLING_MODES 必须一致 —— 那边是权威，这边只负责显示文案。
     *
     *   token    按量计费：真花钱，折金额
     *   estimate 套餐 · 折算：卖的是套餐，但折一个「拿官方价买要多少钱」当参考
     *   credits  订阅 · 不折钱：只报 token 和积分；再打开折算就是「订阅 · 折算」
     */
    const BILLING_LABELS = {
      token: 'API 按量',
      estimate: '套餐 · 折算',
      credits: '订阅 · 不折钱',
      // 2.7.2：本地 CLI agent 没探到登录凭据 —— 既不算订阅也不折钱
      unknown: '未确认',
    }
    const BILLING_SHORT = {
      token: 'API 按量',
      estimate: '折算',
      credits: '订阅',
    }
    /** 「订阅划算吗」的三档结论 */
    const WORTH_VERDICTS = {
      worth: { text: '划算', tone: 'ok' },
      near: { text: '差不多', tone: 'idle' },
      light: { text: '用得少', tone: 'warn' },
    }

    const bucketOfSource = (item) => {
      if (item.reachable === true) return 'ok'
      if (item.reachable === false) return 'dead'
      return 'idle'
    }

    const fmtPrice = (value, currency) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      const text = Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000)
      return currencySymbol(currency) + text
    }

    const fmtContext = (k) => (typeof k === 'number' && k > 0 ? k + 'K' : '—')

    const priceStatusOf = (provider) => {
      if (provider.reachable === true) return { key: 'ok', text: '价格页今天能打开' }
      if (provider.reachable === false) {
        if (provider.httpStatus === 0) return { key: 'warn', text: '本机连不上价格页' }
        if (provider.httpStatus === 401 || provider.httpStatus === 403) return { key: 'warn', text: '价格页拦了自动检查' }
        return { key: 'bad', text: '价格页 HTTP ' + provider.httpStatus }
      }
      return { key: 'idle', text: '价格页待核对' }
    }

    const planStatusOf = (plan) => {
      if (plan.reachable === true) return { key: 'ok', text: '订阅页能打开' }
      if (plan.reachable === false) {
        if (plan.httpStatus === 0) return { key: 'warn', text: '本机连不上订阅页' }
        if (plan.httpStatus === 401 || plan.httpStatus === 403) return { key: 'warn', text: '订阅页拦了自动检查' }
        return { key: 'bad', text: '订阅页 HTTP ' + plan.httpStatus }
      }
      return { key: 'idle', text: '订阅页待核对' }
    }

    const planCategoryOf = (plan) =>
      plan.category === 'coding' || plan.category === 'agent-coding' ? 'coding' : 'general'

    const DOMESTIC_PROVIDER_ORDER = ['腾讯云', '阿里云', '字节', '智谱', '小米', 'MiniMax', 'Kimi']

    const vendorKey = (name) => {
      const raw = String(name || '')
      if (raw.startsWith('字节') || raw === '火山引擎') return '字节'
      if (raw === '月之暗面') return 'Kimi'
      if (raw.startsWith('腾讯')) return '腾讯云'
      if (raw.startsWith('阿里')) return '阿里云'
      if (raw.startsWith('小米')) return '小米'
      return raw
    }

    const vendorRank = (name) => {
      const index = DOMESTIC_PROVIDER_ORDER.indexOf(vendorKey(name))
      return index >= 0 ? index : 999
    }

    const periodLabel = (period) => {
      if (period === 'yearly') return '/ 年'
      if (period === 'one-time') return '一次性'
      return '/ 月'
    }

    const CSS = `
.ac-root { height: 100%; overflow-y: auto; overscroll-behavior: contain; }
.ac-page { max-width: 980px; margin: 0 auto; padding: 30px 30px 72px; color: var(--dsw-alias-label-primary, inherit); }
.ac-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
.ac-kicker { font-size: 11px; letter-spacing: .10em; font-weight: 600; text-transform: uppercase;
  color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-title { margin: 6px 0 8px; font-size: 24px; line-height: 1.2; font-weight: 650; }
.ac-sub { margin: 0; max-width: 560px; font-size: 13px; line-height: 1.7; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-actions { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 4px; }
.ac-btn { padding: 7px 13px; border-radius: 8px; font-size: 12.5px; font-family: inherit; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32));
  background: transparent; color: inherit; transition: background .15s, border-color .15s; }
.ac-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }
.ac-btn:disabled { opacity: .5; cursor: default; }
.ac-btn-primary { background: var(--dsw-alias-brand-primary, #3b82f6); border-color: var(--dsw-alias-brand-primary, #3b82f6); color: #fff; }
.ac-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary, #3b82f6); filter: brightness(1.08); }
.ac-tabs { display: inline-flex; gap: 3px; margin: 20px 0 2px; padding: 3px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.20)); }
.ac-tab { padding: 6px 15px; border: none; border-radius: 7px; background: transparent; font-family: inherit;
  font-size: 12.5px; color: var(--dsw-alias-label-secondary, #8a8f98); cursor: pointer; }
.ac-tab:hover { color: var(--dsw-alias-label-primary, inherit); }
.ac-tab[data-on] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.18)); color: var(--dsw-alias-label-primary, inherit); font-weight: 600; }
.ac-meta { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 14px; padding: 10px 13px; border-radius: 9px;
  font-size: 11.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #8a8f98);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.07));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18)); }
.ac-meta b { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.ac-note { margin-top: 10px; font-size: 11.5px; line-height: 1.6; padding: 8px 12px; border-radius: 8px;
  color: var(--dsw-alias-state-warn-primary, #c08a2e);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c08a2e) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c08a2e) 35%, transparent); }
.ac-legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 8px; padding: 0 2px;
  font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
/* 图例里的「蓝边框」样本：左边一条蓝竖条，跟订阅卡片同一套观感 */
.ac-legend-sub { color: var(--dsw-alias-brand-primary, #4d7cfe); font-weight: 600;
  padding-left: 8px; box-shadow: inset 3px 0 0 0 var(--dsw-alias-brand-primary, #4d7cfe); }
/* 订阅线路一次列出来：不用滚下去数卡片 */
.ac-sub-line { margin-top: 10px; padding: 9px 12px; border-radius: 8px; font-size: 11.5px; line-height: 1.7;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 46%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 7%, transparent);
  box-shadow: inset 3px 0 0 0 var(--dsw-alias-brand-primary, #4d7cfe);
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-sub-line b { color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-sub-line .ac-sub-name { color: var(--dsw-alias-brand-primary, #4d7cfe); font-weight: 600; }
.ac-filter { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 20px 0 6px; }
.ac-chip { padding: 5px 10px; border-radius: 999px; font-size: 11.5px; cursor: pointer; font-family: inherit;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); background: transparent; }
.ac-chip:hover { color: var(--dsw-alias-label-primary, inherit); border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.34)); }
.ac-chip[data-on] { color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16));
  border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.38)); }
.ac-search { flex: 1; min-width: 160px; max-width: 260px; padding: 6px 10px; border-radius: 8px; font-size: 12px;
  font-family: inherit; color: inherit; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08));
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
.ac-search:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #3b82f6); }
.ac-group { margin-top: 24px; }
.ac-group-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.ac-group-title { font-size: 13px; font-weight: 600; }
.ac-group-count { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-group-note { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-bucket { margin-top: 14px; }
.ac-bucket-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.ac-bucket-title { font-size: 11.5px; font-weight: 600; letter-spacing: .01em; }
.ac-bucket-title[data-bucket="ok"] { color: var(--dsw-alias-state-success-primary, #22c55e); }
.ac-bucket-title[data-bucket="dead"] { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.ac-bucket-title[data-bucket="idle"] { color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-bucket-count { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-del { flex: none; margin-left: auto; padding: 1px 5px; border-radius: 5px; cursor: pointer;
  font-size: 11px; line-height: 1.5; border: 1px solid transparent; background: transparent;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-del:hover { color: var(--dsw-alias-state-error-primary, #ef4444);
  border-color: var(--dsw-alias-state-error-primary, #ef4444); }
.ac-del:disabled { opacity: .45; cursor: default; }
.ac-removed { margin-top: 22px; padding-top: 14px; border-top: 1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
.ac-removed-head { display: flex; align-items: baseline; gap: 8px; cursor: pointer; background: none;
  border: none; padding: 0; font: inherit; color: var(--dsw-alias-label-primary, inherit); }
.ac-removed-title { font-size: 11.5px; font-weight: 600; }
.ac-removed-row { display: flex; align-items: baseline; gap: 8px; padding: 5px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12)); }
.ac-removed-row:last-child { border-bottom: none; }
.ac-removed-name { flex: 1; min-width: 0; font-size: 11.5px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.ac-removed-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); white-space: nowrap; }
.ac-suspect { color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.ac-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
.ac-card { display: flex; flex-direction: column; gap: 8px; padding: 13px 14px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.20));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); }
.ac-card:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.36)); }
.ac-card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ac-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary, #9aa0a6); }
.ac-dot[data-state="ok"] { background: var(--dsw-alias-state-success-primary, #22c55e); }
.ac-dot[data-state="warn"] { background: var(--dsw-alias-state-warn-primary, #f59e0b); }
.ac-dot[data-state="bad"] { background: var(--dsw-alias-state-error-primary, #ef4444); }
.ac-card-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-status { margin-left: auto; flex: none; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-claim { font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-card-foot { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 2px; }
.ac-tag { font-size: 10.5px; padding: 2px 7px; border-radius: 6px; color: var(--dsw-alias-label-secondary, #8a8f98);
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); }
.ac-tag-new { color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-host { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-go { margin-left: auto; flex: none; font-size: 12px; font-weight: 600; text-decoration: none;
  color: var(--dsw-alias-brand-primary, #3b82f6); }
.ac-go:hover { text-decoration: underline; }
.ac-state { margin-top: 22px; padding: 22px 18px; border-radius: 10px; text-align: center; font-size: 12.5px;
  line-height: 1.7; color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.28)); }
.ac-state[data-error] { color: var(--dsw-alias-state-error-primary, #ef4444);
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 40%, transparent); }
.ac-price-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 18px 0 4px; }
.ac-sortbar { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ac-sort-label { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-tablewrap { margin-top: 12px; overflow-x: auto; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.20));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05)); }
.ac-table { width: 100%; min-width: 660px; border-collapse: collapse; font-size: 12px; }
.ac-table th { text-align: left; padding: 10px 12px; font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
  white-space: nowrap; color: var(--dsw-alias-label-secondary, #8a8f98);
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.20)); }
.ac-table th:nth-child(2), .ac-table th:nth-child(3) { text-align: right; }
.ac-region-row td { padding: 14px 12px 4px; font-size: 10.5px; font-weight: 700; letter-spacing: .08em;
  text-transform: uppercase; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-prov-row td { padding: 8px 12px 2px; }
.ac-prov-name { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.ac-prov-status { margin-left: 8px; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-prov-note { margin-left: 8px; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-prov-tag { margin-left: 6px; vertical-align: 1px; }
.ac-prov-link { margin-left: 10px; font-size: 11px; font-weight: 500; text-decoration: none;
  color: var(--dsw-alias-brand-primary, #3b82f6); }
.ac-prov-link:hover { text-decoration: underline; }
.ac-model-row td { padding: 8px 12px; vertical-align: top;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14)); }
.ac-model-row td:nth-child(2), .ac-model-row td:nth-child(3) { text-align: right; white-space: nowrap; }
.ac-model-name { font-size: 12px; color: var(--dsw-alias-label-primary, inherit); }
.ac-model-id { margin-top: 1px; font-size: 10px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-price { font-variant-numeric: tabular-nums; font-weight: 600; }
.ac-min { margin-left: 6px; padding: 1px 5px; border-radius: 5px; font-size: 9.5px; font-weight: 600;
  color: var(--dsw-alias-state-success-primary, #22c55e);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 14%, transparent); }
.ac-price-note { font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-price-empty { margin-top: 16px; padding: 26px 18px; border-radius: 10px; text-align: center;
  font-size: 12.5px; line-height: 1.7; color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.28)); }
.ac-foot-note { margin-top: 30px; font-size: 11px; line-height: 1.7; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-inline-btn { padding: 0; border: none; background: transparent; font: inherit; cursor: pointer;
  color: var(--dsw-alias-brand-primary, #3b82f6); text-decoration: underline; }
.ac-plan { gap: 7px; }
.ac-plan-title { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-plan-price-row { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.ac-plan-price { font-size: 22px; font-weight: 650; letter-spacing: -.01em; line-height: 1.1;
  font-variant-numeric: tabular-nums; }
.ac-plan-period { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-plan-note { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-plan-quota { font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-plan-benefits { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
.ac-plan-benefits li { position: relative; padding-left: 12px; font-size: 11.5px; line-height: 1.55;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-plan-benefits li::before { content: '·'; position: absolute; left: 2px;
  color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-plan-source { margin-top: 10px; font-size: 11px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-provider-block { margin-top: 18px; }
.ac-provider-block:first-child { margin-top: 4px; }
.ac-provider-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.ac-provider-name { font-size: 13.5px; font-weight: 650; color: var(--dsw-alias-label-primary, inherit); }
.ac-provider-meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-plan-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 10px; }
.ac-dsh { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
.ac-route { padding: 13px 15px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.20));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); }
.ac-route[data-default] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 46%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 6%, transparent); }
/* 订阅线路标蓝：边框 + 左侧竖条 + 淡蓝底 —— 扫一眼就知道这台机器订了哪些套餐。
   自动判定为订阅的自动蓝，手选的也蓝（手选另有「手选」小标）。 */
.ac-route[data-billing="credits"] {
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 68%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 8%, var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)));
  box-shadow: inset 3px 0 0 0 var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-route[data-billing="credits"][data-default] {
  border-color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-route-subtag { font-size: 10px; padding: 2px 7px; border-radius: 5px; font-weight: 650;
  color: #fff; background: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-route-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ac-route-name { font-size: 13.5px; font-weight: 650; color: var(--dsw-alias-label-primary, inherit); }
.ac-route-id { font-size: 10.5px; padding: 2px 6px; border-radius: 5px; font-family: ui-monospace, monospace;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); }
.ac-route-tag { font-size: 10px; padding: 2px 6px; border-radius: 5px; font-weight: 600;
  color: var(--dsw-alias-brand-primary, #4d7cfe);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 14%, transparent); }
.ac-route-count { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-route-facts { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 7px;
  font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-route-facts code { font-family: ui-monospace, monospace; font-size: 10.5px; }
.ac-key { display: inline-flex; align-items: center; gap: 5px; }
.ac-key[data-state="ok"] { color: var(--dsw-alias-state-success-primary, #22c55e); }
.ac-key[data-state="missing"] { color: var(--dsw-alias-state-warn-primary, #c08a2e); }
/* 计费方式：一行标签 + 一组手选按钮 */
.ac-bill { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.ac-bill-label { font-size: 10.5px; font-weight: 600; letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-bill-mode { font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
.ac-bill-mode[data-mode="token"] { color: var(--dsw-alias-state-success-primary, #22c55e);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 42%, transparent); }
.ac-bill-mode[data-mode="estimate"] { color: var(--dsw-alias-brand-primary, #4d7cfe);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 42%, transparent); }
.ac-bill-mode[data-mode="credits"] { color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-bill-manual { font-size: 10px; padding: 1px 5px; border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 16%, transparent);
  color: var(--dsw-alias-brand-primary, #4d7cfe); font-weight: 600; }
.ac-bill-auto-hint { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-bill-btns { display: inline-flex; gap: 4px; flex-wrap: wrap; margin-left: auto; }
.ac-bill-btn { font-size: 10.5px; line-height: 1.5; padding: 2px 7px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06));
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-bill-btn:hover { border-color: var(--dsw-alias-brand-primary, #4d7cfe);
  color: var(--dsw-alias-brand-primary, #4d7cfe); }
/* 自动判定命中的那一档：描边高亮（不是实心），和「手选」区分开 */
.ac-bill-btn[data-auto] { font-weight: 600; color: var(--dsw-alias-brand-primary, #4d7cfe);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 52%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 7%, transparent); }
.ac-bill-btn[data-active] { font-weight: 650; color: var(--dsw-alias-brand-primary, #4d7cfe);
  border-color: var(--dsw-alias-brand-primary, #4d7cfe);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 14%, transparent); }
.ac-bill-btn:disabled { opacity: .5; cursor: default; }
/* 订阅 + 折算：折算按钮和「订阅」一起亮，标签换一档颜色（仍是订阅色系，偏亮） */
.ac-bill-btn[data-folded] { font-weight: 650; color: var(--dsw-alias-brand-primary, #4d7cfe);
  border-color: var(--dsw-alias-brand-primary, #4d7cfe);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 26%, transparent); }
.ac-bill-mode[data-folded] { color: var(--dsw-alias-brand-primary, #4d7cfe);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 60%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 10%, transparent); }
/* 折算那一行：等价金额 → 折合月 → 参考月费 → 结论 */
.ac-bill-worth-row { margin-top: 5px; padding-left: 10px;
  border-left: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 40%, transparent); }
.ac-bill-worth { font-size: 11px; color: var(--dsw-alias-label-primary, inherit); }
.ac-bill-worth b { color: var(--dsw-alias-brand-primary, #4d7cfe); font-weight: 650; }
.ac-bill-verdict { font-size: 10.5px; font-weight: 650; padding: 1px 6px; border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
.ac-bill-verdict[data-tone="ok"] { color: var(--dsw-alias-state-success-primary, #22c55e);
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 10%, transparent); }
.ac-bill-verdict[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary, #c08a2e);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c08a2e) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c08a2e) 10%, transparent); }
.ac-bill-verdict[data-tone="idle"] { color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-bill-price-wrap { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; }
.ac-bill-price-wrap::before { content: '¥'; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-bill-price { width: 84px; font-size: 10.5px; padding: 2px 6px; border-radius: 5px;
  font-family: inherit; color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); }
.ac-bill-price:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-bill-price::placeholder { color: var(--dsw-alias-label-secondary, #8a8f98); opacity: .8; }
/* 刷新时「自动判定压过手选」的说明 */
.ac-bill-notice { margin-top: 10px; padding: 8px 12px; border-radius: 8px; font-size: 11px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); }
/* 全局搜索栏：栏目切换下面那条，对当前栏即时过滤 */
.ac-globalsearch { display: flex; align-items: center; gap: 8px; margin: 16px 0 2px; }
.ac-search-global { flex: 1; max-width: 420px; }
/* 订阅详情行：订阅形式 / 订阅时间 / 本期实付，三行小表单 */
.ac-sub-detail { margin-top: 6px; padding: 9px 11px; border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 30%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 5%, transparent); }
.ac-sub-detail-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 5px; }
.ac-sub-detail-row:first-child { margin-top: 0; }
.ac-sub-detail-row .ac-bill-label { min-width: 52px; }
.ac-sub-select, .ac-sub-input { font-size: 11px; padding: 3px 7px; border-radius: 6px; font-family: inherit;
  color: var(--dsw-alias-label-primary, inherit);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.26));
  background: var(--dsw-alias-bg-layer-0, #fff); }
.ac-sub-select:focus, .ac-sub-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-sub-select:disabled, .ac-sub-input:disabled { opacity: .55; cursor: default; }
.ac-sub-input::placeholder { color: var(--dsw-alias-label-secondary, #8a8f98); opacity: .8; }
.ac-sub-price { width: 92px; }
.ac-sub-price-wrap { display: inline-flex; align-items: center; gap: 3px; }
.ac-sub-price-wrap::before { content: '¥'; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-sub-promo { flex: 1; min-width: 160px; }
.ac-sub-suggest { font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-sub-period { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-sub-period b { color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-sub-promo-hint { font-size: 10.5px; color: var(--dsw-alias-state-warn-primary, #c08a2e); }
/* 多账号徽标（2.7.1）→ 可展开按钮（2.7.2） */
.ac-route-accounts { font-size: 10px; padding: 1px 6px; border-radius: 5px; font-weight: 600; cursor: pointer;
  font-family: inherit;
  color: var(--dsw-alias-brand-primary, #4d7cfe);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 10%, transparent); }
.ac-route-accounts:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 18%, transparent); }
.ac-route-accounts[data-on] { background: var(--dsw-alias-brand-primary, #4d7cfe); color: #fff; }
/* 多账号明细面板（2.7.2） */
.ac-accounts { margin-top: 8px; padding: 9px 11px; border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 26%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 5%, transparent); }
.ac-accounts-head { font-size: 11px; margin-bottom: 6px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-accounts-head b { color: var(--dsw-alias-label-primary, inherit); }
.ac-account-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 10.5px;
  padding: 4px 0; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14)); }
.ac-account-row:first-of-type { border-top: none; }
.ac-account-row[data-current] .ac-account-name { font-weight: 650; }
.ac-account-name { min-width: 120px; }
.ac-account-member { font-size: 9.5px; padding: 1px 5px; border-radius: 4px; font-weight: 600; }
.ac-account-member[data-member="yes"] { color: var(--dsw-alias-state-ok-primary, #2e9e5b);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-ok-primary, #2e9e5b) 40%, transparent); }
.ac-account-member[data-member="no"] { color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.34)); }
.ac-account-member[data-member="unknown"] { color: var(--dsw-alias-label-secondary, #8a8f98); opacity: .7; }
.ac-account-member[data-member="expired"] { color: var(--dsw-alias-state-danger-primary, #d9534f);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-danger-primary, #d9534f) 40%, transparent); }
.ac-account-fact { color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-account-fact b { color: var(--dsw-alias-label-primary, inherit); }
.ac-account-cur { margin-left: auto; font-size: 9.5px; padding: 1px 5px; border-radius: 4px;
  color: var(--dsw-alias-brand-primary, #4d7cfe);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 12%, transparent); }
.ac-accounts-note { margin-top: 6px; font-size: 10px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #8a8f98); }
/* 本地 CLI agent 未确认（2.7.2） */
.ac-cli-note { margin-top: 6px; padding: 7px 10px; border-radius: 8px; font-size: 10.5px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px dashed var(--dsw-alias-border-l1, rgba(128,128,128,.34)); }
.ac-cli-note b { color: var(--dsw-alias-label-primary, inherit); }
/* Go 官方额度一键填（2.7.2）+ 全表检索（2.7.3） */
.ac-go-fill { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.ac-go-src { font-size: 10px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-go-table { margin-top: 7px; padding: 8px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); }
.ac-go-table-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.ac-go-table-search { flex: 1; min-width: 150px; max-width: 260px; }
.ac-go-table-rows { max-height: 320px; overflow-y: auto; }
.ac-go-table-row { display: grid; grid-template-columns: minmax(160px, 1.6fr) repeat(5, minmax(52px, .7fr));
  gap: 6px; align-items: center; font-size: 10.5px; padding: 3px 2px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12)); }
.ac-go-table-th { border-top: none; font-weight: 600; font-size: 10px;
  color: var(--dsw-alias-label-secondary, #8a8f98); position: sticky; top: 0;
  background: var(--dsw-alias-bg-layer-1, #f4f5f7); }
.ac-go-table-row[data-inroute] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 6%, transparent); }
.ac-go-table-model { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.ac-go-table-model code { font-size: 10px; }
.ac-go-inroute { font-style: normal; font-size: 9px; padding: 0 4px; border-radius: 4px;
  color: var(--dsw-alias-brand-primary, #4d7cfe);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 12%, transparent); }
.ac-go-peak { font-style: normal; font-size: 9px; padding: 0 4px; border-radius: 4px;
  color: var(--dsw-alias-state-warn-primary, #c08a2e);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c08a2e) 35%, transparent); }
.ac-go-free { color: var(--dsw-alias-state-ok-primary, #2e9e5b); font-size: 10px; }
/* 未配置线路的收起开关（2.7.1） */
.ac-unconf-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0 2px; }
.ac-unconf-note { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
/* 订阅时长 / 到期 / 折合月费（2.7.1） */
.ac-sub-term-wrap { display: inline-flex; align-items: center; gap: 4px; }
.ac-sub-term { width: 58px; }
.ac-sub-unit { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-sub-term-quick { font-size: 10px; padding: 2px 7px; }
/* 官方档位下拉 + 计费挡位标签（2.7.4） */
.ac-tier-select { max-width: 220px; }
.ac-bill-class { font-size: 9.5px; padding: 1px 6px; border-radius: 4px; font-weight: 600;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.26)); }
.ac-bill-class[data-class="monthly"] { color: var(--dsw-alias-brand-primary, #4d7cfe);
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 40%, transparent); }
.ac-bill-class[data-class="yearly"] { color: var(--dsw-alias-state-warn-primary, #c08a2e);
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c08a2e) 40%, transparent); }
.ac-sub-cur { width: 46px; padding: 3px 4px; }
.ac-sub-monthly { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-sub-monthly b { color: var(--dsw-alias-label-primary, inherit); }
.ac-sub-expire { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-sub-expire[data-soon] { color: var(--dsw-alias-state-warn-primary, #c08a2e); font-weight: 600; }
.ac-sub-expire[data-expired] { color: var(--dsw-alias-state-danger-primary, #d9534f); font-weight: 600; }
/* 额度池订阅（2.7.1） */
.ac-quota { margin-top: 7px; padding-top: 7px;
  border-top: 1px dashed color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 30%, transparent); }
.ac-quota-pools-row { align-items: flex-start; }
.ac-quota-text { flex: 1; min-width: 200px; font-family: ui-monospace, monospace; font-size: 10.5px;
  line-height: 1.6; resize: vertical; }
.ac-quota-hint { margin-top: 5px; font-size: 10px; line-height: 1.9; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-quota-hint code { margin-right: 5px; padding: 1px 4px; border-radius: 4px; font-size: 9.5px;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.10)); }
.ac-quota-calc { margin-top: 7px; padding: 8px 10px; border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06)); }
.ac-quota-calc-head { font-size: 11px; margin-bottom: 5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-quota-calc-head b { font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }
.ac-quota-calc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 10.5px; padding: 2px 0; }
.ac-quota-calc-row code { font-size: 10px; }
.ac-quota-calc-detail { color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-quota-calc-row b { margin-left: auto; }
.ac-quota-cap { font-size: 9.5px; padding: 0 4px; border-radius: 4px;
  color: var(--dsw-alias-state-warn-primary, #c08a2e);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary, #c08a2e) 40%, transparent); }
.ac-quota-note { margin-top: 5px; font-size: 10px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-models { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
.ac-model-chip { font-size: 10.5px; padding: 3px 7px; border-radius: 6px; font-family: ui-monospace, monospace;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
.ac-model-chip[data-vision]::after { content: ' · 图'; opacity: .7; }
.ac-model-more { border-style: dashed; cursor: default; }
.ac-dsh-default { padding: 12px 15px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 8%, transparent); }
.ac-dsh-default-label { font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-dsh-default-value { margin-top: 4px; font-size: 15px; font-weight: 650; }
.ac-dsh-default-meta { margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-dsh-section { margin-top: 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em;
  text-transform: uppercase; color: var(--dsw-alias-label-secondary, #8a8f98); }

/* ---- 用量花费 ---- */
.ac-spend { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;
  margin-top: 14px; }
.ac-spend-card { padding: 12px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, #e6e8ec);
  background: var(--dsw-alias-bg-l1, #fff); }
.ac-spend-card[data-accent] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 5%, var(--dsw-alias-bg-l1, #fff)); }
.ac-spend-label { font-size: 10.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-spend-value { margin-top: 5px; font-size: 21px; font-weight: 680; font-variant-numeric: tabular-nums;
  line-height: 1.15; }
.ac-spend-unit { margin-left: 2px; font-size: 12px; font-weight: 550; opacity: .62; }
.ac-spend-sub { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }

.ac-usage { display: flex; flex-direction: column; gap: 9px; margin-top: 12px; }
.ac-usage-row { padding: 12px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, #e6e8ec);
  background: var(--dsw-alias-bg-l1, #fff); }
.ac-usage-row[data-unpriced] { border-style: dashed; }
/* 套餐渠道的等价金额：虚线左边框 + 浅色金额，视觉上跟「真花钱」区分开 */
.ac-usage-row[data-billing="estimate"] { border-left: 3px dashed color-mix(in srgb, var(--dsw-alias-warning-primary, #e6a23c) 60%, transparent); }
.ac-usage-row[data-billing="estimate"] .ac-usage-cost { font-size: 13px; font-weight: 620;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-usage-tag { font-size: 9.5px; padding: 1px 5px; border-radius: 4px; font-weight: 600;
  white-space: nowrap; color: color-mix(in srgb, var(--dsw-alias-warning-primary, #e6a23c) 88%, #000);
  background: color-mix(in srgb, var(--dsw-alias-warning-primary, #e6a23c) 16%, transparent); }
.ac-usage-row[data-billing="credits"] { border-left: 3px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 42%, transparent); }
.ac-usage-row[data-billing="credits"] .ac-usage-cost { font-size: 13px; font-weight: 620;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
/* 订阅线路里的模型明细：token 占比，不挂积分 */
.ac-credit-models { display: flex; flex-direction: column; gap: 3px; margin-top: 9px;
  padding-top: 9px; border-top: 1px dashed var(--dsw-alias-border-l2, #e6e8ec); }
.ac-credit-model { display: grid; grid-template-columns: minmax(90px, 1.4fr) minmax(50px, 2fr) 42px 62px 52px;
  align-items: center; gap: 8px; font-size: 10.5px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-credit-model-name { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace);
  font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-credit-model-bar { height: 3px; border-radius: 2px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16)); }
.ac-credit-model-bar i { display: block; height: 100%; border-radius: 2px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 58%, transparent); }
.ac-credit-model-pct { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit); }
.ac-credit-model-tokens { text-align: right; font-variant-numeric: tabular-nums; }
.ac-credit-model-calls { text-align: right; font-variant-numeric: tabular-nums; opacity: .78; }
.ac-usage-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ac-usage-provider { font-size: 13px; font-weight: 650; }
.ac-usage-model { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-usage-cost { margin-left: auto; font-size: 15px; font-weight: 680; font-variant-numeric: tabular-nums; }
.ac-usage-cost[data-unpriced] { font-size: 11.5px; font-weight: 550; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-usage-facts { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 7px; font-size: 11px;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-usage-facts b { font-weight: 620; color: var(--dsw-alias-label-primary, #1a1d21);
  font-variant-numeric: tabular-nums; }
.ac-usage-bar { height: 3px; margin-top: 9px; border-radius: 2px; overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 16%, transparent); }
.ac-usage-bar i { display: block; height: 100%; border-radius: 2px;
  background: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-usage-note { margin-top: 6px; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
/* 峰谷拆分：左高峰 / 中条 / 右空闲 */
.ac-peakbar { display: flex; align-items: center; gap: 8px; margin-top: 8px;
  font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-peakbar-label { white-space: nowrap; font-variant-numeric: tabular-nums; }
.ac-peakbar-label b { font-weight: 620; color: var(--dsw-alias-label-primary, #1a1d21); }
.ac-peakbar-track { flex: 1; min-width: 40px; height: 4px; border-radius: 2px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16)); }
.ac-peakbar-track i { display: block; height: 100%; border-radius: 2px;
  background: color-mix(in srgb, var(--dsw-alias-warning-primary, #e6a23c) 72%, transparent); }

.ac-days { display: flex; flex-direction: column; gap: 2px; margin-top: 10px; }
.ac-day { display: flex; align-items: center; gap: 10px; padding: 5px 2px; font-size: 11.5px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, #f0f1f4); }
.ac-day:last-child { border-bottom: none; }
.ac-day-date { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-day-bar { flex: 1; height: 5px; border-radius: 3px; overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 12%, transparent); }
.ac-day-bar i { display: block; height: 100%; border-radius: 3px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 78%, transparent); }
.ac-day-cost { min-width: 66px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
.ac-day-actual { min-width: 66px; font-weight: 600;
  color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 72%, var(--dsw-alias-label-primary, #1a1d21)); }
.ac-day-gap { min-width: 52px; text-align: right; font-variant-numeric: tabular-nums;
  font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-day-gap[data-big] { color: color-mix(in srgb, var(--dsw-alias-warning-primary, #e6a23c) 92%, #000);
  font-weight: 700; }
/* 官方账单里每个 API key 一行 */
.ac-keyrow { padding: 10px 13px; border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2, #e6e8ec);
  border-left: 3px solid color-mix(in srgb, var(--dsw-alias-success-primary, #3ecf8e) 55%, transparent);
  background: var(--dsw-alias-bg-l1, #fff); }
.ac-keyrow-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ac-keyrow-cost { margin-left: auto; font-size: 14px; font-weight: 680; font-variant-numeric: tabular-nums; }
/* 官方账单 vs 折算：并排给出差额，省得用户自己算 */
.ac-offcmp { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; padding-top: 8px;
  border-top: 1px dashed var(--dsw-alias-border-l2, #e6e8ec);
  font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-offcmp-item { font-variant-numeric: tabular-nums; }
.ac-offcmp-item b { font-weight: 620; color: var(--dsw-alias-label-primary, #1a1d21); }
.ac-offcmp-sub { opacity: .78; }
.ac-offcmp-gap { color: color-mix(in srgb, var(--dsw-alias-success-primary, #3ecf8e) 88%, #000); font-weight: 600; }
.ac-offcmp-gap[data-big] { color: color-mix(in srgb, var(--dsw-alias-warning-primary, #e6a23c) 92%, #000); }
.ac-daylegend { display: flex; gap: 10px; justify-content: flex-end; margin-top: 6px;
  padding-right: 2px; font-size: 10px; letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-daylegend span { min-width: 66px; text-align: right; }
.ac-day-tokens { min-width: 62px; text-align: right; color: var(--dsw-alias-label-secondary, #8a8f98);
  font-variant-numeric: tabular-nums; }
.ac-caveat { margin-top: 14px; padding: 11px 13px; border-radius: 10px; font-size: 11px; line-height: 1.65;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  background: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 6%, transparent); }
.ac-caveat b { color: var(--dsw-alias-label-primary, #1a1d21); font-weight: 620; }
/* ---- 「订阅划算吗」：等价月费 vs 参考月费 ---- */
.ac-worth { margin-top: 16px; padding: 12px 14px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 38%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 5%, transparent); }
.ac-worth-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.ac-worth-title { font-size: 12px; font-weight: 650; color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-worth-meta { font-size: 10.5px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-worth-rows { display: flex; flex-direction: column; gap: 6px; }
.ac-worth-row { display: flex; flex-direction: column; gap: 6px; font-size: 11px;
  padding: 5px 8px; border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.05)); }
.ac-worth-main { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.ac-worth-row[data-expandable] .ac-worth-main { cursor: pointer; }
.ac-worth-row[data-open] { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 7%, transparent); }
.ac-worth-row[data-open] .ac-caret { color: var(--dsw-alias-brand-primary, #4d7cfe); opacity: 1; }
.ac-worth-toggle { font-size: 10px; color: var(--dsw-alias-brand-primary, #4d7cfe); opacity: .82; }
/* ---- 折算明细（点开才出现）---- */
.ac-worth-detail { display: flex; flex-direction: column; gap: 8px; margin-top: 2px;
  padding: 9px 11px 10px; border-radius: 8px;
  border-left: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 42%, transparent);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.04)); }
.ac-worth-detail-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  font-size: 10.5px; font-weight: 620; letter-spacing: .02em;
  color: var(--dsw-alias-label-primary, inherit); }
.ac-worth-detail-sub { font-size: 10px; font-weight: 500; letter-spacing: 0;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-worth-empty { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-worth-models { display: flex; flex-direction: column; gap: 3px; }
.ac-worth-model { display: grid;
  grid-template-columns: minmax(110px, 1.5fr) minmax(40px, 2fr) 58px 66px 72px minmax(150px, 3fr);
  align-items: center; gap: 8px; font-size: 10.5px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-worth-model-name { font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 10.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-primary, inherit); }
.ac-worth-model-bar { height: 3px; border-radius: 2px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.16)); }
.ac-worth-model-bar i { display: block; height: 100%; border-radius: 2px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 58%, transparent); }
.ac-worth-model-tokens { text-align: right; font-variant-numeric: tabular-nums; }
.ac-worth-model-cost { text-align: right; font-variant-numeric: tabular-nums; font-weight: 620;
  color: var(--dsw-alias-label-primary, inherit); }
.ac-worth-model-month { text-align: right; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-worth-model-price { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ac-worth-model-price[data-unpriced] { color: var(--dsw-alias-state-warn-primary, #c08a2e); }
.ac-worth-days { display: flex; flex-direction: column; gap: 2px; }
.ac-worth-day { display: flex; align-items: center; gap: 8px; font-size: 10.5px;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-worth-day-date { min-width: 78px; font-variant-numeric: tabular-nums; }
.ac-worth-day-bar { flex: 1; min-width: 40px; height: 4px; border-radius: 2px; overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 12%, transparent); }
.ac-worth-day-bar i { display: block; height: 100%; border-radius: 2px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 72%, transparent); }
.ac-worth-day-cost { min-width: 62px; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600;
  color: var(--dsw-alias-label-primary, inherit); }
.ac-worth-day-tokens { min-width: 96px; text-align: right; font-variant-numeric: tabular-nums; }
.ac-worth-refbox { display: flex; flex-direction: column; gap: 4px; }
.ac-worth-plans { display: flex; flex-wrap: wrap; gap: 6px; font-size: 10.5px;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-worth-plan { padding: 2px 7px; border-radius: 5px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
.ac-worth-plan b { color: var(--dsw-alias-brand-primary, #4d7cfe); font-weight: 650; }
/* 订阅卡上那行「折合月」也能点开明细 */
.ac-worth-inline { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.ac-worth-inline:hover { color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-worth-inline[data-open] { color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-worth-name { font-weight: 620; color: var(--dsw-alias-label-primary, inherit); min-width: 120px; }
.ac-worth-num { color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-worth-num b { color: var(--dsw-alias-brand-primary, #4d7cfe); font-weight: 650; font-size: 12.5px; }
.ac-worth-ref { color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-worth-tokens { margin-left: auto; color: var(--dsw-alias-label-secondary, #8a8f98); }
/* ---- 时间轴（按会话分段）---- */
.ac-usage-row[data-expandable] .ac-usage-head { cursor: pointer; }
.ac-caret { font-size: 9px; line-height: 1; opacity: .5; width: 9px; flex: none;
  transition: opacity .15s; }
.ac-usage-row[data-expandable]:hover .ac-caret { opacity: 1; }
.ac-usage-row[data-open] .ac-caret { opacity: 1;
  color: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-usage-row[data-open] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 38%, transparent); }

.ac-tl { margin-top: 10px; padding-top: 10px;
  border-top: 1px dashed var(--dsw-alias-border-l2, #e6e8ec); }
.ac-tl-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; font-weight: 600;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-tl-sub { font-size: 10px; font-weight: 500; text-transform: none;
  letter-spacing: 0; opacity: .8; }
.ac-tl-axis { position: relative; height: 13px; margin: 8px 0 2px;
  /* 右边留出总计那一列的宽度，轴才不会跑到柱子底下 */
  margin-right: 52px; }
.ac-tl-tick { position: absolute; top: 0; font-size: 9.5px; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #8a8f98); font-variant-numeric: tabular-nums; }
.ac-tl-rows { display: flex; flex-direction: column; gap: 1px; }
.ac-tl-row { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
.ac-tl-row:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 5%, transparent); }
.ac-tl-name { display: flex; align-items: center; flex: 0 0 34%; max-width: 34%;
  min-width: 0; font-size: 10.5px; line-height: 1.5; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-tl-indent { flex: none; display: inline-block; }
.ac-tl-track { position: relative; flex: 1; min-width: 40px; height: 20px;
  border-radius: 4px; overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 7%, transparent); }
/* 会话活跃区间：淡淡一条底线 */
.ac-tl-span { position: absolute; bottom: 0; height: 2px; border-radius: 1px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 26%, transparent); }
.ac-tl-bar { position: absolute; bottom: 2px; min-width: 1px; border-radius: 1px 1px 0 0;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d7cfe) 78%, transparent);
  transition: background .12s; }
.ac-tl-bar:hover { background: var(--dsw-alias-brand-primary, #4d7cfe); }
.ac-tl-total { flex: 0 0 46px; text-align: right; font-size: 10.5px; font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #1a1d21); }
.ac-tl-foot { margin-top: 8px; font-size: 10px; line-height: 1.55;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-tl-empty { font-size: 11px; padding: 10px 0;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
/* 导入官方账单 */
.ac-import { margin-top: 10px; padding: 11px 13px; border-radius: 10px;
  border: 1px dashed var(--dsw-alias-border-l2, #e6e8ec);
  background: color-mix(in srgb, var(--dsw-alias-label-secondary, #8a8f98) 4%, transparent); }
.ac-import[data-havedata] { margin-top: 8px; padding: 8px 11px; }
.ac-import-text { font-size: 11px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-import-actions { margin-top: 8px; display: flex; gap: 8px; }
.ac-import-note { margin-top: 7px; font-size: 10.5px; line-height: 1.55;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
.ac-import-note[data-ok] { color: color-mix(in srgb, var(--dsw-alias-success-primary, #3ecf8e) 90%, #000); }
.ac-import-note[data-err] { color: color-mix(in srgb, var(--dsw-alias-danger-primary, #e5484d) 92%, #000); }
.ac-import-steps { margin: 8px 0 0; padding-left: 18px; font-size: 10.5px; line-height: 1.7;
  color: var(--dsw-alias-label-secondary, #8a8f98); }
/* 首屏用缓存时的细提示条 */
.ac-stale { display: flex; align-items: center; gap: 7px; margin: 0 0 10px;
  padding: 7px 12px; border-radius: 9px; font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  background: color-mix(in srgb, var(--dsw-alias-warning-primary, #e6a23c) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dsw-alias-warning-primary, #e6a23c) 32%, transparent); }
.ac-stale-dot { width: 6px; height: 6px; border-radius: 50%; flex: none;
  background: var(--dsw-alias-warning-primary, #e6a23c);
  animation: ac-stale-pulse 1.2s ease-in-out infinite; }
@keyframes ac-stale-pulse { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
`

    // ---------------------------------------------------------------- 图标

    // 跟左侧栏其它栏目一样的单色线框图标（继承当前文字颜色）
    function EggIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', {
          d: 'M12 3.1c3.5 0 6.3 4.7 6.3 8.8 0 3.9-2.8 6.9-6.3 6.9s-6.3-3-6.3-6.9c0-4.1 2.8-8.8 6.3-8.8Z',
        }),
        h('path', {
          d: 'M19.4 2.9l.5 1.15 1.15.5-1.15.5-.5 1.15-.5-1.15-1.15-.5 1.15-.5.5-1.15Z',
          fill: 'currentColor',
          stroke: 'none',
        }),
      )
    }

    // ---------------------------------------------------------------- 页面

    function CreditsPage() {
      // 首屏先用上次的快照，点进来立刻有内容；随后 load() 静默刷新覆盖它
      const [data, setData] = React.useState(() => readSnapshot())
      const [error, setError] = React.useState(null)
      const [pending, setPending] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [category, setCategory] = React.useState('all')
      const [view, setView] = React.useState('credits')
      const [priceRegion, setPriceRegion] = React.useState('all')
      const [priceSort, setPriceSort] = React.useState('input')
      const [planRegion, setPlanRegion] = React.useState('all')
      // 用量的时间范围：今天 / 近 7 天 / 近 30 天
      const [usageWindow, setUsageWindow] = React.useState('month')
      // 接入栏：要不要把「本机还没配起来」的线路也显示出来（默认收起，2.7.1）
      const [showUnconfigured, setShowUnconfigured] = React.useState(false)
      // 多账号明细展开的线路 id（2.7.2）：null = 都收着
      const [accountsOpen, setAccountsOpen] = React.useState(null)
      // Go 官方额度全表展开 + 表内检索词（2.7.3）
      const [goTableOpen, setGoTableOpen] = React.useState(false)
      const [goTableQuery, setGoTableQuery] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const suffix = usageWindow === 'month' ? '' : '?window=' + usageWindow
          const response = await fetch(API + '/list' + suffix, { cache: 'no-store', credentials: 'same-origin' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const payload = await response.json()
          if (payload && payload.ok === false) throw new Error(payload.error || '读取失败')
          // 订阅线路的积分余额由页面同源去问各连接器，宿主问不了自己
          const balances = await fetchCreditBalances()
          const next =
            payload && payload.usage
              ? { ...payload, usage: { ...payload.usage, creditBalances: balances } }
              : payload
          setData(next)
          setError(null)
          setFresh(true)
          // 落一份首屏快照 —— 下次点进这一栏先把上次的数立刻画出来，再静默刷新
          saveSnapshot(next)
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        }
      }, [usageWindow])

      /**
       * 删掉一条入口。宿主会留档：种子不会被补回来，联网再搜到同一条只记「存疑」。
       * 不弹确认框 —— 删错了下面「已删除」面板里一点就能恢复。
       */
      const removeEntry = React.useCallback(
        async (item) => {
          const key = item.url || item.id
          setMutating(key)
          setMutateError(null)
          try {
            const response = await fetch(API + '/remove', {
              method: 'POST',
              cache: 'no-store',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: item.id, url: item.url }),
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok || !payload || payload.ok === false) {
              throw new Error((payload && payload.error) || 'HTTP ' + response.status)
            }
            await load()
          } catch (failure) {
            setMutateError('删不掉：' + String((failure && failure.message) || failure))
          } finally {
            setMutating(null)
          }
        },
        [load],
      )

      const restoreEntry = React.useCallback(
        async (entry) => {
          const key = entry.url
          setMutating(key)
          setMutateError(null)
          try {
            const response = await fetch(API + '/restore', {
              method: 'POST',
              cache: 'no-store',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ url: entry.url }),
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok || !payload || payload.ok === false) {
              throw new Error((payload && payload.error) || 'HTTP ' + response.status)
            }
            await load()
          } catch (failure) {
            setMutateError('恢复不了：' + String((failure && failure.message) || failure))
          } finally {
            setMutating(null)
          }
        },
        [load],
      )

      /**
       * 把选中的文件传给宿主，由它写进 $DSH_HOME/ai-credits/official-usage/。
       *
       * 浏览器沙箱写不了那个目录，宿主进程可以 —— 所以走一次 base64 上传。
       * 官方导出是 zip，宿主自己解；已经解压过的 csv 直接单选也行。
       */
      const doImport = React.useCallback(
        async (fileList) => {
          const files = Array.from(fileList || [])
          if (files.length === 0) return
          setImportState({ busy: true, name: files.map((f) => f.name).join('、') })
          try {
            let total = 0
            const written = []
            for (const file of files) {
              const buffer = await file.arrayBuffer()
              const bytes = new Uint8Array(buffer)
              // 分块转字符，避免 apply 参数过多爆栈
              let binary = ''
              const CHUNK = 0x8000
              for (let i = 0; i < bytes.length; i += CHUNK) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
              }
              const data = window.btoa(binary)

              const response = await fetch(API + '/official-import', {
                method: 'POST',
                cache: 'no-store',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: file.name, data }),
              })
              const payload = await response.json().catch(() => null)
              if (!response.ok || !payload || payload.ok === false) {
                throw new Error((payload && payload.error) || 'HTTP ' + response.status)
              }
              total += 1
              for (const name of payload.written || []) written.push(name)
            }
            setImportState({ ok: true, count: total, written })
            // 导进去以后立刻重读一遍，让页面上的数字变掉
            await load()
          } catch (failure) {
            setImportState({ error: String((failure && failure.message) || failure) })
          }
        },
        [load],
      )

      /** 导入区：没数据时是引导，有数据时是一个小「重新导入」 */
      const importPanel = (haveData) => {
        const busy = importState !== null && importState.busy === true
        return h(
          'div',
          { className: 'ac-import', 'data-havedata': haveData ? '' : undefined },
          h(
            'div',
            { className: 'ac-import-text' },
            haveData
              ? '换个时间段的导出，直接盖在旧文件上（同名覆盖）。'
              : '页面上没有官方账单 —— 需要从 DeepSeek 开放平台导出一份用量，在这里导入。',
          ),
          h(
            'div',
            { className: 'ac-import-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'ac-btn' + (haveData ? '' : ' ac-btn-primary'),
                disabled: busy,
                onClick: () => {
                  if (importInputRef.current !== null) importInputRef.current.click()
                },
              },
              busy
                ? '导入中…'
                : haveData
                  ? '重新导入'
                  : '导入官方账单（.zip / .csv）',
            ),
            h('input', {
              ref: importInputRef,
              type: 'file',
              accept: '.zip,.csv,application/zip,text/csv',
              multiple: true,
              style: { display: 'none' },
              onChange: (event) => {
                const picked = event.target.files
                doImport(picked)
                // 清空，这样同一个文件能再选一次
                event.target.value = ''
              },
            }),
          ),
          importState !== null && importState.busy === true
            ? h('div', { className: 'ac-import-note' }, '正在读取 ' + importState.name + ' …')
            : null,
          importState !== null && importState.ok === true
            ? h(
                'div',
                { className: 'ac-import-note', 'data-ok': '' },
                '导入成功，写入 ' +
                  importState.written.length +
                  ' 个文件：' +
                  importState.written.join('、'),
              )
            : null,
          importState !== null && importState.error !== undefined
            ? h('div', { className: 'ac-import-note', 'data-err': '' }, '导入失败：' + importState.error)
            : null,
          haveData
            ? null
            : h(
                'ol',
                { className: 'ac-import-steps' },
                h('li', null, '打开 platform.deepseek.com → 用量 / 账单，选好时间段后导出'),
                h('li', null, '直接选那个 .zip，不用解压（也可以选解压后的 .csv）'),
                h('li', null, '导入后这张卡会显示官方总额，并能按 API key 逐条对账'),
              ),
        )
      }

      React.useEffect(() => {
        let alive = true
        const run = () => {
          if (alive) load()
        }
        run()
        const timer = window.setInterval(run, 60000)
        return () => {
          alive = false
          window.clearInterval(timer)
        }
      }, [load])

      const running = !!(data && data.running)

      // 首屏是快照 → 后台那次真实请求回来之前，给个轻提示，别让人以为数字是新的
      const [fresh, setFresh] = React.useState(false)
      // 点开的用量渠道（null = 都收起）。存 provider 名，时间轴按它取数据
      const [expanded, setExpanded] = React.useState(null)
      // 导入官方账单的进度：null | { busy, name } | { ok, written } | { error }
      const [importState, setImportState] = React.useState(null)
      const importInputRef = React.useRef(null)
      // 正在删 / 恢复的那一条（按 url 记，卡片上按钮显示 … 并禁用）
      const [mutating, setMutating] = React.useState(null)
      // 删除 / 恢复失败时的提示，点别的就清掉
      const [mutateError, setMutateError] = React.useState(null)
      // 「已删除」面板展开状态
      const [removedOpen, setRemovedOpen] = React.useState(false)
      // 正在改计费方式的那条线路（provider id），按钮显示 … 并禁用
      const [billingBusy, setBillingBusy] = React.useState(null)
      // 刷新时自动判定压过手选的说明（点「重新读」才会出现，几秒后自己淡出）
      const [billingNotice, setBillingNotice] = React.useState(null)
      const isSnapshot = data !== null && !fresh

      // 宿主在巡检 → 每 2.2 秒问一次，跑完自己就停
      React.useEffect(() => {
        if (!running) {
          if (data !== null) setPending(null)
          return undefined
        }
        const timer = window.setTimeout(() => load(), 2200)
        return () => window.clearTimeout(timer)
      }, [running, data, load])

      const doRefresh = React.useCallback(
        async (withSearch, pricesOnly) => {
          setPending(withSearch ? 'search' : pricesOnly ? 'prices' : 'check')
          try {
            const response = await fetch(API + '/refresh', {
              method: 'POST',
              cache: 'no-store',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                search: withSearch === true,
                pricesOnly: pricesOnly === true,
              }),
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok || !payload || payload.ok === false) {
              throw new Error((payload && payload.error) || 'HTTP ' + response.status)
            }
            setError(null)
            await load()
          } catch (failure) {
            setError(String((failure && failure.message) || failure))
            setPending(null)
          }
        },
        [load],
      )

      // 「本机接入」单独重读：宿主那边对线路清单有 30 秒缓存，这个口会强制重新问一遍。
      // 带 window 就是切时间范围（今天 / 近 7 天 / 近 30 天）。
      // 带 refresh=true（「重新读」按钮）时，宿主还会把「自动判定是订阅、却被手选成
      // 别的口径」的线路退回订阅 —— 白名单那几家套餐制是确定的，别让它凭空多出花费。
      const reloadDsh = React.useCallback(async (windowKey, hardRefresh) => {
        setPending('dsh')
        try {
          const parts = []
          if (typeof windowKey === 'string' && windowKey !== '') parts.push('window=' + encodeURIComponent(windowKey))
          if (hardRefresh === true) parts.push('refresh=1')
          const suffix = parts.length > 0 ? '?' + parts.join('&') : ''
          const response = await fetch(API + '/dsh' + suffix, { cache: 'no-store', credentials: 'same-origin' })
          const payload = await response.json().catch(() => null)
          if (!response.ok || !payload || payload.ok === false) {
            throw new Error((payload && payload.error) || 'HTTP ' + response.status)
          }
          // 订阅线路的积分余额由浏览器这边同源去问各连接器 —— 宿主管不到自己的端口，
          // 前端本来就是同源，直接问最省事。拿不到就算了，不影响用量数字。
          const balances = await fetchCreditBalances()
          setData((prev) => {
            if (prev === null) return prev
            const nextUsage =
              payload.usage === undefined || payload.usage === null
                ? prev.usage
                : { ...payload.usage, creditBalances: balances }
            return {
              ...prev,
              dshApi: payload.dshApi,
              usage: nextUsage,
              // 「重新读」也带回 Go 官方额度表（2.7.3）
              opencodeGo: payload.opencodeGo !== undefined ? payload.opencodeGo : prev.opencodeGo,
            }
          })
          // 刷新时宿主可能把几条手选的口径退回订阅了 —— 说出来，别让人以为点坏了
          const cleared =
            payload.billingRefresh && Array.isArray(payload.billingRefresh.cleared)
              ? payload.billingRefresh.cleared
              : []
          if (cleared.length > 0) {
            setBillingNotice(
              '刷新时把 ' +
                String(cleared.length) +
                ' 条退回自动判定（自动判定是订阅，白名单比手选可信）：' +
                cleared.join('、'),
            )
          } else if (hardRefresh === true) {
            setBillingNotice('刷新过了：自动判定是订阅的线路都按订阅口径算')
          }
          setError(null)
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
        } finally {
          setPending(null)
        }
      }, [])

      /**
       * 手动指定一条线路的计费方式。
       *
       * patch 只带要改的字段（宿主那边也是「传了才改」）：
       *   { mode }                 'token' | 'estimate' | 'credits' | null（null = 退回自动）
       *   { estimate }             订阅线路的「折算」开关，跟 mode 独立
       *   { monthlyCNY }           你实际付的月费，跟等价月费比；null = 清掉
       * 改完立刻重读 —— 用量栏的金额分类跟着变，不重读会前后不一致。
       */
      const setBilling = React.useCallback(
        async (provider, patch) => {
          setBillingBusy(provider)
          setMutateError(null)
          setBillingNotice(null)
          try {
            const response = await fetch(API + '/billing', {
              method: 'POST',
              cache: 'no-store',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ provider, ...patch }),
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok || !payload || payload.ok === false) {
              throw new Error((payload && payload.error) || 'HTTP ' + response.status)
            }
            await reloadDsh()
          } catch (failure) {
            setMutateError('改不了计费方式：' + String((failure && failure.message) || failure))
          } finally {
            setBillingBusy(null)
          }
        },
        [reloadDsh],
      )

      const sources = data && Array.isArray(data.sources) ? data.sources : []
      const counts = (data && data.counts) || { total: 0, reachable: 0, unreachable: 0, candidates: 0 }

      const categories = React.useMemo(() => {
        const present = new Set(sources.map((item) => item.category))
        const ordered = CATEGORY_ORDER.filter((name) => present.has(name))
        for (const name of present) if (!ordered.includes(name)) ordered.push(name)
        return ordered
      }, [sources])

      const filtered = React.useMemo(() => {
        const needle = query.trim().toLowerCase()
        return sources.filter((item) => {
          if (category !== 'all' && item.category !== category) return false
          if (needle === '') return true
          return [item.title, item.claim, item.url, (item.tags || []).join(' ')]
            .join(' ')
            .toLowerCase()
            .includes(needle)
        })
      }, [sources, category, query])

      const groups = React.useMemo(() => {
        const out = []
        for (const name of categories) {
          const rows = filtered.filter((item) => item.category === name)
          if (rows.length > 0) out.push({ name, rows })
        }
        if (category !== 'all') {
          return out.filter((group) => group.name === category)
        }
        // 「每日新发现」放最后：它是候选页，先看能直接领的官方入口
        const fresh = out.find((group) => group.name === '每日新发现')
        if (fresh === undefined) return out
        return [...out.filter((group) => group.name !== '每日新发现'), fresh]
      }, [categories, filtered, category])

      const searching = data && data.search && data.search.error ? data.search.error : null

      // ------------------------------------------------------------ 价格栏数据

      const priceData = data && data.prices ? data.prices : null
      const priceProviders = priceData && Array.isArray(priceData.providers) ? priceData.providers : []

      const priceRegions = React.useMemo(() => {
        const present = new Set(priceProviders.map((item) => item.region))
        const out = REGION_ORDER.filter((name) => present.has(name))
        for (const name of present) if (!out.includes(name)) out.push(name)
        return out
      }, [priceProviders])

      const priceGroups = React.useMemo(() => {
        const regions = priceRegions.filter((name) => priceRegion === 'all' || name === priceRegion)
        const sortKey = priceSort
        const out = []
        for (const name of regions) {
          // 同一区域里可能混着人民币 / 美元标价的厂商，按币种再分一组，
          // 否则「最低」和按价格排序会把两种货币的数字放在一起比。
          const inRegion = priceProviders.filter((item) => item.region === name)
          const currencies = Array.from(new Set(inRegion.map((item) => item.currency)))
          for (const currency of currencies) {
            const entries = inRegion
              .filter((item) => item.currency === currency)
              .map((provider) => {
                const models = (Array.isArray(provider.models) ? provider.models : []).slice().sort((a, b) => {
                  if (sortKey === 'name') return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
                  const av = typeof a[sortKey] === 'number' ? a[sortKey] : Infinity
                  const bv = typeof b[sortKey] === 'number' ? b[sortKey] : Infinity
                  if (av !== bv) return av - bv
                  return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
                })
                return { provider, models }
              })
            entries.sort((a, b) => {
              if (sortKey === 'name') {
                return String(a.provider.title || '').localeCompare(String(b.provider.title || ''), 'zh-Hans-CN')
              }
              const av = a.models.length > 0 && typeof a.models[0][sortKey] === 'number' ? a.models[0][sortKey] : Infinity
              const bv = b.models.length > 0 && typeof b.models[0][sortKey] === 'number' ? b.models[0][sortKey] : Infinity
              return av - bv
            })
            const inputs = entries.flatMap((entry) => entry.models.map((model) => model.input)).filter((v) => typeof v === 'number')
            const outputs = entries.flatMap((entry) => entry.models.map((model) => model.output)).filter((v) => typeof v === 'number')
            out.push({
              key: name + '/' + currency,
              name,
              currency,
              label: name + ' · ' + (currency === 'CNY' ? '人民币' : currency === 'USD' ? '美元' : currency),
              entries,
              minInput: inputs.length > 1 ? Math.min(...inputs) : null,
              minOutput: outputs.length > 1 ? Math.min(...outputs) : null,
            })
          }
        }
        return out
      }, [priceProviders, priceRegions, priceRegion, priceSort])

      // 价格栏的全局搜索：按厂商名 / 模型名 / 模型 id / 备注过滤，命中的模型行留下，
      // 厂商整名命中就整个厂商留下；过滤后空组不显示
      const filteredPriceGroups = React.useMemo(() => {
        const n = query.trim().toLowerCase()
        if (n === '') return priceGroups
        return priceGroups
          .map((group) => ({
            ...group,
            entries: group.entries
              .map((entry) => {
                const providerHit = [entry.provider.title, entry.provider.note || '']
                  .join(' ')
                  .toLowerCase()
                  .includes(n)
                const models = providerHit
                  ? entry.models
                  : entry.models.filter((model) =>
                      [model.name, model.id, model.note || ''].join(' ').toLowerCase().includes(n),
                    )
                return models.length > 0 ? { ...entry, models } : null
              })
              .filter(Boolean),
          }))
          .filter((group) => group.entries.length > 0)
      }, [priceGroups, query])

      const priceStaleDays = priceData ? daysSince(priceData.snapshotAt) : null

      // ------------------------------------------------------------ 订阅数据（通用 / 编程工具）

      const planData = data && data.plans ? data.plans : null
      const planItems = planData && Array.isArray(planData.items) ? planData.items : []
      const planSource = planData && planData.source ? planData.source : null
      const planCategory = view === 'coding' ? 'coding' : 'general'
      const visiblePlans = planItems.filter((item) => planCategoryOf(item) === planCategory)

      // 订阅栏的全局搜索：按套餐名 / 厂商 / 额度 / 权益 / 备注过滤
      const filteredPlans = React.useMemo(() => {
        const n = query.trim().toLowerCase()
        if (n === '') return visiblePlans
        return visiblePlans.filter((plan) =>
          [plan.title, plan.provider, plan.quota || '', plan.priceNote || '', plan.note || '', (plan.benefits || []).join(' ')]
            .join(' ')
            .toLowerCase()
            .includes(n),
        )
      }, [visiblePlans, query])

      const planRegions = React.useMemo(() => {
        const present = new Set(filteredPlans.map((item) => item.region))
        const out = REGION_ORDER.filter((name) => present.has(name))
        for (const name of present) if (!out.includes(name)) out.push(name)
        return out
      }, [filteredPlans])

      const planGroups = React.useMemo(() => {
        const regions = planRegions.filter((name) => planRegion === 'all' || name === planRegion)
        const out = []
        for (const name of regions) {
          const rows = filteredPlans.filter((item) => item.region === name)
          // 只按厂商分组、不按币种拆组，保证厂商顺序固定；同一家内按价格从低到高
          const byProvider = new Map()
          for (const plan of rows) {
            const key = plan.provider || '其他'
            if (!byProvider.has(key)) byProvider.set(key, [])
            byProvider.get(key).push(plan)
          }
          const providers = Array.from(byProvider.entries()).map(([provider, plans]) => {
            const sorted = plans.slice().sort((a, b) => {
              const av = typeof a.price === 'number' ? a.price : Infinity
              const bv = typeof b.price === 'number' ? b.price : Infinity
              return av - bv || String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN')
            })
            return { provider, plans: sorted }
          })
          providers.sort((a, b) => {
            // 国内按固定厂商顺序（腾讯 → 阿里 → 字节 → 智谱 → 小米 → MiniMax → Kimi），
            // 国外按厂商名首字母排序
            if (name === '国内') {
              const ar = vendorRank(a.provider)
              const br = vendorRank(b.provider)
              if (ar !== br) return ar - br
              return String(a.provider).localeCompare(String(b.provider), 'zh-Hans-CN')
            }
            return String(a.provider).localeCompare(String(b.provider), 'en')
          })
          out.push({
            key: name,
            label: name,
            providers,
            total: rows.length,
          })
        }
        return out
      }, [filteredPlans, planRegions, planRegion])

      const planStaleDays = planData ? daysSince(planData.snapshotAt) : null
      const planReachable = visiblePlans.filter((item) => item.reachable === true).length

      const chip = (id, label, on, onClick) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: 'ac-chip',
            'data-on': on ? '' : undefined,
            onClick,
          },
          label,
        )

      /**
       * 全局搜索框：放在栏目切换下面，对**当前所在栏**即时过滤。
       * 领取入口那栏的过滤已经用同一个 query（名字/关键词），其余五栏各配一个匹配器。
       */
      const needle = query.trim().toLowerCase()
      const SEARCH_PLACEHOLDERS = {
        credits: '搜名字 / 关键词…',
        prices: '搜厂商 / 模型…',
        general: '搜套餐 / 厂商…',
        coding: '搜套餐 / 厂商…',
        dsh: '搜线路 / 模型 / 端点…',
        usage: '搜渠道 / 模型…',
      }
      const searchMatches = (fields) => {
        if (needle === '') return true
        return fields.join(' ').toLowerCase().includes(needle)
      }
      const searchBar = h(
        'div',
        { className: 'ac-globalsearch' },
        h('input', {
          className: 'ac-search ac-search-global',
          type: 'search',
          placeholder: SEARCH_PLACEHOLDERS[view] || '搜索…',
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        needle !== ''
          ? h('button', { type: 'button', className: 'ac-chip', onClick: () => setQuery('') }, '清除 ✕')
          : null,
      )

      // ------------------------------------------------------------ 四个栏目

      const tabs = h(
        'div',
        { className: 'ac-tabs', role: 'tablist' },
        h(
          'button',
          {
            type: 'button',
            className: 'ac-tab',
            role: 'tab',
            'aria-selected': view === 'credits',
            'data-on': view === 'credits' ? '' : undefined,
            onClick: () => setView('credits'),
          },
          '领取入口',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ac-tab',
            role: 'tab',
            'aria-selected': view === 'prices',
            'data-on': view === 'prices' ? '' : undefined,
            onClick: () => setView('prices'),
          },
          '各家价格',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ac-tab',
            role: 'tab',
            'aria-selected': view === 'general',
            'data-on': view === 'general' ? '' : undefined,
            onClick: () => setView('general'),
          },
          '通用订阅',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ac-tab',
            role: 'tab',
            'aria-selected': view === 'coding',
            'data-on': view === 'coding' ? '' : undefined,
            onClick: () => setView('coding'),
          },
          '编程工具订阅',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ac-tab',
            role: 'tab',
            'aria-selected': view === 'dsh',
            'data-on': view === 'dsh' ? '' : undefined,
            onClick: () => setView('dsh'),
          },
          '接入情况',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ac-tab',
            role: 'tab',
            'aria-selected': view === 'usage',
            'data-on': view === 'usage' ? '' : undefined,
            onClick: () => setView('usage'),
          },
          '用量花费',
        ),
      )

      const removedData = (data && data.removed) || { count: 0, items: [] }
      const removedItems = Array.isArray(removedData.items) ? removedData.items : []
      const suspectCount = removedItems.filter((entry) => entry.hits > 0).length

      const sourceCard = (item) => {
        const status = statusOf(item)
        const key = item.url || item.id
        const busy = mutating === key
        return h(
          'article',
          { className: 'ac-card', key: item.id },
          h(
            'div',
            { className: 'ac-card-head' },
            h('span', { className: 'ac-dot', 'data-state': status.key }),
            h('span', { className: 'ac-card-title', title: item.title }, item.title),
            h('span', { className: 'ac-status' }, status.text),
            h(
              'button',
              {
                type: 'button',
                className: 'ac-del',
                disabled: busy,
                title: '删掉这条入口。会留档：种子不会补回来，之后联网再搜到只标「存疑」',
                onClick: () => removeEntry(item),
              },
              busy ? '…' : '✕',
            ),
          ),
          h('div', { className: 'ac-claim' }, item.claim),
          h(
            'div',
            { className: 'ac-card-foot' },
            (item.tags || []).slice(0, 2).map((tag) =>
              h(
                'span',
                { className: item.origin === 'web' ? 'ac-tag ac-tag-new' : 'ac-tag', key: tag },
                tag,
              ),
            ),
            item.overseas === true
              ? h(
                  'span',
                  { className: 'ac-tag', title: '海外入口，本机需要能访问外网才能打开' },
                  '海外',
                )
              : null,
            h('span', { className: 'ac-host' }, hostOf(item.url)),
            h(
              'a',
              {
                className: 'ac-go',
                href: item.url,
                title: '打开 ' + item.url,
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              '去领 →',
            ),
          ),
        )
      }

      const removedPanel =
        removedItems.length === 0
          ? null
          : h(
              'div',
              { className: 'ac-removed' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ac-removed-head',
                  onClick: () => setRemovedOpen((value) => !value),
                },
                h('span', { className: 'ac-removed-title' }, '已删除的入口'),
                h(
                  'span',
                  { className: 'ac-removed-meta' },
                  String(removedItems.length) + ' 条 · ' + (removedOpen ? '收起' : '展开'),
                ),
                suspectCount > 0
                  ? h(
                      'span',
                      { className: 'ac-removed-meta ac-suspect' },
                      '其中 ' + String(suspectCount) + ' 条后来又搜到过（存疑）',
                    )
                  : null,
              ),
              removedOpen
                ? h(
                    'div',
                    null,
                    removedItems.map((entry) =>
                      h(
                        'div',
                        { className: 'ac-removed-row', key: entry.url },
                        h('span', { className: 'ac-removed-name', title: entry.url }, entry.title),
                        h('span', { className: 'ac-removed-meta' }, entry.host),
                        entry.httpStatus !== null && entry.httpStatus !== undefined
                          ? h(
                              'span',
                              { className: 'ac-removed-meta' },
                              entry.httpStatus === 0 ? '连不上' : 'HTTP ' + String(entry.httpStatus),
                            )
                          : null,
                        entry.hits > 0
                          ? h(
                              'span',
                              {
                                className: 'ac-removed-meta ac-suspect',
                                title: '删掉之后联网又搜到过 ' + String(entry.hits) + ' 次，最后 ' + (fmtTime(entry.reseenAt) || ''),
                              },
                              '存疑 ×' + String(entry.hits),
                            )
                          : null,
                        h('span', { className: 'ac-removed-meta' }, fmtTime(entry.at) || ''),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ac-del',
                            disabled: mutating === entry.url,
                            title: '把这条放回清单',
                            onClick: () => restoreEntry(entry),
                          },
                          mutating === entry.url ? '…' : '恢复',
                        ),
                      ),
                    ),
                  )
                : null,
            )

      const creditsBody = [
        data === null
          ? null
          : h(
              'div',
              { className: 'ac-meta' },
              h(
                'span',
                null,
                running ? '巡检中…' : '最近巡检 ',
                running ? null : h('b', null, fmtTime(data.checkedAt) || '还没跑过'),
              ),
              h('span', null, '入口 ', h('b', null, String(counts.total)), ' 个'),
              h('span', null, '能打开 ', h('b', null, String(counts.reachable)), ' 个'),
              counts.candidates > 0 ? h('span', null, '新发现 ', h('b', null, String(counts.candidates)), ' 条') : null,
              h('span', null, '每天 ', h('b', null, String(data.refreshHour) + ':00'), ' 自动更新'),
            ),

        data !== null
          ? h(
              'div',
              { className: 'ac-legend' },
              h('span', null, '灰点 待检查'),
              h('span', null, '绿点 能打开'),
              h('span', null, '黄点 拦了自动检查 / 本机网络连不上（点开试试）'),
            )
          : null,

        searching ? h('div', { className: 'ac-note' }, '联网发现这次没跑成：' + searching) : null,

        error
          ? h('div', { className: 'ac-note' }, (data === null ? '读不到宿主数据：' : '刷新失败：') + error)
          : null,

        data === null && error === null ? h('div', { className: 'ac-state' }, '正在读取清单…') : null,

        data !== null
          ? h(
              'div',
              { className: 'ac-filter' },
              chip('all', '全部 (' + counts.total + ')', category === 'all', () => setCategory('all')),
              ...categories.map((name) => {
                const n = sources.filter((item) => item.category === name).length
                return chip(name, name + ' (' + n + ')', category === name, () => setCategory(name))
              }),
            )
          : null,

        data !== null ? searchBar : null,

        groups.map((group) => {
          const buckets = BUCKETS.map((bucket) => ({
            ...bucket,
            rows: group.rows.filter((item) => bucketOfSource(item) === bucket.key),
          })).filter((bucket) => bucket.rows.length > 0)
          return h(
            'section',
            { className: 'ac-group', key: group.name },
            h(
              'div',
              { className: 'ac-group-head' },
              h('div', { className: 'ac-group-title' }, group.name),
              h('div', { className: 'ac-group-count' }, String(group.rows.length) + ' 个入口'),
              group.name === '每日新发现'
                ? h('div', { className: 'ac-group-note' }, '联网搜到的候选页，点开确认过再领')
                : null,
            ),
            buckets.map((bucket) =>
              h(
                'div',
                { className: 'ac-bucket', key: bucket.key },
                h(
                  'div',
                  { className: 'ac-bucket-head' },
                  h(
                    'span',
                    { className: 'ac-bucket-title', 'data-bucket': bucket.key },
                    bucket.label,
                  ),
                  h('span', { className: 'ac-bucket-count' }, String(bucket.rows.length) + ' 个'),
                  bucket.note ? h('span', { className: 'ac-bucket-count' }, bucket.note) : null,
                ),
                h('div', { className: 'ac-grid' }, bucket.rows.map(sourceCard)),
              ),
            ),
          )
        }),

        data !== null && groups.length === 0
          ? h('div', { className: 'ac-state' }, '没找到匹配的入口，换个关键词，或者把筛选切回「全部」。')
          : null,

        mutateError ? h('div', { className: 'ac-note' }, mutateError) : null,

        data !== null ? removedPanel : null,

        error !== null && data === null
          ? h(
              'div',
              { className: 'ac-state', 'data-error': '' },
              '读不到宿主数据，点一下 ',
              h('button', { type: 'button', className: 'ac-btn', onClick: () => load() }, '重试'),
            )
          : null,
      ]

      const pricesBody = [
        priceData === null
          ? data === null && error === null
            ? h('div', { className: 'ac-state' }, '正在读取价格…')
            : null
          : h(
              'div',
              { className: 'ac-meta' },
              h('span', null, '价格快照 ', h('b', null, priceData.snapshotAt || '未标注')),
              h(
                'span',
                null,
                running ? '核对中…' : '最近核对 ',
                running ? null : h('b', null, fmtTime(priceData.checkedAt) || '还没核对'),
              ),
              h(
                'span',
                null,
                '价格页可访问 ',
                h('b', null, String(priceData.reachable) + ' / ' + String(priceData.total)),
              ),
              h('span', null, '每 ', h('b', null, '20 小时'), ' 自动核对一次'),
            ),

        priceData !== null && priceStaleDays !== null && priceStaleDays > 45
          ? h(
              'div',
              { className: 'ac-note' },
              '价格快照已经是 ' + String(priceStaleDays) + ' 天前的了，官网可能已经调价 —— 以「官网核价」链接为准。',
            )
          : null,

        error
          ? h('div', { className: 'ac-note' }, (data === null ? '读不到宿主数据：' : '刷新失败：') + error)
          : null,

        priceData !== null && priceProviders.length === 0
          ? h('div', { className: 'ac-price-empty' }, '价格表还没准备好。')
          : null,

        priceData !== null && priceProviders.length > 0
          ? h(
              'div',
              { className: 'ac-price-tools' },
              chip('all', '全部 (' + priceProviders.length + ' 家)', priceRegion === 'all', () => setPriceRegion('all')),
              ...priceRegions.map((name) => {
                const n = priceProviders.filter((item) => item.region === name).length
                return chip(name, name + ' (' + n + ' 家)', priceRegion === name, () => setPriceRegion(name))
              }),
              h(
                'div',
                { className: 'ac-sortbar' },
                h('span', { className: 'ac-sort-label' }, '排序'),
                ...[
                  ['input', '输入价'],
                  ['output', '输出价'],
                  ['name', '名字'],
                ].map(([id, label]) =>
                  h(
                    'button',
                    {
                      key: id,
                      type: 'button',
                      className: 'ac-chip',
                      'data-on': priceSort === id ? '' : undefined,
                      onClick: () => setPriceSort(id),
                    },
                    label,
                  ),
                ),
              ),
            )
          : null,

        priceData !== null && priceProviders.length > 0 ? searchBar : null,

        priceData !== null && priceProviders.length > 0
          ? h(
              'div',
              { className: 'ac-tablewrap' },
              h(
                'table',
                { className: 'ac-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, '厂商 / 模型'),
                    h('th', null, '输入 / 1M'),
                    h('th', null, '输出 / 1M'),
                    h('th', null, '上下文'),
                    h('th', null, '说明'),
                  ),
                ),
                filteredPriceGroups.map((group) =>
                  h(
                    'tbody',
                    { key: group.key },
                    h('tr', { className: 'ac-region-row' }, h('td', { colSpan: 5 }, group.label)),
                    group.entries.map((entry) => {
                      const status = priceStatusOf(entry.provider)
                      return h(
                        React.Fragment,
                        { key: entry.provider.id },
                        h(
                          'tr',
                          { className: 'ac-prov-row' },
                          h(
                            'td',
                            { colSpan: 5 },
                            h('span', { className: 'ac-dot', 'data-state': status.key }),
                            h('span', { className: 'ac-prov-name' }, entry.provider.title),
                            entry.provider.source === 'openrouter'
                              ? h(
                                  'span',
                                  {
                                    className: 'ac-tag ac-prov-tag',
                                    title: '官网价格页对本机自动访问不友好，数字按 OpenRouter 目录核对，以官网为准',
                                  },
                                  '聚合价',
                                )
                              : null,
                            h('span', { className: 'ac-prov-status' }, status.text),
                            entry.provider.note
                              ? h('span', { className: 'ac-prov-note' }, '· ' + entry.provider.note)
                              : null,
                            h(
                              'a',
                              {
                                className: 'ac-prov-link',
                                href: entry.provider.pricingUrl,
                                title: '打开官方价格页 ' + entry.provider.pricingUrl,
                                target: '_blank',
                                rel: 'noreferrer noopener',
                              },
                              '官网核价 →',
                            ),
                          ),
                        ),
                        entry.models.map((model) =>
                          h(
                            'tr',
                            { className: 'ac-model-row', key: entry.provider.id + '/' + model.id },
                            h(
                              'td',
                              null,
                              h('div', { className: 'ac-model-name' }, model.name),
                              model.id ? h('div', { className: 'ac-model-id' }, model.id) : null,
                            ),
                            h(
                              'td',
                              null,
                              h('span', { className: 'ac-price' }, fmtPrice(model.input, entry.provider.currency)),
                              group.minInput !== null && model.input === group.minInput
                                ? h('span', { className: 'ac-min' }, '最低')
                                : null,
                            ),
                            h(
                              'td',
                              null,
                              h('span', { className: 'ac-price' }, fmtPrice(model.output, entry.provider.currency)),
                              group.minOutput !== null && model.output === group.minOutput
                                ? h('span', { className: 'ac-min' }, '最低')
                                : null,
                            ),
                            h('td', null, fmtContext(model.contextK)),
                            h(
                              'td',
                              null,
                              h('div', { className: 'ac-price-note' }, model.note || '—'),
                            ),
                          ),
                        ),
                      )
                    }),
                  ),
                ),
              ),
            )
          : null,

        filteredPriceGroups.length === 0 && priceProviders.length > 0
          ? h(
              'div',
              { className: 'ac-price-empty' },
              needle !== ''
                ? '没有匹配「' + query.trim() + '」的厂商或模型，换个关键词试试。'
                : '这个区域还没有收录厂商，切回「全部」看看。',
            )
          : null,

        priceData !== null && priceProviders.length > 0
          ? h(
              'div',
              { className: 'ac-group-note', style: { marginTop: '10px' } },
              '价格是 ',
              h('b', null, priceData.snapshotAt || '未标注'),
              ' 从各家官网整理的公开标价，单位是每 100 万 tokens；缓存价、批量价、税费都另算，',
              '标了「聚合价」的几家官网拦自动访问，数字按 OpenRouter 目录核对。以「官网核价」为准。',
            )
          : null,

        priceData !== null
          ? h(
              'div',
              { className: 'ac-legend' },
              h('span', null, '灰点 价格页还没核对'),
              h('span', null, '绿点 价格页今天能打开'),
              h('span', null, '黄点 拦了自动检查 / 本机网络连不上'),
            )
          : null,

        priceData !== null
          ? h(
              'div',
              { className: 'ac-group-note', style: { marginTop: '18px' } },
              '想白嫖不花钱的？回 ',
              h(
                'button',
                { type: 'button', className: 'ac-inline-btn', onClick: () => setView('credits') },
                '「领取入口」',
              ),
              ' 看各家的免费额度。',
            )
          : null,
      ]

      const planCard = (plan) => {
        const status = planStatusOf(plan)
        return h(
          'article',
          { className: 'ac-card ac-plan', key: plan.id },
          h(
            'div',
            { className: 'ac-card-head' },
            h('span', { className: 'ac-dot', 'data-state': status.key }),
            h('span', { className: 'ac-plan-title', title: plan.title }, plan.title),
            h('span', { className: 'ac-status' }, status.text),
          ),
          h(
            'div',
            { className: 'ac-plan-price-row' },
            h('span', { className: 'ac-plan-price' }, fmtPrice(plan.price, plan.currency)),
            h('span', { className: 'ac-plan-period' }, periodLabel(plan.period)),
            plan.priceNote ? h('span', { className: 'ac-plan-note' }, plan.priceNote) : null,
          ),
          plan.quota ? h('div', { className: 'ac-plan-quota' }, '额度：' + plan.quota) : null,
          plan.benefits.length > 0
            ? h(
                'ul',
                { className: 'ac-plan-benefits' },
                plan.benefits.map((benefit, index) => h('li', { key: index }, benefit)),
              )
            : null,
          plan.note ? h('div', { className: 'ac-plan-quota' }, plan.note) : null,
          h(
            'div',
            { className: 'ac-card-foot' },
            plan.kind === 'agent'
              ? h('span', { className: 'ac-tag' }, planCategory === 'coding' ? '编程 Agent' : '通用 Agent')
              : null,
            plan.source === 'benchlm'
              ? h(
                  'span',
                  {
                    className: 'ac-tag ac-tag-new',
                    title: '官网对本机自动访问不友好，数字按 BenchLM 汇总（逐条引用官方页）核对，以官网为准',
                  },
                  '汇总价',
                )
              : null,
            plan.source === 'aggregator'
              ? h(
                  'span',
                  {
                    className: 'ac-tag ac-tag-new',
                    title: '数字取自 codingplan.fyi 聚合（该站逐条引用官方公告核对），以「去订阅」页面为准',
                  },
                  '聚合',
                )
              : null,
            plan.planStatus === 'restricted'
              ? h(
                  'span',
                  { className: 'ac-tag', title: '该套餐目前限购 / 需申请资格' },
                  '限购',
                )
              : null,
            plan.sourceDate ? h('span', { className: 'ac-host' }, '核对于 ' + plan.sourceDate) : null,
            h(
              'a',
              {
                className: 'ac-go',
                href: plan.url,
                title: '打开 ' + plan.url,
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              '去订阅 →',
            ),
          ),
        )
      }

      const plansBody = [
        planData === null
          ? data === null && error === null
            ? h('div', { className: 'ac-state' }, '正在读取订阅…')
            : null
          : h(
              'div',
              { className: 'ac-meta' },
              planSource !== null && planSource.mode === 'aggregator'
                ? h(
                    'span',
                    null,
                    '订阅价来自 ',
                    h('b', null, planSource.label),
                    ' 聚合（数据 ',
                    h('b', null, planSource.dataDate || '未标注'),
                    '）· ',
                    String(planData.total) + ' 个套餐 / ' + String(planRegions.length) + ' 个地区',
                  )
                : h('span', null, '订阅价快照 ', h('b', null, planData.snapshotAt || '未标注')),
              h(
                'span',
                null,
                running ? '核对中…' : '最近核对 ',
                running ? null : h('b', null, fmtTime(planData.checkedAt) || '还没核对'),
              ),
              h(
                'span',
                null,
                planSource !== null && planSource.mode === 'aggregator' ? '聚合源可访问 ' : '订阅页可访问 ',
                h('b', null, String(planReachable) + ' / ' + String(visiblePlans.length)),
              ),
              h(
                'span',
                null,
                '每 ',
                h('b', null, '20 小时'),
                ' 自动核对；聚合数据缓存 ',
                h('b', null, String(planSource && planSource.ttlHours ? planSource.ttlHours : 6) + ' 小时'),
              ),
            ),

        // 聚合源挂了 → 明确说清现在看的是本地快照，别让人以为数字是新的
        planSource !== null && planSource.mode !== 'aggregator'
          ? h(
              'div',
              { className: 'ac-note' },
              '聚合源 ',
              h('b', null, 'codingplan.fyi'),
              ' 这次没取到',
              planSource.error ? '（' + planSource.error + '）' : '',
              '，下面显示的是本地快照 ',
              h('b', null, planData.snapshotAt || '未标注'),
              '，可能已经改价 —— 以「去订阅」页面为准。',
            )
          : null,

        planData !== null && planStaleDays !== null && planStaleDays > 45
          ? h(
              'div',
              { className: 'ac-note' },
              '订阅价快照已经是 ' + String(planStaleDays) + ' 天前的了，套餐可能已经改价 —— 以「去订阅」页面为准。',
            )
          : null,

        error
          ? h('div', { className: 'ac-note' }, (data === null ? '读不到宿主数据：' : '刷新失败：') + error)
          : null,

        planData !== null && planItems.length === 0
          ? h('div', { className: 'ac-price-empty' }, '订阅表还没准备好。')
          : null,

        planData !== null && planItems.length > 0 && visiblePlans.length === 0
          ? h('div', { className: 'ac-price-empty' }, '这个栏目还没有收录套餐。')
          : null,

        planData !== null && planItems.length > 0 && visiblePlans.length > 0
          ? h(
              'div',
              { className: 'ac-price-tools' },
              chip('all', '全部 (' + visiblePlans.length + ' 个)', planRegion === 'all', () => setPlanRegion('all')),
              ...planRegions.map((name) => {
                const n = filteredPlans.filter((item) => item.region === name).length
                return chip(name, name + ' (' + n + ')', planRegion === name, () => setPlanRegion(name))
              }),
            )
          : null,

        planData !== null && visiblePlans.length > 0 ? searchBar : null,

        planData !== null && visiblePlans.length > 0 && filteredPlans.length === 0
          ? h('div', { className: 'ac-price-empty' }, '没有匹配「' + query.trim() + '」的套餐，换个关键词试试。')
          : null,

        planGroups.map((group) =>
          h(
            'section',
            { className: 'ac-group', key: group.key },
            h(
              'div',
              { className: 'ac-group-head' },
              h('div', { className: 'ac-group-title' }, group.label),
              h(
                'div',
                { className: 'ac-group-count' },
                String(group.providers.length) + ' 家 · ' + String(group.total) + ' 个套餐',
              ),
            ),
            group.providers.map((entry) =>
              h(
                'div',
                { className: 'ac-provider-block', key: entry.provider },
                h(
                  'div',
                  { className: 'ac-provider-head' },
                  h('span', { className: 'ac-provider-name' }, entry.provider),
                  h(
                    'span',
                    { className: 'ac-provider-meta' },
                    String(entry.plans.length) + ' 个套餐',
                  ),
                ),
                h('div', { className: 'ac-plan-grid' }, entry.plans.map(planCard)),
              ),
            ),
          ),
        ),

        planGroups.length === 0 && planItems.length > 0
          ? h('div', { className: 'ac-price-empty' }, '这个筛选下还没有收录套餐，切回「全部」看看。')
          : null,

        planData !== null && planItems.length > 0
          ? h(
              'div',
              { className: 'ac-plan-source' },
              '订阅价是 ',
              h('b', null, planData.snapshotAt || '未标注'),
              ' 从各家官网整理的人工快照，按月付价展示（年付 / 按席位 / 税费另计）；额度、可用模型和权益以「去订阅」页面为准。标「汇总价」的几家官网拦自动访问，数字按 BenchLM 汇总核对。',
            )
          : null,

        planData !== null
          ? h(
              'div',
              { className: 'ac-legend' },
              h('span', null, '灰点 订阅页还没核对'),
              h('span', null, '绿点 订阅页今天能打开'),
              h('span', null, '黄点 拦了自动检查 / 本机网络连不上'),
            )
          : null,

        planData !== null
          ? h(
              'div',
              { className: 'ac-group-note', style: { marginTop: '18px' } },
              '想按 token 算成本的？回 ',
              h(
                'button',
                { type: 'button', className: 'ac-inline-btn', onClick: () => setView('prices') },
                '「各家价格」',
              ),
              ' 看每 1M tokens 的标价。',
            )
          : null,
      ]

      // ------------------------------------------------------------ 本机接入

      const dshApi = data && data.dshApi ? data.dshApi : null
      const dshBilling = dshApi && dshApi.billing ? dshApi.billing : null
      const dshRoutes = dshApi && Array.isArray(dshApi.routes) ? dshApi.routes : []
      const dshTotals = (dshApi && dshApi.totals) || { routes: 0, models: 0, configured: 0, missing: 0 }
      // 接入栏的全局搜索：按线路名 / id / 端点 / 协议 / 模型名过滤
      const searchedRoutes = dshRoutes.filter((route) =>
        searchMatches([
          route.name,
          route.id,
          route.baseURL || '',
          route.api || '',
          ...(Array.isArray(route.models) ? route.models.map((m) => m.name + ' ' + m.id) : []),
        ]),
      )
      /**
       * 本机还没配起来的线路默认收起来（2.7.1）。
       *
       * 宿主会把 profile 里声明过的通道全列出来，哪怕密钥没填、一个模型都读不到
       * （火山方舟那几个没加 API 的通道就是这样），一堆点不动的空卡片很占屏。
       * 这里默认只显示配起来的，另给一个「显示 N 条未配置」的开关。
       *
       * ⚠ 搜索时**不藏**：用户明确在找某条线路，搜到了就该看得见。
       */
      const unconfiguredRoutes = searchedRoutes.filter((route) => route.unconfigured === true)
      const filteredRoutes =
        showUnconfigured || needle !== ''
          ? searchedRoutes
          : searchedRoutes.filter((route) => route.unconfigured !== true)
      // 多账号（2.7.1）：页面问连接器 /usage 拿的账号列表，按线路 id 索引
      const usageCreditBooks = (data && data.usage && data.usage.creditBalances) || {}
      // Go 官方额度全表（2.7.3）：宿主实时拉官方端点、快照兜底；线路里有的排前面
      const goCatalog = data && data.opencodeGo ? data.opencodeGo : null
      // 订阅线路：卡片标蓝，汇总里也能直接把名字列出来
      const dshSubscribed = dshRoutes.filter((route) => route.billing && route.billing.mode === 'credits')
      const dshSubscribedNames = dshSubscribed.map((route) => route.name || route.id).join('、')
      /**
       * 「订阅划算吗」：宿主在用量那一栏已经按线路聚合好了（等价金额 → 折合月 → 参考月费 → 结论），
       * 这里按 provider 建个索引，本机接入栏每条订阅卡直接用，不必再算一遍。
       */
      const dshWorthList = data && data.usage && Array.isArray(data.usage.subscriptionWorth) ? data.usage.subscriptionWorth : []
      const worthByProvider = new Map()
      for (const row of dshWorthList) worthByProvider.set(row.provider, row)
      const worthMeta = data && data.usage && data.usage.worthMeta ? data.usage.worthMeta : null
      // 这个时间窗里哪些线路有用量 —— 开关折算但没用量时，别说成「没有公开价」
      const dshUsageProviders = new Set(
        data && data.usage && Array.isArray(data.usage.bySource)
          ? data.usage.bySource.map((row) => row.provider)
          : [],
      )
      const dshFolded = dshRoutes.filter((route) => route.billing && route.billing.folded === true)
      const dshDefault = dshApi && dshApi.defaultSelection ? dshApi.defaultSelection : null
      const dshDefaultInfo = dshApi && dshApi.defaultModel ? dshApi.defaultModel : null
      const dshDefaultRoute = dshDefault
        ? dshRoutes.find((route) => route.id === dshDefault.provider) || null
        : null

      const keyStateOf = (credential) => {
        if (credential === null || credential === undefined) return { key: 'idle', text: '无需密钥' }
        if (credential.configured === true) return { key: 'ok', text: '密钥已配' }
        if (credential.configured === false) return { key: 'missing', text: '密钥未配' }
        return { key: 'idle', text: '密钥未知' }
      }

      const keySourceLabel = (credential) => {
        if (!credential || credential.configured !== true) return ''
        if (credential.source === 'env') return '来自环境变量'
        if (credential.source === 'file') return '存在本机凭据库'
        if (credential.source === 'dotenv') return '来自 .env'
        return credential.source ? '来自 ' + credential.source : ''
      }

      const routeCard = (route) => {
        const isDefault = dshDefault !== null && dshDefault.provider === route.id
        const keyState = keyStateOf(route.credential)
        const bill = route.billing || null
        // 多账号（2.7.1）：账号列表由页面问连接器 /usage 拿的，挂在 usage.creditBalances 上
        const accountBook = usageCreditBooks[route.id]
        const accountsInfo = accountBook && accountBook.accounts ? accountBook.accounts : null
        // 缺密钥的线路通常读不到模型清单，这时候别说「没报模型」，会让人以为线路坏了
        const countText =
          route.modelCount > 0
            ? String(route.modelCount) + ' 个模型'
            : keyState.key === 'missing'
              ? '缺密钥，模型没读到'
              : route.modelsError
                ? '模型没读到'
                : '没报模型'

        /**
         * 计费方式一行：当前标签 + 手选按钮。
         *
         * 「订阅」和「折算」是可以**同时按下**的两个开关：
         *   · 单按订阅 → 订阅 · 不折钱（只报 token 和积分）
         *   · 订阅 + 折算 → 订阅 · 折算：仍算订阅，但照官方价折一个等价金额，
         *     好跟套餐月费比，判断这个套餐值不值
         *   · 单按折算 → 套餐 · 折算（estimate 那一档）
         * 判错了按「自动」退回白名单拿去。
         */
        const billingRow = (() => {
          if (bill === null) return null
          const busy = billingBusy === route.id
          const autoLabel = (mode) => (BILLING_SHORT[mode] || mode) + '（自动判定）'
          const folded = bill.folded === true
          // 折算按钮：订阅档是开关，其余档是「切成 estimate」
          const toggleFold = () => {
            if (bill.mode === 'credits') setBilling(route.id, { estimate: !folded })
            else setBilling(route.id, { mode: 'estimate' })
          }
          const foldTitle =
            bill.mode === 'credits'
              ? folded
                ? '订阅 + 折算已开：再按一下关掉，这条线路就不折等价金额了'
                : '订阅 + 折算：订阅身份不变，另外照官方价折一个等价金额，用来跟月费比'
              : '标成「套餐 · 折算」'
          return h(
            'div',
            { className: 'ac-bill' },
            h('span', { className: 'ac-bill-label' }, '计费'),
            h(
              'span',
              { className: 'ac-bill-mode', 'data-mode': bill.mode, 'data-folded': folded ? '' : undefined },
              bill.label || BILLING_LABELS[bill.mode],
            ),
            bill.manual
              ? h(
                  'span',
                  {
                    className: 'ac-bill-manual',
                    title: bill.changed
                      ? '你手选成了「' + bill.label + '」，自动判定本来是「' + autoLabel(bill.auto) + '」'
                      : '自动判定也是这个，但你手动钉住了，白名单变了也不会跟着变',
                  },
                  '手选',
                )
              : null,
            bill.mode === 'credits' && bill.creditEndpoint === null
              ? h(
                  'span',
                  { className: 'ac-bill-auto-hint' },
                  '这条线路没有积分查询接口，只报 token',
                )
              : null,
            !bill.manual && !folded
              ? h('span', { className: 'ac-bill-auto-hint' }, '按白名单自动判定；判错了可以手选')
              : null,
            h(
              'div',
              { className: 'ac-bill-btns' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ac-bill-btn',
                  disabled: busy,
                  'data-active': bill.manual && bill.override === 'token' ? '' : undefined,
                  'data-auto': !bill.manual && bill.mode === 'token' ? '' : undefined,
                  title: '标成「API 按量」：真花钱，按官方单价折金额',
                  onClick: () => setBilling(route.id, { mode: 'token' }),
                },
                busy ? '…' : BILLING_SHORT.token,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ac-bill-btn',
                  disabled: busy,
                  'data-active': bill.manual && bill.override === 'credits' ? '' : undefined,
                  'data-auto': !bill.manual && bill.mode === 'credits' ? '' : undefined,
                  title: '标成「订阅」→ 卡片标蓝；下面会出现订阅形式 / 订阅时间 / 实付价的填写行',
                  onClick: () => setBilling(route.id, { mode: 'credits' }),
                },
                busy ? '…' : BILLING_SHORT.credits,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ac-bill-btn',
                  disabled: busy,
                  // 订阅 + 折算 时这个按钮也是亮的 —— 两个开关同时按着
                  'data-active':
                    (bill.manual && bill.override === 'estimate') || folded ? '' : undefined,
                  'data-auto': !bill.manual && !folded && bill.mode === 'estimate' ? '' : undefined,
                  'data-folded': folded ? '' : undefined,
                  title: foldTitle,
                  onClick: toggleFold,
                },
                busy ? '…' : BILLING_SHORT.estimate,
              ),
              bill.touched
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'ac-bill-btn',
                      disabled: busy,
                      title:
                        '全清掉：退回白名单自动判定（现在是「' +
                        autoLabel(bill.auto) +
                        '」），订阅形式 / 时间 / 优惠 / 月费也一起清',
                      onClick: () =>
                        setBilling(route.id, {
                          mode: null,
                          estimate: false,
                          monthlyCNY: null,
                          planType: null,
                          subscribedAt: null,
                          promoNote: null,
                          planTier: null,
                        }),
                    },
                    '自动',
                  )
                : null,
            ),
          )
        })()

        /**
         * 订阅详情行：只在「订阅」档出现。三个可填项 + 套餐表联动建议：
         *   订阅形式   Agent Plan / Token Plan / Coding Plan / 特价 token 包 / 其他
         *   订阅时间   用来算现在处于第几个计费周期（首月优惠还在不在）
         *   实付价     本期实际付了多少（含优惠），跟套餐表建议价并排显示
         * 套餐表建议价来自 plans.js：先按订阅形式的关键词过滤这条线路的候选档，
         * 对不上就摆全部候选档（宁多勿缺）。
         */
        /**
         * 本地 CLI agent 未确认提示（2.7.2）。
         *
         * Claude Code / Codex CLI 这类是「本机装的命令行 agent」，不是 DSH 买的订阅。
         * 它自己怎么认证 DSH 不知道：可能 OAuth + Pro/Max 订阅，可能 API key 按量，
         * 也可能压根没登录。探不到登录凭据就标「未确认」，别硬说成订阅。
         */
        const cliNote = (() => {
          const cli = route.localCli || null
          if (cli === null) return null
          if (cli.signedIn === true) {
            return h(
              'div',
              { className: 'ac-cli-note' },
              '本机 CLI agent（',
              h('b', null, cli.label),
              '）：探到登录凭据（' + (cli.via === 'apikey' ? '环境变量里的 API key' : '凭据文件') + '）。' +
                '⚠ 登录不等于订阅 —— 它可能是按量付费的 API key。确实订阅了再点上面「订阅」。',
            )
          }
          return h(
            'div',
            { className: 'ac-cli-note' },
            '本机 CLI agent（',
            h('b', null, cli.label),
            '）：',
            cli.known
              ? '没探到登录凭据，本机应该还没登录 —— 所以不算订阅，也不折钱。'
              : '这类线路的登录态探不出来。',
            ' 它不是 DSH 买的订阅，而是本机装的命令行 agent；确实订阅了（Pro / Max 等）再点上面「订阅」自己标。',
          )
        })()

        const subscriptionRow = (() => {
          if (bill === null || bill.mode !== 'credits') return null
          const busy = billingBusy === route.id
          const planTypes = (dshBilling && Array.isArray(dshBilling.planTypes) ? dshBilling.planTypes : [])
          const planTypeLabels = (dshBilling && dshBilling.planTypeLabels) || {}
          const suggestion = bill.planSuggestion || null
          const period = bill.period || null
          const firstPeriod = period !== null && period.periodIndex === 1

          /**
           * 额度池订阅（2.7.1）—— OpenCode Go 那种：
           * 付 $10 基础价，各家模型各给一笔额度（DeepSeek $100、Kimi K3 $15…），
           * 用掉多少就按「用掉的 / 该模型额度」的比例，从基础价里扣掉对应的钱。
           *
           * 只在订阅形式选了「额度池订阅」时出现。上半截是配置（基础价 + 每模型额度），
           * 下半截是宿主按用量算出来的折算明细（usage.subscriptionWorth[].quotaPool）。
           */
          const quotaPoolRow = (() => {
            if (bill.planType !== 'quota-pool') return null
            const cfg = bill.quotaPoolConfig || null
            const pools = cfg && Array.isArray(cfg.pools) ? cfg.pools : []
            const worth = worthByProvider.get(route.id) || null
            const calc = worth && worth.quotaPool ? worth.quotaPool : null
            const baseCur = (cfg && cfg.baseCurrency) || 'USD'
            // 编辑额度表：一行一个「模型 id : 额度」，用文本框整体编辑，回车/失焦提交
            const poolsText = pools.map((p) => p.model + ':' + p.quota).join('\n')
            // opencode-go：官方额度表建议（来自公开 models 端点快照），一键填省得手抄
            const goSug = bill.goPoolSuggestion || null
            const goText = goSug ? goSug.pools.map((p) => p.model + ':' + p.quota).join('\n') : ''
            const goSame = goSug !== null && goText === poolsText && cfg && cfg.basePrice === goSug.basePrice
            return h(
              'div',
              { className: 'ac-quota' },
              goSug !== null
                ? h(
                    'div',
                    { className: 'ac-go-fill' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ac-chip',
                        disabled: busy || goSame,
                        title:
                          '按 OpenCode 官方额度表填：' + goSug.tierLabel + ' 档基础价 $' + goSug.basePrice +
                          '，' + goSug.pools.length + ' 个模型各自的月度额度。来源 ' + goSug.snapshotAt + ' 快照',
                        onClick: () =>
                          setBilling(route.id, {
                            basePrice: goSug.basePrice,
                            baseCurrency: 'USD',
                            quotaPools: goSug.pools,
                          }),
                      },
                      goSame ? '已按官方额度表' : '用官方额度表填（' + goSug.pools.length + ' 个模型）',
                    ),
                    h(
                      'span',
                      { className: 'ac-go-src' },
                      'OpenCode ' + goSug.tierLabel + ' $' + goSug.basePrice + '/月 · ',
                      goCatalog !== null && goCatalog.source === 'live'
                        ? '官方实时表 ' + (goCatalog.count || '') + ' 个模型'
                        : '官方快照 ' + goSug.snapshotAt,
                      goSug.unmatched.length > 0 ? ' · ' + goSug.unmatched.length + ' 个模型官方表里没有' : '',
                    ),
                    // 全表检索（2.7.3）：不止本线路的 18 个，官方全部模型都能查
                    goCatalog !== null && Array.isArray(goCatalog.models) && goCatalog.models.length > 0
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'ac-chip',
                            'data-on': goTableOpen ? '' : undefined,
                            onClick: () => setGoTableOpen(!goTableOpen),
                          },
                          goTableOpen ? '收起额度表 ▴' : '查全部模型额度（' + goCatalog.models.length + '）▾',
                        )
                      : null,
                  )
                : null,
              // 官方额度全表：可检索、三档额度 + 官方单价，本线路有的标出来
              goTableOpen && goCatalog !== null && Array.isArray(goCatalog.models)
                ? (() => {
                    const q = goTableQuery.trim().toLowerCase()
                    const rows =
                      q === ''
                        ? goCatalog.models
                        : goCatalog.models.filter(
                            (r) => r.model.includes(q) || (r.name || '').toLowerCase().includes(q),
                          )
                    return h(
                      'div',
                      { className: 'ac-go-table' },
                      h(
                        'div',
                        { className: 'ac-go-table-head' },
                        h('input', {
                          className: 'ac-sub-input ac-go-table-search',
                          type: 'search',
                          placeholder: '检索模型 id / 名称…',
                          value: goTableQuery,
                          onChange: (event) => setGoTableQuery(event.target.value),
                        }),
                        h(
                          'span',
                          { className: 'ac-go-src' },
                          goCatalog.source === 'live'
                            ? '官方实时表 · ' + fmtTime(goCatalog.at) + (goCatalog.stale ? '（上次成功值）' : '')
                            : '离线快照 ' + (goCatalog.snapshotAt || '') + (goCatalog.error ? ' · ' + goCatalog.error : ''),
                          ' · 命中 ' + rows.length + ' / ' + goCatalog.models.length,
                        ),
                      ),
                      h(
                        'div',
                        { className: 'ac-go-table-rows' },
                        h(
                          'div',
                          { className: 'ac-go-table-row ac-go-table-th' },
                          h('span', null, '模型'),
                          h('span', null, 'Go $10'),
                          h('span', null, 'Plus $40'),
                          h('span', null, 'Teams $20/人'),
                          h('span', null, '输入 $/M'),
                          h('span', null, '输出 $/M'),
                        ),
                        ...rows.slice(0, 60).map((r) =>
                          h(
                            'div',
                            { className: 'ac-go-table-row', key: r.model, 'data-inroute': r.inRoute ? '' : undefined },
                            h(
                              'span',
                              { className: 'ac-go-table-model' },
                              h('code', null, r.model),
                              r.inRoute ? h('i', { className: 'ac-go-inroute' }, '本线路') : null,
                              r.peakFactor ? h('i', { className: 'ac-go-peak' }, '高峰×' + r.peakFactor) : null,
                            ),
                            r.free
                              ? h('span', { className: 'ac-go-free' }, '限时免费')
                              : r.limits
                                ? h('span', null, '$' + (r.limits.go !== undefined ? r.limits.go : '—'))
                                : h('span', null, '—'),
                            r.limits && r.limits['go-plus'] !== undefined ? h('span', null, '$' + r.limits['go-plus']) : h('span', null, r.free ? '' : '—'),
                            r.limits && r.limits['go-teams'] !== undefined ? h('span', null, '$' + r.limits['go-teams']) : h('span', null, r.free ? '' : '—'),
                            h('span', null, r.input !== null ? '$' + r.input : '—'),
                            h('span', null, r.output !== null ? '$' + r.output : '—'),
                          ),
                        ),
                        rows.length > 60 ? h('div', { className: 'ac-go-src' }, '只摆前 60 条，检索词再收窄一点') : null,
                        rows.length === 0 ? h('div', { className: 'ac-go-src' }, '没有匹配「' + goTableQuery.trim() + '」的模型') : null,
                      ),
                    )
                  })()
                : null,
              h(
                'div',
                { className: 'ac-sub-detail-row' },
                h('span', { className: 'ac-bill-label' }, '基础价'),
                h('span', { className: 'ac-sub-price-wrap' },
                  h('input', {
                    type: 'number',
                    className: 'ac-sub-input ac-sub-price',
                    key: 'base-' + (cfg && cfg.basePrice !== null ? String(cfg.basePrice) : ''),
                    defaultValue: cfg && cfg.basePrice !== null && cfg.basePrice !== undefined ? String(cfg.basePrice) : '',
                    placeholder: '10',
                    min: 0,
                    step: 1,
                    disabled: busy,
                    title: '这份订阅实际付的基础价（OpenCode Go 是 $10）。各模型的消耗按比例从这里面扣',
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') event.target.blur()
                    },
                    onBlur: (event) => {
                      const raw = String(event.target.value || '').trim()
                      const value = raw === '' ? null : Number(raw)
                      if (value !== null && (!Number.isFinite(value) || value <= 0)) return
                      const current = cfg && cfg.basePrice !== null && cfg.basePrice !== undefined ? cfg.basePrice : null
                      if (value === current) return
                      setBilling(route.id, { basePrice: value })
                    },
                  }),
                  h(
                    'select',
                    {
                      className: 'ac-sub-select ac-sub-cur',
                      disabled: busy,
                      value: baseCur,
                      onChange: (event) => setBilling(route.id, { baseCurrency: event.target.value }),
                    },
                    h('option', { value: 'USD' }, '$'),
                    h('option', { value: 'CNY' }, '¥'),
                  ),
                ),
                h('span', { className: 'ac-bill-auto-hint' }, '各模型用掉的额度按比例从这里扣'),
              ),
              h(
                'div',
                { className: 'ac-sub-detail-row ac-quota-pools-row' },
                h('span', { className: 'ac-bill-label' }, '模型额度'),
                h('textarea', {
                  className: 'ac-sub-input ac-quota-text',
                  key: 'pools-' + poolsText,
                  defaultValue: poolsText,
                  rows: Math.min(6, Math.max(3, pools.length + 1)),
                  placeholder: '每行一个：模型id:额度\ndeepseek:100\nkimi-k3:15',
                  disabled: busy,
                  title: '每行「模型id:额度」。模型id 要和这条线路实际用的模型 id 一致（下面模型标签里能看到），额度是这家给的上限',
                  onBlur: (event) => {
                    const text = String(event.target.value || '')
                    const rows = []
                    for (const line of text.split('\n')) {
                      const t = line.trim()
                      if (t === '') continue
                      const at = t.lastIndexOf(':')
                      if (at <= 0) continue
                      const model = t.slice(0, at).trim()
                      const quota = Number(t.slice(at + 1).trim())
                      if (model === '' || !Number.isFinite(quota) || quota <= 0) continue
                      rows.push({ model, quota })
                    }
                    const nextText = rows.map((p) => p.model + ':' + p.quota).join('\n')
                    if (nextText === poolsText) return
                    setBilling(route.id, { quotaPools: rows.length > 0 ? rows : null })
                  },
                }),
              ),
              pools.length > 0 && route.models.length > 0
                ? h(
                    'div',
                    { className: 'ac-quota-hint' },
                    '这条线路的模型 id：',
                    route.models.slice(0, 12).map((m) => h('code', { key: m.id }, m.id)),
                    route.models.length > 12 ? h('span', null, ' …') : null,
                  )
                : null,
              // 折算明细：宿主按用量算的（用掉额度 / 该模型额度 × 基础价）
              calc !== null && calc.matched > 0
                ? h(
                    'div',
                    { className: 'ac-quota-calc' },
                    h(
                      'div',
                      { className: 'ac-quota-calc-head' },
                      '按比例折算 ',
                      h('b', null, fmtPrice(calc.usedCNY, 'CNY')),
                      ' / 基础价 ' + fmtPrice(calc.baseCNY, 'CNY') + ' · 已用 ' + String(calc.usedPct) + '% · 还剩 ' + fmtPrice(calc.leftCNY, 'CNY'),
                    ),
                    ...calc.rows.map((row) =>
                      h(
                        'div',
                        { className: 'ac-quota-calc-row', key: row.model },
                        h('code', null, row.model),
                        h(
                          'span',
                          { className: 'ac-quota-calc-detail' },
                          '用 ' + fmtPrice(row.usedQuota, calc.baseCurrency) + ' / 额度 ' + fmtPrice(row.quota, calc.baseCurrency) +
                            ' = ' + (row.ratio * 100).toFixed(1) + '%',
                        ),
                        h('b', null, fmtPrice(row.costCNY, 'CNY')),
                        row.capped ? h('span', { className: 'ac-quota-cap' }, '超额按100%') : null,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'ac-quota-note' },
                      calc.overCap ? '多个模型都用超了，已按比例缩到基础价上限。' : '',
                      calc.priceSource === 'opencode-official'
                        ? '「用掉多少额度」按 OpenCode 官方单价折算（快照 ' +
                          (calc.goSnapshotAt || '') +
                          '）。官方口径：用掉的美元 ÷ 该模型月度额度 = 吃掉额度池的百分比。时间窗跟着上面「今天 / 7 天 / 30 天」走。'
                        : '「用掉多少额度」拿按官方价折出的金额当近似（这家没给按模型的额度扣减明细），所以是估算值；时间窗跟着上面「今天 / 7 天 / 30 天」走。',
                    ),
                  )
                : pools.length > 0
                  ? h('div', { className: 'ac-quota-note' }, '这个时间窗里还没有对得上这些模型的用量，折不出金额。')
                  : null,
            )
          })()

          return h(
            'div',
            { className: 'ac-sub-detail' },
            h(
              'div',
              { className: 'ac-sub-detail-row' },
              h('span', { className: 'ac-bill-label' }, '订阅形式'),
              h(
                'select',
                {
                  className: 'ac-sub-select',
                  disabled: busy,
                  value: bill.planType === null ? '' : bill.planType,
                  onChange: (event) => setBilling(route.id, { planType: event.target.value === '' ? null : event.target.value }),
                },
                h('option', { value: '' }, '未指定'),
                planTypes.map((t) => h('option', { key: t, value: t }, planTypeLabels[t] || t)),
              ),
              suggestion !== null && suggestion.plans.length > 0
                ? h(
                    'span',
                    {
                      className: 'ac-sub-suggest',
                      title:
                        '来自订阅表快照 ' + (suggestion.snapshotAt || '') +
                        (suggestion.matched ? '' : '（没按订阅形式精确对上，摆的是这条线路的全部候选档）'),
                    },
                    '建议价 ',
                    suggestion.maxCNY > suggestion.minCNY
                      ? fmtPrice(suggestion.minCNY, 'CNY') + '–' + fmtPrice(suggestion.maxCNY, 'CNY')
                      : fmtPrice(suggestion.minCNY, 'CNY'),
                    ' / 月 · ',
                    suggestion.plans.map((p) => p.title + ' ' + fmtPrice(p.price, p.currency)).join('；'),
                  )
                : h('span', { className: 'ac-bill-auto-hint' }, '订阅表里没有这条线路的参考档，实付价自己填'),
            ),
            // 官方档位下拉（2.7.4）：国内账号按国内官方价。选了档位参考价就按它的月付原价
            bill.cnTiers
              ? h(
                  'div',
                  { className: 'ac-sub-detail-row' },
                  h('span', { className: 'ac-bill-label' }, '官方档位'),
                  h(
                    'select',
                    {
                      className: 'ac-sub-select ac-tier-select',
                      disabled: busy,
                      value: bill.planTier === null || bill.planTier === undefined ? '' : bill.planTier,
                      title: '按官方页面给出的版本选（' + bill.cnTiers.label + '）。参考价按这一档的月付原价（国内价）算',
                      onChange: (event) => setBilling(route.id, { planTier: event.target.value === '' ? null : event.target.value }),
                    },
                    h('option', { value: '' }, '未指定'),
                    bill.cnTiers.tiers.map((t) =>
                      h(
                        'option',
                        { key: t.id, value: t.id },
                        t.official +
                          (t.monthlyCNY === 0 ? '（免费）' : t.monthlyCNY !== null ? '（¥' + t.monthlyCNY + '/月）' : ''),
                      ),
                    ),
                  ),
                  (() => {
                    const sel =
                      bill.planTier && bill.cnTiers
                        ? bill.cnTiers.tiers.find((t) => t.id === bill.planTier) || null
                        : null
                    if (sel === null) return h('span', { className: 'ac-bill-auto-hint' }, '选官方版本，参考价按国内月付原价')
                    return h(
                      'span',
                      { className: 'ac-sub-suggest' },
                      sel.monthlyCNY === 0
                        ? '免费档 · ' + (sel.promoNote || '')
                        : '官方月付 ¥' + sel.monthlyCNY + '/月',
                      sel.promoCNY !== null && sel.promoCNY !== undefined
                        ? ' · 当前促销 ¥' + sel.promoCNY + '（' + (sel.promoNote || '') + '）'
                        : sel.promoNote
                          ? ' · ' + sel.promoNote
                          : '',
                      sel.credits ? ' · 每月 ' + sel.credits + ' 积分' : '',
                    )
                  })(),
                )
              : null,
            h(
              'div',
              { className: 'ac-sub-detail-row' },
              h('span', { className: 'ac-bill-label' }, '订阅时间'),
              h('input', {
                type: 'date',
                className: 'ac-sub-input',
                key: 'sub-' + (bill.subscribedAt || ''),
                defaultValue: bill.subscribedAt === null ? '' : bill.subscribedAt,
                disabled: busy,
                title: '这次订阅是哪天开通 / 续费的 —— 用来算现在处于第几个计费周期',
                onChange: (event) => {
                  const v = String(event.target.value || '').trim()
                  setBilling(route.id, { subscribedAt: v === '' ? null : v })
                },
              }),
              // 这一次订阅了多久（2.7.1）：年付要按 12 个月摊，周期也按 12 个月推
              h('span', { className: 'ac-sub-term-wrap' },
                h('input', {
                  type: 'number',
                  className: 'ac-sub-input ac-sub-term',
                  key: 'term-' + (bill.termMonths === null || bill.termMonths === undefined ? '' : String(bill.termMonths)),
                  defaultValue: bill.termMonths === null || bill.termMonths === undefined ? '' : String(bill.termMonths),
                  placeholder: '1',
                  min: 1,
                  max: 120,
                  step: 1,
                  disabled: busy,
                  title: '这一次订阅了几个月：月付填 1、季付 3、年付 12。留空按 1 个月算',
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') event.target.blur()
                  },
                  onBlur: (event) => {
                    const raw = String(event.target.value || '').trim()
                    const value = raw === '' ? null : Math.floor(Number(raw))
                    if (value !== null && (!Number.isFinite(value) || value < 1 || value > 120)) return
                    const current = bill.termMonths === null || bill.termMonths === undefined ? null : bill.termMonths
                    if (value === current) return
                    setBilling(route.id, { termMonths: value })
                  },
                }),
                h('span', { className: 'ac-sub-unit' }, '个月'),
              ),
              // 常用时长快捷按钮：月 / 两月优惠 / 季 / 年
              ...[1, 2, 3, 12].map((n) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: 'term-quick-' + n,
                    className: 'ac-chip ac-sub-term-quick',
                    'data-on': (bill.termMonths || 1) === n ? '' : undefined,
                    disabled: busy,
                    title: n === 2 ? '限时优惠一次买俩月 —— 仍归月付挡，不是季付' : undefined,
                    onClick: () => setBilling(route.id, { termMonths: n }),
                  },
                  n === 1 ? '月付' : n === 2 ? '两月优惠' : n === 3 ? '季付' : '年付',
                ),
              ),
              // 计费挡位标签（2.7.4）：两月优惠仍归月付挡
              h(
                'span',
                { className: 'ac-bill-class', 'data-class': bill.billingClass || 'monthly' },
                bill.billingClass === 'yearly' ? '年付挡' : bill.billingClass === 'quarterly' ? '多月包挡' : '月付挡',
                (bill.termMonths || 1) === 2 ? '（限时优惠买俩月，仍按月付）' : '',
              ),
              period !== null
                ? h(
                    'span',
                    { className: 'ac-sub-period' },
                    '现在第 ',
                    h('b', null, String(period.periodIndex)),
                    ' 期 · 本期 ' + period.periodStart + ' ~ ' + period.periodEnd + ' · 已订 ' + String(period.daysSince) + ' 天',
                  )
                : bill.subscribedAt === null
                  ? h('span', { className: 'ac-bill-auto-hint' }, '填了订阅时间就能算周期')
                  : null,
            ),
            // 本次订阅到期提醒（2.7.1）：快到期 / 已过期都点出来，免得忘了续费
            period !== null && period.expiresAt
              ? h(
                  'div',
                  { className: 'ac-sub-detail-row' },
                  h('span', { className: 'ac-bill-label' }, '本次到期'),
                  h(
                    'span',
                    { className: 'ac-sub-expire', 'data-soon': !period.expired && period.daysLeft <= 7 ? '' : undefined, 'data-expired': period.expired ? '' : undefined },
                    period.expiresAt,
                    period.expired
                      ? ' · 已过期 ' + String(Math.abs(period.daysLeft)) + ' 天（若已续费，把订阅时间改成续费那天）'
                      : ' · 还剩 ' + String(period.daysLeft) + ' 天',
                  ),
                )
              : null,
            h(
              'div',
              { className: 'ac-sub-detail-row' },
              h('span', { className: 'ac-bill-label' }, '本次实付'),
              h('span', { className: 'ac-sub-price-wrap' },
                h('input', {
                  type: 'number',
                  className: 'ac-sub-input ac-sub-price',
                  key: 'paidtotal-' + (bill.paid && bill.paid.total !== null ? String(bill.paid.total) : ''),
                  defaultValue: bill.paid && bill.paid.total !== null && bill.paid.total !== undefined ? String(bill.paid.total) : '',
                  placeholder: '总额',
                  min: 0,
                  step: 1,
                  disabled: busy,
                  title: '这一次订阅总共付了多少（年付就填年费，不是月费）。除以订阅月数得到「折合月费」，再跟等价月费比',
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') event.target.blur()
                  },
                  onBlur: (event) => {
                    const raw = String(event.target.value || '').trim()
                    const value = raw === '' ? null : Number(raw)
                    if (value !== null && (!Number.isFinite(value) || value <= 0)) return
                    const current = bill.paid && bill.paid.total !== null && bill.paid.total !== undefined ? bill.paid.total : null
                    if (value === current) return
                    setBilling(route.id, { paidTotal: value })
                  },
                }),
                h(
                  'select',
                  {
                    className: 'ac-sub-select ac-sub-cur',
                    disabled: busy,
                    value: (bill.paid && bill.paid.currency) || 'CNY',
                    onChange: (event) => setBilling(route.id, { paidCurrency: event.target.value }),
                  },
                  h('option', { value: 'CNY' }, '¥'),
                  h('option', { value: 'USD' }, '$'),
                ),
              ),
              // 折合月费：实付 ÷ 月数（年付 ¥120/12 = ¥10/月）
              bill.effectiveMonthlyCNY !== null && bill.effectiveMonthlyCNY !== undefined
                ? h(
                    'span',
                    { className: 'ac-sub-monthly' },
                    '折合 ',
                    h('b', null, fmtPrice(bill.effectiveMonthlyCNY, 'CNY')),
                    ' / 月',
                    bill.paid && bill.termMonths ? '（' + fmtPrice(bill.paid.total, bill.paid.currency) + ' ÷ ' + String(bill.termMonths) + ' 个月）' : '',
                  )
                : null,
              h('input', {
                type: 'text',
                className: 'ac-sub-input ac-sub-promo',
                key: 'promo-' + (bill.promoNote || ''),
                defaultValue: bill.promoNote === null ? '' : bill.promoNote,
                placeholder: '优惠说明（如：首月半价 / 火山 40 抵 80）',
                maxLength: 80,
                disabled: busy,
                onKeyDown: (event) => {
                  if (event.key === 'Enter') event.target.blur()
                },
                onBlur: (event) => {
                  const v = String(event.target.value || '').trim()
                  const next = v === '' ? null : v.slice(0, 80)
                  if (next === (bill.promoNote || null)) return
                  setBilling(route.id, { promoNote: next })
                },
              }),
              firstPeriod && bill.promoNote !== null
                ? h('span', { className: 'ac-sub-promo-hint' }, '当前是首期，优惠还在生效期内')
                : period !== null && !firstPeriod && bill.promoNote !== null
                  ? h('span', { className: 'ac-sub-promo-hint' }, '已过首期 —— 首月优惠类的说明只适用第一期，续费价以实际扣款为准')
                  : null,
            ),
            // 老的「按月填月费」入口：没填本次实付总额时保留，填了就以总额÷月数为准
            !bill.paid
              ? h(
                  'div',
                  { className: 'ac-sub-detail-row' },
                  h('span', { className: 'ac-bill-label' }, '或按月'),
                  h('span', { className: 'ac-sub-price-wrap' },
                    h('input', {
                      type: 'number',
                      className: 'ac-sub-input ac-sub-price',
                      key: 'paid-' + (bill.monthlyCNY === null || bill.monthlyCNY === undefined ? '' : String(bill.monthlyCNY)),
                      defaultValue: bill.monthlyCNY === null || bill.monthlyCNY === undefined ? '' : String(bill.monthlyCNY),
                      placeholder: '每月 ¥',
                      min: 0,
                      step: 1,
                      disabled: busy,
                      title: '按月付的话直接填每月多少（等价于「本次实付」填同样的数、时长填 1）',
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') event.target.blur()
                      },
                      onBlur: (event) => {
                        const raw = String(event.target.value || '').trim()
                        const value = raw === '' ? null : Number(raw)
                        if (value !== null && (!Number.isFinite(value) || value <= 0)) return
                        const current = bill.monthlyCNY === null || bill.monthlyCNY === undefined ? null : bill.monthlyCNY
                        if (value === current) return
                        setBilling(route.id, { monthlyCNY: value })
                      },
                    }),
                  ),
                  h('span', { className: 'ac-bill-auto-hint' }, '月付直接填这里；季付 / 年付填上面「本次实付」+ 时长'),
                )
              : null,
            quotaPoolRow,
          )
        })()

        /**
         * 订阅折算了才出现的一行：等价金额 → 折合月 → 对上参考月费 → 值不值。
         * 参考月费来自套餐表里同一条线路那几个套餐的最低价；表里没这条线路就留空，
         * 让人在右边自己填。
         */
        const worthRow = (() => {
          if (bill === null || bill.folded !== true) return null
          const busy = billingBusy === route.id
          // 这条线路的等价金额（宿主按线路聚合好放在 subscriptionWorth 里）；
          // 这段没用量或模型没公开价时是 null
          const worth = worthByProvider.get(route.id) || null
          const verdict = worth && worth.verdict ? WORTH_VERDICTS[worth.verdict] || null : null
          const weekly = worth === null ? null : worth.monthlyCNY
          const priceInput = h('input', {
            type: 'number',
            className: 'ac-bill-price',
            key: 'price-' + (bill.monthlyCNY === null || bill.monthlyCNY === undefined ? '' : String(bill.monthlyCNY)),
            defaultValue:
              bill.monthlyCNY === null || bill.monthlyCNY === undefined ? '' : String(bill.monthlyCNY),
            placeholder: '你付的月费',
            min: 0,
            step: 10,
            disabled: busy,
            title: '你实际每月付多少（人民币）。填了就拿它跟等价月费比；留空就用套餐表里的参考价',
            onKeyDown: (event) => {
              if (event.key === 'Enter') event.target.blur()
            },
            onBlur: (event) => {
              const raw = String(event.target.value || '').trim()
              const value = raw === '' ? null : Number(raw)
              if (value !== null && (!Number.isFinite(value) || value <= 0)) return
              const current = bill.monthlyCNY === null || bill.monthlyCNY === undefined ? null : bill.monthlyCNY
              if (value === current) return
              setBilling(route.id, { monthlyCNY: value })
            },
          })
          const parts = [
            h('span', { className: 'ac-bill-label', key: 'l' }, '折算'),
            worth === null
              ? h(
                  'span',
                  { className: 'ac-bill-auto-hint', key: 'v' },
                  dshUsageProviders.has(route.id)
                    ? '这条线路的模型没有公开价，折不出金额'
                    : '这个时间范围里这条线路没有用量，折不出金额',
                )
              : h(
                  'span',
                  { className: 'ac-bill-worth', key: 'v' },
                  '等价 ',
                  h('b', null, fmtPrice(worth.costCNY + worth.costUSD * (worthMeta ? worthMeta.usdToCny : 7.2), 'CNY')),
                  ' · 折合月 ',
                  h('b', null, fmtPrice(weekly === null ? 0 : weekly, 'CNY')),
                ),
            worth !== null && worth.refMin !== null
              ? h(
                  'span',
                  { className: 'ac-bill-auto-hint', key: 'r' },
                  '参考月费 ',
                  worth.refMax !== null && worth.refMax !== worth.refMin
                    ? fmtPrice(worth.refMin, 'CNY') + '–' + fmtPrice(worth.refMax, 'CNY')
                    : fmtPrice(worth.refMin, 'CNY'),
                  worth.refSource === 'tier'
                    ? '（官方档位·国内价）'
                    : worth.refSource === 'paid'
                      ? '（本次实付 ÷ 订阅月数）'
                      : worth.refSource === 'manual'
                        ? '（你填的）'
                        : '（套餐表）',
                )
              : null,
            verdict
              ? h(
                  'span',
                  {
                    className: 'ac-bill-verdict',
                    key: 'd',
                    'data-tone': verdict.tone,
                    title:
                      worth.refSource === 'tier'
                        ? '拿等价月费跟你选的官方档位月付原价（国内价）比：≥1 倍算划算，0.6–1 倍差不多，≤0.6 倍是用得少'
                        : worth.refSource === 'paid'
                          ? '拿等价月费跟「本次实付 ÷ 订阅月数」比：≥1 倍算划算，0.6–1 倍差不多，≤0.6 倍是用得少'
                          : worth.refSource === 'manual'
                            ? '拿等价月费跟你填的月费比：≥1 倍算划算，0.6–1 倍差不多，≤0.6 倍是用得少'
                            : '拿等价月费跟套餐表里这条线路的最低价档比：≥1 倍算划算，0.6–1 倍差不多，≤0.6 倍是用得少',
                  },
                  verdict.text,
                  worth.ratio === null ? '' : ' ' + worth.ratio.toFixed(2) + '×',
                )
              : null,
            // 订阅档的实付价输入已经挪进「订阅详情行」，这里只在 estimate 档保留月费输入，避免两个框打架
            bill.mode === 'credits' ? null : h('span', { className: 'ac-bill-price-wrap', key: 'p' }, priceInput),
          ]
          return h('div', { className: 'ac-bill ac-bill-worth-row' }, ...parts)
        })()

        /**
         * 多账号明细面板（2.7.2）：点头部「N 个账号」展开。
         *
         * 为什么必须能展开 —— **多账号里可能只有部分账号开了订阅**。
         * 只报一个「2 个账号」会让人以为两个都有额度，实际积分是各账号独立的。
         * 这里逐账号摆：是否会员（订阅）、自己的积分余额、套餐到期、今天签到没。
         *
         * 数据来自连接器 /usage 的 pool.accounts（member / credits / planExpiresAtMs）。
         * 拿不到会员信息的渠道（trae 只给账号列表）就标「未知」，不瞎猜。
         */
        const accountsPanel = (() => {
          if (accountsInfo === null || accountsInfo.count <= 1) return null
          if (accountsOpen !== route.id) return null
          const fmtDay = (ms) => {
            if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null
            const d = new Date(ms)
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          }
          // ⚠ 不能用用量栏那个 fmtCredits —— 它在下面才声明（const 箭头函数不提升），
          // 在这里引用会 TDZ 报错、整页消失。这里自己格式化一份。
          const fmtAccCredits = (n) => {
            if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
            if (Math.abs(n) >= 1000) return n.toFixed(0)
            return Number.isInteger(n) ? String(n) : n.toFixed(1)
          }
          return h(
            'div',
            { className: 'ac-accounts' },
            h(
              'div',
              { className: 'ac-accounts-head' },
              '这台机器在这条渠道上加了 ',
              h('b', null, String(accountsInfo.count)),
              ' 个账号',
              accountsInfo.anyMemberKnown
                ? '，其中 ' + String(accountsInfo.memberCount) + ' 个在订阅中' +
                  (accountsInfo.expiredCount > 0 ? '、' + String(accountsInfo.expiredCount) + ' 个订阅已过期' : '') +
                  (accountsInfo.memberCount < accountsInfo.count ? '（未订阅的账号没有套餐额度，只有免费/签到积分）' : '')
                : '（这家连接器没给会员状态，只能看账号本身）',
            ),
            ...accountsInfo.accounts.map((acc) => {
              const isCurrent = acc.id === accountsInfo.currentId
              const planDay = fmtDay(acc.planExpiresAtMs)
              const tokenDay = fmtDay(acc.tokenExpiresAtMs)
              return h(
                'div',
                { className: 'ac-account-row', key: acc.id, 'data-current': isCurrent ? '' : undefined },
                h('span', { className: 'ac-account-name' }, (isCurrent ? '▸ ' : '') + (acc.name || acc.id)),
                h(
                  'span',
                  {
                    className: 'ac-account-member',
                    'data-member': acc.planExpired ? 'expired' : acc.member === true ? 'yes' : acc.member === false ? 'no' : 'unknown',
                  },
                  acc.planExpired
                    ? '订阅已过期'
                    : acc.member === true
                      ? '已订阅'
                      : acc.member === false
                        ? '未订阅'
                        : '订阅未知',
                ),
                acc.credits !== null
                  ? h('span', { className: 'ac-account-fact' }, '积分 ', h('b', null, fmtAccCredits(acc.credits)))
                  : null,
                planDay ? h('span', { className: 'ac-account-fact' }, '套餐到期 ' + planDay) : null,
                !planDay && tokenDay ? h('span', { className: 'ac-account-fact' }, '登录有效至 ' + tokenDay) : null,
                acc.checkedInToday === true ? h('span', { className: 'ac-account-fact' }, '今日已签到') : null,
                acc.enterprise === true ? h('span', { className: 'ac-account-fact' }, '企业版') : null,
                isCurrent ? h('span', { className: 'ac-account-cur' }, '当前在用') : null,
              )
            }),
            h(
              'div',
              { className: 'ac-accounts-note' },
              '积分是各账号独立的 —— 用量栏那条线路的积分只反映当前在用的这个账号。' +
                '多账号轮换时，别把单个账号的余额当成整条线路的额度。',
            ),
          )
        })()

        return h(
          'div',
          {
            className: 'ac-route',
            key: route.id,
            'data-default': isDefault ? '' : undefined,
            // credits → 卡片标蓝（见样式 .ac-route[data-billing="credits"]）
            'data-billing': bill === null ? undefined : bill.mode,
          },
          h(
            'div',
            { className: 'ac-route-head' },
            h('span', {
              className: 'ac-dot',
              'data-state': keyState.key === 'ok' ? 'ok' : keyState.key === 'missing' ? 'warn' : 'idle',
            }),
            h('span', { className: 'ac-route-name' }, route.name),
            h('span', { className: 'ac-route-id' }, route.id),
            bill !== null && bill.mode === 'credits'
              ? h(
                  'span',
                  {
                    className: 'ac-route-subtag',
                    title: bill.manual
                      ? '你手动标成了「订阅 · 不折钱」：这条线路的消耗算套餐额度，不折现金'
                      : '自动判定为「订阅 · 不折钱」：这条线路的消耗算套餐额度，不折现金',
                  },
                  bill.manual ? '订阅 · 手选' : '订阅',
                )
              : null,
            isDefault ? h('span', { className: 'ac-route-tag' }, '当前默认') : null,
            // 多账号（2.7.1，2.7.2 改为可展开）：点开看每个账号的会员 / 积分 / 到期
            accountsInfo !== null && accountsInfo.count > 1
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ac-route-accounts',
                    'data-on': accountsOpen === route.id ? '' : undefined,
                    title: '点开看每个账号的订阅状态与积分 —— 多账号里可能只有部分开了订阅',
                    onClick: () => setAccountsOpen(accountsOpen === route.id ? null : route.id),
                  },
                  String(accountsInfo.count) + ' 个账号',
                  accountsInfo.anyMemberKnown
                    ? ' · ' + String(accountsInfo.memberCount) + '/' + String(accountsInfo.count) + ' 已订阅'
                    : '',
                  accountsOpen === route.id ? ' ▴' : ' ▾',
                )
              : null,
            h('span', { className: 'ac-route-count' }, countText),
          ),
          h(
            'div',
            { className: 'ac-route-facts' },
            h(
              'span',
              { className: 'ac-key', 'data-state': keyState.key },
              keyState.text,
              route.credential && route.credential.ref ? h('code', null, route.credential.ref) : null,
              keySourceLabel(route.credential) ? h('span', null, '· ' + keySourceLabel(route.credential)) : null,
            ),
            route.api ? h('span', null, '协议 ', h('code', null, route.api)) : null,
            route.baseURL ? h('span', null, '端点 ', h('code', null, route.baseURL)) : null,
            route.settingsNs ? h('span', null, '设置 ', h('code', null, route.settingsNs)) : null,
          ),
          route.modelsError ? h('div', { className: 'ac-note' }, '模型清单没读到：' + route.modelsError) : null,
          accountsPanel,
          billingRow,
          cliNote,
          subscriptionRow,
          worthRow,
          route.models.length > 0
            ? h(
                'div',
                { className: 'ac-models' },
                route.models.slice(0, MODEL_CHIP_LIMIT).map((model) =>
                  h(
                    'span',
                    {
                      className: 'ac-model-chip',
                      key: model.id,
                      title: model.name === model.id ? model.id : model.name + ' · ' + model.id,
                      'data-vision':
                        Array.isArray(model.inputModalities) && model.inputModalities.includes('image')
                          ? ''
                          : undefined,
                    },
                    model.name,
                  ),
                ),
                route.models.length > MODEL_CHIP_LIMIT
                  ? h(
                      'span',
                      {
                        className: 'ac-model-chip ac-model-more',
                        title: route.models
                          .slice(MODEL_CHIP_LIMIT)
                          .map((model) => model.name)
                          .join('、'),
                      },
                      '还有 ' + String(route.models.length - MODEL_CHIP_LIMIT) + ' 个',
                    )
                  : null,
              )
            : null,
        )
      }

      const dshBody = [
        dshApi === null
          ? data === null && error === null
            ? h('div', { className: 'ac-state' }, '正在读取接入情况…')
            : h(
                'div',
                { className: 'ac-state' },
                '这次没读到接入情况。',
                h(
                  'button',
                  { type: 'button', className: 'ac-btn', style: { marginLeft: '10px' }, onClick: () => reloadDsh(undefined, true) },
                  '重新读',
                ),
              )
          : null,

        dshApi !== null && dshApi.ok === false && dshApi.error
          ? h('div', { className: 'ac-note' }, '接入清单不完整：' + dshApi.error)
          : null,

        dshApi !== null
          ? h(
              'div',
              { className: 'ac-meta' },
              h('span', null, '线路 ', h('b', null, String(dshTotals.routes)), ' 条'),
              h('span', null, '模型 ', h('b', null, String(dshTotals.models)), ' 个'),
              h('span', null, '密钥已配 ', h('b', null, String(dshTotals.configured)), ' 条'),
              dshTotals.missing > 0
                ? h('span', null, '还缺密钥 ', h('b', null, String(dshTotals.missing)), ' 条')
                : null,
              // 订阅 / 按量 / 折算各几条 —— 一眼看出「哪些线路在花现金」
              dshBilling !== null
                ? h(
                    'span',
                    {
                      title:
                        dshSubscribed.length > 0
                          ? '订阅线路（卡片标蓝）：' + dshSubscribedNames
                          : '现在没有判定成订阅的线路',
                    },
                    '订阅 ',
                    h('b', null, String(dshBilling.byMode.credits || 0)),
                    ' 条 · 按量 ',
                    h('b', null, String(dshBilling.byMode.token || 0)),
                    ' 条',
                    dshBilling.byMode.estimate > 0
                      ? ' · 折算 ' + String(dshBilling.byMode.estimate) + ' 条'
                      : '',
                  )
                : null,
              dshBilling !== null && dshBilling.manual > 0
                ? h(
                    'span',
                    { title: '这几条是你手动标定的，不会跟着白名单变' },
                    '手选 ',
                    h('b', null, String(dshBilling.manual)),
                    ' 条',
                  )
                : null,
              h('span', null, '读于 ', h('b', null, fmtTime(dshApi.at) || '刚刚')),
            )
          : null,

        // 订阅线路一次全列出来：不用滚下去逐个数蓝卡片
        dshApi !== null && dshBilling !== null && dshSubscribed.length > 0
          ? h(
              'div',
              { className: 'ac-sub-line' },
              h('b', null, '订阅套餐 ' + String(dshSubscribed.length) + ' 条'),
              '（卡片标蓝，消耗算套餐额度、不折现金）：',
              dshSubscribed.map((route, index) =>
                h(
                  'span',
                  { key: route.id },
                  index > 0 ? ' · ' : '',
                  h('span', { className: 'ac-sub-name' }, route.name),
                  route.billing && route.billing.manual ? h('span', null, '（手选）') : null,
                  route.billing && route.billing.folded ? h('span', null, '（折算）') : null,
                ),
              ),
            )
          : null,

        // 订阅里开了折算的，把等价月费汇总一行，直接回答「这些套餐值不值」
        dshApi !== null && dshFolded.length > 0
          ? h(
              'div',
              { className: 'ac-sub-line' },
              h('b', null, '订阅 · 折算 ' + String(dshFolded.length) + ' 条'),
              '：',
              dshFolded.map((route, index) => {
                const worth = worthByProvider.get(route.id) || null
                const verdict = worth && worth.verdict ? WORTH_VERDICTS[worth.verdict] || null : null
                return h(
                  'span',
                  { key: route.id },
                  index > 0 ? ' · ' : '',
                  h('span', { className: 'ac-sub-name' }, route.name),
                  worth === null
                    ? h('span', null, dshUsageProviders.has(route.id) ? '（没有公开价，折不出）' : '（这段没用量）')
                    : h(
                        'span',
                        null,
                        ' 折合月 ' + fmtPrice(worth.monthlyCNY, 'CNY'),
                        verdict ? ' → ' + verdict.text : '',
                      ),
                )
              }),
              worthMeta !== null && worthMeta.usdToCny
                ? h(
                    'span',
                    { title: '美元套餐按这个汇率折成人民币，只用来比月费' },
                    '（$1≈¥' + String(worthMeta.usdToCny) + '）',
                  )
                : null,
            )
          : null,

        billingNotice !== null ? h('div', { className: 'ac-bill-notice' }, billingNotice) : null,

        dshDefault !== null
          ? h(
              'div',
              { className: 'ac-dsh-default' },
              h('div', { className: 'ac-dsh-default-label' }, '新会话默认模型'),
              h('div', { className: 'ac-dsh-default-value' }, dshDefault.model),
              h(
                'div',
                { className: 'ac-dsh-default-meta' },
                '走 ' + (dshDefaultRoute ? dshDefaultRoute.name : dshDefault.provider) + ' 这条线路',
                dshDefaultInfo && dshDefaultInfo.contextWindow
                  ? ' · 上下文 ' + fmtContext(Math.round(dshDefaultInfo.contextWindow / 1000))
                  : '',
                dshDefault.reasoningEffort ? ' · 推理 ' + dshDefault.reasoningEffort : '',
              ),
            )
          : null,

        dshApi !== null
          ? h(
              'div',
              { className: 'ac-price-tools' },
              h('span', { className: 'ac-sort-label' }, '所有线路'),
              h(
                'div',
                { className: 'ac-sortbar' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ac-btn',
                    disabled: pending === 'dsh',
                    onClick: () => reloadDsh(undefined, true),
                  },
                  pending === 'dsh' ? '重新读…' : '重新读',
                ),
              ),
            )
          : null,

        dshApi !== null && dshRoutes.length > 0 ? searchBar : null,

        // 未配置的线路默认收起（2.7.1）：给个开关，别让人以为线路丢了
        unconfiguredRoutes.length > 0 && needle === ''
          ? h(
              'div',
              { className: 'ac-unconf-bar' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ac-chip',
                  'data-on': showUnconfigured ? '' : undefined,
                  onClick: () => setShowUnconfigured(!showUnconfigured),
                },
                showUnconfigured
                  ? '收起未配置（' + unconfiguredRoutes.length + '）'
                  : '显示未配置（' + unconfiguredRoutes.length + '）',
              ),
              h(
                'span',
                { className: 'ac-unconf-note' },
                showUnconfigured
                  ? '这些线路本机还没配起来：密钥没填，或压根没有密钥位且一个模型都读不到。'
                  : '已收起 ' + unconfiguredRoutes.length + ' 条本机没配起来的线路（密钥没填 / 空挂的通道）。',
              ),
            )
          : null,

        filteredRoutes.length > 0 ? h('div', { className: 'ac-dsh' }, filteredRoutes.map(routeCard)) : null,

        dshApi !== null && dshRoutes.length === 0
          ? h('div', { className: 'ac-price-empty' }, '这台机器上还没接任何模型线路。')
          : null,

        dshApi !== null && dshRoutes.length > 0 && filteredRoutes.length === 0
          ? h(
              'div',
              { className: 'ac-price-empty' },
              needle !== ''
                ? '没有匹配「' + query.trim() + '」的线路，换个关键词试试。'
                : '配起来的线路一条都没有 —— 点上面「显示未配置」看看都声明了哪些通道。',
            )
          : null,

        dshApi !== null
          ? h(
              'div',
              { className: 'ac-plan-source' },
              '这一栏直接问宿主当下挂着的服务（llm / settings / credentials），打开页面读一次，点「重新读」立刻再问一遍；' +
                '密钥只看「配了没 / 从哪来」，页面上永远不会出现密钥本身。',
            )
          : null,

        dshApi !== null && dshRoutes.length > 0
          ? h(
              'div',
              { className: 'ac-legend' },
              h('span', null, '绿点 密钥已配、能用'),
              h('span', null, '黄点 缺密钥 / 没登录'),
              h('span', null, '灰点 不需要密钥（自带登录）'),
              h('span', null, '带「图」的模型能吃图片'),
              h('span', { className: 'ac-legend-sub' }, '蓝边框 订阅套餐（自动认出或你手标的）'),
              h(
                'span',
                null,
                '「API 按量」真花钱、「订阅」是套餐额度（点开后填订阅形式/时间/实付价）、「折算」按官方价折个参考 —— 判错了点右边按钮自己改',
              ),
            )
          : null,
      ]

      // ---------------------------------------------------------------- 用量花费
      const usage = data && data.usage ? data.usage : null
      const usageSources = usage && Array.isArray(usage.bySource) ? usage.bySource : []
      const usageDays = usage && Array.isArray(usage.byDay) ? usage.byDay : []
      // 「订阅划算吗」：订阅线路开了折算之后，宿主按线路聚合出来的等价月费 vs 参考月费
      const usageWorth = usage && Array.isArray(usage.subscriptionWorth) ? usage.subscriptionWorth : []
      // 实际扣费（DeepSeek 余额差分）：按天对照用
      const actualByDay =
        usage && usage.actualByDay && typeof usage.actualByDay === 'object' ? usage.actualByDay : {}
      const usageTotals = (usage && usage.totals) || null
      // 官网实时价核对结果（宿主拉的）。拉到就以官网为准算，拉不到用本地快照
      const officialPricing = data && data.officialPricing ? data.officialPricing : null
      // 官方导出的用量账单（CSV）—— 权威口径
      const officialUsage = data && data.officialUsage ? data.officialUsage : null
      // 时间轴（按会话分段）：provider → { from, to, rows, bucketMs }
      const timeline = usage && usage.timeline ? usage.timeline : null
      const timelineOf = (provider) => {
        if (timeline === null || !timeline.providers) return null
        const entry = timeline.providers[provider]
        if (!entry || !Array.isArray(entry.rows) || entry.rows.length === 0) return null
        return { ...entry, bucketMs: timeline.bucketMs }
      }

      // 两类线路分开看：按 token 计费的要折钱，订阅/额度制的只报 token 和积分
      // 积分账是页面这边问来的，合并进行里再用
      const creditBooks = (usage && usage.creditBalances) || {}
      const withBalance = (row) => {
        if (row.billing !== 'credits') return row
        const book = creditBooks[row.provider]
        if (!book) return row
        return {
          ...row,
          creditConsumed: book.consumed,
          creditRemaining: book.remaining,
          creditTotal: book.total,
          creditAccount: book.accountName,
        }
      }
      // 三类线路：
      //   token    按量付费，金额是真金白银的折算
      //   estimate 套餐/订阅，金额只是「按官方价买要多少」的等价参考
      //   credits  纯套餐，不折金额
      // 全局搜索只过滤**行列表**，顶部汇总卡片仍按全量算（不然搜一下总账就变，吓一跳）
      const usageSearchHit = (row) => searchMatches([row.provider, row.model, row.routeLabel || ''])
      const tokenSources = usageSources.filter((row) => row.billing === 'token' && usageSearchHit(row))
      const estimateSources = usageSources.filter((row) => row.billing === 'estimate' && usageSearchHit(row))
      const creditSources = usageSources.filter((row) => row.billing === 'credits' && usageSearchHit(row)).map(withBalance)

      // DeepSeek 系（能对上余额差分的两条）—— 单独算，用来跟实际扣费比
      const deepseekSources = tokenSources.filter(
        (row) => row.provider === 'deepseek-official' || row.provider === 'deepseek-account',
      )
      const deepseekCostCNY = deepseekSources.reduce((sum, row) => sum + (row.cost || 0), 0)
      // 扣余额之外的按量平台（硅基 / 火山 / TokenPlus）——它们的钱不进 DeepSeek 余额
      const otherPlatformCostCNY = tokenSources
        .filter((row) => !deepseekSources.includes(row))
        .reduce((sum, row) => sum + (row.currency === 'CNY' ? row.cost || 0 : 0), 0)

      /**
       * 订阅线路按「线路」聚合。
       *
       * 官方给的积分是**整条线路**的累计值，没有按模型拆分 —— 所以不能每个模型
       * 都挂同一个积分数字（看着像每个模型各花了这么多）。这里一条线路一张卡，
       * 积分挂在线路级，模型只列 token 和占比。
       */
      const creditRoutes = []
      {
        const byProvider = new Map()
        for (const row of creditSources) {
          let bucket = byProvider.get(row.provider)
          if (bucket === undefined) {
            bucket = {
              provider: row.provider,
              routeLabel: row.routeLabel || row.provider,
              creditConsumed: row.creditConsumed,
              creditRemaining: row.creditRemaining,
              creditTotal: row.creditTotal,
              creditAccount: row.creditAccount,
              creditSupported: row.creditSupported !== false,
              calls: 0,
              totalTokens: 0,
              models: [],
            }
            byProvider.set(row.provider, bucket)
          }
          bucket.calls += row.calls
          bucket.totalTokens += row.totalTokens
          bucket.models.push(row)
        }
        for (const bucket of byProvider.values()) {
          bucket.models.sort((a, b) => b.totalTokens - a.totalTokens)
          creditRoutes.push(bucket)
        }
        creditRoutes.sort((a, b) => b.totalTokens - a.totalTokens)
      }
      const maxCreditTokens = creditRoutes.reduce(
        (max, route) => (route.totalTokens > max ? route.totalTokens : max),
        0,
      )
      const windowTabs =
        usage && Array.isArray(usage.windows) && usage.windows.length > 0
          ? usage.windows
          : [
              { key: 'day', label: '今天' },
              { key: 'week', label: '近 7 天' },
              { key: 'month', label: '近 30 天' },
            ]
      const activeWindow = usageWindow

      const fmtTokens = (n) => {
        if (!Number.isFinite(n) || n <= 0) return '0'
        if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
        if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
        if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
        return String(Math.round(n))
      }
      const fmtMoney = (n, currency) => {
        if (!Number.isFinite(n)) return '—'
        const symbol = currency === 'USD' ? '$' : '¥'
        return symbol + (n >= 100 ? n.toFixed(1) : n.toFixed(2))
      }
      /** 积分：整数不带小数点，小数留一位 */
      const fmtCredits = (n) => {
        if (!Number.isFinite(n)) return '—'
        if (Math.abs(n) >= 1000) return n.toFixed(0)
        return Number.isInteger(n) ? String(n) : n.toFixed(1)
      }

      /** 等价金额按天折成月时用的倍数（30 天口径） */
      const worthScale =
        usage && usage.worthMeta && usage.worthMeta.windowDays ? 30 / usage.worthMeta.windowDays : 1

      /**
       * 折算明细：点开「订阅划算吗」一行（或订阅卡上的「折合月」）才展开的东西。
       *
       * 三块：
       *   1. 模型 × 单价 —— 等价金额是「这堆 token 乘官方单价」出来的，逐条摊开能自己核对
       *   2. 按天 —— 哪几天用得凶，等价金额怎么随时间摊开
       *   3. 参考月费从哪来 —— 套餐表里对得上的那几个档位，或你手填的数
       *
       * 这些都在宿主的 `subscriptionWorth` 里，没拉到就什么都不显示（不编数字）。
       */
      const worthDetail = (row) => {
        if (!row || typeof row !== 'object') return null
        const modelRows = Array.isArray(row.modelRows) ? row.modelRows : []
        const dayRows = Array.isArray(row.byDay) ? row.byDay : []
        const maxModelCost = modelRows.reduce((max, m) => (m.costCNY > max ? m.costCNY : max), 0)
        const maxDayCost = dayRows.reduce((max, d) => (d.costCNY > max ? d.costCNY : max), 0)
        const total = row.totalTokens > 0 ? row.totalTokens : 1

        const modelBlock =
          modelRows.length === 0
            ? h('div', { className: 'ac-worth-empty' }, '这个时间范围里没有可折算的模型明细。')
            : h(
                'div',
                { className: 'ac-worth-models' },
                modelRows.map((m) =>
                  h(
                    'div',
                    { className: 'ac-worth-model', key: m.model },
                    h('span', { className: 'ac-worth-model-name' }, m.model),
                    h(
                      'span',
                      { className: 'ac-worth-model-bar' },
                      h('i', { style: { width: Math.max(1, (m.totalTokens / total) * 100).toFixed(1) + '%' } }),
                    ),
                    h('span', { className: 'ac-worth-model-tokens' }, fmtTokens(m.totalTokens)),
                    h('span', { className: 'ac-worth-model-cost' }, fmtPrice(m.costCNY, 'CNY')),
                    h('span', { className: 'ac-worth-model-month' }, '月 ' + fmtPrice(m.monthlyCNY, 'CNY')),
                    m.priceProvider === null || m.priceProvider === undefined
                      ? h('span', { className: 'ac-worth-model-price', 'data-unpriced': '' }, '没有公开价')
                      : h(
                          'span',
                          {
                            className: 'ac-worth-model-price',
                            title:
                              (m.pricingUrl ? '单价来自 ' + m.pricingUrl + ' · ' : '') +
                              (m.alias ? '模型 id 归到 ' + m.alias + ' 计价' : ''),
                          },
                          m.priceProvider,
                          ' ¥' + String(m.priceInput) + ' / ¥' + String(m.priceOutput),
                          m.priceCacheRead ? ' / 缓存 ¥' + String(m.priceCacheRead) : '',
                          ' 每 M',
                          m.priceDate ? ' · ' + m.priceDate : '',
                          m.alias ? ' · 按 ' + m.alias : '',
                        ),
                  ),
                ),
              )

        const dayBlock =
          dayRows.length === 0
            ? null
            : h(
                'div',
                { className: 'ac-worth-days' },
                h(
                  'div',
                  { className: 'ac-worth-detail-head' },
                  '按天',
                  h('span', { className: 'ac-worth-detail-sub' }, '每天的等价金额（不是账单）'),
                ),
                dayRows.slice(0, 14).map((d) =>
                  h(
                    'div',
                    { className: 'ac-worth-day', key: d.day },
                    h('span', { className: 'ac-worth-day-date' }, d.day),
                    h(
                      'span',
                      { className: 'ac-worth-day-bar' },
                      h('i', {
                        style: {
                          width:
                            maxDayCost <= 0
                              ? '0%'
                              : Math.max(1, (d.costCNY / maxDayCost) * 100).toFixed(1) + '%',
                        },
                      }),
                    ),
                    h('span', { className: 'ac-worth-day-cost' }, fmtPrice(d.costCNY, 'CNY')),
                    h('span', { className: 'ac-worth-day-tokens' }, fmtTokens(d.tokens) + ' · ' + String(d.calls) + ' 次'),
                  ),
                ),
              )

        // 参考月费：手填的 > 套餐表的 > 都没有
        const planRef = row.planRef && Array.isArray(row.planRef.plans) ? row.planRef.plans : []
        const refBlock = h(
          'div',
          { className: 'ac-worth-refbox' },
          h(
            'div',
            { className: 'ac-worth-detail-head' },
            '参考月费',
            h(
              'span',
              { className: 'ac-worth-detail-sub' },
              row.refSource === 'tier'
                ? '你选的官方档位月付原价（国内价，cn-tiers.js）—— 促销价另记在实付里'
                : row.refSource === 'paid'
                  ? '本次实付 ÷ 订阅月数（年付摊到月）—— 在「接入情况」里填的'
                  : row.refSource === 'manual'
                    ? '你在「接入情况」里填的数'
                    : row.refSource === 'plan'
                      ? '套餐表（plans.js）里这条线路对得上的档位，取最低一档比'
                      : '没有参考价 —— 去「接入情况」这条线路右边填你实际付的月费',
            ),
          ),
          planRef.length > 0
            ? h(
                'div',
                { className: 'ac-worth-plans' },
                planRef.map((plan) =>
                  h(
                    'span',
                    { className: 'ac-worth-plan', key: plan.id },
                    plan.title,
                    ' ',
                    h('b', null, fmtPrice(plan.price, plan.currency)),
                  ),
                ),
              )
            : null,
          row.refSource === 'paid' && row.refMin !== null
            ? h(
                'div',
                { className: 'ac-worth-plans' },
                h(
                  'span',
                  { className: 'ac-worth-plan' },
                  '本次实付 ',
                  h('b', null, row.paid ? fmtPrice(row.paid.total, row.paid.currency) : fmtPrice(row.refMin, 'CNY')),
                  row.termMonths ? ' ÷ ' + String(row.termMonths) + ' 个月 = ' : ' → ',
                  h('b', null, fmtPrice(row.refMin, 'CNY')),
                  ' / 月',
                ),
              )
            : row.refSource === 'manual' && row.refMin !== null
              ? h('div', { className: 'ac-worth-plans' }, h('span', { className: 'ac-worth-plan' }, '你填 ', h('b', null, fmtPrice(row.refMin, 'CNY')), ' / 月'))
              : null,
        )

        return h(
          'div',
          { className: 'ac-worth-detail' },
          h(
            'div',
            { className: 'ac-worth-detail-head' },
            '模型明细',
            h(
              'span',
              { className: 'ac-worth-detail-sub' },
              '等价金额 = token × 官方单价；折合月按 ' + String(Math.round(worthScale)) + '× 折成 30 天',
            ),
          ),
          modelBlock,
          dayBlock,
          refBlock,
        )
      }

      const spendCard = (label, value, unit, sub, accent) =>
        h(
          'div',
          { className: 'ac-spend-card', 'data-accent': accent ? '' : undefined },
          h('div', { className: 'ac-spend-label' }, label),
          h(
            'div',
            { className: 'ac-spend-value' },
            value,
            unit ? h('span', { className: 'ac-spend-unit' }, unit) : null,
          ),
          sub ? h('div', { className: 'ac-spend-sub' }, sub) : null,
        )

      // 花费条按最大的一条算宽度，避免几千倍差距时小的那条看不见
      const maxSourceCost = usageSources.reduce(
        (max, row) => (row.cost !== null && row.cost > max ? row.cost : max),
        0,
      )
      // 按天那条的比例尺用 DeepSeek 系的金额（这一栏专门跟余额对账）
      const maxDayCost = usageDays.reduce((max, row) => {
        const v = typeof row.costCNYDeepSeek === 'number' ? row.costCNYDeepSeek : row.costCNY
        return v > max ? v : max
      }, 0)

      /**
       * 时间轴面板：按会话分段，横轴是时间。
       *
       * 每一行是一个会话（子会话按 parentSession 缩进挂在父会话下面）；
       * 行内那些小柱子是「这一小时消耗了多少 token」，高度按 sqrt 缩放 ——
       * 直接线性画的话，几十 M 的大桶会把几百 K 的小桶压成看不见的点。
       */
      const timelinePanel = (provider) => {
        const tl = timelineOf(provider)
        if (tl === null) {
          return h('div', { className: 'ac-tl' }, h('div', { className: 'ac-tl-empty' }, '这个时间范围里没有可用的会话明细。'))
        }
        const axisFrom = tl.from
        const axisTo = Math.max(tl.to, tl.from + tl.bucketMs)
        const span = axisTo - axisFrom
        const pct = (ms) => (span <= 0 ? 0 : ((ms - axisFrom) / span) * 100)

        // 强度基准：把所有点里最大的那个当 100%
        let maxPoint = 0
        for (const row of tl.rows) {
          for (const point of row.points) {
            if (point[1] > maxPoint) maxPoint = point[1]
          }
        }

        // 横轴刻度：均匀取 5 个，按跨度决定显示到「日」还是「时」
        const showHour = span <= 36 * 60 * 60 * 1000
        const ticks = []
        const TICK_COUNT = 5
        for (let i = 0; i < TICK_COUNT; i++) {
          const at = axisFrom + (span * i) / (TICK_COUNT - 1)
          const d = new Date(at)
          ticks.push({
            left: (i / (TICK_COUNT - 1)) * 100,
            label:
              String(d.getMonth() + 1).padStart(2, '0') +
              '-' +
              String(d.getDate()).padStart(2, '0') +
              (showHour ? ' ' + String(d.getHours()).padStart(2, '0') + ':00' : ''),
          })
        }

        const bucketPct = Math.max(0.15, (tl.bucketMs / span) * 100)

        return h(
          'div',
          { className: 'ac-tl' },
          h(
            'div',
            { className: 'ac-tl-head' },
            h('span', null, '按会话分段 · 横轴时间'),
            h('span', { className: 'ac-tl-sub' },
              tl.rows.length + ' 个会话' +
                (tl.truncated > 0 ? '（还有 ' + tl.truncated + ' 个未画出）' : '') +
                ' · 每格 ' + (tl.bucketMs >= 3600000 ? tl.bucketMs / 3600000 + ' 小时' : tl.bucketMs / 60000 + ' 分钟'),
            ),
          ),
          // 横轴
          h(
            'div',
            { className: 'ac-tl-axis' },
            ticks.map((tick, i) =>
              h(
                'span',
                {
                  className: 'ac-tl-tick',
                  key: 'tick-' + i,
                  style: i === 0 ? { left: '0', transform: 'none' } : i === ticks.length - 1 ? { left: '100%', transform: 'translateX(-100%)' } : { left: tick.left + '%', transform: 'translateX(-50%)' },
                },
                tick.label,
              ),
            ),
          ),
          h(
            'div',
            { className: 'ac-tl-rows' },
            tl.rows.map((row) =>
              h(
                'div',
                { className: 'ac-tl-row', key: row.sessionId },
                h(
                  'span',
                  { className: 'ac-tl-name', title: (row.cwd || '') + '\n' + row.sessionId },
                  h('span', { className: 'ac-tl-indent', style: { width: row.depth * 11 + 'px' } }),
                  row.title || '（无标题会话）',
                ),
                h(
                  'span',
                  { className: 'ac-tl-track' },
                  // 会话活跃区间：淡淡一条底线，让人看出这段是连续的
                  h('i', {
                    className: 'ac-tl-span',
                    style: {
                      left: pct(row.from) + '%',
                      width: Math.max(0.4, pct(row.to) - pct(row.from)) + '%',
                    },
                  }),
                  row.points.map((point, i) =>
                    h('i', {
                      className: 'ac-tl-bar',
                      key: 'p' + i,
                      style: {
                        left: pct(point[0]) + '%',
                        width: bucketPct + '%',
                        height:
                          (maxPoint <= 0
                            ? 2
                            : 2 + Math.sqrt(point[1] / maxPoint) * 16).toFixed(1) + 'px',
                      },
                      title:
                        new Date(point[0]).toLocaleString('zh-CN') +
                        ' · ' +
                        (point[1] >= 1e6
                          ? (point[1] / 1e6).toFixed(2) + 'M'
                          : (point[1] / 1e3).toFixed(1) + 'K') +
                        ' tokens · ' +
                        point[2] +
                        ' 次',
                    }),
                  ),
                ),
                h(
                  'span',
                  { className: 'ac-tl-total' },
                  row.tokens >= 1e9
                    ? (row.tokens / 1e9).toFixed(2) + 'B'
                    : row.tokens >= 1e6
                      ? (row.tokens / 1e6).toFixed(1) + 'M'
                      : (row.tokens / 1e3).toFixed(0) + 'K',
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ac-tl-foot' },
            '柱子高度 = 该时段 token 量（平方根缩放，便于看清小桶）；把鼠标停在柱子上能看具体数值。',
          ),
        )
      }

      /** 一条线路一张条。billing='estimate' 时金额标「等价」 */
      const usageRow = (row) => {
        const unpriced = row.cost === null
        const isEstimate = row.billing === 'estimate'
        const width =
          unpriced || maxSourceCost <= 0 ? 0 : Math.max(2, (row.cost / maxSourceCost) * 100)

        // 分时价：把高峰 / 空闲各花了多少摆出来
        const hasPeak = row.hasPeakPricing === true
        const peakShare =
          hasPeak && row.totalTokens > 0 ? (row.peakTokens / row.totalTokens) * 100 : 0

        const open = expanded === row.provider
        const canOpen = timelineOf(row.provider) !== null

        return h(
          'div',
          {
            className: 'ac-usage-row',
            'data-unpriced': unpriced ? '' : undefined,
            'data-billing': isEstimate ? 'estimate' : 'token',
            // 可展开的行给个手型，点了出时间轴
            'data-expandable': canOpen ? '' : undefined,
            'data-open': open ? '' : undefined,
            key: row.provider + '|' + row.model,
          },
          h(
            'div',
            {
              className: 'ac-usage-head',
              onClick: canOpen
                ? () => setExpanded((prev) => (prev === row.provider ? null : row.provider))
                : undefined,
            },
            canOpen ? h('span', { className: 'ac-caret' }, open ? '▾' : '▸') : null,
            h('span', { className: 'ac-usage-provider' }, row.provider),
            isEstimate
              ? h('span', { className: 'ac-usage-tag' }, '等价参考')
              : null,
            h('span', { className: 'ac-usage-model' }, row.model),
            h(
              'span',
              { className: 'ac-usage-cost', 'data-unpriced': unpriced ? '' : undefined },
              unpriced ? '没有标价' : fmtMoney(row.cost, row.currency),
            ),
          ),
          h(
            'div',
            { className: 'ac-usage-facts' },
            h('span', null, '调用 ', h('b', null, String(row.calls))),
            h('span', null, '未命中输入 ', h('b', null, fmtTokens(row.inputTokens))),
            h('span', null, '命中输入 ', h('b', null, fmtTokens(row.cacheReadTokens))),
            h('span', null, '输出 ', h('b', null, fmtTokens(row.outputTokens))),
            h('span', null, '合计 ', h('b', null, fmtTokens(row.totalTokens))),
          ),

          // 峰谷拆分条：只有分时价的厂商才显示
          hasPeak
            ? h(
                'div',
                { className: 'ac-peakbar' },
                h(
                  'span',
                  { className: 'ac-peakbar-label' },
                  '高峰 ',
                  h('b', null, fmtMoney(row.costPeak || 0, row.currency)),
                  ' · ',
                  peakShare.toFixed(1) + '% tokens',
                ),
                h(
                  'span',
                  { className: 'ac-peakbar-track' },
                  h('i', { style: { width: Math.max(1, peakShare).toFixed(1) + '%' } }),
                ),
                h(
                  'span',
                  { className: 'ac-peakbar-label' },
                  '空闲 ',
                  h('b', null, fmtMoney(row.costOffPeak || 0, row.currency)),
                  ' · ',
                  (100 - peakShare).toFixed(1) + '% tokens',
                ),
              )
            : null,

          // 官方账单对比：官方金额 / 折算金额 / 差。有官方 CSV 才显示
          row.officialKey
            ? (() => {
                const off = row.officialKey
                const mineCost = row.cost === null ? null : row.cost
                const gap = mineCost === null ? null : mineCost - off.cost
                const gapPct = mineCost === null || off.cost <= 0 ? null : (gap / off.cost) * 100
                // 有些调用有请求但日志没记 usage（搜索 / 标题生成），次数算上它们再对比
                const extra = row.extraCalls || null
                const mineTotalCalls = row.calls + (extra ? extra.total : 0)
                const reqGap = off.requests - mineTotalCalls
                return h(
                  'div',
                  { className: 'ac-offcmp' },
                  h(
                    'span',
                    { className: 'ac-offcmp-item' },
                    '官方 ',
                    h('b', null, fmtMoney(off.cost, row.currency || 'CNY')),
                    h('span', { className: 'ac-offcmp-sub' }, ' · key「' + off.key + '」'),
                  ),
                  h(
                    'span',
                    { className: 'ac-offcmp-item' },
                    '折算 ',
                    h('b', null, mineCost === null ? '—' : fmtMoney(mineCost, row.currency || 'CNY')),
                    gap === null
                      ? null
                      : h(
                          'span',
                          { className: 'ac-offcmp-gap', 'data-big': Math.abs(gapPct) >= 3 ? '' : undefined },
                          ' ' + (gap >= 0 ? '+' : '') + gap.toFixed(2) + '（' +
                            (gapPct >= 0 ? '+' : '') + gapPct.toFixed(1) + '%）',
                        ),
                  ),
                  // 请求数：官方 vs 日志（含无 usage 的那几类）
                  h(
                    'span',
                    { className: 'ac-offcmp-item' },
                    '请求 官方 ',
                    h('b', null, String(off.requests)),
                    ' / 日志 ',
                    h('b', null, String(mineTotalCalls)),
                    reqGap > 0 ? '（仍缺 ' + reqGap + '）' : reqGap < 0 ? '（多 ' + -reqGap + '）' : '',
                  ),
                  extra && extra.total > 0
                    ? h(
                        'span',
                        { className: 'ac-offcmp-item' },
                        '无 usage ',
                        h('b', null, String(extra.total)),
                        ' 次' +
                          (extra.search > 0 ? '（搜索 ' + extra.search + '）' : '') +
                          (extra.title > 0 ? '（标题 ' + extra.title + '）' : ''),
                      )
                    : null,
                  off.fnCalls > 0
                    ? h(
                        'span',
                        { className: 'ac-offcmp-item' },
                        '官方搜索计费 ',
                        h('b', null, off.fnCalls + ' 次'),
                        '（¥' + (off.fnCalls * 0.005).toFixed(2) + '，不计入 token）',
                      )
                    : null,
                )
              })()
            : null,

          unpriced
            ? h(
                'div',
                { className: 'ac-usage-note' },
                '这条线路报的模型名（' + row.model + '）对不上价格表，只统计用量、不折金额。',
              )
            : hasPeak
              ? h(
                  'div',
                  { className: 'ac-usage-note' },
                  (isEstimate ? '【等价参考，不是账单】这条是套餐渠道，不按 token 扣现金；' : '') +
                    '按 ' +
                    row.priceProvider +
                    ' 官方分时价折（每百万 tokens）—— 高峰：未命中 ' +
                    row.priceInput +
                    ' / 命中 ' +
                    row.priceCacheRead +
                    ' / 输出 ' +
                    row.priceOutput +
                    '；空闲：未命中 ' +
                    row.priceInputOffPeak +
                    ' / 命中 ' +
                    row.priceCacheReadOffPeak +
                    ' / 输出 ' +
                    row.priceOutputOffPeak +
                    '。' +
                    (row.peakNote ? row.peakNote + '。' : '') +
                    (row.alias ? '（' + row.model + ' 按 ' + row.alias + ' 计价）' : ''),
                )
              : h(
                  'div',
                  { className: 'ac-usage-note' },
                  '按 ' +
                    row.priceProvider +
                    ' 标价折：未命中输入 ' +
                    row.priceInput +
                    ' / 输出 ' +
                    row.priceOutput +
                    ' / 命中输入 ' +
                    row.priceCacheRead +
                    ' 每百万 tokens' +
                    (row.alias ? '（' + row.model + ' 按 ' + row.alias + ' 计价）' : '') +
                    (row.cacheReadFromNote ? '' : '；缓存价按标价一成估'),
                ),
          h(
            'div',
            { className: 'ac-usage-bar' },
            h('i', { style: { width: width + '%' } }),
          ),
          // 展开时在行内显示时间轴
          open ? timelinePanel(row.provider) : null,
        )
      }

      /**
       * 订阅线路：一条线路一张卡。
       *
       * 积分挂在**线路级**（官方只给整条线路的累计消耗），模型只列 token 和占比 ——
       * 每个模型都挂同一个积分会让人以为每个模型各花了这么多。
       */
      const creditRouteCard = (route) => {
        const hasConsumed =
          route.creditConsumed !== undefined &&
          route.creditConsumed !== null &&
          route.creditConsumed > 0
        // 这条订阅线路打开了折算的话，等价金额 / 折合月费在这（宿主按线路聚合好的）
        const routeWorth = usageWorth.find((item) => item.provider === route.provider) || null
        // 订阅线路同样能展开时间轴（token 用量是按会话记的，跟计费方式无关）
        const creditOpen = expanded === route.provider
        const creditCanOpen = timelineOf(route.provider) !== null
        const width =
          maxCreditTokens <= 0 ? 0 : Math.max(2, (route.totalTokens / maxCreditTokens) * 100)
        const right = hasConsumed
          ? '耗 ' + fmtCredits(route.creditConsumed) + ' 积分'
          : route.creditRemaining === null || route.creditRemaining === undefined
            ? route.creditSupported
              ? '积分未知'
              : '只看 token'
            : '剩 ' + fmtCredits(route.creditRemaining) + ' 积分'

        // 模型占比：按 token 分，合计 100%
        const share = (model) =>
          route.totalTokens <= 0 ? 0 : (model.totalTokens / route.totalTokens) * 100

        return h(
          'div',
          {
            className: 'ac-usage-row',
            'data-billing': 'credits',
            'data-expandable': creditOpen ? '' : undefined,
            'data-open': creditOpen ? '' : undefined,
            key: 'credit-' + route.provider,
          },
          h(
            'div',
            {
              className: 'ac-usage-head',
              onClick: creditCanOpen
                ? () => setExpanded((prev) => (prev === route.provider ? null : route.provider))
                : undefined,
            },
            creditCanOpen ? h('span', { className: 'ac-caret' }, creditOpen ? '▾' : '▸') : null,
            h('span', { className: 'ac-usage-provider' }, route.provider),
            h(
              'span',
              { className: 'ac-usage-model' },
              route.models.length === 1 ? route.models[0].model : route.models.length + ' 个模型',
            ),
            h('span', { className: 'ac-usage-cost' }, right),
          ),
          h(
            'div',
            { className: 'ac-usage-facts' },
            h('span', null, '调用 ', h('b', null, String(route.calls))),
            h('span', null, '合计 ', h('b', null, fmtTokens(route.totalTokens))),
            hasConsumed && route.creditRemaining !== null && route.creditRemaining !== undefined
              ? h('span', null, '还剩 ', h('b', null, fmtCredits(route.creditRemaining) + ' 积分'))
              : null,
            route.creditTotal !== null && route.creditTotal !== undefined
              ? h('span', null, '总额度 ', h('b', null, fmtCredits(route.creditTotal) + ' 积分'))
              : null,
            routeWorth !== null
              ? (() => {
                  const worthKey = 'worth:' + route.provider
                  const worthOpen = expanded === worthKey
                  return h(
                    'span',
                    {
                      className: 'ac-worth-inline',
                      'data-open': worthOpen ? '' : undefined,
                      onClick: () => setExpanded((prev) => (prev === worthKey ? null : worthKey)),
                      title: '点开看折算明细：每个模型的单价与金额、按天分布、参考月费来源',
                    },
                    h('span', { className: 'ac-caret' }, worthOpen ? '▾' : '▸'),
                    '等价 ',
                    h(
                      'b',
                      null,
                      fmtPrice(
                        routeWorth.costCNY + routeWorth.costUSD * (worthMeta ? worthMeta.usdToCny : 7.2),
                        'CNY',
                      ),
                    ),
                    ' · 折合月 ',
                    h('b', null, fmtPrice(routeWorth.monthlyCNY, 'CNY')),
                    routeWorth.verdict
                      ? ' · ' + (WORTH_VERDICTS[routeWorth.verdict] ? WORTH_VERDICTS[routeWorth.verdict].text : '')
                      : '',
                  )
                })()
              : null,
          ),
          routeWorth !== null && expanded === 'worth:' + route.provider ? worthDetail(routeWorth) : null,

          // 模型明细：token 与占比，不挂积分
          route.models.length > 0
            ? h(
                'div',
                { className: 'ac-credit-models' },
                route.models.map((model) =>
                  h(
                    'div',
                    { className: 'ac-credit-model', key: model.model },
                    h('span', { className: 'ac-credit-model-name' }, model.model),
                    h(
                      'span',
                      { className: 'ac-credit-model-bar' },
                      h('i', { style: { width: Math.max(1, share(model)).toFixed(1) + '%' } }),
                    ),
                    h('span', { className: 'ac-credit-model-pct' }, share(model).toFixed(1) + '%'),
                    h('span', { className: 'ac-credit-model-tokens' }, fmtTokens(model.totalTokens)),
                    h('span', { className: 'ac-credit-model-calls' }, String(model.calls) + ' 次'),
                  ),
                ),
              )
            : null,

          h(
            'div',
            { className: 'ac-usage-note' },
            hasConsumed
              ? '整条线路累计已耗 ' +
                fmtCredits(route.creditConsumed) +
                ' 积分（官方口径，累计值、不随上面的时间范围变）' +
                (route.creditAccount ? '，账号 ' + route.creditAccount : '') +
                '。官方没有按模型拆分的消耗数据，所以下面的百分比只表示 ' +
                'token 用量占比，不是积分占比。'
              : route.creditSupported
                ? '订阅线路，消耗的是额度不是现金。没拿到积分账，可能没登录或没开这家连接器。'
                : '订阅线路，消耗的是额度不是现金。这家没有开放积分查询接口，只能看 token 用量。',
          ),
          h(
            'div',
            { className: 'ac-usage-bar' },
            h('i', { style: { width: width + '%' } }),
          ),
          creditOpen ? timelinePanel(route.provider) : null,
        )
      }

      const usageBody = [
        usage === null
          ? null
          : h(
              'div',
              { className: 'ac-meta' },
              h('span', null, '日志 ', h('b', null, String(usage.scannedFiles || 0)), ' 个文件'),
              h('span', null, '消息 ', h('b', null, String(usage.scannedMessages || 0)), ' 条'),
              h('span', null, '读于 ', h('b', null, fmtTime(usage.at))),
              // fork / 分支会话复制的历史事件 —— 已剔除，有才显示
              usageTotals && usageTotals.dedupedCalls > 0
                ? h(
                    'span',
                    { title: 'fork / 分支会话会原样复制父会话的历史事件（时间戳和 usage 都相同），这些已从统计中剔除' },
                    '已去重 ',
                    h('b', null, String(usageTotals.dedupedCalls)),
                    ' 条' +
                      (usageTotals.dedupedTokens > 0 ? '（' + fmtTokens(usageTotals.dedupedTokens) + ' tokens）' : ''),
                  )
                : null,
              // 官网价核对状态：拉到就以官网为准算，拉不到才用本地快照
              officialPricing !== null
                ? h(
                    'span',
                    { 'data-ok': officialPricing.ok ? '' : undefined },
                    'DeepSeek 官网价 ',
                    officialPricing.ok
                      ? h('b', null, '已核对')
                      : h('b', null, '没拉到（用本地快照）'),
                    officialPricing.ok ? '' : ' · ' + (officialPricing.error || ''),
                  )
                : null,
            ),

        usage !== null && usage.error ? h('div', { className: 'ac-error' }, usage.error) : null,

        // 时间范围：今天 / 近 7 天 / 近 30 天
        usage !== null
          ? h(
              'div',
              { className: 'ac-tabs', style: { marginTop: '14px' } },
              windowTabs.map((item) =>
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ac-tab',
                    'data-on': item.key === activeWindow ? '' : undefined,
                    key: item.key,
                    onClick: () => {
                      if (item.key !== activeWindow) setUsageWindow(item.key)
                    },
                  },
                  item.label,
                ),
              ),
            )
          : null,

        usage !== null ? searchBar : null,
        usage !== null && needle !== ''
          ? h('div', { className: 'ac-group-note' }, '搜索只过滤下面的明细行，顶部汇总仍是全量数字。')
          : null,

        usageTotals !== null
          ? h(
              'div',
              { className: 'ac-spend', style: { marginTop: '12px' } },
              // 官方账单（CSV 导入）—— 有就以它为准，这是唯一能拿到官方计费口径的途径
              officialUsage !== null && officialUsage.ok === true && officialUsage.totals
                ? spendCard(
                    '官方账单',
                    fmtMoney(officialUsage.totals.cost, 'CNY'),
                    '',
                    (officialUsage.range
                      ? officialUsage.range.from.slice(5) + '~' + officialUsage.range.to.slice(5) +
                        ' · ' + officialUsage.range.days + ' 天有数据'
                      : '') +
                      ' · ' + officialUsage.byKey.length + ' 个 key · 含搜索 ¥' +
                      (officialUsage.totals.fnCost || 0).toFixed(2) +
                      (officialUsage.totals.overcount > 0.01
                        ? ' · 已去重（不去重会算 ¥' + officialUsage.totals.rawCost.toFixed(2) + '）'
                        : ''),
                    true,
                  )
                : null,
              spendCard(
                '按标价折算',
                fmtMoney(usageTotals.costCNY, 'CNY'),
                '',
                usageTotals.costUSD > 0
                  ? '另有 $' + usageTotals.costUSD.toFixed(2)
                  : '按量渠道 · ' + tokenSources.length + ' 条',
              ),
              // 实际扣费：DeepSeek 账户余额差分。只跟 DeepSeek 系的那两条比才同口径 ——
              // 硅基 / 火山 / TokenPlus 的钱不进这个余额
              typeof usageTotals.actualCNY === 'number'
                ? spendCard(
                    '实际扣费',
                    fmtMoney(usageTotals.actualCNY, 'CNY'),
                    '',
                    'DeepSeek 余额差分 · ' +
                      usageTotals.actualDays +
                      ' 天 · 对应上方 DeepSeek 系 ¥' +
                      deepseekCostCNY.toFixed(2),
                  )
                : spendCard('实际扣费', '—', '', '本机没有 DeepSeek 余额账本'),
              spendCard(
                '计费 tokens',
                fmtTokens(
                  usageTotals.totalTokens - (usageTotals.creditTokens || 0),
                ),
                '',
                tokenSources.length + ' 条按 token 计费的线路',
              ),
              spendCard(
                '订阅 tokens',
                fmtTokens(usageTotals.creditTokens || 0),
                '',
                (usageTotals.creditCalls || 0) + ' 次调用 · 走额度不折钱',
              ),
              (() => {
                // 订阅线路的累计积分消耗：把各线路的官方 consumed 加起来（只加拿得到的）
                let consumed = 0
                let known = 0
                let missing = 0
                for (const route of creditRoutes) {
                  if (
                    route.creditConsumed !== null &&
                    route.creditConsumed !== undefined &&
                    route.creditConsumed > 0
                  ) {
                    consumed += route.creditConsumed
                    known += 1
                  } else if (route.creditSupported) {
                    missing += 1
                  }
                }
                if (known === 0) return null
                return spendCard(
                  '订阅积分消耗',
                  fmtCredits(consumed),
                  ' 积分',
                  known + ' 条线路累计' + (missing > 0 ? '，' + missing + ' 条没拿到' : '') + ' · 官方口径',
                )
              })(),
              spendCard(
                '调用次数',
                String(usageTotals.calls),
                ' 次',
                usageSources.length + ' 个来源 · ' + (usage.windowLabel || ''),
              ),
            )
          : null,

        // ---------------------------------------------------------------- 云端出图 / 生视频花费
        // 和上面的 token 折算是两套账：生图按张、生视频按 token 估算，都是按量真花钱。
        (() => {
          const m = usage && usage.media ? usage.media : null
          if (m === null || !m.totals || (m.totals.count || 0) === 0) return null
          const t = m.totals
          const allModels = Array.isArray(m.byModel) ? m.byModel : []
          // 媒体行也吃全局搜索：按模型名 / 供应商过滤；汇总卡仍是全量
          const models = needle === '' ? allModels : allModels.filter((r) => searchMatches([r.model, r.provider || '']))
          if (models.length === 0) return null
          const maxMediaCost = models.reduce((mx, r) => (r.cny > mx ? r.cny : mx), 0)

          const mediaRow = (row) => {
            const isVid = row.kind === 'vid'
            const unpriced = !(row.cny > 0) && row.unpriced > 0
            const width = unpriced || maxMediaCost <= 0 ? 0 : Math.max(2, (row.cny / maxMediaCost) * 100)
            // 单价说明：生图「¥0.30/张」，生视频「46 元/M token · 720p」
            const unitText =
              row.unit === null || row.unit === undefined
                ? ''
                : isVid
                  ? row.unit + ' 元/M token' + (row.detail && row.detail.res ? ' · ' + row.detail.res : '')
                  : (row.currency === 'USD' ? '$' : '¥') + row.unit + '/张'
            return h(
              'div',
              {
                className: 'ac-usage-row',
                'data-unpriced': unpriced ? '' : undefined,
                'data-billing': 'token',
                key: row.kind + '|' + row.model,
              },
              h(
                'div',
                { className: 'ac-usage-head' },
                h('span', { className: 'ac-usage-provider' }, row.provider || (isVid ? '生视频' : '生图')),
                h('span', { className: 'ac-usage-tag' }, isVid ? '视频' : '图片'),
                h('span', { className: 'ac-usage-model' }, row.model),
                h(
                  'span',
                  { className: 'ac-usage-cost', 'data-unpriced': unpriced ? '' : undefined },
                  unpriced ? '没有标价' : fmtMoney(row.cny, 'CNY'),
                ),
              ),
              h(
                'div',
                { className: 'ac-usage-facts' },
                h('span', null, isVid ? '生成 ' : '出图 ', h('b', null, String(row.count)), isVid ? ' 条' : ' 张'),
                unitText ? h('span', null, '单价 ', h('b', null, unitText)) : null,
                row.unpriced > 0 ? h('span', null, h('b', null, String(row.unpriced)), ' 条没标价') : null,
                isVid && row.detail && row.detail.tokens
                  ? h('span', null, '估算 ', h('b', null, fmtTokens(row.detail.tokens)), ' tokens')
                  : null,
              ),
              !unpriced && width > 0
                ? h('div', { className: 'ac-usage-bar' }, h('i', { style: { width: width.toFixed(1) + '%' } }))
                : null,
              row.note ? h('div', { className: 'ac-caveat', style: { marginTop: '6px' } }, row.note) : null,
            )
          }

          return h(
            'div',
            null,
            h('div', { className: 'ac-dsh-section', style: { marginTop: '22px' } }, '云端出图 / 生视频花费'),
            h(
              'div',
              { className: 'ac-caveat', style: { marginTop: '0' } },
              '本机通过 API 调云端模型',
              h('b', null, '出图 / 生视频'),
              '的花费 —— 和上面的 token 折算是两套账。生图',
              h('b', null, '按张'),
              '计价（部分模型按输出像素分档）；生视频',
              h('b', null, '按 token'),
              '计价，本机拿不到官方 token 数，用的是官方估算公式（',
              h('code', null, '时长 × 宽 × 高 × 帧率 / 1024'),
              '），所以视频金额是',
              h('b', null, '估算值'),
              '。数据来自会话日志里的工具调用 + 影像工坊面板账本，按产物文件名去重。单价快照 ',
              m.snapshotAt || '',
              '。',
            ),
            h(
              'div',
              { className: 'ac-spend', style: { marginTop: '12px' } },
              spendCard('云端出图', fmtMoney(t.imageCNY, 'CNY'), '', String(t.images) + ' 张' + (t.unpricedImages > 0 ? ' · ' + t.unpricedImages + ' 张没标价' : '')),
              spendCard('云端生视频', fmtMoney(t.videoCNY, 'CNY'), '', String(t.videos) + ' 条（估算）' + (t.unpricedVideos > 0 ? ' · ' + t.unpricedVideos + ' 条没标价' : '')),
              spendCard('出图+生视频合计', fmtMoney(t.totalCNY, 'CNY'), '', t.totalUSD > 0 ? '≈ $' + t.totalUSD.toFixed(2) : '按量真花钱 · ' + (usage.windowLabel || ''), true),
              t.deduped > 0 ? spendCard('已去重', String(t.deduped), ' 条', '会话日志与面板账本的重复记录') : null,
            ),
            models.length > 0
              ? h('div', { className: 'ac-usage', style: { marginTop: '12px' } }, models.map(mediaRow))
              : null,
          )
        })(),

        // 官方账单：唯一能拿到官方计费口径的途径（API 没有用量端点）

        officialUsage !== null && officialUsage.ok === true && Array.isArray(officialUsage.byKey)
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'ac-dsh-section', style: { marginTop: '22px' } },
                '官方账单（按 API key）',
              ),
              h(
                'div',
                { className: 'ac-caveat', style: { marginTop: '0' } },
                '从 DeepSeek 开放平台导出的用量 CSV，',
                h('b', null, '官方计费口径'),
                '。同一账号下所有 key 的调用都在这里 —— DSH 只用其中两个，其余是别的工具用的，',
                h('b', null, '这部分不在会话日志里'),
                '，所以上面的「按标价折算」会小于这里的总额。',
                officialUsage.totals && officialUsage.totals.agree === false
                  ? '（注意：两个 CSV 的金额对不上，导出可能不完整）'
                  : '',
              ),
              // 重复导入的说明：多次导出必然有交集，这里把去重的账算清楚
              officialUsage.dedupe && officialUsage.dedupe.overwritten > 0
                ? h(
                    'div',
                    { className: 'ac-caveat', style: { marginTop: '8px' } },
                    '导入过 ',
                    h('b', null, String(officialUsage.dedupe.files)),
                    ' 份 CSV，其中 ',
                    h('b', null, String(officialUsage.dedupe.overwritten)),
                    ' 行落在多份文件的交集里，已按「后导入的覆盖先导入的」去重 —— ',
                    '直接累加会算成 ',
                    h('b', null, '¥' + (officialUsage.totals.rawCost || 0).toFixed(2)),
                    '，实际 ',
                    h('b', null, '¥' + officialUsage.totals.cost.toFixed(2)),
                    '。',
                    officialUsage.dedupe.conflicts > 0
                      ? '其中 ' + officialUsage.dedupe.conflicts + ' 行两次数值不同（导出时那天还没过完），取的是较新的那份。'
                      : '',
                    officialUsage.overlaps && officialUsage.overlaps.length > 0
                      ? h(
                          'div',
                          { style: { marginTop: '4px' } },
                          '重叠区间：',
                          officialUsage.overlaps
                            .map((o) => o.from.slice(5) + '~' + o.to.slice(5) + '（' + o.days + ' 天）')
                            .join('、'),
                        )
                      : null,
                    officialUsage.range && officialUsage.range.missing && officialUsage.range.missing.length > 0
                      ? h(
                          'div',
                          { style: { marginTop: '4px' } },
                          '区间内 ' + officialUsage.range.missing.length + ' 天没有用量记录（不是缺数据）：',
                          officialUsage.range.missing.slice(0, 8).map((d) => d.slice(5)).join('、'),
                          officialUsage.range.missing.length > 8
                            ? ' 等'
                            : '',
                        )
                      : null,
                  )
                : null,
              importPanel(true),
              h(
                'div',
                { className: 'ac-usage' },
                officialUsage.byKey.map((key) =>
                  h(
                    'div',
                    { className: 'ac-keyrow', key: key.name },
                    h(
                      'div',
                      { className: 'ac-keyrow-head' },
                      h('span', { className: 'ac-usage-provider' }, key.name),
                      h('span', { className: 'ac-usage-model' }, key.days + ' 天'),
                      h('span', { className: 'ac-keyrow-cost' }, fmtMoney(key.cost, 'CNY')),
                    ),
                    h(
                      'div',
                      { className: 'ac-usage-facts' },
                      h('span', null, '命中 ', h('b', null, fmtTokens(key.hit))),
                      h('span', null, '未命中 ', h('b', null, fmtTokens(key.miss))),
                      h('span', null, '输出 ', h('b', null, fmtTokens(key.out))),
                      h('span', null, '请求 ', h('b', null, String(key.requests))),
                      key.fnCalls > 0
                        ? h('span', null, '搜索 ', h('b', null, key.fnCalls + ' 次'))
                        : null,
                    ),
                  ),
                ),
              ),
            )
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'ac-dsh-section', style: { marginTop: '22px' } },
                '官方账单',
              ),
              importPanel(false),
            ),

        tokenSources.length > 0
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'ac-dsh-section', style: { marginTop: '22px' } },
                '按 token 计费',
              ),
              h(
                'div',
                { className: 'ac-caveat', style: { marginTop: '0' } },
                '这些线路按 token 明码标价、充值后按量扣款，用量乘标价就是真金白银（实际扣款还要看赠金和折扣）。',
              ),
              h('div', { className: 'ac-usage' }, tokenSources.map(usageRow)),
            )
          : null,

        estimateSources.length > 0
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'ac-dsh-section', style: { marginTop: '22px' } },
                '套餐渠道 · 等价参考',
              ),
              h(
                'div',
                { className: 'ac-caveat', style: { marginTop: '0' } },
                '这些是套餐 / 订阅渠道，按月付费或买积分包，',
                h('b', null, '不按 token 扣现金'),
                '。下面的金额只是拿 DeepSeek 官方价当尺子折算的',
                h('b', null, '等价参考'),
                '，回答「这些 token 如果按官方价买要多少钱」—— 不是账单，也和你实际付的月费无关。',
                usageTotals && usageTotals.estimateCNY > 0
                  ? '（本窗口合计 ¥' + usageTotals.estimateCNY.toFixed(2) + '）'
                  : '',
              ),
              h('div', { className: 'ac-usage' }, estimateSources.map(usageRow)),
            )
          : null,

        // 「订阅划算吗」：只有开了折算的订阅线路才有数
        usageWorth.length > 0
          ? h(
              'div',
              { className: 'ac-worth' },
              h(
                'div',
                { className: 'ac-worth-head' },
                h('span', { className: 'ac-worth-title' }, '订阅划算吗'),
                h(
                  'span',
                  { className: 'ac-worth-meta' },
                  '等价月费 = 这个窗口的等价金额 × ',
                  String(
                    usage && usage.worthMeta && usage.worthMeta.windowDays
                      ? Math.round(30 / usage.worthMeta.windowDays)
                      : 1,
                  ),
                  '（折成 30 天）；≥ 参考月费就算划算，0.6–1 倍差不多，低于 0.6 倍是用得少',
                ),
              ),
              h(
                'div',
                { className: 'ac-worth-rows' },
                usageWorth.map((row) => {
                  const verdict = row.verdict ? WORTH_VERDICTS[row.verdict] || null : null
                  // 用 worth:<线路> 作展开键 —— 跟订阅卡的时间轴（用纯线路 id）互不干扰，两块能同时开着
                  const worthKey = 'worth:' + row.provider
                  const worthOpen = expanded === worthKey
                  const hasDetail =
                    (Array.isArray(row.modelRows) && row.modelRows.length > 0) ||
                    (Array.isArray(row.byDay) && row.byDay.length > 0)
                  const toggle = hasDetail
                    ? () => setExpanded((prev) => (prev === worthKey ? null : worthKey))
                    : undefined
                  return h(
                    'div',
                    {
                      className: 'ac-worth-row',
                      key: row.provider,
                      'data-expandable': hasDetail ? '' : undefined,
                      'data-open': worthOpen ? '' : undefined,
                    },
                    h(
                      'div',
                      { className: 'ac-worth-main', onClick: toggle },
                      hasDetail ? h('span', { className: 'ac-caret' }, worthOpen ? '▾' : '▸') : null,
                      h('span', { className: 'ac-worth-name' }, row.routeLabel || row.provider),
                      h(
                        'span',
                        { className: 'ac-worth-num' },
                        h('b', null, fmtPrice(row.monthlyCNY, 'CNY')),
                        ' / 月',
                      ),
                      h(
                        'span',
                        { className: 'ac-worth-ref' },
                        row.refMin === null
                          ? '参考月费没对上（在「接入情况」里填你付的月费）'
                          : '参考 ' +
                            (row.refMax !== null && row.refMax !== row.refMin
                              ? fmtPrice(row.refMin, 'CNY') + '–' + fmtPrice(row.refMax, 'CNY')
                              : fmtPrice(row.refMin, 'CNY')) +
                            (row.refSource === 'tier'
                              ? '（官方档位·国内价）'
                              : row.refSource === 'paid'
                                ? '（实付÷月数）'
                                : row.refSource === 'manual'
                                  ? '（你填的）'
                                  : '（套餐表）'),
                      ),
                      verdict
                        ? h(
                            'span',
                            { className: 'ac-bill-verdict', 'data-tone': verdict.tone },
                            verdict.text,
                            row.ratio === null ? '' : ' ' + row.ratio.toFixed(2) + '×',
                          )
                        : null,
                      h(
                        'span',
                        { className: 'ac-worth-tokens' },
                        fmtTokens(row.totalTokens) + ' token · ' + String(row.calls) + ' 次',
                      ),
                      hasDetail
                        ? h(
                            'span',
                            { className: 'ac-worth-toggle' },
                            worthOpen ? '收起明细' : '看明细（模型 / 按天 / 参考价）',
                          )
                        : null,
                    ),
                    worthOpen ? worthDetail(row) : null,
                  )
                }),
              ),
            )
          : null,

        creditRoutes.length > 0
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'ac-dsh-section', style: { marginTop: '22px' } },
                '订阅 / 额度制',
              ),
              h(
                'div',
                { className: 'ac-caveat', style: { marginTop: '0' } },
                '这些线路消耗的是套餐额度或积分，不花现金 —— 不折金额，只报 token 用量和积分。',
                h('b', null, '积分是整条线路的累计消耗'),
                '（官方口径），不随上面的时间范围变；官方没有按模型拆分的消耗数据，所以模型只列 token 占比。',
                usageWorth.length > 0
                  ? '开了「折算」的线路会多一行等价金额 —— 那是「这些 token 按官方标价买要多少钱」，用来跟套餐月费比，不是账单。'
                  : '',
              ),
              h('div', { className: 'ac-usage' }, creditRoutes.map(creditRouteCard)),
            )
          : null,

        usage !== null && usageSources.length === 0
          ? h('div', { className: 'ac-price-empty' }, '这个时间范围里还没有用量记录。')
          : null,

        usageDays.length > 0
          ? h(
              'div',
              null,
              h('div', { className: 'ac-dsh-section', style: { marginTop: '22px' } }, '按天'),
              h(
                'div',
                { className: 'ac-daylegend' },
                h('span', null, 'DeepSeek 折算'),
                h('span', null, '实际扣费'),
                h('span', null, '差'),
              ),
              h(
                'div',
                { className: 'ac-days' },
                usageDays.map((row) => {
                  const actual = actualByDay[row.day]
                  // 这一栏专门用来跟余额对账，所以只放 DeepSeek 系；
                  // 硅基 / 火山 / TokenPlus 的钱不进那个余额，放在上面来源卡片里
                  const dsCost =
                    typeof row.costCNYDeepSeek === 'number' ? row.costCNYDeepSeek : row.costCNY
                  const gap = typeof actual === 'number' ? dsCost - actual : null
                  return h(
                    'div',
                    { className: 'ac-day', key: row.day },
                    h('span', { className: 'ac-day-date' }, row.day),
                    h(
                      'span',
                      { className: 'ac-day-bar' },
                      h('i', {
                        style: {
                          width:
                            (maxDayCost <= 0 ? 0 : Math.max(2, (dsCost / maxDayCost) * 100)) + '%',
                        },
                      }),
                    ),
                    h(
                      'span',
                      { className: 'ac-day-cost' },
                      dsCost > 0 ? fmtMoney(dsCost, 'CNY') : '—',
                    ),
                    // 实际扣费（余额差分）那一列 —— 没有就留空，不编 0
                    h(
                      'span',
                      { className: 'ac-day-cost ac-day-actual' },
                      typeof actual === 'number' ? fmtMoney(actual, 'CNY') : '—',
                    ),
                    // 差额：接近 0 说明对得上；明显负值说明那天有日志外的消费
                    h(
                      'span',
                      {
                        className: 'ac-day-gap',
                        'data-big': gap !== null && Math.abs(gap) >= 0.5 ? '' : undefined,
                      },
                      gap === null ? '—' : (gap >= 0 ? '+' : '') + gap.toFixed(2),
                    ),
                    h('span', { className: 'ac-day-tokens' }, fmtTokens(row.totalTokens)),
                  )
                }),
              ),
            )
          : null,

        usage !== null
          ? h(
              'div',
              { className: 'ac-caveat' },
              h('b', null, '这个金额是折算值，不是账单。'),
              '它只给',
              h('b', null, '真正按 token 后付费、扣现金的渠道'),
              '（DeepSeek 官方 / 账户、硅基流动、火山方舟按量）算钱，而且按官方分时价分开算：',
              h('br'),
              h('b', null, '高峰 / 空闲'),
              '：每条调用按它自己的时间戳判时段（工作日 9:00-12:00、14:00-18:00 为高峰，其余含周末与法定节假日全按空闲），各自套对应单价；',
              h('br'),
              h('b', null, '缓存命中 / 未命中'),
              '：日志里的 inputTokens 是未命中部分、cacheReadTokens 是命中部分，两者单价差几十倍，分开算。',
              h('br'),
              '套餐 / 订阅渠道（Trae / Qoder / WorkBuddy / 通义 Token Plan / Ark Agent Plan / opencode-go / TokenPlus 等）',
              h('b', null, '一律不折金额'),
              '—— 它们消耗的是额度不是现金，套官方标价会得出「看着花了 ¥22、其实一分没扣」的假数字。它们报',
              h('b', null, '官方口径的累计消耗积分'),
              '和各模型 token 占比。',
              h('br'),
              h('b', null, '为什么积分只到线路级、不到模型级：'),
              '官方接口只给整条线路的累计值，没有按模型拆分的明细。各家也没有公开「每 token 扣多少积分」的换算 ——',
              '模型名里的 x0.06 是相对系数不是单价（实测 qoder 反推常数约 521、trae 约 48，差 10 倍），硬乘会得出错数。',
              h('br'),
              '实际扣款还会被',
              h('b', null, '赠金 / 免费额度'),
              '、各家缓存计价细则拉开。想对真实余额，看「领取」那一栏的 DeepSeek 余额。',
            )
          : null,
      ]

      return h(
        'div',
        { className: 'ac-root' },
        h('style', null, CSS),
        // 用的是上次快照 → 顶部一条细提示，数字马上会被真实结果替换
        isSnapshot
          ? h(
              'div',
              { className: 'ac-stale' },
              h('span', { className: 'ac-stale-dot' }),
              '显示的是上次缓存的数据，正在刷新…',
            )
          : null,
        h(
          'div',
          { className: 'ac-page' },
          h(
            'header',
            { className: 'ac-head' },
            h(
              'div',
              null,
              h('div', { className: 'ac-kicker' }, 'AI 免费额度 · 各家价格 · 订阅'),
              h('h1', { className: 'ac-title' }, '赛博鸡蛋领取处'),
              h(
                'p',
                { className: 'ac-sub' },
                '每天自动把能领额度、积分的地方巡一遍，能打开的直接给链接；顺手把各家 AI 的 API 价格和订阅（通用 / 编程工具）摆成两张表，再告诉你这台机器现在接了哪几家、这些线路各自花了多少。',
              ),
            ),
            h(
              'div',
              { className: 'ac-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ac-btn ac-btn-primary',
                  disabled: data === null || running || pending === 'dsh',
                  onClick: () =>
                    view === 'dsh'
                      ? reloadDsh()
                      : view === 'usage'
                        ? reloadDsh(usageWindow)
                        : doRefresh(false, view !== 'credits'),
                },
                running
                  ? pending === 'search'
                    ? '巡检 + 联网中…'
                    : pending === 'prices'
                      ? '核对中…'
                      : '巡检中…'
                  : view === 'prices'
                    ? '立即核对价格'
                    : view === 'general' || view === 'coding'
                      ? '立即核对订阅'
                      : view === 'dsh'
                        ? '重新读接入'
                        : view === 'usage'
                          ? '重新算用量'
                          : '立即巡检',
              ),
              view === 'credits'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'ac-btn',
                      disabled: data === null || running,
                      onClick: () => doRefresh(true),
                    },
                    running ? '等这次跑完' : '联网找新的',
                  )
                : null,
            ),
          ),

          tabs,

          view === 'credits'
            ? creditsBody
            : view === 'prices'
              ? pricesBody
              : view === 'dsh'
                ? dshBody
                : view === 'usage'
                  ? usageBody
                  : plansBody,

          h(
            'div',
            { className: 'ac-foot-note' },
            '数据只存在这台机器上（$DSH_HOME/ai-credits/catalog.json）。' +
              (view === 'credits'
                ? '清单里每一条都是官方入口；「每日新发现」是每天联网搜出来的候选页，点开确认过再领。'
                : view === 'prices'
                  ? '价格数字是人工核对的快照，不会自动爬取；每天自动核对的是各官网价格页能不能打开。'
                  : view === 'dsh'
                    ? '这一栏不存任何东西，读的全是宿主当下的活状态；改接入去「设置 → 模型」，这里只负责告诉你现在接了什么。'
                    : view === 'usage'
                      ? '数字来自本机会话日志（每条回复自己记的 token 数），金额按各家官网标价折算 —— 是「等价金额」，不是账单。'
                      : '订阅价是人工核对的快照，不会自动爬取；每天自动核对的是各官网订阅页能不能打开，额度和权益以「去订阅」页面为准。'),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- 挂载

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('main', () =>
        slots.register({ name: 'main', key: 'ai-credits' }, CreditsPage),
      )

      slots.inject('sidebar.panellist', () =>
        slots.register(
          {
            name: 'sidebar.panellist',
            id: 'ai-credits',
            order: 100,
            label: () => '赛博鸡蛋领取处',
          },
          EggIcon,
        ),
      )
    }

    return { inject: ['slots'], apply }
  },
})
