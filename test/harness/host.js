/**
 * host.js —— 测试用的「宿主」装置。
 *
 * ## 定位
 * 它扮演 DSH 宿主：提供插件的三个接入点（`tools/pre-execute`、
 * `tools/post-execute`、`ctx.tools.guard`）、工具注册表、效果生命周期与日志，
 * 并记录发生了什么。
 *
 * ## 设计原则
 * 1. **不 mock 被测插件**：用的是真实的 `apply()`，因此测的是真实装配行为。
 * 2. **只替换边界**：审计可选真实文件（保真 JSONL 往返）或内存（纯逻辑），
 *    策略可选真实实现或替身。时间一律走虚拟时钟。
 * 3. **行为友好**：暴露 `givenObservationFrom()` 之类的语义方法，
 *    让 BDD 场景读起来接近自然语言，而不是堆砌内部细节。
 *
 * @module dsh_Windows_MCP/test/harness/host
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../../index.js'
import { createAuditLog } from '../../lib/audit.js'
import { createKillSwitch } from '../../lib/policy.js'
import { createVirtualClock } from './clock.js'

/** 真实抓取过的 Screenshot 文本（与 test/coords.test.mjs 同源，作为共享常量）。 */
export const REAL_SCREENSHOT_TEXT = `Cursor Position: (1290, 651)
Screenshot Original Size: (2560,1440)
Screenshot Coordinate Scale: 1.333333 — image pixels are downscaled; multiply every image pixel coordinate by 1.333333 before passing to Click, Move, Scroll, or any loc= argument (e.g. image pixel (200, 150) → screen coordinate (267, 200))
Visible Displays: 0:\\\\.\\DISPLAY1 (0,0,2560,1440) primary
Selected Displays: 0
Screenshot Region: (0,0,2560,1440)
Coordinate Space: Virtual desktop coordinates
Screenshot Backend: dxcam

Image sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef; request preview 1708x961px. Normalized copy (read-only; may be resized or re-encoded): "C:\\Users\\<user>\\.dsh\\attachments\\v1\\objects\\e0\\0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" (1920x1080px, image/png). Source dimensions, format, and byte size may differ.`

/** 真实抓取过的 Snapshot 文本（含焦点窗口与 UI 树）。 */
export const REAL_SNAPSHOT_TEXT = `    Cursor Position: (755, 733)
Screenshot Original Size: (2560,1440)
Screenshot Coordinate Scale: 1.333333 — x
Screenshot Region: (0,0,2560,1440)
Coordinate Space: Virtual desktop coordinates

    Focused Window:
    Name                                                           Depth  Status       Width    Height    Handle
-----------------------------------------------------------  -------  ---------  -------  --------  --------
Notepad                                                           10  Normal        800      600   4242

    Opened Windows:
    Name                                    Depth  Status       Width    Height    Handle
------------------------------------  -------  ---------  -------  --------  --------
ChatGPT                                    25  Minimized        0         0  30081398

UI Tree:
desktop
├── window "Notepad"
│   ├── (2361,35) 按钮 "最小化"  [action: click]
│   └── (2520,35) 按钮 "关闭"  [action: click]
└── (1838,720) 文档 "ChatGPT"  [action: click]  [focused]  [value:"app://-/index.html"]`

/** 桥投影后的内容块（与真实桥一致：文本 + 图片附件）。 */
export function screenshotBlocks(text = REAL_SCREENSHOT_TEXT) {
  return [
    { type: 'text', text },
    { type: 'image', attachment: { attachmentId: 'att-test', mediaType: 'image/png', bytes: 1024, width: 1920, height: 1080 } },
  ]
}

/** 只含文本的结果块。 */
export function textBlocks(text) {
  return [{ type: 'text', text }]
}

/** 内存审计替身（纯逻辑测试用；不碰磁盘）。 */
export function createMemoryAudit() {
  const entries = []
  return {
    entries,
    record(entry) {
      entries.push(entry)
      return { ok: true }
    },
    read({ limit = 50 } = {}) {
      return entries.slice(-limit)
    },
    stats() {
      return { entries: entries.length, bytes: 0, rotations: 0, lastWriteFailure: null, writeFailures: 0 }
    },
    dispose() {},
  }
}

/** 恒放行的策略替身。 */
export function allowAllPolicy() {
  return { evaluate: () => ({ kind: 'allow' }) }
}

/**
 * 创建一个宿主装置。
 *
 * @param {object} [options]
 * @param {object} [options.config] 传给插件的原始配置
 * @param {'memory'|'file'} [options.audit] 审计后端，默认 memory
 * @param {object} [options.policy] 策略替身；默认恒放行（闸门的日志判定另测）
 * @param {object} [options.log] 日志收集器
 */
export function createHost(options = {}) {
  const clock = options.clock ?? createVirtualClock()
  const listeners = new Map()
  const registered = []
  const guards = []
  const effects = []
  const logs = { info: [], warn: [] }
  let tempDir = null

  const audit = options.audit === 'file'
    ? (() => {
        tempDir = mkdtempSync(join(tmpdir(), 'dsh-wmcppro-'))
        return createAuditLog({ file: join(tempDir, 'audit.jsonl'), clock: () => clock.now() })
      })()
    : createMemoryAudit()

  const ctx = {
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
    /** 假的 DSH 服务查询入口（插件用 ctx.get('systemPrompt') 取服务）。 */
    get(name) {
      return names.get(name)
    },
    /**
     * 假的系统提示服务：记录上下文注册，供测试直接调用其 `text()` 求值。
     * 这样可以在**不启动 DSH** 的前提下验证注入文本与会话隔离。
     */
    systemPrompt: {
      contexts: [],
      context(contribution) {
        if (
          this.contexts.some((existing) => existing.name === contribution.name)
        ) {
          throw new Error(`prompt context "${contribution.name}" is already registered`)
        }
        this.contexts.push(contribution)
        return () => {
          const index = this.contexts.indexOf(contribution)
          if (index >= 0) this.contexts.splice(index, 1)
        }
      },
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((entry) => entry !== handler))
      }
    },
    effect(fn) {
      effects.push(fn)
      const disposer = fn()
      return () => disposer?.()
    },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
      guard(fn) {
        guards.push(fn)
        return () => {
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
  }

  /** 急停实例由**装置**创建，并同时交给插件与策略。
   *
   * 曾经踩过的坑：测试自己 `createKillSwitch()` 传给策略，而插件内部另建了一个，
   * 于是"急停是否生效"这类测试比较的是两个不同对象的状态——结论毫无意义。
   * 现在装置是唯一创建者，并通过 `host.killSwitch` 对外暴露。
   */
  const killSwitch = options.killSwitch ?? createKillSwitch({})

  /**
   * 可注入的服务表。`systemPrompt: false` 可模拟"宿主没有提供系统提示服务"，
   * 用于验证 S-CTX-05（缺失时退化为不注入而不是崩）。
   */
  const names = new Map()
  if (options.systemPrompt !== false) names.set('systemPrompt', ctx.systemPrompt)
  for (const [key, value] of Object.entries(options.services ?? {})) names.set(key, value)

  const dispose = apply(ctx, options.config ?? {}, {
    env: { DSH_HOME: 'C:\\fake-dsh' },
    // 允许测试注入自己的日志收集器（否则"配置被强转是否警告"这类断言无法验证）
    log: options.log ?? ctx.logger,
    now: () => clock.now(),
    audit,
    killSwitch,
    policy: options.policy ?? allowAllPolicy(),
    currentProcessProvider: options.currentProcess
      ? () => options.currentProcess
      : undefined,
    ...(options.options ?? {}),
  })

  let callSeq = 0

  function exec(name, args = {}, agentId = 'agent-1') {
    callSeq += 1
    return {
      name,
      arguments: args,
      callId: `call-${callSeq}`,
      agent: { id: agentId },
      signal: options.signal ?? new AbortController().signal,
    }
  }

  /** 依次跑 pre-execute 监听器，返回最终决定。 */
  async function pre(execution) {
    let decision = { kind: 'allow' }
    const handlers = listeners.get('tools/pre-execute') ?? []
    for (const handler of handlers) {
      const out = await handler(execution, async () => decision)
      if (out) decision = out
    }
    return decision
  }

  /**
   * 模拟「工具调用在宿主层就失败了」：`next()` 抛错。
   *
   * 真实宿主在工具抛错时会把异常一路传给 post-execute 监听器（而不是伪造一个
   * `isError: true` 的结果）。这个入口让「传输失败时插件什么都不能做」变成可测的。
   */
  async function postRejects(execution, error) {
    let decision = { kind: 'accept' }
    const handlers = listeners.get('tools/post-execute') ?? []
    for (const handler of handlers) {
      const out = await handler(execution, null, async () => {
        throw error
      })
      if (out) decision = out
    }
    return decision
  }

  /**
   * 依次跑 post-execute 监听器，返回最终决定。
   *
   * 默认决定刻意与真实宿主同构：`{ kind: 'accept', ...result }`。
   * 早期版本默认成裸 `{ kind: 'accept' }`，于是「插件有没有改写上游结果」这类
   * 断言在测试里**永远看不出差别**（决定对象里根本没有上游字段可比较）。
   */
  async function post(execution, result) {
    let decision = { kind: 'accept', ...(result ?? {}) }
    const handlers = listeners.get('tools/post-execute') ?? []
    for (const handler of handlers) {
      const out = await handler(execution, result, async () => decision)
      if (out) decision = out
    }
    return decision
  }

  /** 触发一个宿主事件（用于模拟 agent/created 等生命周期）。 */
  async function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) await handler(payload)
  }

  /** 已注册的上下文贡献。 */
  function contextContributions() {
    return ctx.systemPrompt.contexts
  }

  /** 为某个 scope 求值所有上下文贡献，返回非空文本数组（抛错记为 __THREW__）。 */
  function assembleContextFor(scope, extra = {}) {
    const out = []
    for (const contribution of contextContributions()) {
      let text
      try {
        text = typeof contribution.text === 'function' ? contribution.text({ scope, ...extra }) : contribution.text
      } catch (error) {
        out.push(`__THREW__:${error?.message ?? error}`)
        continue
      }
      if (typeof text === 'string' && text !== '') out.push(text)
    }
    return out
  }

  /** 一次成功的观测（Screenshot）：喂真实文本 + 图片块。 */
  async function observeScreenshot(agentId = 'agent-1', text = REAL_SCREENSHOT_TEXT) {    const execution = exec(`mcp__winmcp__Screenshot`, {}, agentId)
    const result = { isError: false, value: { content: textBlocks(text).concat([{ type: 'image', data: 'AAAA' }]) }, content: screenshotBlocks(text) }
    const decision = await post(execution, result)
    return { execution, result, decision }
  }

  /** 一次成功的观测（Snapshot，含焦点窗口与 UI 树）。 */
  async function observeSnapshot(agentId = 'agent-1', text = REAL_SNAPSHOT_TEXT) {
    const execution = exec(`mcp__winmcp__Snapshot`, {}, agentId)
    const result = { isError: false, value: { content: textBlocks(text) }, content: textBlocks(text) }
    const decision = await post(execution, result)
    return { execution, result, decision }
  }

  /**
   * 用**假 MCP 服务器**喂一次调用（Batch 1 起的主路径）。
   *
   * 与 `observeScreenshot()` 的区别：这里的结果形状来自 `fake-mcp.js` 的旋钮，
   * 因此可以重放「UI 树空 / 图片进不来 / 断线 / 畸形」等真机上难以故意造出的边界，
   * 而不用在测试里手搓上游文本。
   *
   * @param {object} server createFakeMcpServer() 的产物
   * @param {string} tool 裸工具名（如 `Screenshot`）
   * @param {object} [args] 工具参数
   * @param {string} [agentId]
   */
  async function callTool(server, tool, args = {}, agentId = 'agent-1') {
    const execution = exec(`mcp__${(options.config?.serverName) ?? 'winmcp'}__${tool}`, args, agentId)
    const result = await server.respond(tool, args)
    const decision = await post(execution, result)
    return { execution, result, decision }
  }

  /** 同上，但不跑 post-execute（用于「桥投影被判不接纳」这类纯桥测试）。 */
  async function callToolRaw(server, tool, args = {}, agentId = 'agent-1') {
    const execution = exec(`mcp__${(options.config?.serverName) ?? 'winmcp'}__${tool}`, args, agentId)
    const result = await server.respond(tool, args)
    return { execution, result }
  }

  /** 取回某个辅助工具的定义并执行它。 */
  async function runTool(name, args = {}, agentId = 'agent-1') {
    const definition = registered.find((entry) => entry.name === name)
    if (!definition) throw new Error(`工具 ${name} 未注册`)
    const execution = exec(name, args, agentId)
    const result = await definition.execute(args, execution)
    return { definition, result, text: extractText(result) }
  }

  return {
    clock,
    audit,
    killSwitch,
    ctx,
    logs,
    registered,
    guards,
    exec,
    pre,
    post,
    postRejects,
    emit,
    contextContributions,
    assembleContextFor,
    observeScreenshot,
    observeSnapshot,
    callTool,
    callToolRaw,
    runTool,
    /** 当前已注册的工具名。 */
    toolNames: () => registered.map((entry) => entry.name),
    /** 监听器数量（诊断用）。 */
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    dispose,
    cleanup() {
      try {
        dispose?.()
      } catch {
        /* 清理失败不掩盖真实失败 */
      }
      try {
        audit.dispose?.()
      } catch {
        /* 同上 */
      }
      if (tempDir) {
        try {
          rmSync(tempDir, { recursive: true, force: true })
        } catch {
          /* 同上 */
        }
      }
    },
  }
}

/** 从工具结果里取文本（兼容 content 块与裸字符串）。 */
export function extractText(result) {
  if (typeof result === 'string') return result
  if (!result) return ''
  if (typeof result.value === 'string') return result.value
  const content = result.content ?? result.value?.content ?? []
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
