/**
 * policy.js — Windows-MCP 调用决策策略
 *
 * 纯逻辑 + 注入副作用：killSwitch（急停）、audit（审计）、ask（审批通道探针）、now（时钟）。
 * `evaluate(request)` 同步返回决策对象，不发起交互、不阻塞：
 *   { kind: 'allow' } | { kind: 'deny', code, reason } | { kind: 'ask', code, reason }
 *
 * 规则按优先级顺序（先命中先返回，code 稳定可编程判断）：
 *   0 COMMAND_RULE      命中命令级危险规则（Batch 3），或 CMD_UNEVALUABLE
 *   1 KILL_SWITCH       急停开启 → 除 observe 外全部拒绝
 *   2 TOOL_DENIED       工具在 denyTools 中
 *   3 TOOL_NOT_ALLOWED  allowTools 非空且不含该工具
 *   4 NO_OBSERVATION    input 类缺少观察记录且 requireObservation
 *   5 STALE_OBSERVATION input 类观察过旧，或存在更新的截图 generation
 *   6 PROCESS_CHANGED   input 类观察到的前台进程与当前截图不一致
 *   7 APPROVAL_REQUIRED system（或 requireApprovalForInput 的 input）需要审批：
 *                       有审批通道 → ask；审批已 grant → allow；无审批通道 → APPROVAL_UNAVAILABLE（fail closed）
 *   8 默认 allow
 *
 * 注意：`ask` 只作为「审批通道是否可用」的探针，策略本身不会调用它；
 * 交互与超时由上层（index.js / gate.js）负责，这样 evaluate 保持可测试的同步纯函数。
 */

import { evaluateCommand } from './commands.js'

/** 动作分类。 */
export const ACTION_CLASS = Object.freeze({
  OBSERVE: 'observe',
  INPUT: 'input',
  SYSTEM: 'system',
  UNKNOWN: 'unknown',
})

/** 稳定的机器可读决策码。 */
export const DECISION_CODES = Object.freeze({
  KILL_SWITCH: 'KILL_SWITCH',
  TOOL_DENIED: 'TOOL_DENIED',
  TOOL_NOT_ALLOWED: 'TOOL_NOT_ALLOWED',
  NO_OBSERVATION: 'NO_OBSERVATION',
  STALE_OBSERVATION: 'STALE_OBSERVATION',
  PROCESS_CHANGED: 'PROCESS_CHANGED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_UNAVAILABLE: 'APPROVAL_UNAVAILABLE',
  /** Batch 3：命中内置危险操作规则。 */
  COMMAND_RULE: 'COMMAND_RULE',
  /** Batch 3：类目需要命令文本却取不到，判定不了（失败关闭）。 */
  CMD_UNEVALUABLE: 'CMD_UNEVALUABLE',
})

/** 默认配置；`evaluate` 会用 createPolicy 的 config 与 request.config 逐层覆盖。 */
export const DEFAULT_POLICY_CONFIG = Object.freeze({
  denyTools: [],
  allowTools: [],
  requireObservation: true,
  maxObservationAgeMs: 15000,
  requireApproval: true,
  requireApprovalForInput: false,
  /** Batch 3：命令级策略开关。 */
  commandRulesEnabled: true,
  approvalTtlMs: 60000,
})

const OBSERVE_TOOLS = new Set([
  'displayinventory',
  'snapshot',
  'screenshot',
  'waitfor',
  'wait',
])

const INPUT_TOOLS = new Set([
  'click',
  'type',
  'scroll',
  'move',
  'shortcut',
  'multiselect',
  'multiedit',
])

const SYSTEM_TOOLS = new Set([
  'app',
  'powershell',
  'filesystem',
  'registry',
  'process',
  'clipboard',
  'notification',
])

/** 去掉 `mcp__<server>__` 前缀；不带前缀时原样返回。 */
export function stripToolPrefix(toolName) {
  let name = typeof toolName === 'string' ? toolName.trim() : ''
  if (name.toLowerCase().startsWith('mcp__')) {
    const rest = name.slice(5)
    const index = rest.indexOf('__')
    if (index !== -1) name = rest.slice(index + 2)
  }
  return name
}

/** 用于配置比对/审批键的归一化工具名（小写、去前缀）。 */
export function normalizeToolName(toolName) {
  return stripToolPrefix(toolName).toLowerCase()
}

/** 工具名 → 动作分类。前缀形式与裸名都接受。 */
export function classifyAction(toolName) {
  const key = normalizeToolName(toolName)
  if (key === '') return ACTION_CLASS.UNKNOWN
  if (OBSERVE_TOOLS.has(key)) return ACTION_CLASS.OBSERVE
  if (INPUT_TOOLS.has(key)) return ACTION_CLASS.INPUT
  if (SYSTEM_TOOLS.has(key)) return ACTION_CLASS.SYSTEM
  return ACTION_CLASS.UNKNOWN
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function firstNumber(...values) {
  for (const value of values) {
    const num = numberOrNull(value)
    if (num !== null) return num
  }
  return null
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 比较前后两次记录的进程；无差异或信息不全时返回 null。 */
export function diffProcessBeforeAfter(before, after) {
  if (!isRecord(before) || !isRecord(after)) return null
  const pidBefore = numberOrNull(before.pid)
  const pidAfter = numberOrNull(after.pid)
  if (pidBefore !== null && pidAfter !== null && pidBefore !== pidAfter) {
    return `pid ${pidBefore} → ${pidAfter}`
  }
  const exeBefore = stringOrNull(before.executable)
  const exeAfter = stringOrNull(after.executable)
  if (exeBefore && exeAfter && exeBefore.toLowerCase() !== exeAfter.toLowerCase()) {
    return `executable ${exeBefore} → ${exeAfter}`
  }
  const titleBefore = stringOrNull(before.title)
  const titleAfter = stringOrNull(after.title)
  if (titleBefore && titleAfter && titleBefore !== titleAfter) {
    return `title "${titleBefore}" → "${titleAfter}"`
  }
  return null
}

/**
 * 极简急停开关（内存态，不做文件写入；持久化由上层负责）。
 *
 * ## 两个计数必须分开（对抗性验证发现的规格自相矛盾）
 * - `engageCount` —— **累计 engage 调用次数**（含重复）。用途：诊断"谁在反复尝试停手"，
 *   例如某个组件在循环里疯狂喊停，看这个数就知道。
 * - `engageSeq`   —— **成功启用序号**（重复 engage 不递增）。用途：判断"这是第几次真正停手"。
 *
 * 早期实现只有一个 `engageCount` 且重复 engage 不递增，于是"累计尝试"这个用途无法满足；
 * 而把两者混为一个字段又会让"成功启用序号"不可得——所以拆成两个。
 *
 * `engage()` 对状态**幂等**：重复开启不刷新 `engagedAt`、不覆盖首次 `reason`
 * （第一次的原因才是"为什么喊停"的答案），但会累加 `engageCount`。
 * `release()` 后再 `engage()` 视为新的一次启用：序号 +1、时间与原因刷新、
 * `releasedAt` 重置为 null。
 */
export function createKillSwitch({ state = null, clock = Date.now } = {}) {
  let engaged = state?.engaged === true
  let reason = state?.reason ?? null
  let engagedAt = numberOrNull(state?.engagedAt)
  let releasedAt = numberOrNull(state?.releasedAt)
  let engageCount = numberOrNull(state?.engageCount) ?? (engaged ? 1 : 0)
  let engageSeq = numberOrNull(state?.engageSeq) ?? (engaged ? 1 : 0)

  const nowMs = () => {
    try {
      const value = clock()
      return numberOrNull(value) ?? Date.now()
    } catch {
      return Date.now()
    }
  }

  function snapshot() {
    return { engaged, reason, engagedAt, releasedAt, engageCount, engageSeq }
  }

  function engage(nextReason = null) {
    // 累计尝试次数**无论是否已在启用状态**都递增
    engageCount += 1
    if (engaged) return snapshot()
    engaged = true
    engageSeq += 1
    reason = nextReason === null || nextReason === undefined ? null : String(nextReason)
    engagedAt = nowMs()
    // 再次启用时必须清掉上一次的释放时刻，否则状态会自相矛盾
    releasedAt = null
    return snapshot()
  }

  function release() {
    if (!engaged) return snapshot()
    engaged = false
    releasedAt = nowMs()
    return snapshot()
  }

  function isEngaged() {
    return engaged
  }

  return { engage, release, isEngaged, snapshot }
}

/**
 * 创建策略。
 *
 * @param {object} options
 * @param {object} [options.config]
 * @param {{ isEngaged?: () => boolean, snapshot?: () => object }} [options.killSwitch]
 * @param {{ record?: (entry: object) => unknown }} [options.audit]
 * @param {Function} [options.ask] 审批通道探针：不存在时审批类请求一律 fail closed
 * @param {() => number} [options.now]
 */
export function createPolicy({
  config = {},
  killSwitch = null,
  audit = null,
  ask,
  now = Date.now,
} = {}) {
  const granted = new Map()
  const hasAsker = typeof ask === 'function'

  const nowMs = () => {
    try {
      const value = now()
      return numberOrNull(value) ?? Date.now()
    } catch {
      return Date.now()
    }
  }

  function effective(requestConfig) {
    const merged = { ...DEFAULT_POLICY_CONFIG, ...(isRecord(config) ? config : {}) }
    if (isRecord(requestConfig)) Object.assign(merged, requestConfig)
    return merged
  }

  function emitAudit(decision, context, request) {
    if (!audit || typeof audit.record !== 'function') return
    try {
      audit.record({
        action: 'policy.evaluate',
        tool: context.tool,
        actionClass: context.actionClass,
        at: context.at,
        decision: decision.kind,
        allowed: decision.kind === 'allow',
        code: decision.code ?? null,
        reason: decision.reason ?? null,
        // S-CMD-07：豁免不改变决定，但必须让"哪条规则被放过了"可复盘。
        // 这个字段曾经只被赋值、从未被读取（对抗性验证 V3 的死赋值），
        // 于是规格承诺的"可复盘"完全不可复盘。
        ruleExempted: context.ruleExempted ?? null,
        observationId:
          request.observation?.observationId ?? request.observation?.id ?? null,
        sessionId: request.sessionId ?? null,
      })
    } catch {
      /* 审计永远不能影响决策 */
    }
  }

  /** 取出并消耗一个仍然有效的审批（一次性/限次 + 过期）。 */
  function takeApproval(key, at) {
    const approval = granted.get(key)
    if (!approval) return null
    // S-SAFE-04 / A-11：授权在 `now - grantedAt > approvalTtlMs` 时失效，
    // **恰好等于上限时仍然有效**。这里曾经用 `>=`，比规格早失效 1ms；
    // 而同一文件的观测年龄判定用的是正确的一侧（`>`），两处互相矛盾。
    if (approval.expiresAt !== null && at > approval.expiresAt) {
      granted.delete(key)
      return null
    }
    if (approval.remaining <= 0) {
      granted.delete(key)
      return null
    }
    approval.remaining -= 1
    approval.lastUsedAt = at
    if (approval.remaining <= 0) granted.delete(key)
    return { ...approval }
  }

  /**
   * 记录一次审批授权。默认一次性、按 config.approvalTtlMs 过期。
   * `ttlMs: Infinity` 表示不过期；`uses` 可放行多次。
   */
  function grant(tool, options = {}) {
    const key = normalizeToolName(tool)
    const cfg = effective(null)
    const ttl = Number.isFinite(options.ttlMs)
      ? options.ttlMs
      : Number.isFinite(cfg.approvalTtlMs)
        ? cfg.approvalTtlMs
        : DEFAULT_POLICY_CONFIG.approvalTtlMs
    const uses =
      Number.isFinite(options.uses) && options.uses > 0 ? Math.floor(options.uses) : 1
    const at = nowMs()
    const approval = {
      tool: key,
      requested: typeof tool === 'string' ? tool : null,
      at,
      expiresAt: ttl === Infinity ? null : at + Math.max(0, ttl),
      uses,
      remaining: uses,
      lastUsedAt: null,
    }
    granted.set(key, approval)
    if (audit && typeof audit.record === 'function') {
      try {
        audit.record({
          action: 'policy.grant',
          tool: key,
          at,
          decision: 'grant',
          allowed: true,
          reason: null,
        })
      } catch {
        /* ignore */
      }
    }
    return { ...approval }
  }

  function revoke(tool) {
    return granted.delete(normalizeToolName(tool))
  }

  function listApprovals() {
    return [...granted.values()].map((item) => ({ ...item }))
  }

  function evaluate(request = {}) {
    const req = isRecord(request) ? request : {}
    const cfg = effective(req.config)
    const rawTool = typeof req.tool === 'string' ? req.tool : ''
    const displayTool = rawTool === '' ? '(unknown)' : rawTool
    const key = normalizeToolName(rawTool)
    const declared = typeof req.action === 'string' ? req.action.toLowerCase() : ''
    const actionClass = Object.values(ACTION_CLASS).includes(declared)
      ? declared
      : classifyAction(rawTool)
    const at = nowMs()
    const context = { tool: rawTool, actionClass, at }
    const decide = (decision) => {
      emitAudit(decision, context, req)
      return decision
    }

    const observation = isRecord(req.observation) ? req.observation : null
    const screen = isRecord(req.screenObservation) ? req.screenObservation : null

    // 0. 命令级策略（Batch 3）：按**内容**判定危险操作，优先级最高。
    //
    // 为什么排在审批之前（S-CMD-09）：审批是"让人决定"，而这类操作是
    // "默认不该做"。让人批准一次 `Remove-Item -Recurse C:\` 本身就是设计缺陷。
    if (cfg.commandRulesEnabled !== false && key !== '') {
      // 用**去前缀**的工具名，这样 commands.js 的类目表（PowerShell/Registry/…）
      // 不会耦合到 `mcp__<server>__` 这个前缀写法。
      const command = evaluateCommand({ tool: stripToolPrefix(rawTool), args: req.args, config: cfg })
      if (command.kind === 'deny') {
        return decide({
          kind: 'deny',
          code: command.code === 'CMD_UNEVALUABLE' ? DECISION_CODES.CMD_UNEVALUABLE : DECISION_CODES.COMMAND_RULE,
          ruleId: command.ruleId ?? null,
          ruleIds: command.ruleIds ?? [],
          reason: command.reason,
        })
      }
      if (command.kind === 'exempt') {
        // 豁免不改变决定，但必须让审计看到"哪条规则被放过了"（S-CMD-07）。
        //
        // 这里同时挂到两处：`context`（供本模块自己的 emitAudit）与最终决策对象
        // （供上层用**自己的**审计实例记录）。上层 index.js 有意让 policy 不直接写审计
        // （避免每个动作两条重复日志），所以决策对象必须把这条信息带出去，
        // 否则规格承诺的"可复盘"就只是本模块内部的死赋值——对抗性验证 V3。
        context.ruleExempted = command.ruleId
      }
    }

    // 1. 急停：除 observe 外一律拒绝（优先级高于白名单）。
    if (killSwitch && typeof killSwitch.isEngaged === 'function' && killSwitch.isEngaged()) {
      if (actionClass !== ACTION_CLASS.OBSERVE) {
        const snap = typeof killSwitch.snapshot === 'function' ? killSwitch.snapshot() : null
        const why = snap && snap.reason ? `（原因：${snap.reason}）` : ''
        return decide({
          kind: 'deny',
          code: DECISION_CODES.KILL_SWITCH,
          reason: `全局急停已开启${why}，除只读观察类工具外全部拒绝；请先释放急停再重试 ${displayTool}。`,
        })
      }
    }

    // 2. 禁止清单（优先于白名单）。
    const denyTools = Array.isArray(cfg.denyTools) ? cfg.denyTools.map(normalizeToolName) : []
    if (denyTools.includes(key) && key !== '') {
      return decide({
        kind: 'deny',
        code: DECISION_CODES.TOOL_DENIED,
        reason: `工具 ${displayTool} 在禁止清单（denyTools）中，已拒绝。`,
      })
    }

    // 3. 白名单非空时，其它工具一律拒绝。
    const allowTools = Array.isArray(cfg.allowTools)
      ? cfg.allowTools.map(normalizeToolName).filter((item) => item !== '')
      : []
    if (allowTools.length > 0 && !allowTools.includes(key)) {
      return decide({
        kind: 'deny',
        code: DECISION_CODES.TOOL_NOT_ALLOWED,
        reason: `白名单（allowTools）已启用且不包含 ${displayTool}，已拒绝；可用工具：${allowTools.join(', ')}。`,
      })
    }

    const isInput = actionClass === ACTION_CLASS.INPUT

    // 4. input 类必须先有观察记录。
    if (isInput && cfg.requireObservation !== false && !observation) {
      return decide({
        kind: 'deny',
        code: DECISION_CODES.NO_OBSERVATION,
        reason: `输入类操作 ${displayTool} 缺少屏幕观察记录：请先调用 Snapshot 获取当前屏幕状态，再重试该操作。`,
      })
    }

    if (isInput && observation) {
      // 5a. 观察年龄。
      const observedAt = firstNumber(
        observation.at,
        observation.recordedAt,
        observation.observedAt,
        observation.timestamp,
      )
      const maxAge = numberOrNull(cfg.maxObservationAgeMs) ?? DEFAULT_POLICY_CONFIG.maxObservationAgeMs
      if (observedAt !== null && at - observedAt > maxAge) {
        return decide({
          kind: 'deny',
          code: DECISION_CODES.STALE_OBSERVATION,
          reason: `屏幕观察已过期（${Math.round(at - observedAt)}ms > ${maxAge}ms）：请重新 Snapshot 后再执行 ${displayTool}。`,
        })
      }

      // 5b. 已有更新的截图 generation。
      const observedGeneration = numberOrNull(observation.generation)
      const screenGeneration = numberOrNull(screen?.generation)
      if (
        observedGeneration !== null &&
        screenGeneration !== null &&
        observedGeneration < screenGeneration
      ) {
        return decide({
          kind: 'deny',
          code: DECISION_CODES.STALE_OBSERVATION,
          reason: `存在比所依赖观察更新的屏幕截图（generation ${screenGeneration} > ${observedGeneration}）：请基于最新 Snapshot 重新决策后再执行 ${displayTool}。`,
        })
      }

      // 6. 前台进程变化。
      const change = diffProcessBeforeAfter(observation.process, screen?.process)
      if (change) {
        return decide({
          kind: 'deny',
          code: DECISION_CODES.PROCESS_CHANGED,
          reason: `前台进程已变化（${change}），观察与当前屏幕不一致：请重新 Snapshot 后再执行 ${displayTool}。`,
        })
      }
    }

    // 7. 审批。
    //
    // 语义边界（对抗性验证逼出来的）：两个开关**各自独立**生效。
    // - `requireApproval === true`        → 系统级动作需要审批
    // - `requireApprovalForInput === true`→ 输入类动作需要审批（不依赖前者）
    //
    // 早期实现写成 `needsApproval && cfg.requireApproval !== false`，于是只设
    // `requireApprovalForInput: true`（而 requireApproval 保持默认 false）时，
    // 整个审批分支被跳过 → 该配置**静默失效**：用户以为输入动作被审批拦着，实际一路放行。
    const systemNeedsApproval = actionClass === ACTION_CLASS.SYSTEM && cfg.requireApproval === true
    const inputNeedsApproval = isInput && cfg.requireApprovalForInput === true
    if (systemNeedsApproval || inputNeedsApproval) {
      const approval = takeApproval(key, at)
      if (!approval) {
        const scope =
          actionClass === ACTION_CLASS.SYSTEM ? '系统级' : '需审批的输入类'
        const base = `工具 ${displayTool} 属于${scope}操作，需要人工批准后重试。`
        if (!hasAsker) {
          return decide({
            kind: 'deny',
            code: DECISION_CODES.APPROVAL_UNAVAILABLE,
            reason: `${base}但当前没有可用的审批通道，已按失败关闭（fail closed）。`,
          })
        }
        return decide({
          kind: 'ask',
          code: DECISION_CODES.APPROVAL_REQUIRED,
          reason: base,
          tool: rawTool,
        })
      }
    }

    // 8. 默认放行。
    // S-CMD-07：把豁免事实带出到决策对象，供上层审计记录（见上面 exempt 分支的说明）。
    return decide({
      kind: 'allow',
      ...(context.ruleExempted ? { ruleExempted: context.ruleExempted } : {}),
    })
  }

  return { evaluate, grant, revoke, listApprovals }
}

/** 把决策转成一句中文说明，供模型/用户直接阅读。 */
export function describeDecision(decision) {
  if (!decision || typeof decision !== 'object') return '没有可用的决策结果。'
  const reason =
    typeof decision.reason === 'string' && decision.reason !== '' ? decision.reason : null
  if (decision.kind === 'allow') return '允许执行该 Windows-MCP 调用。'
  if (decision.kind === 'deny') {
    return `拒绝执行该调用（${decision.code ?? 'UNKNOWN'}）：${reason ?? '策略未给出原因。'}`
  }
  if (decision.kind === 'ask') {
    return `需要人工确认（${decision.code ?? DECISION_CODES.APPROVAL_REQUIRED}）：${reason ?? '请先获得用户批准。'}`
  }
  return `未知的决策类型 ${String(decision.kind)}。`
}
