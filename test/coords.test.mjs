/**
 * observe.js / coords.js 的解析与映射测试。
 *
 * 测试数据是**真实抓取的输出**（本机 2560x1440 单显示器、Windows 缩放 125%），
 * 不是编造的样例，这样一旦上游改了输出格式，这里会立刻失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildObservation,
  parseCursor,
  parseOriginalSize,
  parseCoordScale,
  parseRegion,
  parseCoordinateSpace,
  parseBackend,
  parseFocusedWindow,
  parseOpenedWindows,
  parseUiElements,
  parseAttachmentSize,
  parseImageSha,
  stripToolPrefix,
  attachmentRatio,
  isCoordinateComplete,
  extractText,
  hasImageBlock,
} from '../lib/observe.js'
import {
  buildMapping,
  imageToScreen,
  screenToImage,
  screenPerImagePx,
  describeMapping,
} from '../lib/coords.js'

// ── 真实样本 ────────────────────────────────────────────────────────────────

/** 实测 Snapshot(use_vision=false) 的文本载荷（节选自真实输出）。 */
const SNAPSHOT_TEXT = `    Cursor Position: (755, 733)
Visible Displays: 0:\\\\.\\DISPLAY1 (0,0,2560,1440) primary

    Active Desktop:
    Name
---------
Desktop 1

    Focused Window:
    Name                                                           Depth  Status       Width    Height    Handle
-----------------------------------------------------------  -------  ---------  -------  --------  --------
https://github.com/CursorTouch/Windows-M — DeepSeek Harness       10  Maximized     2578      1458   9439642

    Opened Windows:
    Name                                    Depth  Status       Width    Height    Handle
------------------------------------  -------  ---------  -------  --------  --------
我的订阅 - Max JOJO Code - Google Chrome       19  Minimized        0         0    134202
ChatGPT                                    25  Minimized        0         0  30081398


UI Tree:
desktop
├── window "https://github.com/CursorTouch/Windows-M — DeepSeek Harness"
│   └── 区域 "https://github.com/CursorTouch/Windows-M — DeepSeek Harness"
│       ├── (2361,35) 按钮 "最小化"  [action: click]
│       ├── (2439,35) 按钮 "恢复"  [action: click]
│       └── (2520,35) 按钮 "关闭"  [action: click]
├── window "ChatGPT"
│   └── 窗格 "ChatGPT"
│       └── 区域 "ChatGPT"
│           └── (1838,720) 文档 "ChatGPT"  [action: click]  [focused]  [value:"app://-/index.html"]
└── window "任务栏"`

/** 实测 Screenshot() 的文本载荷（节选）。 */
const SCREENSHOT_TEXT = `    Cursor Position: (1290, 651)
Screenshot Original Size: (2560,1440)
Screenshot Coordinate Scale: 1.333333 — image pixels are downscaled; multiply every image pixel coordinate by 1.333333 before passing to Click, Move, Scroll, or any loc= argument (e.g. image pixel (200, 150) → screen coordinate (267, 200))
Visible Displays: 0:\\\\.\\DISPLAY1 (0,0,2560,1440) primary
Selected Displays: 0
Screenshot Region: (0,0,2560,1440)
Coordinate Space: Virtual desktop coordinates
Screenshot Backend: dxcam

Focused Window:
No active window found

Opened Windows:
No windows found

Image sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; request preview 1708x961px. Normalized copy (read-only; may be resized or re-encoded): "C:\\Users\\<user>\\.dsh\\attachments\\v1\\objects\\e0\\0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" (1920x1080px, image/png). Source dimensions, format, and byte size may differ.`

/** 落盘附件真实尺寸（用 PNG IHDR 读出来的）。 */
const ATTACHMENT_WIDTH = 1920
const ATTACHMENT_HEIGHT = 1080

// ── 单项解析器 ──────────────────────────────────────────────────────────────

test('stripToolPrefix 去掉桥加的前缀，且不误伤别的 server', () => {
  assert.equal(stripToolPrefix('mcp__winmcp__Snapshot'), 'Snapshot')
  assert.equal(stripToolPrefix('mcp__other__Snapshot'), 'mcp__other__Snapshot')
  assert.equal(stripToolPrefix('Snapshot'), 'Snapshot')
  assert.equal(stripToolPrefix(undefined), '')
})

test('parseCursor 支持负数坐标', () => {
  assert.deepEqual(parseCursor('Cursor Position: (755, 733)'), { x: 755, y: 733 })
  assert.deepEqual(parseCursor('Cursor Position: (-100, -20)'), { x: -100, y: -20 })
  assert.equal(parseCursor('nothing here'), null)
})

test('parseOriginalSize 同时兼容 "Screenshot Size:" 与 "Screenshot Original Size:"', () => {
  assert.deepEqual(parseOriginalSize('Screenshot Original Size: (2560,1440)'), { width: 2560, height: 1440 })
  assert.deepEqual(parseOriginalSize('Screenshot Size: (1920,1080)'), { width: 1920, height: 1080 })
  assert.equal(parseOriginalSize('Screenshot Backend: dxcam'), null)
})

test('parseCoordScale 解析乘数，且拒绝非法值', () => {
  assert.equal(parseCoordScale('Screenshot Coordinate Scale: 1.333333 — image pixels'), 1.333333)
  assert.equal(parseCoordScale('Screenshot Coordinate Scale: 0'), null)
  assert.equal(parseCoordScale('Screenshot Size: (1920,1080)'), null)
})

test('parseRegion 给出四条边与宽高', () => {
  assert.deepEqual(parseRegion('Screenshot Region: (0,0,2560,1440)'), {
    left: 0, top: 0, right: 2560, bottom: 1440, width: 2560, height: 1440,
  })
  assert.deepEqual(parseRegion('Screenshot Region: (-1920,0,0,1080)'), {
    left: -1920, top: 0, right: 0, bottom: 1080, width: 1920, height: 1080,
  })
  assert.equal(parseRegion('no region'), null)
})

test('parseCoordinateSpace / parseBackend', () => {
  assert.equal(parseCoordinateSpace(SCREENSHOT_TEXT), 'Virtual desktop coordinates')
  assert.equal(parseBackend(SCREENSHOT_TEXT), 'dxcam')
  assert.equal(parseBackend(SNAPSHOT_TEXT), null)
})

test('parseFocusedWindow 从行尾逆向切分，容忍名称含空格', () => {
  const w = parseFocusedWindow(SNAPSHOT_TEXT)
  assert.equal(w.name, 'https://github.com/CursorTouch/Windows-M — DeepSeek Harness')
  assert.equal(w.depth, 10)
  assert.equal(w.status, 'Maximized')
  assert.equal(w.width, 2578)
  assert.equal(w.height, 1458)
  assert.equal(w.handle, '9439642')
})

test('parseFocusedWindow 对 "No active window found" 返回 null', () => {
  assert.equal(parseFocusedWindow(SCREENSHOT_TEXT), null)
})

test('parseOpenedWindows 解析多行且跳过表头/分隔线', () => {
  const list = parseOpenedWindows(SNAPSHOT_TEXT)
  assert.equal(list.length, 2)
  assert.equal(list[0].name, '我的订阅 - Max JOJO Code - Google Chrome')
  assert.equal(list[0].handle, '134202')
  assert.equal(list[1].name, 'ChatGPT')
  assert.equal(list[1].depth, 25)
})

test('parseUiElements 提取坐标/控件类型/标签/动作/焦点/value', () => {
  // 真实输出是 CRLF 行尾，这里刻意保留，顺带验证按行界定属性不受 \r 影响。
  // 注意：解析只在 `UI Tree:` 区段内进行（区段外的 (x,y) 属于光标/区域等元数据）。
  const els = parseUiElements(SNAPSHOT_TEXT.replace(/\n/g, '\r\n'))
  // 样本里 UI 树内带坐标的元素恰好 4 个：3 个标题栏按钮 + 1 个文档区域
  assert.equal(els.length, 4, `实际解析出 ${els.length} 个：${els.map((e) => e.label).join('|')}`)
  const close = els.find((e) => e.label === '关闭')
  assert.deepEqual({ x: close.x, y: close.y, controlType: close.controlType }, { x: 2520, y: 35, controlType: '按钮' })
  assert.equal(close.action, 'click')
  // 关键回归：只有文档元素带 [focused]/[value]，前面的按钮不能继承到它们
  assert.equal(close.focused, false, '按钮不该被后面元素的 [focused] 污染')
  assert.equal(close.value, null, '按钮不该被后面元素的 [value] 污染')
  const doc = els.find((e) => e.focused)
  assert.equal(doc.label, 'ChatGPT')
  assert.equal(doc.value, 'app://-/index.html')
  assert.equal(doc.x, 1838)
  assert.equal(els.filter((e) => e.focused).length, 1, '有且只有一个元素带焦点')
})

test('parseAttachmentSize / parseImageSha 从附件说明行提取', () => {
  assert.deepEqual(parseAttachmentSize(SCREENSHOT_TEXT), { width: 1920, height: 1080, format: 'png' })
  assert.equal(
    parseImageSha(SCREENSHOT_TEXT),
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  )
})

test('extractText 从桥的结构化值里取文本块', () => {
  const value = { content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }, { type: 'text', text: 'b' }] }
  assert.equal(extractText(value), 'a\nb')
  assert.equal(extractText('raw'), 'raw')
  assert.equal(extractText(null), '')
})

test('hasImageBlock 识别桥投影后的图片块', () => {
  assert.equal(hasImageBlock([{ type: 'text' }, { type: 'image', attachment: {} }]), true)
  assert.equal(hasImageBlock([{ type: 'text' }]), false)
  assert.equal(hasImageBlock(undefined), false)
})

// ── 整条观测 ────────────────────────────────────────────────────────────────

test('buildObservation 从真实 Screenshot 文本构建完整观测', () => {
  const value = { content: [{ type: 'text', text: SCREENSHOT_TEXT }, { type: 'image', data: 'AAAA' }] }
  const obs = buildObservation({
    value,
    content: [{ type: 'text', text: SCREENSHOT_TEXT }, { type: 'image', attachment: { id: 'x' } }],
    tool: 'mcp__winmcp__Screenshot',
    at: 1000,
    generation: 3,
    id: 'obs-3',
  })
  assert.equal(obs.id, 'obs-3')
  assert.equal(obs.tool, 'Screenshot')
  assert.equal(obs.generation, 3)
  assert.equal(obs.at, 1000)
  assert.deepEqual(obs.cursor, { x: 1290, y: 651 })
  assert.deepEqual(obs.originalSize, { width: 2560, height: 1440 })
  assert.equal(obs.coordScale, 1.333333)
  assert.equal(obs.region.width, 2560)
  assert.equal(obs.coordinateSpace, 'Virtual desktop coordinates')
  assert.equal(obs.backend, 'dxcam')
  assert.equal(obs.image.hasImage, true)
  assert.deepEqual(obs.image.attachmentSize, { width: ATTACHMENT_WIDTH, height: ATTACHMENT_HEIGHT, format: 'png' })
  assert.equal(isCoordinateComplete(obs), true)
})

test('buildObservation 对纯文本结果不虚构坐标', () => {
  const obs = buildObservation({ value: 'Done', content: [{ type: 'text', text: 'Done' }], tool: 'mcp__winmcp__Click' })
  assert.equal(obs.cursor, null)
  assert.equal(obs.region, null)
  assert.equal(obs.image.hasImage, false)
  assert.equal(isCoordinateComplete(obs), false)
})

test('makeObservationRecord 风格的映射：真实 Screenshot 文本给出可用映射', () => {
  const obs = buildObservation({ value: SCREENSHOT_TEXT, content: [], tool: 'Screenshot', id: 'obs-1' })
  const mapping = buildMapping(obs)
  assert.equal(mapping.ok, true)
  assert.equal(mapping.screenPerImagePx, 1.333333)
  assert.equal(mapping.observationId, 'obs-1')
})

// ── 映射 ────────────────────────────────────────────────────────────────────

test('screenPerImagePx = coord_scale（实测确认：不叠加附件比例）', () => {
  // 关键回归：早期版本把 attachmentRatio 也乘进去，得到 1.7778——已被实测否掉。
  // 本机 1920 = 2560 / 1.333333，coord_scale 本身就是「模型所见图 → 屏幕」的完整因子。
  assert.equal(screenPerImagePx({ coordScale: 1.333333 }), 1.333333)
  // 缺省按 1
  assert.equal(screenPerImagePx({}), 1)
  // 非法值退化为 1，而不是产生 0 或负数
  assert.equal(screenPerImagePx({ coordScale: -3 }), 1)
  assert.equal(screenPerImagePx({ coordScale: null }), 1)
})

test('screenPerImagePx 只在显式给出不同 previewWidth 时才做兜底换算', () => {
  assert.equal(screenPerImagePx({ coordScale: 1.5, previewWidth: 1000, originalWidth: 1000 }), 1.5)
  assert.equal(screenPerImagePx({ coordScale: 1.5, previewWidth: 500, originalWidth: 1000 }), 3)
  // 只用其中一个参数不算数，避免误触发
  assert.equal(screenPerImagePx({ coordScale: 1.5, previewWidth: 500 }), 1.5)
})

test('buildMapping 用实测数据算出 1.333333 的系数与 (0,0) 原点', () => {
  const obs = buildObservation({ value: SCREENSHOT_TEXT, content: [], tool: 'Screenshot' })
  const mapping = buildMapping(obs)
  assert.equal(mapping.ok, true)
  assert.equal(mapping.coordScale, 1.333333)
  assert.equal(Math.round(mapping.screenPerImagePx * 1000) / 1000, 1.333)
  assert.deepEqual(mapping.origin, { x: 0, y: 0 })
  assert.equal(mapping.region.left, 0)
  // 附件尺寸只作为诊断暴露，绝不参与换算
  assert.equal(mapping.attachmentSize.width, 1920)
  assert.ok(mapping.diagnostics.some((d) => /不叠加附件比例/.test(d)), '应当给出附件≠上游的提示')
})

test('映射与实测探针一致：屏幕 2520 → 图片 1890（关闭按钮）', () => {
  // 实测依据：use_annotation=true 时服务端把 CURSOR 红十字画在 2520/1.333333 = 1890，
  // 且该十字正好压在「关闭」按钮上。这正是坐标验证报告里那个无残差点。
  const obs = buildObservation({ value: SCREENSHOT_TEXT, content: [], tool: 'Screenshot' })
  const mapping = buildMapping(obs)
  const image = screenToImage(2520, 35, mapping)
  assert.equal(Math.round(image.x), 1890)
  assert.ok(Math.abs(image.x - 1890) < 0.01, `期望 1890，实际 ${image.x}`)
  // 反向必须回到原值
  const back = imageToScreen(image.x, image.y, mapping)
  assert.ok(Math.abs(back.x - 2520) < 0.01)
  assert.ok(Math.abs(back.y - 35) < 0.01)
})

test('映射与实测探针一致：光标 (2000,720) → 图片 (1500,540)', () => {
  const obs = buildObservation({ value: SCREENSHOT_TEXT, content: [], tool: 'Screenshot' })
  const mapping = buildMapping(obs)
  const image = screenToImage(2000, 720, mapping)
  assert.ok(Math.abs(image.x - 1500) < 0.6, `期望 ~1500，实际 ${image.x}`)
  assert.ok(Math.abs(image.y - 540) < 0.6, `期望 ~540，实际 ${image.y}`)
  assert.deepEqual(imageToScreen(1500, 540, mapping), { x: 2000, y: 720 })
})

test('映射在非零原点的 region 上仍然正确（多显示器/子区域）', () => {
  // 构造一个「无额外缩放」的样本：上游没有 Coordinate Scale 行（=1.0），
  // region 为负原点，附件与上游图片同尺寸。真实多显示器布局里 region 原点常为负。
  const text = [
    'Cursor Position: (0, 0)',
    'Screenshot Size: (1920,1080)',
    'Screenshot Region: (-1920,0,0,1080)',
    'Coordinate Space: Virtual desktop coordinates',
    'Normalized copy (1920x1080px, image/png)',
  ].join('\n')
  const obs = buildObservation({ value: text, content: [], tool: 'Screenshot' })
  const mapping = buildMapping(obs)
  assert.equal(mapping.coordScale, 1)
  assert.equal(mapping.screenPerImagePx, 1)
  // 负原点区域：图片 (0,0) 对应屏幕 (-1920, 0)
  assert.deepEqual(imageToScreen(0, 0, mapping), { x: -1920, y: 0 })
  // 反向：屏幕原点在图片的 x=1920 处
  assert.equal(Math.round(screenToImage(0, 0, mapping).x), 1920)
  // 区域右下角
  assert.deepEqual(imageToScreen(1920, 1080, mapping), { x: 0, y: 1080 })
})

test('缺少 Scale 与 Size 时映射标记为不可用并给出原因', () => {
  const obs = buildObservation({ value: 'Cursor Position: (1, 2)', content: [], tool: 'Screenshot' })
  const mapping = buildMapping(obs)
  assert.equal(mapping.ok, false)
  assert.match(mapping.reason, /Coordinate Scale/)
})

test('缺少 Region 行时原点退化为 (0,0) 并给出诊断（上游默认全桌面路径就不打印 Region）', () => {
  const text = 'Screenshot Size: (2560,1440)\nNormalized copy (1920x1080px, image/png)'
  const obs = buildObservation({ value: text, content: [], tool: 'Screenshot' })
  const mapping = buildMapping(obs)
  assert.equal(mapping.ok, true, '有 Scale/Size 就该可用')
  assert.deepEqual(mapping.origin, { x: 0, y: 0 })
  assert.ok(mapping.diagnostics.some((d) => /Region/.test(d)))
})

test('没有 coordScale 行时按 1 处理（上游 scale=1.0 的情形）', () => {
  const text = 'Screenshot Size: (2560,1440)\nScreenshot Region: (0,0,2560,1440)\nNormalized copy (2560x1440px, image/png)'
  const obs = buildObservation({ value: text, content: [], tool: 'Screenshot' })
  const mapping = buildMapping(obs)
  assert.equal(mapping.ok, true)
  assert.equal(mapping.coordScale, 1)
  assert.equal(mapping.screenPerImagePx, 1)
  assert.ok(mapping.diagnostics.some((d) => /Scale/.test(d)))
  assert.deepEqual(imageToScreen(100, 200, mapping), { x: 100, y: 200 })
})

test('describeMapping 输出单行、可机器读取的键值对', () => {
  const obs = buildObservation({ value: SCREENSHOT_TEXT, content: [], tool: 'Screenshot' })
  const line = describeMapping(buildMapping(obs), { observationId: 'obs-7' })
  assert.match(line, /^\[mcp\] /)
  assert.match(line, /scale=1\.333/)
  assert.match(line, /origin=0,0/)
  assert.match(line, /region=0,0,2560,1440/)
  assert.match(line, /coord_scale=1\.333333/)
  assert.match(line, /source=2560x1440/)
  assert.match(line, /attachment=1920x1080/)
  assert.match(line, /based_on=obs-7/)
  assert.match(line, /screen = \(0,0\) \+ image_px \* 1\.333/)
  assert.equal(line.split('\n').length, 1, '必须是一行，避免污染上下文')
})

test('映射不可用时 describeMapping 说明原因而不是抛异常', () => {
  assert.match(describeMapping(null), /无坐标映射数据/)
  assert.match(describeMapping({ ok: false, reason: '缺 Region' }), /缺 Region/)
})

test('imageToScreen 在映射不可用时抛出可读错误', () => {
  assert.throws(() => imageToScreen(1, 2, { ok: false, reason: 'x' }), /坐标映射不可用/)
  assert.throws(() => imageToScreen(1, 2, null), /坐标映射不可用/)
})
