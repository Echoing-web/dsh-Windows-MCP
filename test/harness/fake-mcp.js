/**
 * fake-mcp.js —— 可编程的「假 Windows-MCP 服务器」。
 *
 * ## 它为什么存在
 * 真机验证有三个致命弱点：**不可复现**（桌面状态变了结论就变了）、**慢**、
 * **覆盖不到故障路径**（服务器不说话、回一半断线、图片进不来，真机上很难故意造）。
 * 本文件把 Windows-MCP 的**响应形状**变成可编程的数据，于是整条链路
 * （假桥 → `tools/post-execute` 观测 → `tools/pre-execute` 闸门 → 审计）
 * 可以在无桌面、无进程、无计时器的环境下完整重放。
 *
 * ## 纪律（很重要）
 * 1. **形状来自实测，不是编造**：`snapshot()` / `screenshot()` 的默认输出在结构上
 *    与 `harness/host.js` 里真实抓取的 `REAL_SNAPSHOT_TEXT` / `REAL_SCREENSHOT_TEXT`
 *    同源（同一批头部行、同一套表格与 UI 树缩进、同一句 Coordinate Scale 说明文字）。
 *    需要别的形状时用**旋钮**（`blocks` / `scale` / `region` / `windows` / `uiTree`），
 *    不要手搓新模板——否则测试断言的就不是上游，而是测试自己的想象力。
 * 2. **确定性**：没有 `setTimeout`、没有随机数、没有真实进程、没有网络。
 *    同一份 knobs 必然得到同一串字节。唯一的「异步」是 `neverSpeak`（刻意永不 settle）。
 * 3. **假服务器不证明上游行为**，只证明「给定的上游形状下本插件的行为符合规格」。
 *    上游本身的差异仍然属于 SYS_SPEC 第 9 章的未验证项。
 *
 * ## 两个投影层，别混淆
 * 一次 MCP 调用在 DSH 里产生两份东西：
 * - `value.content`：桥搬运的**原始 MCP 块**（图片是 base64 `data`）；
 * - `content`：DSH 侧的**投影块**（图片变成 `attachment` 引用）。
 * 本模块的 `respond()` 同时给出这两者，`projectContent()` 单独暴露投影规则，
 * 于是「图片能不能被桥接纳」这件事可以被单独测试（S-BRIDGE-05）。
 *
 * @module dsh_Windows_MCP/test/harness/fake-mcp
 */

import { REAL_SCREENSHOT_TEXT, REAL_SNAPSHOT_TEXT } from './host.js'

/** `Screenshot Coordinate Scale` 行后面那句真实说明文字（实测抓取，逐字保留）。 */
export const SCALE_NOTE =
  'image pixels are downscaled; multiply every image pixel coordinate by 1.333333 before passing to Click, Move, Scroll, or any loc= argument (e.g. image pixel (200, 150) → screen coordinate (267, 200))'

/** 允许出现在结果里的块类型（旋钮校验用，拼错要立刻报错而不是静默忽略）。 */
export const KNOWN_BLOCKS = Object.freeze([
  'cursor',
  'originalSize',
  'coordScale',
  'region',
  'coordinateSpace',
  'backend',
  'displays',
  'focusedWindow',
  'openedWindows',
  'uiTree',
])

/** 桥能接纳的图片媒体类型。不在这个列表里的图片进不了 DSH 内容块。 */
export const ADMITTABLE_MEDIA_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** 假服务器上「注册」的工具名（去掉 mcp__ 前缀后的裸名）。 */
export const TOOLS = Object.freeze([
  'Snapshot',
  'Screenshot',
  'DisplayInventory',
  'Wait',
  'WaitFor',
  'Click',
  'Type',
  'Move',
  'Scroll',
  'Shortcut',
  'PowerShell',
])

/** 真实抓取里 UI 树空树的占位文本（recon 报告记录的上游行为）。 */
export const NO_ELEMENTS_TEXT = 'No elements'
/** 真实抓取里焦点窗口为空时的占位文本。 */
export const NO_ACTIVE_WINDOW_TEXT = 'No active window found'
/** 真实抓取里已打开窗口为空时的占位文本。 */
export const NO_WINDOWS_TEXT = 'No windows found'

/** 是否是可被桥接纳的图片媒体类型。 */
export function canAdmitImage(mediaType) {
  return ADMITTABLE_MEDIA_TYPES.includes(String(mediaType ?? '').toLowerCase())
}

/**
 * 把原始 MCP 内容块投影成 DSH 内容块（与真实桥同规则）。
 *
 * - text 块原样保留（**逐字节**，不做 trim / 规范化）；
 * - image 块：媒体类型不在允许列表 → **整块丢弃**（其它块继续保留）；
 *   能被接纳 → 转成 `{ type: 'image', attachment: {...} }`。
 *
 * @param {readonly object[]} rawBlocks value.content（原始 MCP 块）
 * @returns {object[]} DSH 投影后的内容块
 */
export function projectContent(rawBlocks) {
  const out = []
  for (const block of rawBlocks ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      out.push({ type: 'text', text: block.text })
      continue
    }
    if (block.type === 'image') {
      const mediaType = block.mimeType ?? block.mediaType ?? 'image/png'
      if (!canAdmitImage(mediaType)) continue
      out.push({
        type: 'image',
        attachment: {
          attachmentId: block.attachmentId ?? 'att-fake',
          mediaType,
          bytes: block.bytes ?? (typeof block.data === 'string' ? block.data.length : 0),
          width: block.width ?? null,
          height: block.height ?? null,
        },
      })
    }
  }
  return out
}

function assertKnownBlocks(blocks) {
  if (blocks === undefined) return
  if (!Array.isArray(blocks)) throw new TypeError(`blocks 必须是数组，收到 ${typeof blocks}`)
  for (const block of blocks) {
    if (!KNOWN_BLOCKS.includes(block)) {
      throw new Error(`未知的 blocks 项 "${block}"；可用：${KNOWN_BLOCKS.join(', ')}`)
    }
  }
}

function formatNumber(value) {
  // 只用于坐标/尺寸这类整数场景；上游输出也没有小数点后多余的零。
  return Number.isInteger(value) ? String(value) : String(Number(value))
}

function parsePair(text) {
  const m = /\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/.exec(text ?? '')
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 }
}

/**
 * 把各种写法归一成 {left, top, right, bottom}。
 * 接受 `[l,t,r,b]`、`{left,top,right,bottom}`、`{x,y,width,height}`。
 */
export function normaliseRegion(region) {
  if (region === null || region === undefined) return { left: -100, top: -200, right: 2460, bottom: 1240 }
  if (Array.isArray(region)) {
    const [left, top, right, bottom] = region
    return { left, top, right, bottom }
  }
  if (typeof region === 'object') {
    if ('right' in region && 'bottom' in region) {
      return { left: region.left ?? 0, top: region.top ?? 0, right: region.right, bottom: region.bottom }
    }
    const left = region.left ?? region.x ?? 0
    const top = region.top ?? region.y ?? 0
    return { left, top, right: left + (region.width ?? 0), bottom: top + (region.height ?? 0) }
  }
  throw new TypeError(`无法识别的 region：${JSON.stringify(region)}`)
}

/**
 * 把 UI 元素列表渲染成上游风格的树行。
 *
 * @param {object[]} elements 每项 `{x, y, controlType, label, action, focused, value}`
 * @param {object} [options]
 * @param {boolean} [options.crlf] 用 CRLF 行尾（S-OBS-05 的容错输入之一）
 */
export function renderUiTree(elements, { crlf = false } = {}) {
  const eol = crlf ? '\r\n' : '\n'
  const lines = ['desktop']
  elements.forEach((element, index) => {
    const branch = index === elements.length - 1 ? '└──' : '├──'
    const attrs = []
    if (element.action) attrs.push(`[action: ${element.action}]`)
    if (element.focused) attrs.push('[focused]')
    if (element.value !== undefined && element.value !== null) attrs.push(`[value:"${element.value}"]`)
    const label = element.label === undefined ? '' : ` "${element.label}"`
    lines.push(
      `${branch} (${formatNumber(element.x)},${formatNumber(element.y)}) ` +
        `${element.controlType}${label}${attrs.length ? '  ' + attrs.join('  ') : ''}`,
    )
  })
  return lines.join(eol)
}

function renderWindowTable(focused) {
  return [
    '    Name                                                           Depth  Status       Width    Height    Handle',
    '-----------------------------------------------------------  -------  ---------  -------  --------  --------',
    `${focused.name}                                                           ${focused.depth}  ${focused.status}        ${focused.width}      ${focused.height}   ${focused.handle}`,
  ].join('\n')
}

function renderOpenedTable(windows) {
  return [
    '    Name                                    Depth  Status       Width    Height    Handle',
    '------------------------------------  -------  ---------  -------  --------  --------',
    ...windows.map(
      (w) => `${w.name}                                    ${w.depth}  ${w.status}        ${w.width}         ${w.height}  ${w.handle}`,
    ),
  ].join('\n')
}

/**
 * 创建一个假 MCP 服务器。
 *
 * @param {object} [knobs]
 * @param {readonly string[]} [knobs.blocks] 要出现的区块；缺省 = 全部常规区块。
 *   可选：cursor / originalSize / coordScale / region / coordinateSpace / backend /
 *         displays / focusedWindow / openedWindows / uiTree
 * @param {number|null} [knobs.scale] `Screenshot Coordinate Scale` 的值；`null` = 不打印该行（上游 scale==1.0 的分支）
 * @param {number[]|object|null} [knobs.region] 截图区域；数组 `[l,t,r,b]` 或对象；`null` = 不打印该行
 * @param {{x:number,y:number}|null} [knobs.cursor] 光标位置；`null` = 不打印该行
 * @param {{name,depth,status,width,height,handle}|null} [knobs.focusedWindow] 焦点窗口；null = `No active window found`
 * @param {object[]} [knobs.windows] 已打开窗口列表
 * @param {object[]|null} [knobs.uiTree] UI 元素；`null` = 占位空树 `No elements`
 * @param {{width:number,height:number}} [knobs.originalSize]
 * @param {number} [knobs.attachmentWidth] / [knobs.attachmentHeight] 落盘附件尺寸
 * @param {string} [knobs.mediaType] 图片媒体类型（默认 image/png；换成别的可造 S-BRIDGE-05）
 * @param {boolean} [knobs.crlf] 用 CRLF 行尾输出
 * @param {boolean} [knobs.image] 是否生成图片块（默认 Screenshot=true / Snapshot=false）
 * @param {boolean} [knobs.neverSpeak] 永不返回（模拟服务器不响应）
 * @param {number|null} [knobs.disconnectAfterChunks] 只送出前 N 个块后断线
 * @param {string|null} [knobs.malformedText] 文本载荷替换成任意畸形字符串
 * @param {object|null} [knobs.error] 上游报错 `{ message, code? }`
 */
export function createFakeMcpServer(knobs = {}) {
  assertKnownBlocks(knobs.blocks)
  const blocks = knobs.blocks === undefined ? null : new Set(knobs.blocks)

  const has = (name) => (blocks === null ? true : blocks.has(name))
  const calls = []
  const sentChunks = []
  let pending = 0

  const defaults = {
    cursor: { x: 1290, y: 651 },
    originalSize: { width: 2560, height: 1440 },
    scale: 1.333333,
    region: { left: 0, top: 0, right: 2560, bottom: 1440 },
    coordinateSpace: 'Virtual desktop coordinates',
    backend: 'dxcam',
    focusedWindow: { name: 'Notepad', depth: 10, status: 'Normal', width: 800, height: 600, handle: '4242' },
    windows: [{ name: 'ChatGPT', depth: 25, status: 'Minimized', width: 0, height: 0, handle: '30081398' }],
    uiTree: [
      { x: 2361, y: 35, controlType: '按钮', label: '最小化', action: 'click' },
      { x: 2520, y: 35, controlType: '按钮', label: '关闭', action: 'click' },
      { x: 1838, y: 720, controlType: '文档', label: 'ChatGPT', action: 'click', focused: true, value: 'app://-/index.html' },
    ],
    attachment: { width: 1920, height: 1080 },
    mediaType: 'image/png',
  }

  const pick = (key) => (key in knobs ? knobs[key] : defaults[key])

  /** 组装观测头部（Cursor / Size / Scale / Region / Coordinate Space / Backend / Displays）。 */
  function renderHead() {
    const eol = knobs.crlf ? '\r\n' : '\n'
    const lines = []
    if (has('cursor') && pick('cursor') !== null) {
      const cursor = pick('cursor')
      lines.push(`Cursor Position: (${formatNumber(cursor.x)}, ${formatNumber(cursor.y)})`)
    }
    if (has('originalSize') && pick('originalSize') !== null) {
      const size = pick('originalSize')
      lines.push(`Screenshot Original Size: (${size.width},${size.height})`)
    }
    if (has('coordScale') && pick('scale') !== null) {
      const note = knobs.scaleNote ?? SCALE_NOTE.replaceAll('1.333333', String(pick('scale')))
      lines.push(`Screenshot Coordinate Scale: ${pick('scale')} — ${note}`)
    }
    if (has('displays')) {
      lines.push('Visible Displays: 0:\\\\.\\DISPLAY1 (0,0,2560,1440) primary')
      lines.push('Selected Displays: 0')
    }
    if (has('region') && pick('region') !== null) {
      const region = normaliseRegion(pick('region'))
      lines.push(`Screenshot Region: (${region.left},${region.top},${region.right},${region.bottom})`)
    }
    if (has('coordinateSpace')) lines.push(`Coordinate Space: ${pick('coordinateSpace')}`)
    if (has('backend')) lines.push(`Screenshot Backend: ${pick('backend')}`)
    return lines.join(eol)
  }

  function renderAttachments() {
    const eol = knobs.crlf ? '\r\n' : '\n'
    const attachment = pick('attachment')
    const mediaType = pick('mediaType')
    if (!knobs.hideAttachmentLine) {
      return (
        `${eol}Image sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; ` +
        `request preview 1708x961px. Normalized copy (read-only; may be resized or re-encoded): ` +
        `"C:\\Users\\<user>\\.dsh\\attachments\\v1\\objects\\e0\\0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ` +
        `(${attachment.width}x${attachment.height}px, ${mediaType}). Source dimensions, format, and byte size may differ.`
      )
    }
    return ''
  }

  /** Snapshot 文本（观测头部 + 焦点窗口 + 已打开窗口 + UI 树）。 */
  function snapshot() {
    const eol = knobs.crlf ? '\r\n' : '\n'
    const parts = []
    const head = renderHead()
    if (head !== '') parts.push(head)
    if (has('focusedWindow')) {
      const focused = pick('focusedWindow')
      parts.push('')
      parts.push('    Focused Window:')
      parts.push(focused === null ? NO_ACTIVE_WINDOW_TEXT : renderWindowTable(focused))
    }
    if (has('openedWindows')) {
      const windows = pick('windows')
      parts.push('')
      parts.push('    Opened Windows:')
      parts.push(windows.length === 0 ? NO_WINDOWS_TEXT : renderOpenedTable(windows))
    }
    if (has('uiTree')) {
      const elements = pick('uiTree')
      parts.push('')
      parts.push('UI Tree:')
      const placeholder = knobs.treePlaceholder ?? NO_ELEMENTS_TEXT
      parts.push(
        elements === null || elements.length === 0 ? placeholder : renderUiTree(elements, { crlf: knobs.crlf }),
      )
    }
    // 真实快照的 Cursor 行带前导空格（上游原样输出），这里保留同样的不规则性。
    const text = parts.join(eol)
    return knobs.crlf ? text : text.replace(/^(\s*)Cursor Position:/m, '    Cursor Position:')
  }

  /** Screenshot 文本（观测头部 + 附件说明行；无 UI 树）。 */
  function screenshot() {
    const eol = knobs.crlf ? '\r\n' : '\n'
    return `${renderHead()}${renderAttachments()}`.split('\n').join(eol)
  }

  const actionText = {
    Click: (args) => `Clicked at ${JSON.stringify(args?.loc ?? args?.location ?? null)}`,
    Type: (args) => `Typed ${String(args?.text ?? '').length} characters`,
    Move: (args) => `Moved cursor to ${JSON.stringify(args?.loc ?? null)}`,
    Scroll: () => 'Scrolled',
    Shortcut: (args) => `Sent shortcut ${String(args?.shortcut ?? '')}`,
    PowerShell: (args) => `Command executed: ${String(args?.command ?? '')}`,
    Wait: (args) => `Waited ${String(args?.duration ?? 0)} seconds`,
    WaitFor: (args) => `Condition met: ${String(args?.condition ?? '')}`,
  }

  /**
   * 调用一次工具，返回 MCP / DSH 两层形状。
   *
   * @param {string} tool 裸工具名（不带 `mcp__<server>__` 前缀）
   * @param {object} [args]
   * @returns {Promise<{isError: boolean, value: {content: object[]}, content: object[], error?: object, partial?: boolean}>}
   */
  async function respond(tool, args = {}) {
    calls.push({ tool, args })

    if (knobs.neverSpeak) {
      pending += 1
      // 刻意永不 settle：这就是「服务器不响应」的可观测定义。
      // 没有定时器、没有副作用，测试用 pendingCount() 断言它确实悬着。
      return new Promise(() => {})
    }

    if (knobs.error) {
      return { isError: true, error: { message: knobs.error.message ?? 'upstream error', code: knobs.error.code ?? null }, value: { content: [] }, content: [] }
    }

    const raw = []
    const withImage = knobs.image ?? tool === 'Screenshot'
    let text
    if (knobs.malformedText !== undefined && knobs.malformedText !== null) {
      text = knobs.malformedText
    } else if (tool === 'Snapshot') {
      text = snapshot()
    } else if (tool === 'Screenshot') {
      text = screenshot()
    } else if (tool === 'DisplayInventory') {
      text = 'Display 0: \\\\.\\DISPLAY1 (0,0,2560,1440) primary, scale 1.25'
    } else if (typeof actionText[tool] === 'function') {
      text = actionText[tool](args)
    } else {
      return { isError: true, error: { message: `未知工具 ${tool}` }, value: { content: [] }, content: [] }
    }

    raw.push({ type: 'text', text })
    if (withImage) {
      raw.push({
        type: 'image',
        data: 'ZmFrZS1pbWFnZS1ieXRlcw==',
        mimeType: pick('mediaType'),
        width: pick('attachment').width,
        height: pick('attachment').height,
      })
    }

    // 断线：只送出前 N 个块，然后以传输错误结束——「收到一半」这件事被显式保留。
    if (typeof knobs.disconnectAfterChunks === 'number') {
      sentChunks.length = 0
      for (const block of raw.slice(0, knobs.disconnectAfterChunks)) sentChunks.push(block)
      const error = new Error(`MCP 传输中断：已收到 ${sentChunks.length}/${raw.length} 个块后连接断开`)
      error.code = 'MCP_DISCONNECT'
      error.sentChunks = [...sentChunks]
      throw error
    }

    return { isError: false, value: { content: raw }, content: projectContent(raw) }
  }

  return {
    knobs,
    /** 上游原始块（最近一次 respond 的 raw）——诊断用。 */
    respond,
    /** 已发生调用的记录（工具名 + 参数）。 */
    calls: () => [...calls],
    /** 有多少次调用悬着没 settle（`neverSpeak` 场景）。 */
    pendingCount: () => pending,
    /** 断线时实际送出的块（`disconnectAfterChunks` 场景）。 */
    sentChunks: () => [...sentChunks],
    /** 把原始块投影成 DSH 内容块（可在不调用的情况下单独验证桥规则）。 */
    project: (rawBlocks) => projectContent(rawBlocks),
    /** 手工造一份文本结果（用于字节保真断言）。 */
    textResult: (text, extra = {}) => ({
      isError: false,
      value: { content: [{ type: 'text', text }] },
      content: [{ type: 'text', text }],
      ...extra,
    }),
    /** 与 host.js 共享的真实样本，方便测试对照「假形状 vs 真形状」。 */
    samples: { REAL_SNAPSHOT_TEXT, REAL_SCREENSHOT_TEXT },
  }
}

/** 常用旋钮组合：真实抓取过的完整形状（与 REAL_SNAPSHOT_TEXT 同结构）。 */
export const REAL_LIKE_SNAPSHOT_KNOBS = Object.freeze({
  focusedWindow: { name: 'Notepad', depth: 10, status: 'Normal', width: 800, height: 600, handle: '4242' },
  windows: [{ name: 'ChatGPT', depth: 25, status: 'Minimized', width: 0, height: 0, handle: '30081398' }],
})

/** 常用旋钮组合：UI 树占位空树（U-05 的第二种形状）。 */
export const EMPTY_TREE_KNOBS = Object.freeze({ uiTree: null })

/** 常用旋钮组合：图片媒体类型不被桥接纳（S-BRIDGE-05）。 */
export const UNADMITTABLE_IMAGE_KNOBS = Object.freeze({ image: true, mediaType: 'image/heif' })
