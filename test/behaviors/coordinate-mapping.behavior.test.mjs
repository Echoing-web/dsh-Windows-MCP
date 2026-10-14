/**
 * BDD 行为测试：features/coordinate-mapping.feature
 *
 * 与 test/coords.test.mjs 的分工：
 * - coords.test.mjs 是**单元层**（解析器逐个函数、边界、错误分支）；
 * - 本文件是**行为层**，只按 feature 的场景断言对外结果，不关心内部函数名。
 *
 * 两者都必须存在：单元层保证细节正确，行为层保证"规格说的那件事"真的成立。
 * spec/spec-coverage.test.mjs 会强制本文件声明覆盖了全部 21 个场景。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildObservation, parsePreviewSize, parseAttachmentSize } from '../../lib/observe.js'
import {
  buildMapping,
  imageToScreen,
  screenToImage,
  describeMapping,
  screenPerImagePx,
} from '../../lib/coords.js'
import { createHost } from '../harness/host.js'
import { createFakeMcpServer } from '../harness/fake-mcp.js'
import { coverage } from '../harness/link.js'

coverage({
  spec: ['S-MAP-01', 'S-MAP-02', 'S-MAP-03', 'S-MAP-04', 'S-MAP-05', 'S-MAP-06', 'S-MAP-07', 'S-MAP-08', 'S-OBS-05', 'S-OBS-06'],
  covers: [
    '坐标映射 :: 图片像素换算为屏幕坐标',
    '坐标映射 :: 屏幕坐标换算回图片像素',
    '坐标映射 :: 换算结果与整数相差极小时吸附到整数',
    '坐标映射 :: 附件尺寸不参与换算',
    '坐标映射 :: 缺少缩放系数行时按 1.0 处理',
    '坐标映射 :: 缺少区域行时原点退化为零',
    '坐标映射 :: 坐标系原点非零时仍然正确',
    '坐标映射 :: 映射信息不足时必须明确失败',
    '坐标映射 :: 映射摘要必须是一行',
    '坐标映射 :: 附件说明里的预览尺寸被解析并核对',
    '坐标映射 :: 解析容错——CRLF 与中文控件名',
    '坐标映射 :: 多个元素的焦点与取值只属于各自所在行',
  ],
})

/** 实测的 Screenshot 元数据（本机 2560x1440 @125%）。 */
const REAL = `Cursor Position: (1290, 651)
Screenshot Original Size: (2560,1440)
Screenshot Coordinate Scale: 1.333333 — image pixels are downscaled; multiply every image pixel coordinate by 1.333333 before passing to Click, Move, Scroll, or any loc= argument
Screenshot Region: (0,0,2560,1440)
Coordinate Space: Virtual desktop coordinates
Normalized copy (1920x1080px, image/png)`

/** 从文本构造一次观测（Given 步骤的底层实现）。 */
function observationFrom(text) {
  return buildObservation({ value: text, content: [], tool: 'mcp__winmcp__Screenshot', at: 1000, id: 'obs-1' })
}

function mappingFrom(text) {
  return buildMapping(observationFrom(text))
}

// ── Scenario: 图片像素换算为屏幕坐标 ────────────────────────────────────────
test('坐标映射 :: 图片像素换算为屏幕坐标', () => {
  const mapping = mappingFrom(REAL)
  const screen = imageToScreen(1890, 26.25, mapping)
  assert.deepEqual(screen, { x: 2520, y: 35 })
})

// ── Scenario: 屏幕坐标换算回图片像素 ────────────────────────────────────────
test('坐标映射 :: 屏幕坐标换算回图片像素', () => {
  const mapping = mappingFrom(REAL)
  const image = screenToImage(2000, 720, mapping)
  assert.ok(Math.abs(image.x - 1500) < 0.01, `期望 1500，实际 ${image.x}`)
  assert.ok(Math.abs(image.y - 540) < 0.01, `期望 540，实际 ${image.y}`)
})

// ── Scenario: 换算结果与整数相差极小时吸附到整数 ────────────────────────────
test('坐标映射 :: 换算结果与整数相差极小时吸附到整数', () => {
  const mapping = mappingFrom(REAL)
  const screen = imageToScreen(1890, 26.25, mapping)
  // 1890 × 1.333333 = 2519.99937；必须吸附成 2520，否则模型会反复微调
  assert.equal(screen.x, 2520)
  assert.equal(Number.isInteger(screen.x), true)
})

// ── Scenario: 附件尺寸不参与换算 ────────────────────────────────────────────
test('坐标映射 :: 附件尺寸不参与换算', () => {
  const mapping = mappingFrom(REAL)
  assert.equal(mapping.screenPerImagePx, 1.333333)
  assert.notEqual(mapping.screenPerImagePx, 1.333333 / 0.75)
  // 同时必须把「附件 ≠ 上游」这件事作为诊断暴露出来，而不是沉默
  assert.ok(mapping.diagnostics.some((line) => line.includes('不叠加附件比例')))
})

// ── Scenario: 缺少缩放系数行时按 1.0 处理 ───────────────────────────────────
test('坐标映射 :: 缺少缩放系数行时按 1.0 处理', () => {
  const text = 'Screenshot Size: (2560,1440)\nScreenshot Region: (0,0,2560,1440)'
  const mapping = mappingFrom(text)
  assert.equal(mapping.coordScale, 1)
  assert.equal(mapping.screenPerImagePx, 1)
})

// ── 补强：scale==1.0 行缺失的**自洽形态**必须端到端成立（U-04）───────────────
test('补强｜scale==1.0 且未缩放时换算是恒等（端到端，U-04）', async () => {
  // U-04 的真机不可复现原因：本机上游截图恒被压到 1920x1080，
  // 所以 `coord_scale` 恒为 1.333，永远走不到"不打印该行"的分支。
  // 但该形态在进程内是**可以完整构造**的：上游没缩放时
  // Original Size == Region，且不打印 Coordinate Scale 行 → 换算应为恒等。
  //
  // 这里刻意用**假服务器**走完整条工具路径（而不是直接调纯函数），
  // 因为"缺行按 1.0"这条规格说的是插件在真实响应上的行为。
  const server = createFakeMcpServer({
    scale: null, // 不打印 Coordinate Scale 行
    originalSize: { width: 2560, height: 1440 },
    region: [0, 0, 2560, 1440],
    cursor: { x: 100, y: 200 },
  })
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    const { result } = await host.callTool(server, 'Screenshot')
    const observation = buildObservation({
      value: result.value,
      content: result.content,
      tool: 'mcp__winmcp__Screenshot',
    })
    assert.equal(observation.coordScale, null, '该形态下不应有 Coordinate Scale 行')
    const mapping = buildMapping(observation)
    assert.equal(mapping.coordScale, 1, '缺行必须按 1.0')
    assert.equal(mapping.screenPerImagePx, 1, '未缩放时换算系数应为 1')
    // 恒等：图片像素即屏幕坐标（原点为 0）
    assert.deepEqual(imageToScreen(100, 200, mapping), { x: 100, y: 200 })
    // 且必须留下"按 1.0 处理"的诊断，而不是静默假设
    assert.ok(
      mapping.diagnostics.some((d) => /Coordinate Scale/.test(d)),
      `应诊断缺行，实际 ${JSON.stringify(mapping.diagnostics)}`,
    )
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 缺少区域行时原点退化为零 ──────────────────────────────────────
test('坐标映射 :: 缺少区域行时原点退化为零', () => {
  const text = 'Screenshot Original Size: (2560,1440)\nScreenshot Coordinate Scale: 1.5'
  const mapping = mappingFrom(text)
  assert.deepEqual(mapping.origin, { x: 0, y: 0 })
  assert.ok(mapping.diagnostics.some((line) => line.includes('Region')))
})

// ── Scenario: 坐标系原点非零时仍然正确 ──────────────────────────────────────
test('坐标映射 :: 坐标系原点非零时仍然正确', () => {
  const text = 'Screenshot Size: (1920,1080)\nScreenshot Region: (-1920,0,0,1080)'
  const mapping = mappingFrom(text)
  assert.deepEqual(imageToScreen(0, 0, mapping), { x: -1920, y: 0 })
  assert.deepEqual(imageToScreen(1920, 1080, mapping), { x: 0, y: 1080 })
})

// ── Scenario: 映射信息不足时必须明确失败 ────────────────────────────────────
test('坐标映射 :: 映射信息不足时必须明确失败', () => {
  const mapping = mappingFrom('Cursor Position: (1, 2)')
  assert.equal(mapping.ok, false)
  assert.match(mapping.reason, /Coordinate Scale/)
  assert.throws(() => imageToScreen(1, 2, mapping), /坐标映射不可用/)
  assert.throws(() => screenToImage(1, 2, mapping), /坐标映射不可用/)
  // 摘要也必须说明原因，而不是抛异常
  assert.match(describeMapping(mapping), /不可用/)
})

// ── Scenario: 映射摘要必须是一行 ────────────────────────────────────────────
test('坐标映射 :: 映射摘要必须是一行', () => {
  const mapping = mappingFrom(REAL)
  const summary = describeMapping(mapping, { observationId: 'obs-1' })
  assert.equal(summary.split('\n').length, 1)
  assert.match(summary, /scale=1\.333/)
  assert.match(summary, /origin=0,0/)
  assert.match(summary, /based_on=obs-1/)
})

// ── Scenario: 解析容错——CRLF 与中文控件名 ───────────────────────────────────
test('坐标映射 :: 解析容错——CRLF 与中文控件名', () => {
  const crlf = `Cursor Position: (755, 733)\r\nScreenshot Region: (0,0,2560,1440)\r\nScreenshot Original Size: (2560,1440)\r\n\r\nUI Tree:\r\n├── (2361,35) 按钮 "最小化"  [action: click]\r\n└── (1418,26) 按钮 "关闭"  [action: click]\r\n`
  const observation = observationFrom(crlf)
  assert.deepEqual(observation.cursor, { x: 755, y: 733 })
  assert.equal(observation.uiElements.length, 2)
  assert.equal(observation.uiElements[1].label, '关闭')
  assert.equal(observation.uiElements[0].label, '最小化')
})

// ── Scenario: 多个元素的焦点与取值只属于各自所在行 ──────────────────────────
test('坐标映射 :: 多个元素的焦点与取值只属于各自所在行', () => {
  const text = `UI Tree:
├── (1,1) 按钮 "A"  [action: click]
├── (2,2) 按钮 "B"  [action: click]
└── (3,3) 文档 "C"  [action: click]  [focused]  [value:"v"]`
  const observation = observationFrom(text)
  const [a, b, c] = observation.uiElements
  assert.equal(a.focused, false)
  assert.equal(a.value, null)
  assert.equal(b.focused, false)
  assert.equal(b.value, null)
  assert.equal(c.focused, true)
  assert.equal(c.value, 'v')
  assert.equal(observation.uiElements.filter((element) => element.focused).length, 1)
})

// ── Scenario: 附件说明里的预览尺寸被解析并核对 ──────────────────────────────
test('坐标映射 :: 附件说明里的预览尺寸被解析并核对', () => {
  // S-MAP-08：说明里有两个语义完全不同的尺寸。
  // `request preview WxHpx` 是 DSH **请求**渲染的预览尺寸（预算相关），
  // `Normalized copy (...) (WxHpx)` 才是实际交给模型的副本尺寸。
  // 换算假设"模型看到的 = 归一化副本"，因此两者不一致时必须给出诊断。
  const note =
    'Image sha256:' + 'a'.repeat(64) + '; request preview 1708x961px. Normalized copy ' +
    '(read-only; may be resized or re-encoded): "C:\\x.png" (1920x1080px, image/png). ' +
    'Source dimensions, format, and byte size may differ.'

  assert.deepEqual(parsePreviewSize(note), { width: 1708, height: 961 })
  assert.deepEqual(parseAttachmentSize(note), { width: 1920, height: 1080, format: 'png' })

  // 不一致 → 必须诊断（诊断不改变换算值）
  const flagged = buildObservation({ value: `Cursor Position: (1, 2)\n${note}`, content: [], tool: 'S' })
  const mapping = buildMapping(flagged)
  assert.ok(
    mapping.diagnostics.some((d) => /预览请求尺寸.*与归一化副本.*不一致/.test(d)),
    `预览尺寸与副本尺寸不一致时必须诊断，实际：${JSON.stringify(mapping.diagnostics)}`,
  )

  // 一致 → 不产生该诊断（避免噪声）
  const consistent = note.replace('request preview 1708x961px', 'request preview 1920x1080px')
  const quiet = buildMapping(
    buildObservation({ value: `Cursor Position: (1, 2)\n${consistent}`, content: [], tool: 'S' }),
  )
  assert.equal(
    quiet.diagnostics.some((d) => /不一致/.test(d)),
    false,
    `一致时不应产生该诊断，实际：${JSON.stringify(quiet.diagnostics)}`,
  )

  // 没有预览片段时解析为 null，且不得抛错
  assert.equal(parsePreviewSize('no preview here'), null)
  assert.equal(parsePreviewSize(''), null)
  assert.equal(parsePreviewSize(null), null)
})

// ── 补强：screenPerImagePx 的独立性（S-MAP-02 的直接断言）───────────────────
test('补强｜换算系数只由 coord_scale 决定', () => {
  assert.equal(screenPerImagePx({ coordScale: 2 }), 2)
  assert.equal(screenPerImagePx({}), 1)
  assert.equal(screenPerImagePx({ coordScale: -1 }), 1, '非法值必须退化为 1 而非负数')
  // 只有显式给出不同的 previewWidth 时才走兜底分支（U-02，未实测）
  assert.equal(screenPerImagePx({ coordScale: 1.5, previewWidth: 100, originalWidth: 300 }), 4.5)
})
