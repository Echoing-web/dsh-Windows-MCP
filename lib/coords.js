/**
 * coords.js — 图片像素 ⇄ 屏幕坐标的**可验证映射**。
 *
 * ## 实测确认的关系（不是推导，是量出来的）
 *
 * `（本机实测记录，见项目文档）` 用
 * Windows-MCP 自己画的 CURSOR 红十字当探针（`use_annotation=true`），把映射量到
 * 了「无残差」的程度：
 *
 * ```
 *   screen_x = region_left + img_x * coord_scale
 *   screen_y = region_top  + img_y * coord_scale
 *   img      = (screen - region_origin) / coord_scale
 * ```
 *
 * - 两点拟合得到 slope = 1.333333、**intercept = 0.0000** → 纯乘法，无偏移。
 * - 光标 (2000,720) → 红十字落在图片 (1500,540) = 2000/1.333333、720/1.333333。实测一致。
 * - 125% DPI **不需要任何补偿**：Move 参数与回读的 Cursor Position 往返 7/7 精确。
 *
 * 其中 `img` 是**模型实际看到的那张图**的像素；`coord_scale` 就是结果里那句
 * `Screenshot Coordinate Scale:` 的数。缺该行时按 1.0（上游 scale==1.0 时只打印
 * `Screenshot Size:`）；缺 `Screenshot Region:` 行时原点按 (0,0)。
 *
 * ## ⚠️ 一个被实测否掉的错误做法
 *
 * 早期版本把「附件宽 / 上游图片宽」也乘进系数（`coordScale / attachmentRatio`），
 * 得到 1.777778。**这是错的**：本机 `1920 = 2560 / 1.333333`，`coord_scale`
 * 本身就已经是「模型所见图 → 屏幕」的完整因子。双重缩放会把「关闭」按钮预测到
 * 图片 x≈1417.5，而实测在 x≈1890。
 *
 * 因此本模块**不再假定附件尺寸参与换算**。附件尺寸只作为诊断信息暴露；
 * 只有当你明确知道模型看到的是另一个尺寸（例如别的模型触发预览缩放）时，
 * 才用 `previewWidth` 参数显式说明，此时按 `screen = origin + px * origW / seenW` 换算
 * （该分支本机 UNVERIFIED，属兜底）。
 *
 * @module dsh_Windows_MCP/coords
 */

/**
 * 计算「一个模型可见图片像素」对应多少屏幕像素。
 *
 * @param {object} mapping
 * @param {number|null} mapping.coordScale 结果里的 Coordinate Scale（缺省 1）
 * @param {number|null} [mapping.previewWidth] 模型实际看到的图宽（仅在非上游尺寸时才需要）
 * @param {number|null} [mapping.originalWidth] 上游 Screenshot Original Size 宽
 * @returns {number} 屏幕像素 / 图片像素
 */
export function screenPerImagePx({ coordScale = null, previewWidth = null, originalWidth = null } = {}) {
  const cs = typeof coordScale === 'number' && coordScale > 0 ? coordScale : 1
  if (
    typeof previewWidth === 'number' && previewWidth > 0 &&
    typeof originalWidth === 'number' && originalWidth > 0 &&
    previewWidth !== originalWidth
  ) {
    // 模型看到的是被重新缩放过的一张图：先回到上游尺寸，再乘 coordScale。
    return cs * (originalWidth / previewWidth)
  }
  return cs
}

/**
 * 由一次观测构造完整映射。
 *
 * @param {object} observation buildObservation() 的产物
 * @param {object} [options]
 * @param {number|null} [options.previewWidth] 模型实际看到的图宽（一般不需要）
 * @returns {object} 映射（含正反算所需的全部字段与诊断信息）
 */
export function buildMapping(observation, options = {}) {
  const coordScale = typeof observation?.coordScale === 'number' && observation.coordScale > 0
    ? observation.coordScale
    : null
  const originalSize = observation?.originalSize ?? null
  const region = observation?.region ?? null
  const attachmentSize = observation?.image?.attachmentSize ?? null
  const previewWidth = typeof options.previewWidth === 'number' && options.previewWidth > 0
    ? options.previewWidth
    : null

  const per = screenPerImagePx({
    coordScale,
    previewWidth,
    originalWidth: originalSize?.width ?? null,
  })

  const diagnostics = []
  if (region === null) {
    diagnostics.push(
      observation?.rawRegionInvalid
        ? `Screenshot Region 行存在但无法解析（${JSON.stringify(observation.rawRegionInvalid)}），原点按 (0,0) 处理`
        : '缺少 Screenshot Region 行，原点按 (0,0) 处理',
    )
  }
  if (originalSize === null && observation?.rawOriginalSizeInvalid) {
    diagnostics.push(
      `Screenshot Original Size 行存在但值非法/非正（${JSON.stringify(observation.rawOriginalSizeInvalid)}），视为缺失`,
    )
  }
  if (coordScale === null) {
    // 区分「行不存在」与「行存在但值非法」：对抗性验证指出这两者
    // 曾共用同一句诊断，导致"行明明在、却说缺少该行"的谎报。
    diagnostics.push(
      observation?.rawCoordScaleInvalid
        ? `Screenshot Coordinate Scale 行存在但值非法（${JSON.stringify(observation.rawCoordScaleInvalid)}），按 1.0 处理`
        : '缺少 Screenshot Coordinate Scale 行，按 1.0 处理（上游 scale==1.0 时不打印该行）',
    )
  }
  if (attachmentSize && originalSize && attachmentSize.width !== originalSize.width) {
    diagnostics.push(
      `诊断：落盘附件 ${attachmentSize.width}x${attachmentSize.height} ≠ 上游图片 ${originalSize.width}x${originalSize.height}；` +
        '换算只用 coord_scale，不叠加附件比例（实测确认）。',
    )
  }
  if (previewWidth !== null && originalSize && previewWidth !== originalSize.width) {
    diagnostics.push(`按显式 previewWidth=${previewWidth} 做了兜底换算（该分支未经实测验证）`)
  }

  // S-MAP-08：说明里的"预览请求尺寸"与"归一化副本尺寸"语义不同。
  // 换算假设"模型看到的 = 归一化副本"，所以两者不一致时必须说出来——
  // 不猜、不自动补偿（自动补偿要先知道模型到底看到了哪一张图，那属 U-02）。
  const previewRequest = observation?.image?.previewSize ?? null
  if (
    previewRequest &&
    attachmentSize &&
    (previewRequest.width !== attachmentSize.width || previewRequest.height !== attachmentSize.height)
  ) {
    diagnostics.push(
      `预览请求尺寸 ${previewRequest.width}x${previewRequest.height} 与归一化副本 ` +
        `${attachmentSize.width}x${attachmentSize.height} 不一致；` +
        '换算仍按归一化副本进行（该假设未实测，见 U-02）',
    )
  }

  // 只要拿到 Scale 或 Original Size 之一就能给出可用乘数；Region 缺失时退化为 (0,0)。
  const ok = coordScale !== null || originalSize !== null

  return {
    ok,
    reason: ok ? null : '结果里既没有 Screenshot Coordinate Scale 也没有 Screenshot Original Size',
    coordScale: coordScale ?? 1,
    screenPerImagePx: per,
    origin: region ? { x: region.left, y: region.top } : { x: 0, y: 0 },
    region,
    originalSize,
    attachmentSize,
    previewWidth,
    coordinateSpace: observation?.coordinateSpace ?? null,
    observationId: observation?.id ?? null,
    diagnostics,
  }
}

function assertMapping(mapping) {
  if (!mapping || !mapping.ok) {
    throw new Error(`坐标映射不可用：${mapping?.reason ?? '缺少映射数据'}`)
  }
  if (!(mapping.screenPerImagePx > 0)) {
    throw new Error('坐标映射不可用：screenPerImagePx 非正数')
  }
}

/**
 * 数值友好化（正向：图片像素 → 屏幕坐标）。
 *
 * 两个目标必须同时满足：
 * 1. 输出干净——`1890 × 1.333333 = 2519.99937` 若原样输出，模型会以为差 0.001px
 *    而反复微调；
 * 2. **往返误差有界**——`screenToImage(imageToScreen(px))` 必须回到 px 附近。
 *
 * 对抗性验证指出：早期实现固定用「与整数相差 < 0.002 就吸附」，在小数缩放
 * （`coord_scale = 0.0001`）下吸附误差被放大成 **19.9 图像像素**，与"远小于
 * 1 像素"的说法相悖。
 *
 * 现在只在 `scale >= 1` 时吸附。此时屏幕吸附 0.5px 换算回图片只有
 * `0.5 / scale <= 0.5` 图像像素；而 `scale < 1` 时吸附会把误差放大，收益远小于损失。
 *
 * 关键细节：`scale >= 1` 分支**不做 3 位小数舍入**。否则 `px=12345.678, scale=2`
 * 会输出 24691.356→24691.356、再反算回 12345.678 没问题，但 `px=100.0005`
 * 会被舍成 200.001 而丢失精度。整数吸附已经提供了"干净"的收益，
 * 再多一次舍入只会引入往返误差。
 */
function roundFriendly(n, scale) {
  if (!Number.isFinite(n)) return n
  const per = Number.isFinite(scale) && scale > 0 ? scale : 1
  if (per >= 1) {
    const nearest = Math.round(n)
    // 落在整数附近就吸附（消除 2519.99937 这种浮点噪声）
    if (Math.abs(n - nearest) <= 0.002) return nearest
    // 否则保留 3 位小数：屏幕坐标的 0.001px 远小于一个像素，
    // 而 3 位精度**足以让往返换算可逆**（见 screenToModel 的 6 位保留）。
    return Math.round(n * 1000) / 1000
  }
  // scale < 1 时不吸附、保留 6 位：吸附会被放大成远超 1 图像像素的误差。
  return Math.round(n * 1e6) / 1e6
}

/**
 * 反向换算（屏幕坐标 → 图片像素）的舍入。
 * 保留 3 位：屏幕坐标本身最多 3 位精度，反算结果再多位只是浮点噪声
 * （`2520 / 1.333333` → 1890.000473，模型看到这种数会以为坐标不干净）。
 */
function roundImage(n) {
  if (!Number.isFinite(n)) return n
  return Math.round(n * 1000) / 1000
}

/**
 * 摘要里显示缩放系数的紧凑格式。
 * 只用于**展示**，不参与计算——所以这里可以放心按 6 位有效数字修剪，
 * 去掉 `1.3333330000000001` 这种浮点尾巴。
 */
function roundCompact(n) {
  if (!Number.isFinite(n)) return String(n)
  return String(Number(n.toPrecision(6)))
}

/**
 * 模型可见图片像素 → 屏幕坐标。
 * @param {number} x
 * @param {number} y
 * @param {object} mapping
 */
export function modelToScreen(x, y, mapping) {
  assertMapping(mapping)
  return {
    x: roundFriendly(mapping.origin.x + x * mapping.screenPerImagePx, mapping.screenPerImagePx),
    y: roundFriendly(mapping.origin.y + y * mapping.screenPerImagePx, mapping.screenPerImagePx),
  }
}

/**
 * 屏幕坐标 → 模型可见图片像素。
 */
export function screenToModel(x, y, mapping) {
  assertMapping(mapping)
  const per = mapping.screenPerImagePx
  return {
    x: roundImage((x - mapping.origin.x) / per),
    y: roundImage((y - mapping.origin.y) / per),
  }
}

/**
 * 兼容别名。在本模块的语义里，「图片像素」与「模型可见图片像素」是同一个空间
 * （历史上有过第二个空间，已因实测错误被移除）。
 */
export const imageToScreen = modelToScreen
export const screenToImage = screenToModel

/**
 * 生成给模型看的紧凑说明：**单行**、可机器读取的键值对，
 * 与上游那句长散文互补而不是替换它。
 *
 * @param {object} mapping
 * @param {object} [extra]
 * @returns {string}
 */
export function describeMapping(mapping, extra = {}) {
  if (!mapping) return '[mcp] 无坐标映射数据'
  if (!mapping.ok) return `[mcp] 坐标映射不可用：${mapping.reason}`
  const parts = [
    `scale=${roundCompact(mapping.screenPerImagePx)}`,
    `origin=${mapping.origin.x},${mapping.origin.y}`,
  ]
  if (mapping.region) {
    parts.push(`region=${mapping.region.left},${mapping.region.top},${mapping.region.right},${mapping.region.bottom}`)
  }
  parts.push(`coord_scale=${mapping.coordScale}`)
  if (mapping.originalSize) parts.push(`source=${mapping.originalSize.width}x${mapping.originalSize.height}`)
  if (mapping.attachmentSize) parts.push(`attachment=${mapping.attachmentSize.width}x${mapping.attachmentSize.height}`)
  if (extra.observationId ?? mapping.observationId) parts.push(`based_on=${extra.observationId ?? mapping.observationId}`)
  const formula = `screen = (${mapping.origin.x},${mapping.origin.y}) + image_px * ${roundCompact(mapping.screenPerImagePx)}`
  return `[mcp] ${parts.join(' ')} | ${formula}`
}

/** 把映射摘要包装成一条 DSH 文本内容块（追加用）。 */
export function mappingContentBlock(mapping, extra = {}) {
  return { type: 'text', text: describeMapping(mapping, extra) }
}
