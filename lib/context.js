/**
 * context.js —— 把「当前会话最新观测」注入运行时上下文。
 *
 * ## 为什么需要它
 * 坐标换算系数（`scale` / `origin` / 观测编号）如果只出现在**一次**工具结果后面，
 * 模型在后续步骤里只能靠对话记忆复用。对话一长、或中间插了几轮别的工具调用，
 * 那个系数就可能被记错——而记错的代价是一次点偏。
 *
 * 放进运行时上下文的意义在于：它**每一轮都按当前状态重建**，
 * 不依赖模型记住任何东西，也不会随对话增长而失踪。
 *
 * ## 技术接缝
 * `ctx.systemPrompt.context()` 注册的是**全局层**；组装时宿主通过
 * `AssembleContext.scope` 告诉提供方"现在是哪个 agent 在组装"。因此本模块维护
 * 一张 `scope → agent` 的映射（由 `agent/created` / `agent/disposed` 维护），
 * 再用它取该会话自己的观测——这就是 S-CTX-02 会话隔离的实现方式。
 *
 * ## 失败姿态
 * 任何一步失败（服务缺失、scope 解析不出、取值抛错）都退化为"不注入"。
 * 上下文是**增益**，不是对话成立的前提，绝不能让它在组装期抛错（S-CTX-05）。
 *
 * @module dsh_Windows_MCP/lib/context
 */

import { buildMapping } from './coords.js'

/** 注入文本的长度上限（字符）。上下文每轮都出现，必须严格有界。 */
export const MAX_CONTEXT_CHARS = 400

/**
 * 由一次观测生成注入文本。
 *
 * 设计取向：**单行、键值对、无 Markdown**。
 * 它每轮都会出现，所以：
 * - 多行会持续挤占上下文预算；
 * - 装饰性文字（标题、说明句）每轮都要重新付出 token 成本，收益为零。
 *
 * @param {object|null} observation
 * @param {number} [now]
 * @returns {string} 单行文本；无观测时返回空串
 */
export function buildRuntimeContextText(observation, now = Date.now()) {
  if (!observation || typeof observation !== 'object') return ''
  const id = typeof observation.id === 'string' ? observation.id : null
  if (id === null) return ''

  const parts = [`obs=${id}`]
  const age = typeof observation.at === 'number' ? Math.max(0, Math.round((now - observation.at) / 1000)) : null
  if (age !== null) parts.push(`age=${age}s`)

  const mapping = safeBuildMapping(observation)
  if (mapping?.ok) {
    parts.push(`scale=${compact(mapping.screenPerImagePx)}`)
    parts.push(`origin=${mapping.origin.x},${mapping.origin.y}`)
  } else {
    // 明确说"不可用"比省略更有用：模型会知道不要去做图片坐标换算。
    parts.push('coord=unavailable')
  }

  const window = observation.focusedWindow?.name
  if (typeof window === 'string' && window !== '') parts.push(`window=${truncate(window, 60)}`)

  parts.push('use based_on=' + id)
  // S-CTX-04 的"一行"必须**无条件**成立：任何字段都可能带上控制字符
  // （窗口名来自上游文本解析）。曾经窗口名里的 `\n` 会让注入文本变成两行。
  return truncate(flattenToOneLine(`[winmcp] ${parts.join(' ')}`), MAX_CONTEXT_CHARS)
}

/** 把任何换行/行分隔符折叠成空格，保证输出恒为一行。 */
function flattenToOneLine(text) {
  // 覆盖 CR/LF、U+2028/U+2029（JS 里也算行终止符）、以及其余 C0 控制字符
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\r\n\u2028\u2029\u0000-\u001f\u007f]+/g, ' ')
}

/** 单行紧凑数字（只用于展示，不参与计算）。 */
function compact(n) {
  if (!Number.isFinite(n)) return String(n)
  return String(Number(n.toPrecision(6)))
}

/** 截断并标注，避免悄悄丢内容。 */
function truncate(text, limit) {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

function safeBuildMapping(observation) {
  try {
    return buildMapping(observation)
  } catch {
    return null
  }
}

/**
 * 维护 `scope → agent` 映射。
 *
 * 为什么不直接在 `apply()` 里按 agent 注册上下文：插件只挂载一次，
 * 而 agent 是运行期逐个创建的。宿主在组装时给的是 `scope`，
 * 所以需要这张表把 scope 换回 agent。
 */
export function createAgentScopeIndex() {
  /** @type {Map<object, string>} scope → agent id */
  const idByScope = new Map()
  /**
   * 按 **agent id** 去重，存**作用域栈**（最新在末尾）。
   *
   * 为什么不能用对象引用：`agent/created` 与 `agent/disposed` 两个事件里的
   * agent 可能是不同的对象（宿主不保证同一个引用），用对象做键会导致
   * `untrack` 找不到而**残留注入**。
   *
   * 为什么存栈而不是单个 scope：`untrack` 必须只移除属于该 agent 的**一个**作用域。
   * 原先按 id 保存单个 scope 并整键删除，会把同一 id 下另一个**仍在世**的会话的
   * 作用域也删掉——那个活会话会突然丢掉上下文。
   * 这是变异测试逼出来的：我原先的 docstring 声称"只移除匹配项"，但代码做的是整 id 清除。
   */
  const scopesByAgentId = new Map()

  return {
    /** 记录一个 agent 的 scope。 */
    track(agent) {
      const scope = agent?.ctx
      const id = agent?.id
      if (scope === null || scope === undefined || id === null || id === undefined) return
      const key = String(id)
      idByScope.set(scope, key)
      const stack = scopesByAgentId.get(key) ?? []
      if (!stack.includes(scope)) stack.push(scope)
      scopesByAgentId.set(key, stack)
    },
    /**
     * 移除一个 agent 的作用域。
     *
     * 只移除**一个**：优先用事件带来的 `agent.ctx`（最精确），
     * 否则回退到该 id 栈顶（最后注册的那个）。
     * 不得按 id 把同 id 的所有作用域一次清空。
     */
    untrack(agent) {
      const id = agent?.id
      if (id === null || id === undefined) return
      const key = String(id)
      const stack = scopesByAgentId.get(key)
      if (!stack || stack.length === 0) return

      const givenScope = agent?.ctx
      const scope =
        givenScope !== null && givenScope !== undefined && idByScope.get(givenScope) === key
          ? givenScope
          : stack[stack.length - 1]
      idByScope.delete(scope)

      const remaining = stack.filter((item) => item !== scope)
      if (remaining.length > 0) scopesByAgentId.set(key, remaining)
      else scopesByAgentId.delete(key)
    },
    /** 由组装上下文里的 scope 反查 agent id，并返回一个带 id 的句柄。 */
    resolve(assembleContext) {
      const scope = assembleContext?.scope
      if (scope === null || scope === undefined) return null
      const id = idByScope.get(scope)
      return id === undefined ? null : { id }
    },
    /** 已跟踪数量（诊断用）。 */
    size() {
      return idByScope.size
    },
    clear() {
      idByScope.clear()
      scopesByAgentId.clear()
    },
  }
}

/**
 * 注册上下文贡献。
 *
 * @param {object} input
 * @param {any} input.ctx Cordis 上下文
 * @param {object} input.store 观测存储
 * @param {object} input.index createAgentScopeIndex()
 * @param {() => number} input.now
 * @param {(message: string) => void} [input.warn]
 * @returns {() => void} 释放函数（永远可安全调用，即使注册失败）
 */
export function registerContext({ ctx, store, index, now, warn = () => {} }) {
  const noop = () => {}
  // 只认 `ctx.get(name)`。不要回落到 `ctx.systemPrompt`：那是**注册者自己的属性**，
  // 在服务未被提供时依然存在，于是"服务缺失"会被误判成"可用"，
  // 注册进一个永远不会被组装的孤岛里（测试里就撞到了这个）。
  const systemPrompt = ctx?.get?.('systemPrompt')
  if (!systemPrompt || typeof systemPrompt.context !== 'function') {
    // 服务不存在不算错误：本插件在无 UI/无提示服务的部署里也应能工作。
    warn('[dsh_Windows_MCP] systemPrompt 服务不可用，跳过上下文注入')
    return noop
  }

  try {
    const dispose = systemPrompt.context({
      name: 'dsh-windows-mcp-observation',
      // 排在运行时上下文靠前的位置：它描述"我现在依据的是什么"，
      // 越早出现越容易被后续推理当作前提。
      order: -50,
      text: (assembleContext) => {
        try {
          const agent = index.resolve(assembleContext)
          if (!agent) return ''
          const observation = store.current(agent.id)
          return buildRuntimeContextText(observation, now())
        } catch (error) {
          // 组装期抛错会中断整个提示词组装——增益变故障，绝不允许（S-CTX-05）。
          warn(`[dsh_Windows_MCP] 上下文取值失败，已退化为不注入：${error?.message ?? error}`)
          return ''
        }
      },
    })
    return typeof dispose === 'function' ? dispose : noop
  } catch (error) {
    // 重复注册同名上下文会抛错；不能因此让插件挂载失败（S-HOST-04）。
    warn(`[dsh_Windows_MCP] 上下文注册失败，已跳过：${error?.message ?? error}`)
    return noop
  }
}
