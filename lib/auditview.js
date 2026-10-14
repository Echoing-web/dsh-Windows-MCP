/**
 * auditview.js —— 把审计 JSONL 渲染成人类可读的视图。
 *
 * ## 设计立场
 * 1. **确定性纯函数**：同一份输入永远渲染出同样的文本。审计是事后复盘的依据，
 *    一个"看起来差不多"的视图没有价值。
 * 2. **不丢条目**：统计口径必须让"各类合计 == 总数"成立。
 *    字段缺失的条目代表真实发生过的事，不能被"形状不对"过滤掉——
 *    否则可视化会给出一个比事实更乐观的印象。
 * 3. **展示层不得成为新的故障点**：任何畸形输入都返回可用结果，绝不抛异常。
 * 4. **两个入口共用**：工具 `winmcp_audit`（view=summary）与
 *    `scripts/audit-report.mjs` 都调用这里，避免"两处看到的不是一回事"。
 *
 * @module dsh_Windows_MCP/lib/auditview
 */

/** 原因在单行里显示的最大字符数。 */
export const REASON_MAX_CHARS = 80

/** 最近条目区默认显示多少条。 */
export const DEFAULT_RECENT = 10

/**
 * 审计工具默认读取的条数。
 * 与 `DEFAULT_RECENT` 分开定义**但取同一个值**：工具与脚本必须给出同样的默认视图，
 * 否则"同一份日志渲染出同样的文本"就不成立（对抗性验证 V13）。
 */
export const DEFAULT_AUDIT_LIMIT = DEFAULT_RECENT

const UNKNOWN = 'unknown'
const UNKNOWN_TOOL = '(unknown)'

/**
 * 工具名归一化：去掉 `mcp__<server>__` 前缀。
 *
 * 为什么必须做：审计里同一个工具会有两种写法——闸门写去前缀名（`PowerShell`），
 * 策略层写带前缀名（`mcp__winmcp__PowerShell`）。不归一化的话"按工具"分区会把
 * 一次调用拆成两行，看起来像发生了两次（实机数据里就是这样）。
 *
 * **只影响展示**：日志里存的仍是原始值，永远不为"好看"改写审计。
 */
export function normalizeToolForDisplay(name) {
  const value = typeof name === 'string' ? name.trim() : ''
  if (value === '') return UNKNOWN_TOOL
  if (value.toLowerCase().startsWith('mcp__')) {
    const rest = value.slice(5)
    const index = rest.indexOf('__')
    if (index !== -1) {
      const stripped = rest.slice(index + 2)
      return stripped === '' ? UNKNOWN_TOOL : stripped
    }
  }
  return value
}

/**
 * 把一个审计条目提取成展示所需的字段。
 *
 * 刻意**不做**形状校验：字段缺失就是缺失，由渲染层决定怎么显示。
 * 但**不得**因此把条目丢掉（S-VIEW-01）。
 *
 * @returns {{at: unknown, decision: string, tool: string, action: string, code: string|null, allowed: boolean|null, reason: string, raw: unknown}}
 */
export function representEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      at: null,
      decision: UNKNOWN,
      tool: UNKNOWN_TOOL,
      action: UNKNOWN,
      code: null,
      allowed: null,
      reason: typeof entry === 'string' ? entry : '(非对象条目)',
      raw: entry,
    }
  }
  const stringOr = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback)
  return {
    // 所有字段读取都走 safeGet：属性可能是会抛异常的 getter（对抗性输入常见），
    // 而这是被导出的公共函数，元数据读取失败不该让整个展示崩掉（S-VIEW-04）。
    at: safeGet(entry, 'at') ?? null,
    decision: stringOr(safeGet(entry, 'decision'), UNKNOWN),
    tool: normalizeToolForDisplay(stringOr(safeGet(entry, 'tool'), UNKNOWN_TOOL)),
    action: stringOr(safeGet(entry, 'action'), UNKNOWN),
    code: (() => {
      const value = safeGet(entry, 'code')
      return typeof value === 'string' && value !== '' ? value : null
    })(),
    allowed: (() => {
      const value = safeGet(entry, 'allowed')
      return typeof value === 'boolean' ? value : null
    })(),
    reason: (() => {
      const value = safeGet(entry, 'reason')
      return typeof value === 'string' ? value : ''
    })(),
    raw: entry,
  }
}

/** 读取一个属性，任何抛错都退化为 undefined。 */
function safeGet(object, key) {
  try {
    return object[key]
  } catch {
    return undefined
  }
}

/** 安全版 representEntry：任何取值异常都退化为占位，绝不让展示层抛出（S-VIEW-04）。 */
function representSafely(entry) {
  try {
    return representEntry(entry)
  } catch (error) {
    return {
      at: null,
      decision: UNKNOWN,
      tool: UNKNOWN_TOOL,
      action: UNKNOWN,
      code: null,
      allowed: null,
      reason: `(读取条目时出错：${error?.message ?? error})`,
      raw: null,
    }
  }
}

/** 计数：按某个取值分组，降序、同频按名称升序（保证渲染稳定）。 */
function countBy(items, pick) {
  const counts = new Map()
  for (const item of items) {
    const key = pick(item)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, count: value }))
    .sort((left, right) => (right.count - left.count) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

/**
 * 统计审计条目。
 *
 * 不变式（由测试强制）：`byDecision` 的合计 === `total`，`byTool` 的合计 === `total`。
 *
 * @param {unknown} entries
 * @returns {{total: number, byDecision: Array, byAction: Array, byTool: Array, byCode: Array, allowed: number, denied: number, unknownOutcome: number}}
 */
export function summarize(entries) {
  const source = Array.isArray(entries) ? entries : []
  const represented = source.map(representSafely)
  let allowed = 0
  let denied = 0
  let unknownOutcome = 0
  for (const item of represented) {
    if (item.allowed === true) allowed += 1
    else if (item.allowed === false) denied += 1
    else unknownOutcome += 1
  }
  const malformed = represented.filter(
    (item) => item.raw === null || typeof item.raw !== 'object' || Array.isArray(item.raw),
  ).length
  return {
    total: represented.length,
    byDecision: countBy(represented, (item) => item.decision),
    byAction: countBy(represented, (item) => item.action),
    byTool: countBy(represented, (item) => item.tool),
    byCode: countBy(represented.filter((item) => item.code !== null), (item) => item.code),
    allowed,
    denied,
    unknownOutcome,
    // 供调用方诊断"有多少条形状不对"，但不影响上面任何计数
    malformed,
  }
}

/** 解析 `at` 为毫秒时间戳；不可解析返回 null（不伪造时间）。 */
export function parseTime(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    // 有限但越界的毫秒数不是合法时间：`new Date(1e20)` 是 Invalid Date。
    // 曾经这里直接返回该数，于是它既显示成 `NaN:NaN:NaN`，
    // 又因为"看起来有值"被排到**最前**（当成最新）。对抗性验证 V5。
    return Number.isNaN(new Date(value).getTime()) ? null : value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) return null
    return Number.isNaN(new Date(parsed).getTime()) ? null : parsed
  }
  return null
}

/** `HH:MM:SS`；不可解析时给占位符（S-VIEW-05）。 */
export function formatTime(value) {
  const ms = parseTime(value)
  if (ms === null) return '--:--:--'
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 截断并标注省略，避免悄悄丢内容（S-VIEW-03）。 */
export function truncate(text, limit = REASON_MAX_CHARS) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * 把文本压成**单行**。
 *
 * 为什么必须做（对抗性验证 V7）：`reason` 可能来自自定义规则的配置文本。
 * 如果它带换行，"每条一行"的保证就破了，而且能**伪造出与真实条目同构的行**
 * ——审计视图是给人看的复盘工具，被注入伪造行等于复盘结论被污染。
 */
export function toSingleLine(text) {
  // 覆盖 CR/LF、U+2028/U+2029 与其余 C0 控制字符
  // eslint-disable-next-line no-control-regex
  return String(text ?? '').replace(/[\r\n\u2028\u2029\u0000-\u001f\u007f]+/g, ' ')
}

/** 把最近条目排序：时间倒序，时间不可用的排最后（S-VIEW-05）。 */
export function orderRecent(items, limit = DEFAULT_RECENT) {
  const withTime = []
  const withoutTime = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const ms = parseTime(item.at)
    // 记住输入序号：等时间戳必须保持**输入顺序**（稳定排序）。
    // 只按 ms 比较时 `Array.sort` 对相等元素的行为不保证稳定语义，
    // 于是"输入反转 → 输出也反转"——那等于没排序（对抗性 N6）。
    if (ms === null) withoutTime.push({ item, index })
    else withTime.push({ item, ms, index })
  }
  withTime.sort((left, right) => (right.ms - left.ms) || (left.index - right.index))
  const ordered = [...withTime.map((entry) => entry.item), ...withoutTime.map((entry) => entry.item)]
  return Number.isFinite(limit) && limit >= 0 ? ordered.slice(0, limit) : ordered
}

/**
 * 渲染人类可读报告（S-VIEW-02 / S-VIEW-03）。
 *
 * @param {unknown} entries
 * @param {object} [options]
 * @param {number} [options.recent] 最近条目条数
 * @returns {string}
 */
export function renderReport(entries, { recent = DEFAULT_RECENT } = {}) {
  const list = Array.isArray(entries) ? entries : []
  const stats = summarize(list)
  const lines = []

  if (stats.total === 0) {
    lines.push('# Windows-MCP 审计报告（0 条记录）')
    lines.push('')
    lines.push('暂无记录。审计默认写入 $DSH_HOME/logs/windows-mcp-audit.jsonl；')
    lines.push('若该文件不存在，可能是 autoAudit 被关闭，或本进程尚未产生任何动作。')
    return lines.join('\n')
  }

  lines.push(`# Windows-MCP 审计报告（${stats.total} 条记录）`)
  lines.push('')

  lines.push('## 概览')
  lines.push(`- 放行：${stats.allowed}    拒绝：${stats.denied}    未标注结果：${stats.unknownOutcome}`)
  if (stats.malformed > 0) lines.push(`- 形状不完整的条目：${stats.malformed}（仍计入统计）`)
  lines.push('')

  lines.push('## 分类')
  lines.push(`- 按判定：${formatCounts(stats.byDecision)}`)
  lines.push(`- 按动作：${formatCounts(stats.byAction)}`)
  lines.push(`- 按工具：${formatCounts(stats.byTool)}`)
  if (stats.byCode.length > 0) lines.push(`- 拒绝原因代码：${formatCounts(stats.byCode)}`)
  lines.push('')

  const ordered = orderRecent(list.map(representSafely), recent)
  lines.push(`## 最近条目（最多 ${recent} 条，最新在前）`)
  if (ordered.length === 0) {
    lines.push('- （无）')
  } else {
    for (const item of ordered) {
      const parts = [
        formatTime(item.at),
        toSingleLine(item.decision),
        toSingleLine(item.tool),
        item.code === null ? '' : toSingleLine(item.code),
        item.reason === '' ? '' : truncate(toSingleLine(item.reason), REASON_MAX_CHARS),
      ].filter((part) => part !== '')
      lines.push(`- ${parts.join('  |  ')}`)
    }
  }
  return lines.join('\n')
}

function formatCounts(counts) {
  if (!counts || counts.length === 0) return '（无）'
  // 计数键来自日志内容（工具名/代码），同样要压成单行，否则会破坏分区结构
  return counts.map((entry) => `${toSingleLine(entry.key)}×${entry.count}`).join('，')
}
