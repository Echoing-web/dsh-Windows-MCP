/**
 * link.js —— 可执行的规格关联登记处。
 *
 * ## 为什么要有运行时登记，而不是只靠正则扫源码
 * 覆盖门如果只看测试源码里的 `spec: [...]` 文本，会有一个致命盲点：
 * **声明还在，但测试被删了/被 skip 了**，覆盖率依然显示 100%。
 * 那是"看起来有覆盖"而不是"确有覆盖"。
 *
 * 所以这里做两层：
 * 1. 静态层（coverage.js）：扫源码确认声明存在 → 防止"改了规格忘了改测试"；
 * 2. 运行时层（本文件）：测试真正执行时登记 → 防止"声明存在但测试没跑"。
 *
 * 门禁同时要求两层都成立。测试被删或未执行时，第二层会暴露出来。
 *
 * ## 用法（在被测测试文件顶层调用一次）
 * ```js
 * coverage({
 *   spec: ['S-MAP-01', 'S-MAP-02'],
 *   covers: ['坐标映射 :: 图片像素换算为屏幕坐标'],
 * })
 * ```
 *
 * @module dsh_Windows_MCP/test/harness/link
 */

/** 已登记的关联：文件路径 → {spec, covers, at}。 */
const registry = new Map()

/**
 * 登记本测试文件覆盖的规格条目与行为场景。
 * 必须在测试文件顶层同步调用（这样即使其中的测试被跳过，登记依然发生，
 * 从而能被门禁发现"登记了但没执行"——执行情况由 executed 计数单独跟踪）。
 *
 * @param {{spec?: readonly string[], covers?: readonly string[]}} declaration
 * @param {string} [file] 覆盖来源标识；默认取调用栈里的文件名
 */
export function coverage(declaration, file = callerFile()) {
  if (!declaration || typeof declaration !== 'object') {
    throw new Error('coverage() 需要一个 { spec, covers } 对象')
  }
  const spec = normalizeList(declaration.spec, 'spec')
  const covers = normalizeList(declaration.covers, 'covers')
  if (spec.length === 0 && covers.length === 0) {
    throw new Error('coverage() 至少要声明一个 spec 或 covers，否则这次登记没有意义')
  }
  const existing = registry.get(file)
  if (existing) {
    existing.spec.push(...spec)
    existing.covers.push(...covers)
    return
  }
  registry.set(file, { spec, covers, at: new Date().toISOString() })
}

function normalizeList(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`coverage().${label} 必须是数组`)
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new Error(`coverage().${label} 里出现空值或非字符串: ${String(item)}`)
    }
    out.push(item.trim())
  }
  return out
}

/** 把登记表折叠成两个集合。 */
export function registered() {
  const spec = new Set()
  const covers = new Set()
  const files = new Map()
  for (const [file, entry] of registry) {
    for (const id of entry.spec) spec.add(id)
    for (const id of entry.covers) covers.add(id)
    files.set(file, { spec: [...entry.spec], covers: [...entry.covers], at: entry.at })
  }
  return { spec, covers, files }
}

/** 测试进程内已执行的用例名（由 reporter 之外的机械方式填充）。 */
const executed = new Set()

/** 记录一个已执行的用例（用例名或契约断言标识）。 */
export function markExecuted(name) {
  if (typeof name === 'string' && name !== '') executed.add(name)
}

/** 已执行的用例集合。 */
export function executedNames() {
  return new Set(executed)
}

/** 仅供测试使用：清空登记。 */
export function resetRegistry() {
  registry.clear()
  executed.clear()
}

/** 取调用方文件路径。 */
function callerFile() {
  const stack = new Error().stack ?? ''
  const lines = stack.split('\n')
  for (const line of lines) {
    const match = /\((.*?):\d+:\d+\)/.exec(line) ?? /at (.*?):\d+:\d+/.exec(line)
    if (!match) continue
    const candidate = match[1]
    if (candidate.includes('link.js')) continue
    if (candidate.startsWith('node:')) continue
    return candidate.replace(/^file:\/\//, '')
  }
  return '<unknown>'
}
