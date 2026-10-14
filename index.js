/**
 * dsh_Windows_MCP —— DeepSeek Harness 的 Windows-MCP 深度适配插件。
 *
 * Windows-MCP（CursorTouch/Windows-MCP）本身通过 DSH 内置的
 * `@deepseek-ai/dsh-mcp-client` 桥接入，工具以 `mcp__winmcp__<Tool>` 出现。
 * 桥只做「协议搬运」，不做任何语义加工。本插件补上桥缺的那一层：
 *
 * | 问题（桥不解决） | 本插件的做法 |
 * |---|---|
 * | 坐标换算信息是一句散文，模型要心算，易漏乘/重复乘 | `tools/post-execute` 追加单行结构化映射，并提供双向换算工具 |
 * | 观测可以很旧，`Click` 不看新鲜度，会静默点到别的窗口 | `tools/pre-execute` 前置闸门：无观测/过期/代次落后/窗口漂移 → 拒绝并给出修复动作 |
 * | 没有任何审计记录，出问题无法复盘 | append-only JSONL 审计（含脱敏） |
 * | 无法一键停下 | 常驻急停开关；急停后只放行只读观测工具 |
 *
 * 所有 DSH 侧接缝都是官方契约（`tools/pre-execute` / `tools/post-execute` /
 * `ctx.tools.register`），因此在同一个进程内生效，且对模型透明。
 *
 * @module dsh_Windows_MCP
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  buildObservation,
  extractText,
  stripToolPrefix,
} from './lib/observe.js'
import {
  buildMapping,
  describeMapping,
  imageToScreen,
  screenToImage,
  modelToScreen,
  screenToModel,
  screenPerImagePx,
} from './lib/coords.js'
import {
  ACTION,
  classifyAction,
  createObservationStore,
  assessFreshness,
  buildGateRequest,
} from './lib/gate.js'
import { createAuditLog } from './lib/audit.js'
import { createKillSwitch, createPolicy, describeDecision } from './lib/policy.js'
import { DEFAULT_COMMAND_RULES, WINDOWS_MCP_ARGUMENTS } from './lib/commands.js'
import { createAgentScopeIndex, registerContext } from './lib/context.js'
import { renderReport, DEFAULT_AUDIT_LIMIT } from './lib/auditview.js'

/** 插件名（也是 loader entry 引用的模块名）。 */
export const name = 'dsh_Windows_MCP'

/** 依赖的 DSH 服务；缺任何一个本插件都不该激活。 */
export const inject = ['tools']

/** 默认配置；README 与测试会强制三处一致。 */
export const DEFAULTS = Object.freeze({
  // 桥接行使用的 serverName；工具名前缀 mcp__<serverName>__
  serverName: 'winmcp',
  // 输入类动作允许依赖的最旧观测（毫秒）
  maxObservationAgeMs: 60000,
  // 输入类动作是否必须有前置观测
  requireObservation: true,
  // 是否要求观测包含坐标映射信息（缺了就提示，不阻断）
  requireCoordinateMapping: true,
  // 是否复核目标窗口是否漂移
  requireProcessMatch: true,
  // 高影响工具是否走审批
  requireApproval: false,
  // 输入类动作是否也走审批
  requireApprovalForInput: false,
  // 审批有效期
  approvalTtlMs: 120000,
  // 审计日志路径；空字符串 = 关闭审计
  auditFile: '',
  // 审计文件大小上限
  auditMaxBytes: 8 * 1024 * 1024,
  // 启动时是否自动打开审计（默认写到 $DSH_HOME/logs/windows-mcp-audit.jsonl）
  autoAudit: true,
  // 是否在结果里追加坐标映射行
  annotateResults: true,
  // 是否注册 winmcp_* 辅助工具
  registerTools: true,
  // 是否把当前观测注入运行时上下文（每轮重建）
  injectContext: true,
  // Batch 3：命令级策略开关
  commandRulesEnabled: true,
  // 追加的自定义危险规则（不能移除内置规则）
  commandRules: [],
  // 内置规则的显式豁免（规则 id 数组）；豁免会记入审计
  allowRules: [],
})

// ─────────────────────────────────────────────────────────────────────────────
// 配置归一化
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 安全读取配置字段。
 *
 * 为什么要包一层：配置对象来自 Loader，理论上可以是任意对象——包括带抛错
 * getter 的、或 Proxy。对抗性验证者用 `get serverName() { throw … }` 让
 * `apply()` 直接抛异常，违反了 S-HOST-04（插件自身的失败不得让宿主启动失败）。
 * 因此所有配置读取都必须容错，失败就退化为默认值。
 */
function safeRead(config, key) {
  try {
    return config?.[key]
  } catch {
    return undefined
  }
}

function readString(config, key, fallback) {
  const value = safeRead(config, key)
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function readNumber(config, key, fallback) {
  const value = safeRead(config, key)
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function readBoolean(config, key, fallback) {
  const value = safeRead(config, key)
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** 把原始配置归一化成内部使用的形状。
 *
 * `onCoerce` 用于报告"配置值被强转或回退默认"这种情况。
 * 为什么必须报告：静默把 `maxObservationAgeMs: 'x'` 变成 60000 是危险的——
 * 用户以为改了配置，实际被悄悄忽略（S-HOST-04 要求给出可执行的修复信息）。
 */
export function normalizeConfig(raw = {}, env = process.env, onCoerce = null) {
  const dshHome = env.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(homedir(), '.dsh')
  const warn = typeof onCoerce === 'function' ? onCoerce : () => {}

  /** 统一入口：读到非法值时警告并回退默认。 */
  const num = (key, fallback) => {
    const value = safeRead(raw, key)
    if (value === undefined) return fallback
    const n = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(n)) return n
    warn(key, value, fallback)
    return fallback
  }
  const bool = (key, fallback) => {
    const value = safeRead(raw, key)
    if (value === undefined) return fallback
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    warn(key, value, fallback)
    return fallback
  }
  const str = (key, fallback) => {
    const value = safeRead(raw, key)
    if (value === undefined || value === null || value === '') return fallback
    if (typeof value === 'string') return value.trim() !== '' ? value.trim() : fallback
    warn(key, value, fallback)
    return fallback
  }

  const configured = str('auditFile', '')
  const autoAudit = bool('autoAudit', DEFAULTS.autoAudit)
  const auditFile = configured !== ''
    ? configured
    : autoAudit
      ? join(dshHome, 'logs', 'windows-mcp-audit.jsonl')
      : ''
  return {
    serverName: str('serverName', DEFAULTS.serverName),
    maxObservationAgeMs: num('maxObservationAgeMs', DEFAULTS.maxObservationAgeMs),
    requireObservation: bool('requireObservation', DEFAULTS.requireObservation),
    requireCoordinateMapping: bool('requireCoordinateMapping', DEFAULTS.requireCoordinateMapping),
    requireProcessMatch: bool('requireProcessMatch', DEFAULTS.requireProcessMatch),
    requireApproval: bool('requireApproval', DEFAULTS.requireApproval),
    requireApprovalForInput: bool('requireApprovalForInput', DEFAULTS.requireApprovalForInput),
    approvalTtlMs: num('approvalTtlMs', DEFAULTS.approvalTtlMs),
    auditFile,
    auditMaxBytes: num('auditMaxBytes', DEFAULTS.auditMaxBytes),
    autoAudit,
    annotateResults: bool('annotateResults', DEFAULTS.annotateResults),
    registerTools: bool('registerTools', DEFAULTS.registerTools),
    injectContext: bool('injectContext', DEFAULTS.injectContext),
    commandRulesEnabled: bool('commandRulesEnabled', DEFAULTS.commandRulesEnabled),
    commandRules: readRuleList(raw, 'commandRules'),
    allowRules: readStringList(raw, 'allowRules'),
  }
}

/** 读取自定义规则数组；形态不完整的条目被丢弃（由 lib/commands.js 再做一次校验）。 */
function readRuleList(config, key) {
  const value = safeRead(config, key)
  if (!Array.isArray(value)) return []
  return value.filter((item) => item && typeof item === 'object')
}

/** 读取字符串数组（规则 id 列表）。 */
function readStringList(config, key) {
  const value = safeRead(config, key)
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/** 判断一次执行是否属于本插件管辖的 winmcp 工具。 */
export function ownsTool(toolName, serverName) {
  return typeof toolName === 'string' && toolName.startsWith(`mcp__${serverName}__`)
}

/** agent 会话键；没有 agent 时归到一个全局桶。 */
function agentKeyOf(agent) {
  return agent?.id ?? '__global__'
}

/**
 * 决策形状契约：闸门只接受这三种之一。
 *
 * 为什么把它抽成独立函数并导出：这是**安全边界**，需要被测试直接覆盖，
 * 也需要在文档（spec/SYS_SPEC.md S-GATE-01）里可引用。任何"看起来像放行"
 * 但不满足这里的形状的值，都会被当作异常并失败关闭。
 */
export function isRecognizedDecision(decision) {
  if (!decision || typeof decision !== 'object') return false
  const kind = decision.kind
  if (kind === 'allow') return true
  if (kind === 'deny') return typeof decision.reason === 'string' && decision.reason.length > 0
  if (kind === 'ask') return true
  return false
}

/** 给日志用的形状描述（诊断"上游到底给了什么"）。 */
function describeShape(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type !== 'object') return type
  const keys = Object.keys(value)
  return keys.length === 0 ? 'empty object' : `object{${keys.join(',')}}`
}

// ─────────────────────────────────────────────────────────────────────────────
// 结果富化
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 为一次观测构造追加内容块。刻意**只追加**，不改动上游内容，
 * 这样即使本插件的映射算错，模型仍然能看到 Windows-MCP 原文。
 * @returns {Array<{type:'text',text:string}>}
 */
export function annotationBlocks(tool, observation, mapping) {
  const raw = stripToolPrefix(tool).toLowerCase()
  if (raw !== 'snapshot' && raw !== 'screenshot') return []
  const blocks = []
  if (mapping?.ok) {
    const parts = [
      describeMapping(mapping, { observationId: observation?.id }),
      '换算：图像坐标 → 屏幕坐标用 winmcp_to_screen；反过来用 winmcp_screen_to_image。',
    ]
    if (observation?.region) {
      // 上游 desktop/service.py 的真实语义：
      //   capture_rect = 显式 region ?: 所选 display 的并集 : null
      //   screenshot_region = capture_rect 的边界框
      // 所以这是"本次截图覆盖的矩形"，**不是**整个虚拟桌面——
      // 多显示器 + 负坐标（U-01）下两者不同，说错会让人把原点用错。
      parts.push(
        `原点 (${observation.region.left},${observation.region.top}) 是本次截图覆盖区域的左上角` +
          `（来自 region 参数或所选显示器的并集，不是整个虚拟桌面）；若结果里没有 Region 行，原点按 (0,0)。`,
      )
    }
    // 「模型像素」这一环必须显式写出来：模型看到的那张图可能被预览缩放，
    // 与上游图片像素不同（附件说明里的 request preview 尺寸）。漏乘会让坐标系统性偏掉。
    parts.push(
      '注意：如果你是从截图里读出的像素，那是「模型像素」，可能与上游图片像素不同（见附件说明的预览尺寸）；' +
        '两者不一致时先按宽度比例换算，再套上面的公式。',
    )
    blocks.push({ type: 'text', text: parts.join(' ') })
  } else {
    blocks.push({
      type: 'text',
      text: `[mcp] 坐标映射不完整：${mapping?.reason ?? '缺少 Scale/Size'}；请以 UI 树给出的屏幕坐标为准（那是唯一无需换算的坐标）。`,
    })
  }
  if (observation?.uiElements?.length) {
    blocks.push({
      type: 'text',
      text: `[mcp] 本次观测到 ${observation.uiElements.length} 个可交互元素；这些元素括号里的坐标就是屏幕坐标，可直接用于 Click/Move 的 loc=，无需换算。`,
    })
  }
  return blocks
}

// ─────────────────────────────────────────────────────────────────────────────
// 插件主体
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 挂载插件。
 * @param {any} ctx Cordis 上下文（含 tools 服务、logger、timer）
 * @param {object} rawConfig 未归一化的配置
 * @param {object} [options] 测试注入点
 */
/**
 * 取上游内容块，按 S-HOST-02 / A-12 的回退顺序：
 * `result.content`（数组）→ `result.value.content`（数组）→ `result.value`（字符串）。
 *
 * 为什么必须回退：上游可能把内容放在 `value` 里。只读 `result.content`
 * 会让富化后的 `content` 只剩追加块，Windows-MCP 原文就丢了——
 * 而"即使映射算错模型仍能看到原文"是本章的核心承诺。
 */
export function upstreamContentOf(result) {
  if (!result || typeof result !== 'object') return []
  if (Array.isArray(result.content)) return result.content
  const value = result.value
  if (value && typeof value === 'object' && Array.isArray(value.content)) return value.content
  if (typeof value === 'string' && value !== '') return [{ type: 'text', text: value }]
  return []
}

export function apply(ctx, rawConfig = {}, options = {}) {
  const env = options.env ?? process.env
  const log = options.log ?? ctx.logger ?? console
  const now = options.now ?? Date.now

  // 配置强转/回退必须留痕：静默忽略用户写的配置是"看起来生效其实没生效"的典型。
  const config = normalizeConfig(rawConfig, env, (key, received, adopted) => {
    log.warn?.(
      `[${name}] 配置项 ${key} 的值 ${JSON.stringify(received)} 不可用，已回退为默认值 ${JSON.stringify(adopted)}`,
    )
  })

  const store = options.store ?? createObservationStore()
  const killSwitch = options.killSwitch ?? createKillSwitch({})
  const audit = options.audit ?? createAuditLog({
    file: config.auditFile,
    maxBytes: config.auditMaxBytes,
    onError: (error) => log.warn?.(`[${name}] 审计写入失败（不影响动作结果）：${error?.message ?? error}`),
  })
  const ask = options.ask
  // policy 不直接写审计：本插件在 pre/post-execute 里记录更完整的一手条目
  // （含观测 id、坐标、耗时）。policy 再记一遍会造成每个动作两条重复日志。
  const policy = options.policy ?? createPolicy({ config, killSwitch, audit: null, ask, now })

  /** 记录一次动作的耗时起点，用于审计 durationMs。 */
  const startedAt = new Map()

  function recordAudit(entry) {
    try {
      audit.record({
        at: new Date(now()).toISOString(),
        serverName: config.serverName,
        sessionId: null,
        ...entry,
      })
    } catch (error) {
      // 审计永远不能反噬主流程。
      log.warn?.(`[${name}] audit.record 抛出异常（已忽略）：${error?.message ?? error}`)
    }
  }

  // ── 1) 观测 & 结果富化：tools/post-execute ────────────────────────────────
  const onPostExecute = async (exec, result, next) => {
    const decision = await next()
    try {
      if (!ownsTool(exec?.name, config.serverName)) return decision
      const raw = stripToolPrefix(exec.name, config.serverName)
      const action = classifyAction(exec.name, config.serverName)
      const agentKey = agentKeyOf(exec.agent)
      const isError = result?.isError === true

      if (isError) {
        recordAudit({
          action,
          tool: raw,
          decision: 'error',
          allowed: true,
          reason: result?.error?.message ?? 'tool error',
          observationId: store.current(agentKey)?.id ?? null,
          target: null,
          screen: null,
          image: null,
          stale: false,
          durationMs: takeDuration(exec),
          result: 'error',
        })
        return decision
      }

      const text = extractText(result?.value)
      // post-execute 是全局监听器，会收到所有 agent 的调用，
      // 因此必须用「这次执行自己的 agent」去索引观测桶，否则多会话会串。
      const observation = buildObservation({
        value: result.value,
        content: result.content,
        tool: exec.name,
        at: now(),
        generation: store.generation(agentKey) + 1,
      })
      const hasAnySignal =
        observation.cursor !== null ||
        observation.region !== null ||
        observation.originalSize !== null ||
        observation.uiElements.length > 0
      let mapping = null
      if (hasAnySignal) {
        const stored = store.record(agentKey, observation)
        mapping = buildMapping(stored)
        recordAudit({
          action,
          tool: raw,
          decision: 'observed',
          allowed: true,
          reason: null,
          observationId: stored.id,
          target: stored.focusedWindow?.name ?? null,
          screen: stored.cursor,
          image: stored.image?.attachmentSize ?? null,
          stale: false,
          durationMs: takeDuration(exec),
          result: 'ok',
          mappingOk: mapping.ok,
          coordScale: mapping.coordScale,
          screenPerImagePx: mapping.screenPerImagePx,
        })
      } else {
        recordAudit({
          action,
          tool: raw,
          decision: 'ok',
          allowed: true,
          reason: null,
          observationId: store.current(agentKey)?.id ?? null,
          target: null,
          screen: null,
          image: null,
          stale: false,
          durationMs: takeDuration(exec),
          result: text ? 'ok' : 'empty',
        })
      }

      if (!config.annotateResults || mapping === null) return decision

      const extra = annotationBlocks(exec.name, store.current(agentKey), mapping)
      if (extra.length === 0) return decision

      if (decision.kind === 'accept' && Array.isArray(decision.content)) {
        return { ...decision, content: [...decision.content, ...extra] }
      }
      if (decision.kind === 'accept') {
        // 结果为结构化值：保留 value，同时把映射作为附加内容块。
        //
        // S-HOST-02 / A-12 的上游内容源回退顺序必须实现：
        //   result.content（数组） → result.value.content（数组） → result.value（字符串）
        // 曾经只读 `result.content`，于是当上游内容只存在于 `value.content` / `value` 时，
        // 富化后的 `content` **只剩追加块**，Windows-MCP 原文不在里面——
        // 直接违反"富化结果必须以上游内容开头""即使映射算错模型仍能看到原文"。
        // 对抗性验证 V9。
        return { ...decision, content: [...upstreamContentOf(result), ...extra] }
      }
      return decision
    } catch (error) {
      log.warn?.(`[${name}] post-execute 富化失败（结果保持原样）：${error?.message ?? error}`)
      return decision
    }
  }

  function takeDuration(exec) {
    const key = exec?.callId ?? exec?.name
    const start = startedAt.get(key)
    if (start === undefined) return null
    startedAt.delete(key)
    return now() - start
  }

  // ── 2) 前置闸门：tools/pre-execute ───────────────────────────────────────
  /**
   * 实时进程事实的采集点。
   *
   * 默认不采集：真机上唯一可靠的来源是再跑一次 Snapshot，
   * 那会让每一次点击都多花几秒——闸门不能比它保护的动作还贵。
   * 宿主/测试可以通过 `options.currentProcessProvider(exec)` 注入，
   * 注入后 S-GATE-05（窗口漂移）就会基于真实数据生效。
   */
  const currentProcessProvider = options.currentProcessProvider

  const onPreExecute = async (exec, next) => {
    const started = now()
    if (!ownsTool(exec?.name, config.serverName)) return next()
    const key = exec?.callId ?? exec?.name
    startedAt.set(key, started)

    const raw = stripToolPrefix(exec.name, config.serverName)
    const agentKey = agentKeyOf(exec.agent)
    // args 必须传进去：模型可以在参数里用 based_on 声明依据哪一次观测，
    // 闸门要据此校验该 id 是否真实存在（拦「凭空写 id」）。
    let currentProcess = null
    if (typeof currentProcessProvider === 'function') {
      try {
        currentProcess = currentProcessProvider(exec) ?? null
      } catch (error) {
        // 采集失败不得让闸门崩：按"无数据"处理，漂移判定会自动跳过。
        log.warn?.(`[${name}] currentProcessProvider 失败（按无数据继续）：${error?.message ?? error}`)
      }
    }
    const request = buildGateRequest({
      agentKey,
      tool: exec.name,
      store,
      now: started,
      config,
      args: exec.arguments,
      currentProcess,
    })

    // policy 优先（急停/黑白名单/审批），然后叠加新鲜度评估。
    //
    // ⚠️ 这里必须**只接受明确定义的决策形状**。对抗性验证者构造出的反例是：
    // 策略返回 `{}`（或 `null`/字符串/没有 evaluate），旧实现用
    // `if (decision.kind === 'allow')` 判断，于是畸形决策既不是 allow、也不是
    // deny/ask，就直接落到 `return next()` ——**整个新鲜度检查被跳过**，
    // 没有观测也能点击。这是典型的失败开放（fail-open），安全组件绝不允许。
    // 现在只有 `{kind:'allow'}` 才继续，其它一律按 POLICY_ERROR 拒绝。
    let decision
    try {
      decision = policy?.evaluate?.(request)
    } catch (error) {
      log.warn?.(`[${name}] policy.evaluate 抛出异常，按失败关闭处理：${error?.message ?? error}`)
      decision = null
    }

    if (!isRecognizedDecision(decision)) {
      log.warn?.(
        `[${name}] policy 返回了无法识别的决策（${describeShape(decision)}），按失败关闭处理。`,
      )
      decision = {
        kind: 'deny',
        reason: '策略返回了无法识别的决策形状，已按安全默认拒绝（失败关闭）',
        code: 'POLICY_ERROR',
      }
    }

    if (decision.kind === 'allow' && config.requireObservation !== false) {
      const problems = assessFreshness(request, config)
      const blocking = problems.filter((p) => p.code !== 'MAPPING_INCOMPLETE')
      if (blocking.length > 0) {
        decision = { kind: 'deny', reason: blocking.map((p) => p.message).join(' '), code: blocking[0].code }
      } else if (problems.length > 0) {
        request.warnings = problems
      }
    }

    if (decision.kind === 'deny') {
      recordAudit({
        action: request.action,
        tool: raw,
        decision: 'deny',
        allowed: false,
        reason: decision.reason,
        code: decision.code ?? null,
        observationId: request.observation?.id ?? null,
        target: request.observation?.focusedWindow?.name ?? null,
        screen: request.observation?.cursor ?? null,
        image: null,
        stale: decision.code === 'STALE_OBSERVATION',
        durationMs: null,
        result: 'blocked',
      })
      return { kind: 'deny', reason: `${describeDecision(decision)} 原始原因：${decision.reason}`, info: { name: 'dsh_Windows_MCP', code: decision.code ?? 'DENIED' } }
    }

    if (decision.kind === 'ask') {
      recordAudit({
        action: request.action,
        tool: raw,
        decision: 'ask',
        allowed: false,
        reason: decision.reason,
        observationId: request.observation?.id ?? null,
        target: request.observation?.focusedWindow?.name ?? null,
        screen: request.observation?.cursor ?? null,
        image: null,
        stale: false,
        durationMs: null,
        result: 'pending-approval',
      })
      return { kind: 'ask', reason: decision.reason }
    }

    // S-AUDIT-07：**放行的改动类动作也必须留痕**。
    //
    // 只记拒绝会让审计出现一个致命盲区：真正改动了桌面的那些动作（放行的
    // Click/Type/PowerShell…）反而查不到，而未发生的拒绝倒是记了一堆。
    // 复盘时最需要的恰恰是前者。
    //
    // 只对会改动状态的类目记录（input/system）：只读观测工具的结果由
    // post-execute 记更完整的条目，在这里再记一条只会造成重复噪声。
    if (request.action === ACTION.INPUT || request.action === ACTION.SYSTEM) {
      recordAudit({
        action: request.action,
        tool: raw,
        decision: 'allow',
        allowed: true,
        reason: request.warnings?.length ? request.warnings.map((w) => w.message).join(' ') : null,
        code: request.warnings?.length ? request.warnings[0].code : null,
        // S-CMD-07：命令级规则被显式豁免时，审计必须能回答
        // "谁在什么情况下用了豁免"。这条信息由 policy 的决策对象带出。
        ruleExempted: decision.ruleExempted ?? null,
        observationId: request.observation?.id ?? null,
        target: request.observation?.focusedWindow?.name ?? null,
        screen: request.observation?.cursor ?? null,
        image: null,
        stale: false,
        durationMs: null,
        result: 'allowed',
      })
    }

    return next()
  }

  // ── 3) 同步兜底闸门：tools.guard ────────────────────────────────────────
  const guard = (exec) => {
    try {
      if (!ownsTool(exec?.name, config.serverName)) return undefined
      if (!killSwitch.isEngaged()) return undefined
      if (classifyAction(exec.name, config.serverName) === ACTION.OBSERVE) return undefined
      return `${name}: 急停已启用 —— 只允许只读观测工具（Snapshot/Screenshot/DisplayInventory/Wait/WaitFor）。先 winmcp_kill action=release 释放。`
    } catch {
      return undefined
    }
  }

  // ── 4) 辅助工具 ─────────────────────────────────────────────────────────
  const disposers = []
  if (config.registerTools) {
    // `winmcp_doctor` 需要读**实际注册表**才能发现参数漂移（S-HOST-06）。
    // 用惰性 provider 而不是启动时快照：工具表会随插件挂载/卸载变化。
    const toolSchemasProvider = () => ctx.tools?.schemas?.()
    for (const definition of buildTools({ config, store, killSwitch, policy, audit, now, toolSchemasProvider })) {
      disposers.push(ctx.tools.register(definition))
    }
  }

  // ── 5) 事件挂载 ─────────────────────────────────────────────────────────
  const offPre = ctx.on('tools/pre-execute', onPreExecute)
  const offPost = ctx.on('tools/post-execute', onPostExecute)
  const offGuard = ctx.tools.guard(guard)

  // ── 6) 运行时上下文注入（Batch 2）────────────────────────────────────────
  // 维护 scope → agent 映射：插件只挂载一次，而 agent 是运行期逐个创建的。
  const scopeIndex = createAgentScopeIndex()
  let offContext = () => {}
  if (config.injectContext) {
    const trackAgent = (payload) => {
      const agent = payload?.agent
      if (agent) scopeIndex.track(agent)
    }
    const untrackAgent = (payload) => {
      const agent = payload?.agent
      if (agent) scopeIndex.untrack(agent)
    }
    // `agent/created` 在 agent 的 scope 就绪后触发，正好用来建映射。
    const offCreated = ctx.on?.('agent/created', trackAgent)
    const offDisposed = ctx.on?.('agent/disposed', untrackAgent)
    const offCtx = registerContext({
      ctx,
      store,
      index: scopeIndex,
      now,
      warn: (message) => log.warn?.(message),
    })
    offContext = () => {
      try { offCreated?.() } catch {}
      try { offDisposed?.() } catch {}
      try { offCtx?.() } catch {}
      scopeIndex.clear()
    }
  }

  log.info?.(
    `[${name}] 已挂载：serverName=${config.serverName} 审批=${config.requireApproval} 审计=${config.auditFile || '关闭'} ` +
      `观测上限=${config.maxObservationAgeMs}ms`,
  )

  const disposeAll = () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
    try { offPre?.() } catch {}
    try { offPost?.() } catch {}
    try { offGuard?.() } catch {}
    try { offContext?.() } catch {}
    try { audit.dispose?.() } catch {}
  }

  // Cordis 生命周期：优先交给 ctx.effect，HMR/卸载时按序回收。
  try {
    ctx.effect?.(() => disposeAll)
  } catch (error) {
    log.warn?.(`[${name}] ctx.effect 注册失败（不影响功能，但卸载可能不干净）：${error?.message ?? error}`)
  }

  return disposeAll
}

// ─────────────────────────────────────────────────────────────────────────────
// 辅助工具定义
// ─────────────────────────────────────────────────────────────────────────────

function textOutput(schemaProps = {}) {
  return {
    schema: { type: 'object', properties: schemaProps, additionalProperties: true },
    render: (_args, value) => {
      if (typeof value === 'string') return [{ type: 'text', text: value }]
      return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 运行时自检（Batch 8）
// ─────────────────────────────────────────────────────────────────────────────

/** 自检总体结论。判定优先级：broken > unknown > healthy。 */
export const DOCTOR_VERDICT = Object.freeze({
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  BROKEN: 'broken',
  UNKNOWN: 'unknown',
})

const LEVEL_RANK = Object.freeze({ ok: 0, warn: 1, unknown: 2, critical: 3 })

/**
 * 把"本插件对上游的假设"与"上游**实际注册**的工具参数"逐项比对，并汇总运行态检查。
 *
 * ## 为什么需要它
 * 本项目最大的一个缺陷是把**猜出来的** `action` 当上游字段名，而真实工具用 `mode`：
 * 规则表在每份文档里都对、真机上永远不命中，而单元测试用的是同样猜错的键所以全绿。
 * 这类"假设漂移"**只有对着真实注册表才能发现**，所以把它做成随时可调的自检。
 *
 * ## 只读与失败关闭（S-HOST-07）
 * 不写任何状态；任一检查抛错都记为 `unknown`（**不**记为 ok）。
 * 自检工具最常见的危害是给出**虚假的健康结论**——那比没有自检更糟。
 */
export function diagnose({ config, store, killSwitch, audit, agentKey, toolSchemas, now = Date.now }) {
  const checks = []
  const push = (check) => checks.push({ level: 'ok', kind: 'state', ...check })

  // ── 1) schema 漂移比对（最重要的一项）────────────────────────────────────
  const schemas = Array.isArray(toolSchemas) ? toolSchemas : null
  if (schemas === null) {
    push({
      kind: 'schema',
      name: '上游工具注册表',
      level: 'unknown',
      detail: '工具注册表不可读（tools.schemas() 不可用或返回非数组），无法比对参数名',
    })
  } else {
    const byName = new Map()
    for (const schema of schemas) {
      if (schema && typeof schema.name === 'string') byName.set(schema.name, schema)
    }
    for (const [tool, expected] of Object.entries(WINDOWS_MCP_ARGUMENTS)) {
      const fullName = `mcp__${config.serverName}__${tool}`
      const schema = byName.get(fullName)
      if (!schema) {
        // 工具可能被 --disable-tools 关掉：那是**部署选择**，不是漂移。
        push({
          kind: 'schema',
          name: `${tool} 参数名`,
          level: 'unknown',
          detail: `注册表里没有 ${fullName}（上游未启用该工具？），本项无法比对`,
        })
        continue
      }
      const props = schema.inputSchema?.properties
      if (!props || typeof props !== 'object') {
        push({
          kind: 'schema',
          name: `${tool} 参数名`,
          level: 'unknown',
          detail: `${fullName} 没有可读的 inputSchema.properties`,
        })
        continue
      }
      const actual = Object.keys(props)
      const missing = [...expected].filter((key) => !actual.includes(key))
      const extra = actual.filter((key) => !expected.includes(key))
      if (missing.length > 0) {
        push({
          kind: 'schema',
          name: `${tool} 参数名`,
          level: 'critical',
          detail:
            `上游缺少本插件要读的字段：${missing.join(', ')}（上游实有 ${actual.length} 个）。` +
            `后果：依赖这些字段的命令级规则会**静默失效**——规则看起来对，真机上永远不命中。`,
        })
      } else if (extra.length > 0) {
        push({
          kind: 'schema',
          name: `${tool} 参数名`,
          level: 'warn',
          detail:
            `上游多出未登记的字段：${extra.join(', ')}。` +
            `这不一定错，但若其中有可区分字段（如布尔修饰符），相关规则可能漏拦。`,
        })
      } else {
        push({ kind: 'schema', name: `${tool} 参数名`, level: 'ok', detail: `${actual.length} 个参数与登记全等` })
      }
    }
  }

  // ── 2) 观测与映射 ────────────────────────────────────────────────────────
  let observation = null
  try {
    observation = store.current(agentKey) ?? null
  } catch (error) {
    push({ kind: 'state', name: '观测读取', level: 'critical', detail: `读取观测抛错：${error?.message ?? error}` })
  }
  if (observation === null) {
    // 「还没有观测」是**正常状态**（刚启动、还没 Snapshot），不是插件缺陷 ——
    // 因此记为 ok，只在 detail 里给出下一步动作。把它记成 warn 会让每次冷启动都"降级"，
    // 那样的告警没有信息量，反而会让人忽略真正的告警。
    push({
      kind: 'state',
      name: '当前观测',
      level: 'ok',
      detail: '本会话还没有观测（正常状态）。执行输入类操作前先 Snapshot，否则会被闸门按无观测拒绝。',
    })
  } else {
    const ageMs = typeof observation.at === 'number' ? Math.max(0, now() - observation.at) : null
    const ageText = ageMs === null ? '未知' : `${Math.round(ageMs / 1000)}s`
    let mappingOk = false
    let mappingDetail = '未计算'
    try {
      const mapping = buildMapping(observation)
      mappingOk = mapping?.ok === true
      mappingDetail = mappingOk ? describeMapping(mapping, { observationId: observation.id }) : `不可用（${mapping?.reason}）`
    } catch (error) {
      mappingDetail = `计算抛错：${error?.message ?? error}`
    }
    push({
      kind: 'state',
      name: '当前观测',
      level: mappingOk ? 'ok' : 'warn',
      detail: `${observation.id}（${observation.tool}，age=${ageText}）坐标映射 ${mappingDetail}`,
    })
    const maxAge = Number(config.maxObservationAgeMs)
    if (ageMs !== null && Number.isFinite(maxAge) && ageMs > maxAge) {
      push({
        kind: 'state',
        name: '观测新鲜度',
        level: 'warn',
        detail: `已过期 ${ageText} > 上限 ${Math.round(maxAge / 1000)}s；输入类操作会被 STALE_OBSERVATION 拒绝，请重新 Snapshot。`,
      })
    }
  }

  // ── 3) 急停 ──────────────────────────────────────────────────────────────
  try {
    const engaged = killSwitch.isEngaged() === true
    push({
      kind: 'state',
      name: '急停',
      level: engaged ? 'warn' : 'ok',
      detail: engaged
        ? `已启用（${killSwitch.snapshot?.()?.reason ?? '无原因'}）：除只读工具外全部拒绝`
        : '未启用',
    })
  } catch (error) {
    push({ kind: 'state', name: '急停', level: 'unknown', detail: `读取急停状态抛错：${error?.message ?? error}` })
  }

  // ── 4) 策略与配置 ────────────────────────────────────────────────────────
  const rulesEnabled = config.commandRulesEnabled !== false
  push({
    kind: 'state',
    name: '命令级策略',
    level: rulesEnabled ? 'ok' : 'warn',
    detail: rulesEnabled
      ? `已启用，内置规则 ${DEFAULT_COMMAND_RULES.length} 条`
      : '已关闭（commandRulesEnabled=false）：命令内容不做判定',
  })
  push({
    kind: 'state',
    name: '上下文注入',
    level: config.injectContext === false ? 'warn' : 'ok',
    detail: config.injectContext === false ? '已关闭（injectContext=false）' : '已开启（每轮重建观测上下文）',
  })
  push({
    kind: 'state',
    name: '结果富化',
    level: config.annotateResults === false ? 'warn' : 'ok',
    detail: config.annotateResults === false ? '已关闭（annotateResults=false）' : '已开启（追加坐标映射行）',
  })

  // ── 5) 审计 ──────────────────────────────────────────────────────────────
  try {
    const stats = audit?.stats?.()
    if (!stats) {
      push({ kind: 'state', name: '审计', level: 'warn', detail: '审计未启用或不可读' })
    } else {
      push({
        kind: 'state',
        name: '审计',
        level: (stats.writeFailures ?? 0) > 0 ? 'warn' : 'ok',
        detail: `file=${config.auditFile || '关闭'} entries=${stats.entries} skipped=${stats.skipped ?? 0} 写失败=${stats.writeFailures ?? 0}`,
      })
    }
  } catch (error) {
    push({ kind: 'state', name: '审计', level: 'unknown', detail: `读取审计统计抛错：${error?.message ?? error}` })
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────────
  const worst = checks.reduce((acc, c) => Math.max(acc, LEVEL_RANK[c.level] ?? 0), 0)
  const hasCritical = checks.some((c) => c.level === 'critical')
  const hasUnknown = checks.some((c) => c.level === 'unknown')
  const hasWarn = checks.some((c) => c.level === 'warn')
  const verdict = hasCritical
    ? DOCTOR_VERDICT.BROKEN
    : hasUnknown
      ? DOCTOR_VERDICT.UNKNOWN
      : hasWarn
        ? DOCTOR_VERDICT.DEGRADED
        : DOCTOR_VERDICT.HEALTHY

  return {
    // 只有 healthy 才算 ok；degraded/unknown/broken 都要显式说明，避免虚假健康结论
    ok: verdict === DOCTOR_VERDICT.HEALTHY,
    verdict,
    worstLevel: worst,
    checks,
    config,
  }
}

/** 把自检结果渲染成人/模型可读的报告。 */
export function buildDoctorReport(result) {
  const { verdict, checks } = result
  const headline =
    verdict === DOCTOR_VERDICT.HEALTHY
      ? '结论：健康 —— 参数名与登记全等，运行态无异常'
      : verdict === DOCTOR_VERDICT.DEGRADED
        ? '结论：可用但有告警（见下方 warn 项）'
        : verdict === DOCTOR_VERDICT.UNKNOWN
          ? '结论：**无法确认健康** —— 有检查项查不到结果（见 unknown 项）'
          : '结论：**不健康** —— 有严重差异，命令级规则可能已静默失效'
  const lines = ['# dsh_Windows_MCP 自检', headline, '']
  const order = ['critical', 'unknown', 'warn', 'ok']
  const label = { critical: '严重', unknown: '未知', warn: '告警', ok: '正常' }
  for (const level of order) {
    const group = checks.filter((c) => c.level === level)
    if (group.length === 0) continue
    lines.push(`## ${label[level]}（${group.length}）`)
    for (const check of group) {
      const kind = check.kind === 'schema' ? 'schema' : '运行态'
      lines.push(`- [${kind}] ${check.name}：${check.detail}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** 当前 agent 的 winmcp 状态快照（人/模型都可读）。 */
export function buildStateReport({ config, store, killSwitch, audit, agentKey, now = Date.now() }) {  const observation = store.current(agentKey)
  const mapping = observation ? buildMapping(observation) : null
  const lines = []
  lines.push(`# dsh_Windows_MCP 状态`)
  lines.push(`serverName: ${config.serverName}`)
  lines.push(`急停: ${killSwitch.isEngaged() ? `已启用（${killSwitch.snapshot()?.reason ?? '无原因'}）` : '未启用'}`)
  lines.push(`观测数: ${store.size()} 个会话桶；本会话代次 generation=${store.generation(agentKey)}`)
  if (observation) {
    const age = observation.at ? Math.round((now - observation.at) / 1000) : null
    lines.push(`最新观测: ${observation.id}（${observation.tool}，${age ?? '?'}s 前）`)
    lines.push(`  → 做输入操作时可在参数里带上 based_on: "${observation.id}" 声明依据，闸门会校验该 id 是否真实存在。`)
    lines.push(`  光标: ${observation.cursor ? `(${observation.cursor.x}, ${observation.cursor.y})` : '未知'}`)
    lines.push(`  焦点窗口: ${observation.focusedWindow?.name ?? '未识别'}`)
    lines.push(`  上游图片: ${observation.originalSize ? `${observation.originalSize.width}x${observation.originalSize.height}` : '未知'}`)
    lines.push(`  附件尺寸: ${observation.image?.attachmentSize ? `${observation.image.attachmentSize.width}x${observation.image.attachmentSize.height}` : '无/未知'}`)
    lines.push(`  坐标映射: ${mapping?.ok ? describeMapping(mapping, { observationId: observation.id }) : `不可用（${mapping?.reason}）`}`)
    lines.push(`  可交互元素: ${observation.uiElements.length}`)
  } else {
    lines.push('最新观测: 无 —— 执行任何输入类操作前请先 Snapshot。')
    // 即便本会话还没有观测，也告诉模型全局最新是哪一个，
    // 免得它凭记忆编一个 id 出来（那种会被 UNKNOWN_OBSERVATION 拒绝）。
    const newest = store.newest?.()
    if (newest) {
      lines.push(`（注意：其他会话桶里有更新的一条观测 ${newest.observation.id}，但那属于别的 agent，不能作为你的依据。）`)
    }
  }
  const recent = store.history?.(agentKey, 5) ?? []
  if (recent.length > 1) {
    lines.push('最近观测: ' + recent.map((o) => `${o.id}(${o.tool})`).join(' → '))
  }
  const stats = audit?.stats?.()
  if (stats) {
    lines.push(`审计: file=${config.auditFile || '关闭'} entries=${stats.entries} bytes=${stats.bytes} 失败=${stats.writeFailures ?? 0}`)
  }
  return lines.join('\n')
}

function resolveAgentKey(exec) {
  return agentKeyOf(exec?.agent)
}

function buildTools({ config, store, killSwitch, policy, audit, now, toolSchemasProvider }) {
  /** 统一的结果壳。 */
  const okResult = (value) => ({ value, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })

  const doctorTool = {
    name: 'winmcp_doctor',
    description:
      '只读自检：把本插件对上游 Windows-MCP 的假设（工具参数名、坐标映射、策略与审计状态）' +
      '与实际注册情况逐项比对，并给出总体结论。' +
      '当你「点击似乎偏了」「规则好像没生效」或刚装好环境时，先跑它——' +
      '它能发现只有对着真实注册表才能发现的参数漂移问题。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput({ report: { type: 'string' } }),
    execute: async () => {
      // S-HOST-08：复用启动时的 config 快照，不引入独立配置。
      const result = diagnose({
        config,
        store,
        killSwitch,
        audit,
        agentKey: '__doctor__',
        toolSchemas: safeToolSchemas(toolSchemasProvider),
        now,
      })
      return okResult(buildDoctorReport(result))
    },
  }

  const stateTool = {
    name: 'winmcp_state',
    description:
      '读取 dsh_Windows_MCP 的当前状态：急停开关、最近一次桌面观测及其坐标映射、审计统计。' +
      '在做任何点击/输入之前或点击落空之后，用它确认「我依据的是哪一次观测、映射系数是多少」。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOutput({ state: { type: 'string' } }),
    execute: async (_args, exec) => {
      const report = buildStateReport({
        config,
        store,
        killSwitch,
        audit,
        agentKey: resolveAgentKey(exec),
        now: now(),
      })
      return okResult(report)
    },
  }

  const toScreenTool = {
    name: 'winmcp_to_screen',
    description:
      '把「图片像素」换算成「屏幕坐标」。当你要点击的位置是从截图/图片里目测得到的（而不是 UI 树里给出的 ' +
      '坐标）时，必须先用它换算，再交给 Click/Move 的 loc=。它会读取最近一次观测的映射系数，避免手算漏乘或重复乘。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '图片里的 x 像素' },
        y: { type: 'number', description: '图片里的 y 像素' },
        space: {
          type: 'string',
          enum: ['model', 'image'],
          description: 'model=你实际看到的那张图的像素（默认）；image=上游 Screenshot Original Size 空间的像素',
        },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    output: textOutput({ screen: { type: 'object' }, mapping: { type: 'string' } }),
    execute: async (args, exec) => {
      const agentKey = resolveAgentKey(exec)
      const observation = store.current(agentKey)
      if (!observation) {
        return { value: { ok: false, reason: '还没有任何桌面观测。先调用 mcp__' + config.serverName + '__Snapshot。' }, isError: false, content: [{ type: 'text', text: '还没有任何桌面观测，无法换算。请先 Snapshot。' }] }
      }
      const mapping = buildMapping(observation)
      if (!mapping.ok) {
        return { value: { ok: false, reason: mapping.reason }, content: [{ type: 'text', text: `无法换算：${mapping.reason}。请改用 UI 树给出的屏幕坐标。` }] }
      }
      const space = args?.space === 'image' ? 'image' : 'model'
      const point = space === 'image' ? imageToScreen(args.x, args.y, mapping) : modelToScreen(args.x, args.y, mapping)
      const back = space === 'image' ? undefined : screenToModel(point.x, point.y, mapping)
      const text =
        `${space === 'model' ? '图片像素' : '上游图片像素'} (${args.x}, ${args.y}) → 屏幕 (${point.x}, ${point.y})\n` +
        `${describeMapping(mapping, { observationId: observation.id })}\n` +
        `可直接用于 loc=[${point.x}, ${point.y}]` +
        (back ? `\n（反查确认：屏幕 (${point.x}, ${point.y}) → 图片 (${back.x}, ${back.y})）` : '')
      return okResult(text)
    },
  }

  const toImageTool = {
    name: 'winmcp_screen_to_image',
    description:
      '把「屏幕坐标」（UI 树里给出的那种坐标，或 Click 的 loc=）换算回图片像素，便于在截图上核对位置是否正确。',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '屏幕 x 坐标' },
        y: { type: 'number', description: '屏幕 y 坐标' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    output: textOutput({ image: { type: 'object' } }),
    execute: async (args, exec) => {
      const agentKey = resolveAgentKey(exec)
      const observation = store.current(agentKey)
      if (!observation) {
        return { value: { ok: false }, content: [{ type: 'text', text: '还没有任何桌面观测，无法换算。请先 Snapshot。' }] }
      }
      const mapping = buildMapping(observation)
      if (!mapping.ok) {
        return { value: { ok: false, reason: mapping.reason }, content: [{ type: 'text', text: `无法换算：${mapping.reason}` }] }
      }
      const image = screenToImage(args.x, args.y, mapping)
      const text = `屏幕 (${args.x}, ${args.y}) → 图片像素 (${image.x}, ${image.y})\n${describeMapping(mapping, { observationId: observation.id })}`
      return okResult(text)
    },
  }

  const killTool = {
    name: 'winmcp_kill',
    description:
      '急停开关：action=engage 立即阻止所有会改动桌面/系统的 winmcp 工具调用（只读观测工具仍可用）；' +
      'action=release 解除；action=status 查看当前状态。用于「AI 正在乱点，先停下来」的场景。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['engage', 'release', 'status'], description: '要执行的动作' },
        reason: { type: 'string', description: 'engag 时记录的原因' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput({ engaged: { type: 'boolean' } }),
    execute: async (args) => {
      const action = args?.action
      if (action === 'engage') {
        killSwitch.engage(args?.reason ?? '模型主动急停')
      } else if (action === 'release') {
        killSwitch.release()
      }
      const snapshot = killSwitch.snapshot()
      const text = `急停状态：${killSwitch.isEngaged() ? '已启用' : '未启用'}\n${JSON.stringify(snapshot, null, 2)}`
      return okResult(text)
    },
  }

  const auditTool = {
    name: 'winmcp_audit',
    description:
      '读取最近的 Windows-MCP 动作审计记录（append-only JSONL，已脱敏）。' +
      '当你不确定刚才到底点了什么、或者要复盘一系列操作时用它。' +
      'view=summary 给出人可读的统计与最近条目（被拦了什么、为什么）；' +
      'view=raw（默认）返回原始 JSON 条目。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `返回条数，默认 ${DEFAULT_AUDIT_LIMIT}` },
        view: {
          type: 'string',
          enum: ['raw', 'summary'],
          description: 'raw=原始 JSON（默认）；summary=人可读的统计与最近条目',
        },
      },
      additionalProperties: false,
    },
    output: textOutput({ entries: { type: 'array' } }),
    execute: async (args) => {
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(500, args.limit)) : DEFAULT_AUDIT_LIMIT
      const entries = audit.read({ limit })
      if (entries.length === 0) {
        return okResult(`暂无审计记录（file=${config.auditFile || '已关闭'}）`)
      }
      // view=summary 与 scripts/audit-report.mjs 共用同一批纯函数（S-VIEW-06）。
      // `recent` 也取同一个默认值，避免"工具里看到 30 条、脚本里看到 10 条"
      // 这种同源不同果的情况（对抗性验证 V13）。
      return okResult(
        args?.view === 'summary'
          ? renderReport(entries, { recent: limit })
          : JSON.stringify(entries, null, 2),
      )
    },
  }

  return [doctorTool, stateTool, toScreenTool, toImageTool, killTool, auditTool]
}

/**
 * 安全地取工具 schema 列表（S-HOST-07 失败关闭：取不到返回 null 而不是空数组，
 * 因为"注册表里什么都没有"与"读不到注册表"是两件不同的事，混同会给出假结论）。
 */
function safeToolSchemas(provider) {
  try {
    if (typeof provider !== 'function') return null
    const schemas = provider()
    return Array.isArray(schemas) ? schemas : null
  } catch {
    return null
  }
}

export { buildObservation, buildMapping, imageToScreen, screenToImage, screenPerImagePx, describeMapping }
