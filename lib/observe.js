/**
 * observe.js — 把 Windows-MCP 的「散文式」元数据解析成**结构化观测**。
 *
 * 为什么需要这一层：Windows-MCP 的 Snapshot/Screenshot 把关键坐标信息全部放在
 * 一段人类可读文本里，例如
 *
 *     Cursor Position: (755, 733)
 *     Screenshot Original Size: (2560,1440)
 *     Screenshot Coordinate Scale: 1.333333 — image pixels are downscaled; multiply …
 *     Screenshot Region: (0,0,2560,1440)
 *     Coordinate Space: Virtual desktop coordinates
 *
 * 模型要拿这些信息去做「图片像素 → 屏幕坐标」的换算，全靠读散文并做心算，
 * 一旦漏读或多读一次，点击就会偏。本模块把它变成稳定字段，供 coords.js 与
 * gate.js 使用；后续所有判断都以结构化数据为准，不再解析文本。
 *
 * 上游真源：`src/windows_mcp/tools/_snapshot_helpers.py`（`coord_scale =
 * round(1.0 / screenshot_scale, 6)`，仅当内部缩放 < 1.0 时才输出该行）。
 *
 * @module dsh_Windows_MCP/observe
 */

/** 观测 id 前缀；配合单调递增序号保证同一进程内可排序、可引用。 */
export const OBSERVATION_PREFIX = 'obs'

/** 判定「这是不是一次桌面观测」的工具名（去掉 mcp__<server>__ 前缀后比较）。 */
export const OBSERVE_TOOLS = Object.freeze(['snapshot', 'screenshot'])

/** 空观测的字段形态；所有解析入口都返回这个形状，缺失即 null。 */
export function emptyObservation() {
  return {
    id: null,
    at: null,
    tool: null,
    cursor: null,
    originalSize: null,
    coordScale: null,
    /** 行存在但值非法时保存原始文本，供诊断区分"缺行"与"值非法"。 */
    rawCoordScaleInvalid: null,
    /** Region 行存在但无法解析时保存原始文本，同理。 */
    rawRegionInvalid: null,
    /** Original Size 行存在但值非法/非正时保存原始文本，同理。 */
    rawOriginalSizeInvalid: null,
    region: null,
    coordinateSpace: null,
    backend: null,
    focusedWindow: null,
    windows: [],
    uiElements: [],
    process: null,
    generation: 0,
    image: null,
  }
}

/** 去掉 `mcp__<serverName>__` 前缀，得到上游原始工具名。 */
export function stripToolPrefix(name, serverName = 'winmcp') {
  if (typeof name !== 'string') return ''
  const prefix = `mcp__${serverName}__`
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 解析 `Cursor Position: (755, 733)`。
 * @returns {{x: number, y: number} | null}
 */
export function parseCursor(text) {
  const m = /Cursor Position:\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i.exec(text ?? '')
  if (!m) return null
  return { x: toNumber(m[1]), y: toNumber(m[2]) }
}

/**
 * 解析 `Screenshot Original Size: (2560,1440)`。
 *
 * 任一维 ≤ 0 视为**缺失**而返回 null：`(0,0)` 这种值不是"尺寸为零的图片"，
 * 而是上游给不出尺寸。若把它当有效值，后续所有按尺寸做的推导都会静默算错。
 */
export function parseOriginalSizeDetailed(text) {
  const source = text ?? ''
  const m = /Screenshot (?:Original )?Size:\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/i.exec(source)
  if (!m) {
    // 行存在但形状不对（或尺寸写成了非数字）→ 保留原文供诊断
    const raw = /Screenshot (?:Original )?Size:\s*(.+)/i.exec(source)?.[1]?.trim() ?? null
    return { present: raw !== null, value: null, invalid: raw }
  }
  const width = toNumber(m[1])
  const height = toNumber(m[2])
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { present: true, value: null, invalid: `${width}x${height}` }
  }
  return { present: true, value: { width, height }, invalid: null }
}

/** 解析 `Screenshot Original Size: (2560,1440)`（非正值视为缺失）。 */
export function parseOriginalSize(text) {
  return parseOriginalSizeDetailed(text).value
}

/**
 * 解析 `Screenshot Coordinate Scale: 1.333333`。
 *
 * 语义（务必不要想当然）：这是「把*已降采样图片*里的像素换算回屏幕坐标」的**乘数**。
 * 图片像素 × coordScale = 屏幕坐标。源码里它是 `1 / screenshot_scale`。
 * 该行只在内部缩放 < 1.0 时出现；缺省时上游用的是 1.0。
 */
export function parseCoordScale(text) {
  return parseCoordScaleDetailed(text).value
}

/**
 * 解析 Coordinate Scale 的**详细结果**，区分三种情况：
 * - 行不存在 → `{ present: false, value: null, invalid: null }`
 * - 行存在但值非法（0 / 负数 / 非数字）→ `{ present: true, value: null, invalid: <原始文本> }`
 * - 正常 → `{ present: true, value: <数字>, invalid: null }`
 *
 * 为什么必须区分：对抗性验证指出，早期实现把前两种都归为"缺行"，
 * 于是诊断会谎称"缺少该行"，而实际上行就在那里、只是值不可用。
 * 诊断不准会让排障方向完全跑偏。
 */
export function parseCoordScaleDetailed(text) {
  const m = /Screenshot Coordinate Scale:\s*([^\s—–-]+)/i.exec(text ?? '')
  if (!m) return { present: false, value: null, invalid: null }
  const raw = m[1].trim()
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return { present: true, value: null, invalid: raw }
  return { present: true, value: n, invalid: null }
}

/**
 * 详细解析 `Screenshot Region:`，区分「行不存在」「行存在但无法解析」「正常」。
 *
 * 为什么要区分：诊断如果对前两种都说"缺少该行"，会在行明明存在时把排障方向带偏
 * （对抗性验证指出过这一点）。
 */
export function parseRegionDetailed(text) {
  const source = text ?? ''
  if (!/Screenshot Region:/i.test(source)) return { present: false, value: null, invalid: null }
  const m = /Screenshot Region:\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i.exec(source)
  if (!m) {
    const raw = /Screenshot Region:\s*(.+)/i.exec(source)?.[1]?.trim() ?? ''
    return { present: true, value: null, invalid: raw }
  }
  const left = toNumber(m[1])
  const top = toNumber(m[2])
  const right = toNumber(m[3])
  const bottom = toNumber(m[4])
  return { present: true, value: { left, top, right, bottom, width: right - left, height: bottom - top }, invalid: null }
}

/** 解析 `Screenshot Region: (0,0,2560,1440)`（虚拟桌面坐标）。 */
export function parseRegion(text) {
  return parseRegionDetailed(text).value
}

/** 解析 `Coordinate Space: Virtual desktop coordinates`。 */
export function parseCoordinateSpace(text) {
  const m = /Coordinate Space:\s*(.+)/i.exec(text ?? '')
  return m ? m[1].trim() : null
}

/** 解析 `Screenshot Backend: dxcam`。 */
export function parseBackend(text) {
  const m = /Screenshot Backend:\s*(\S+)/i.exec(text ?? '')
  return m ? m[1].trim() : null
}

/**
 * 解析焦点窗口。上游输出的是一个定界表格：
 *
 *     Focused Window:
 *     Name                     Depth  Status  Width  Height  Handle
 *     ------                   -----  ------  -----  ------  ------
 *     Notepad                  10     Normal  800    600     123456
 *
 * 宽度不固定（名称里可能有空格），所以从**行尾**按 5 个字段逆向切分：
 * handle 是最后一段、height/width 是数字、status/depth 是单个词。
 */
export function parseFocusedWindow(text) {
  const block = /Focused Window:\s*\n([\s\S]*?)(?:\n\s*\n|Opened Windows:|UI Tree:|$)/i.exec(text ?? '')
  if (!block) return null
  const rows = block[1]
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
  for (const row of rows) {
    if (/^-+$/.test(row.trim())) continue
    if (/^Name\s+Depth/i.test(row)) continue
    const parsed = parseWindowRow(row)
    if (parsed) return parsed
  }
  return null
}

/**
 * 从一行窗口表格里解析出窗口事实。
 * 行尾固定为 5 个字段：depth status width height handle。
 * @returns {{name: string, depth: number|null, status: string|null, width: number|null, height: number|null, handle: string|null} | null}
 */
export function parseWindowRow(row) {
  const m = /^(.*?)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(row)
  if (!m) return null
  return {
    name: m[1].trim(),
    depth: toNumber(m[2]),
    status: m[3],
    width: toNumber(m[4]),
    height: toNumber(m[5]),
    handle: m[6],
  }
}

/** 解析 `Opened Windows:` 表格里的全部窗口。 */
export function parseOpenedWindows(text) {
  const block = /Opened Windows:\s*\n([\s\S]*?)(?:\n\s*\n|UI Tree:|$)/i.exec(text ?? '')
  if (!block) return []
  const out = []
  for (const raw of block[1].split(/\r?\n/)) {
    const row = raw.trimEnd()
    if (row.trim() === '' || /^-+$/.test(row.trim()) || /^Name\s+Depth/i.test(row)) continue
    const parsed = parseWindowRow(row)
    if (parsed) out.push(parsed)
  }
  return out
}

/**
 * 空树占位标记：上游在拿不到 UI 树时会输出 `No elements`（recon 报告实测记录）。
 *
 * 为什么必须显式识别而不是「靠正则不匹配侥幸通过」：现行元素正则要求
 * `(x,y) <控件类型>` 的形状，所以纯 `No elements` 恰好不会被匹配。
 * 但同一行一旦带上坐标与属性（`(0,0) No elements  [action: click]`），
 * 正则就会在占位文字里"找到"控件类型，凭空造出一个 (0,0) 元素——
 * 用错误的数据通过一次判断比直接报错更危险（S-BRIDGE-06）。
 *
 * 判定规则刻意保守：整段只是「可选坐标 + 占位短语 + 可选属性」才算空树，
 * 因此真实元素（哪怕名字里含 No elements）不会被误判成空树。
 */
const EMPTY_UI_TREE_RE = /^(?:\(\s*-?\d+\s*,\s*-?\d+\s*\)\s*)?(?:no\s+(?:ui\s+)?elements?|no\s+elements?\s+found)(?:\s*\[[^\]]*\])*\s*$/i

/**
 * 提取 UI 树区段。
 *
 * 为什么必须先切区段再解析：结果文本里 `(数字, 数字)` 这种形状出现在多个地方——
 * `Cursor Position: (100, 200)`、`Screenshot Region: (0,0,2560,1440)` 等等。
 * 如果直接全文匹配坐标，就会把这些**元数据**误当成可交互元素，
 * 让"有几个可点元素"这种判断彻底失真。
 *
 * 区段起点是 `UI Tree:`（上游会在同一行或下一行开始树）；终点是文末
 * （UI 树永远是最后一段）。找不到该标记时返回空串——宁可判不出元素，
 * 也不能凭空造出元素。**整段只是空树占位文本时同样返回空串**。
 */
export function extractUiTreeSection(text) {
  const source = text ?? ''
  const marker = /^\s*UI Tree:\s*$/m.exec(source)
  if (!marker) return ''
  const section = source.slice(marker.index + marker[0].length)
  return EMPTY_UI_TREE_RE.test(section.trim()) ? '' : section
}

/**
 * 解析 UI 树里的可交互元素。上游格式：
 *
 *     ├── (2361,35) 按钮 "最小化"  [action: click]
 *     └── (1838,720) 文档 "ChatGPT"  [action: click]  [focused]  [value:"…"]
 *
 * 只提取带坐标的行；坐标即 UIA BoundingRectangle 空间，与 Click 的 `loc=`
 * 完全同一个坐标系（上游用 UIA 做输入，因此没有额外 DPI 换算）。
 *
 * 注意：属性（`[action:]` / `[focused]` / `[value:]`）只在**该元素所在的这一行**里找。
 * 早期版本用固定长度的字符窗口向后看，结果把后面元素的 `[focused]` 误挂到前面的元素上——
 * 这类错误会让「哪个元素有焦点」判断全错，必须按行界定。
 *
 * 另外只解析 `UI Tree:` 之后的区段，避免把光标/区域等元数据里的坐标当成元素。
 */
export function parseUiElements(text) {
  const section = extractUiTreeSection(text)
  if (section === '') return []
  const out = []
  // 控件类型是「非空白且不含引号/括号/中括号」的一段（实际是中文名如 按钮/区域/文档）。
  const re = /\((-?\d+)\s*,\s*(-?\d+)\)\s+([^\s"()\[\]{}]+)\s*(?:"([^"]*)")?/g
  let m
  while ((m = re.exec(section)) !== null) {
    const lineEnd = section.indexOf('\n', m.index)
    const line = section.slice(m.index, lineEnd === -1 ? section.length : lineEnd).replace(/\r$/, '')
    const action = /\[action:\s*([^\]]+)\]/.exec(line)?.[1] ?? null
    const focused = /\[focused\]/.test(line)
    const value = /\[value:"([^"]*)"\]/.exec(line)?.[1] ?? null
    out.push({
      x: toNumber(m[1]),
      y: toNumber(m[2]),
      controlType: m[3],
      label: m[4] ?? '',
      action,
      focused,
      value,
    })
  }
  return out
}

/** 解析附件说明行里的像素尺寸：`(1920x1080px, image/png)`。 */
export function parseAttachmentSize(text) {
  const m = /\((\d+)x(\d+)px,\s*image\/(\w+)\)/i.exec(text ?? '')
  if (!m) return null
  return { width: toNumber(m[1]), height: toNumber(m[2]), format: m[3].toLowerCase() }
}

/**
 * 解析附件说明里的**预览请求**尺寸：`request preview 1708x961px`。
 *
 * 为什么单独解析：说明里有**两个**语义完全不同的尺寸——
 * `request preview` 是 DSH 请求渲染的预览尺寸（预算相关），
 * `Normalized copy (...) (WxHpx)` 才是实际交给模型的副本尺寸。
 * 坐标换算假设"模型看到的 = 归一化副本"，所以两者不一致时必须能被发现。
 * 只解析、不猜、不自动补偿（S-MAP-08）。
 */
export function parsePreviewSize(text) {
  const m = /request preview\s+(\d+)x(\d+)px/i.exec(text ?? '')
  if (!m) return null
  const width = toNumber(m[1])
  const height = toNumber(m[2])
  if (width === null || height === null || width <= 0 || height <= 0) return null
  return { width, height }
}

/** 解析 `Image sha256:<hex>` 便于与落盘文件对应。 */
export function parseImageSha(text) {
  const m = /Image sha256:([0-9a-f]{64})/i.exec(text ?? '')
  return m ? m[1].toLowerCase() : null
}

/**
 * 判断这次结果是否携带真实图片（桥已经把它转成 DSH image 内容块）。
 * @param {readonly unknown[]} content
 */
export function hasImageBlock(content) {
  return Array.isArray(content) && content.some((block) => block && block.type === 'image')
}

/**
 * 从一次工具结果的 JSON 值里取出 Windows-MCP 的文本载荷。
 * 桥把 MCP 原始 content 放在 `value.content`，文本块是 `{type:'text', text}`。
 * 同时兼容直接给字符串的情况，便于单测。
 */
export function extractText(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const content = Array.isArray(value.content) ? value.content : null
  if (content) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

/**
 * 把一次 Snapshot/Screenshot 结果解析成结构化观测。
 *
 * @param {object} input
 * @param {unknown} input.value 工具结果的结构化值（`value.content` 里是原始 MCP 块）
 * @param {readonly unknown[]} [input.content] DSH 投影后的内容块（用来判断有没有图）
 * @param {string} input.tool 工具名（可带前缀）
 * @param {number} [input.at] 时间戳
 * @param {number} [input.generation] 单调递增的观测代次
 * @returns {ReturnType<typeof emptyObservation>}
 */
export function buildObservation({ value, content, tool, at = Date.now(), generation = 0, id = null }) {
  const text = extractText(value)
  const obs = emptyObservation()
  obs.id = id
  obs.at = at
  obs.tool = stripToolPrefix(tool)
  obs.generation = generation
  obs.cursor = parseCursor(text)
  const sizeDetail = parseOriginalSizeDetailed(text)
  obs.originalSize = sizeDetail.value
  obs.rawOriginalSizeInvalid = sizeDetail.invalid
  const scaleDetail = parseCoordScaleDetailed(text)
  obs.coordScale = scaleDetail.value
  // 供诊断区分「缺行」与「行在但值非法」
  obs.rawCoordScaleInvalid = scaleDetail.invalid
  const regionDetail = parseRegionDetailed(text)
  obs.region = regionDetail.value
  obs.rawRegionInvalid = regionDetail.invalid
  obs.coordinateSpace = parseCoordinateSpace(text)
  obs.backend = parseBackend(text)
  obs.focusedWindow = parseFocusedWindow(text)
  obs.windows = parseOpenedWindows(text)
  obs.uiElements = parseUiElements(text)
  const focused = obs.focusedWindow
  obs.process = focused
    ? {
        title: focused.name || null,
        handle: focused.handle ?? null,
        pid: null,
        executable: null,
      }
    : null
  const attached = parseAttachmentSize(text)
  const preview = parsePreviewSize(text)
  const sha = parseImageSha(text)
  obs.image = {
    hasImage: hasImageBlock(content),
    attachmentSize: attached,
    previewSize: preview,
    sha256: sha,
  }
  return obs
}

/**
 * 计算「模型看到的图片像素 → 上游图片像素」的额外系数。
 *
 * 上游 `Screenshot Original Size` 描述的是**服务端**图片尺寸；桥落盘时还可能
 * 再缩一次（实测 2560x1440 → 1920x1080）。模型如果直接按自己看到的像素读数，
 * 必须再乘这个系数才能回到 coordScale 生效的那个空间。
 *
 * @returns {number | null} attachmentSize.width / originalSize.width；数据不全时 null
 */
export function attachmentRatio(observation) {
  const orig = observation?.originalSize
  const attached = observation?.image?.attachmentSize
  if (!orig || !attached || !orig.width || !attached.width) return null
  return attached.width / orig.width
}

/** 观测是否具备做坐标换算的完整信息。 */
export function isCoordinateComplete(observation) {
  if (!observation) return false
  const hasScale = typeof observation.coordScale === 'number' && observation.coordScale > 0
  const hasRegion = observation.region !== null
  const hasOriginal = observation.originalSize !== null
  // 没给 coordScale 表示上游 scale=1.0，也算完整。
  return hasRegion && hasOriginal && (hasScale || observation.coordScale === null)
}
