/**
 * ai-credits · 影像工坊（dsh-cloud-media）面板侧账本
 * ============================================================================
 * 云端出图 / 出视频的记录散在三处：
 *
 *   1. **会话日志**（`tool/call` + `tool/result` 事件）—— Agent 调工具那条道，
 *      由 usage.js 的 scanFile 顺手捞（主来源，覆盖最全）。
 *   2. **`<videoDir>\cloud-media-ui.log`** —— 网页面板手动操作那条道
 *      （`云端生图 → 成功 · 模型 · 耗时 · 文件` 这种行）。Agent 工具调用
 *      **不写**这个日志，面板操作**不进**会话日志，两边互补。
 *   3. **`<videoDir>\.cloud-media-state.json`** 的 `tasks` —— 视频任务的权威状态
 *      （只有 succeeded 的任务才产生费用）。
 *
 * 这个文件只读 2 和 3。三处的记录用**产物文件名**互相去重（同一张图只会算一次）。
 *
 * videoDir 的发现顺序（cloud-media 的配置散在三个地方，逐个试）：
 *   a. `<home>\cloud-media\settings.json` → `路径.videoDir`（面板上改过存储路径）
 *   b. `<home>\profiles\*\cordis.patch.yml` → `- id: cloud-media` 块里的 `videoDir:`
 *   c. 兜底 `<home>\cloud-media\video`（插件默认值）
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const stripBom = (s) => String(s || '').replace(/^\uFEFF/, '')

async function readJsonSafe(file) {
  try {
    return JSON.parse(stripBom(await readFile(file, 'utf8')))
  } catch (error) {
    return null
  }
}

/** 找出所有可能的 videoDir（去重，保持优先级顺序） */
export async function findCloudMediaDirs(home) {
  const dirs = []
  const push = (d) => {
    const s = String(d || '').trim().replace(/\\/g, '\\')
    if (s !== '' && !dirs.includes(s)) dirs.push(s)
  }

  // a. 面板改过的存储路径
  const settings = await readJsonSafe(join(home, 'cloud-media', 'settings.json'))
  if (settings && typeof settings === 'object') {
    const paths = settings['路径'] || settings.paths || {}
    if (paths && typeof paths.videoDir === 'string') push(paths.videoDir)
  }

  // b. profile 的 cordis.patch.yml 里 cloud-media 的 config
  try {
    const profilesRoot = join(home, 'profiles')
    const profiles = await readdir(profilesRoot, { withFileTypes: true })
    for (const prof of profiles) {
      if (!prof.isDirectory()) continue
      const text = await readFile(join(profilesRoot, prof.name, 'cordis.patch.yml'), 'utf8').catch(() => '')
      if (text === '') continue
      // 找到 `- id: cloud-media` 之后最近的 videoDir 行（配置块很短，600 字符内足够）
      const m = /-\s*id:\s*cloud-media[\s\S]{0,600}?videoDir:\s*['"]?([^'"\r\n#]+)/.exec(text)
      if (m) push(m[1].trim())
    }
  } catch (error) {}

  // c. 插件默认
  push(join(home, 'cloud-media', 'video'))
  return dirs
}

const UI_IMAGE_RE = /^\[([^\]]+)\]\s*(?:云端生图|生图)\s*→\s*成功\s*·\s*([^·]+?)\s*·\s*([\d.]+)s\s*·\s*(.+?)\s*$/
const UI_VIDEO_RE = /^\[([^\]]+)\]\s*建视频任务\s*→\s*([0-9a-f]{6,})\s*·\s*([^·]+?)\s*·\s*([^·]*?)\s*·\s*([\d.]+)s/

/**
 * 读面板侧账本。返回的 images / videos 都带 `file`（产物文件名）供跨来源去重。
 * 读不到任何文件不报错 —— 没装 cloud-media 的机器上这就是空结果。
 */
export async function readCloudMediaLedger(home) {
  const images = []
  const videos = []
  const dirsFound = []
  for (const dir of await findCloudMediaDirs(home)) {
    let sawSomething = false

    // 2. UI 日志：只认「成功」行；`本地生图` 不会命中正则（前缀是「本地」），
    //    老格式 `生图 → 成功` 也认，但只统计 cloud- 前缀的产物（本地是 local- 前缀）。
    try {
      const text = await readFile(join(dir, 'cloud-media-ui.log'), 'utf8')
      sawSomething = true
      for (const line of stripBom(text).split('\n')) {
        let m = UI_IMAGE_RE.exec(line)
        if (m) {
          const at = Date.parse(m[1])
          const model = m[2].trim()
          for (const raw of m[4].split(',')) {
            const file = raw.trim()
            // 只认云端产物：cloud-* 前缀。带路径的取 basename。
            const base = file.split(/[\\/]/).pop() || ''
            if (!base.startsWith('cloud-')) continue
            if (Number.isFinite(at)) images.push({ kind: 'img', at, model, provider: '', size: '', file: base, src: 'ui-log' })
          }
          continue
        }
        // 建视频任务只是「创建」，成功与否要看 state 文件 —— 这里不直接计费
        m = UI_VIDEO_RE.exec(line)
        if (m) {
          // 仅用于兜底展示（state 文件被清时至少知道建过任务），不计钱
          continue
        }
      }
    } catch (error) {}

    // 3. 视频任务状态：只有 succeeded 才计费（官方口径：失败不收钱）
    const state = await readJsonSafe(join(dir, '.cloud-media-state.json'))
    if (state && typeof state === 'object') {
      sawSomething = true
      const tasks = state.tasks && typeof state.tasks === 'object' ? state.tasks : {}
      for (const t of Object.values(tasks)) {
        if (!t || typeof t !== 'object') continue
        if (String(t['状态'] || '') !== 'succeeded') continue
        const at = Date.parse(String(t['创建时间'] || '')) || 0
        videos.push({
          kind: 'vid',
          at,
          model: String(t['模型'] || ''),
          provider: String(t['供应商'] || ''),
          resolution: String(t['分辨率'] || ''),
          duration: Number(t['时长']) || 0,
          ratio: String(t['比例'] || ''),
          file: String(t['文件'] || ''),
          id: String(t.id || ''),
          src: 'state',
        })
      }
    }

    if (sawSomething) dirsFound.push(dir)
  }
  return { images, videos, dirsFound }
}
