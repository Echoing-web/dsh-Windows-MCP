/**
 * gate.js — 观测存储 + 新鲜度判定。
 *
 * 解决的问题：模型看到一次 Snapshot 之后，可能过很久才去 Click；这中间用户可能
 * 切换了窗口、程序可能被关掉、或者又做了一次新的截图。此时按旧观测去点，就是
 * 「静默点到别的程序上」——最危险的一类错误。
 *
 * 本模块只负责**记账与判定**，不负责最终放行/拒绝：放行策略在 policy.js，
 * 装配在 index.js。
 *
 * @module dsh_Windows_MCP/gate
 */

import { emptyObservation, isCoordinateComplete, stripToolPrefix } from './observe.js'
import { buildMapping } from './coords.js'

/** 判定「这条工具会改动桌面」，因此必须绑定一次新鲜观测。 */
export const INPUT_TOOLS = Object.freeze([
  'click',
  'type',
  'scroll',
  'move',
  'shortcut',
  'multiselect',
  'multiedit',
])

/** 读取类工具：只观测、不要求前置观测。 */
export const OBSERVE_ONLY_TOOLS = Object.freeze([
  'displayinventory',
  'snapshot',
  'screenshot',
  'wait',
  'waitfor',
])

/** 高影响工具：默认需要审批（策略可关）。 */
export const SYSTEM_TOOLS = Object.freeze([
  'app',
  'powershell',
  'filesystem',
  'registry',
  'process',
  'clipboard',
  'notification',
])

/** 动作分类。 */
export const ACTION = Object.freeze({
  OBSERVE: 'observe',
  INPUT: 'input',
  SYSTEM: 'system',
  UNKNOWN: 'unknown',
})

/**
 * 按工具名分类动作。接受三种写法（大小写不敏感）：
 *   - 带本 server 前缀：`mcp__winmcp__Click`
 *   - 裸名：`Click`
 *   - 带**别的** server 前缀：`mcp__other__Click`
 *
 * 第三种刻意也识别：`Click` 无论挂在哪个 server 下都是会改动桌面的动作，
 * 分类应当「失败关闭」而不是因为它不归我管就降级成 unknown。
 * 真正决定要不要拦的是调用方的 `ownsTool()` 判断，分类本身不能成为绕过点。
 */
export function classifyAction(toolName, serverName = 'winmcp') {
  if (typeof toolName !== 'string') return ACTION.UNKNOWN
  let raw = toolName.toLowerCase()
  const own = `mcp__${String(serverName).toLowerCase()}__`
  if (raw.startsWith(own)) {
    raw = raw.slice(own.length)
  } else {
    // 取最后一段 `__` 之后的部分作为工具名
    const sep = raw.lastIndexOf('__')
    if (sep !== -1) raw = raw.slice(sep + 2)
  }
  if (OBSERVE_ONLY_TOOLS.includes(raw)) return ACTION.OBSERVE
  if (INPUT_TOOLS.includes(raw)) return ACTION.INPUT
  if (SYSTEM_TOOLS.includes(raw)) return ACTION.SYSTEM
  return ACTION.UNKNOWN
}

/** 该动作是否会改动桌面/系统状态。 */
export function isMutating(toolName, serverName = 'winmcp') {
  const action = classifyAction(toolName, serverName)
  return action === ACTION.INPUT || action === ACTION.SYSTEM
}

/** 窗口签名里参与比较的字段；任一变化都视为「目标已漂移」。 */
const PROCESS_FIELDS = Object.freeze(['pid', 'executable', 'title', 'handle'])

/**
 * 比较两个进程/窗口事实。
 * @returns {{changed: boolean, fields: string[], before: object|null, after: object|null}}
 */
export function diffProcess(before, after) {
  if (!before || !after) return { changed: false, fields: [], before: before ?? null, after: after ?? null }
  const fields = []
  for (const field of PROCESS_FIELDS) {
    const a = before[field] ?? null
    const b = after[field] ?? null
    if (a !== b && !(a === null && b === null)) fields.push(field)
  }
  return { changed: fields.length > 0, fields, before, after }
}

/**
 * 从工具参数里取出「这次动作用的是哪一次观测」。
 *
 * 为什么需要它：闸门能判断「有没有观测、观测新不新」，但判断不了
 * 「模型说的那一次观测是不是真的存在」。模型完全可能凭空写出 `based_on: obs-99`
 * 然后在错误的坐标上点击——它自己以为有依据。把 id 校验一遍，这类幻觉就会
 * 当场变成一条明确的拒绝，而不是一次点偏。
 *
 * 接受三种写法，都是模型自然会说出口的形式：`based_on` / `basedOn` / `observation_id`。
 *
 * ## 返回值的三态（重要）
 * - `null`   —— 参数里**没有**这个字段（合法：不带依据声明）
 * - `string` —— 合法 id
 * - `undefined` —— 字段**存在但值非法**（数字、数组、对象、布尔…）
 *
 * 为什么必须区分 null 与 undefined：对抗性验证发现，把非法值当成"没声明"，
 * 会让 `based_on: 99` 这类输入静默通过——模型以为声明了依据，闸门却当它没说。
 * 非法值必须显式拒绝。
 */
export function extractBasedOn(args) {
  if (!args || typeof args !== 'object') return null
  for (const key of ['based_on', 'basedOn', 'observation_id', 'observationId']) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue
    const value = args[key]
    if (value === null || value === undefined) return null
    if (typeof value === 'string') {
      const trimmed = value.trim()
      return trimmed === '' ? undefined : trimmed
    }
    // 字段存在但类型不对 → 标记非法
    return undefined
  }
  return null
}

/**
 * 观测存储：按 agent 隔离，带代次与历史。
 * @returns 见下方方法
 */
export function createObservationStore() {
  /** @type {Map<string, {current: object|null, previous: object|null, generation: number, history: object[]}>} */
  const byAgent = new Map()
  /**
   * 全局单调递增的观测序号。
   *
   * 为什么必须是全局而不是每 agent 各从 1 开始：观测 id 会被写进审计日志，
   * 也会被模型写进 `based_on`。如果两个会话桶各自从 obs-1 开始，
   * 日志里就会出现两个不同的 obs-1，事后复盘根本分不清是哪一次。
   * 全局序号让 id 在整个进程内唯一，同时 `generation` 依然按 agent 单调。
   */
  let sequence = 0

  function bucket(agentKey) {
    let entry = byAgent.get(agentKey)
    if (!entry) {
      entry = { current: null, previous: null, generation: 0, history: [] }
      byAgent.set(agentKey, entry)
    }
    return entry
  }

  return {
    /**
     * 记录一次观测。
     * @param {string} agentKey
     * @param {object} observation buildObservation() 的产物
     * @returns {object} 补好 id/generation/mapping 的观测
     */
    record(agentKey, observation) {
      const entry = bucket(agentKey)
      const generation = entry.generation + 1
      sequence += 1
      const id = `obs-${sequence}`
      const stored = { ...observation, id, generation }
      entry.previous = entry.current
      entry.current = stored
      entry.generation = generation
      entry.history.push(stored)
      if (entry.history.length > 20) entry.history.splice(0, entry.history.length - 20)
      return stored
    },

    /** 最近一次观测（可能是 null）。 */
    current(agentKey) {
      return bucket(agentKey).current
    },

    /** 上一条观测。 */
    previous(agentKey) {
      return bucket(agentKey).previous
    },

    /** 当前代次。 */
    generation(agentKey) {
      return bucket(agentKey).generation
    },

    /** 最近 N 条观测（limit<=0 返回空数组，而不是"全部"）。 */
    history(agentKey, limit = 5) {
      const entry = bucket(agentKey)
      if (!Number.isFinite(limit) || limit <= 0) return []
      return entry.history.slice(-limit)
    },

    /**
     * 按 id 精确查一条观测。找不到返回 null。
     * 用来验证模型 `based_on` 里写的 id 是否真的存在。
     */
    byId(agentKey, id) {
      if (typeof id !== 'string' || id === '') return null
      return bucket(agentKey).history.find((observation) => observation.id === id) ?? null
    },

    /**
     * 所有会话桶里最新的一条观测（含其 agentKey）。
     * 用途：`winmcp_state` 需要告诉模型「最新观测叫什么 id」，
     * 否则模型无法在自己的动作里正确地引用它。
     */
    newest() {
      let best = null
      for (const [agentKey, entry] of byAgent) {
        if (!entry.current) continue
        if (best === null || (entry.current.at ?? 0) >= (best.observation.at ?? 0)) {
          best = { agentKey, observation: entry.current }
        }
      }
      return best
    },

    /** 清空（用于 kill switch 之后要求重新观测）。 */
    clear(agentKey) {
      byAgent.delete(agentKey)
    },

    /** 已跟踪的 agent 数（诊断用）。 */
    size() {
      return byAgent.size
    },
  }
}

/**
 * 构造一次「动作前置校验」所需的上下文。
 *
 * @param {object} input
 * @param {string} input.agentKey
 * @param {string} input.tool
 * @param {object} input.store createObservationStore()
 * @param {number} [input.now]
 * @param {object} input.config 归一化后的插件配置
 * @param {object|null} [input.screenObservation] 当前实时观测（可选，用于进程漂移复核）
 * @returns {object} 供 policy.evaluate() 使用的请求对象
 */
export function buildGateRequest({
  agentKey,
  tool,
  store,
  now = Date.now(),
  config,
  screenObservation = null,
  args = undefined,
  currentProcess = null,
}) {
  const observation = store.current(agentKey)
  const ageMs = observation?.at ? now - observation.at : null
  const generation = store.generation(agentKey)

  const basedOn = extractBasedOn(args)
  const referenced = basedOn === null ? null : store.byId(agentKey, basedOn)

  // 「依据的那一次观测是否已被更新的一次取代」。
  // 只在模型显式声明 based_on 时才有意义：它指的必须是**当前最新**的观测，
  // 否则说明模型拿的是一张已经被刷新过的旧截图。
  const newerObservationExists =
    referenced !== null && observation !== null && referenced.id !== observation.id

  // 用于漂移复核的「当前」进程事实。默认回落到所依赖观测自身
  // （此时必然相等、不会误报），调用方可以传入实时采集的值来做真实比对。
  const effectiveScreenObservation = screenObservation ?? (currentProcess ? { process: currentProcess } : null)

  return {
    tool,
    action: classifyAction(tool, config?.serverName ?? 'winmcp'),
    observation,
    referencedObservation: referenced,
    observationAgeMs: ageMs,
    storeGeneration: generation,
    screenObservation: effectiveScreenObservation,
    newerObservationExists,
    basedOn,
    args,
    config,
    agentKey,
  }
}

/**
 * 纯函数式的新鲜度判定：返回问题列表（空数组即新鲜）。
 * policy.js 会把它转成最终决定；这里保持可测、无副作用。
 *
 * @param {object} request buildGateRequest() 的产物
 * @param {object} config
 * @returns {Array<{code: string, message: string}>}
 */
export function assessFreshness(request, config = {}) {
  const problems = []
  const action = request?.action ?? ACTION.UNKNOWN
  const observation = request?.observation ?? null

  if (action !== ACTION.INPUT) return problems

  if (!observation) {
    problems.push({
      code: 'NO_OBSERVATION',
      message: '这次输入操作前没有任何桌面观测记录。先调用 Snapshot（建议 use_vision=true）看清当前状态，再执行点击/输入。',
    })
    return problems
  }

  // 模型显式声明的依据必须真实存在。这是唯一能拦住「凭空引用一个观测 id」的检查。
  if (request.basedOn === undefined) {
    // 字段存在但值非法（数字/数组/空串…）。不得当成"没声明"，那会静默放行。
    problems.push({
      code: 'UNKNOWN_OBSERVATION',
      message:
        'based_on 的值必须是观测编号字符串（例如 "obs-3"），你给的类型不合法。' +
        '不带依据声明时请完全省略该参数，而不是传数字或数组。',
    })
  } else if (request.basedOn !== null) {
    if (request.referencedObservation === null) {
      problems.push({
        code: 'UNKNOWN_OBSERVATION',
        message:
          `你声明本次操作基于观测 "${request.basedOn}"，但本会话不存在这个观测。` +
          `最新可用的观测是 ${observation.id}。请重新 Snapshot 并用返回的 based_on 值，不要凭记忆写 id。`,
      })
    }
  }

  const maxAge = config.maxObservationAgeMs ?? 60000
  if (typeof request.observationAgeMs === 'number' && request.observationAgeMs > maxAge) {
    problems.push({
      code: 'STALE_OBSERVATION',
      message: `所依赖的观测（${observation.id}）已过期 ${Math.round(request.observationAgeMs / 1000)}s（上限 ${Math.round(maxAge / 1000)}s）。请重新 Snapshot 后再操作。`,
    })
  }

  if (request.newerObservationExists) {
    problems.push({
      code: 'STALE_OBSERVATION',
      message: `你依据的观测（${request.basedOn}）已经被更新的一次观测取代。请基于最新一次 Snapshot 操作，并引用它返回的 based_on。`,
    })
  }

  if (config.requireCoordinateMapping !== false && !isCoordinateComplete(observation)) {
    // 不是致命问题（UI 树坐标依然可用），但值得提示，因此单独一个 code。
    problems.push({
      code: 'MAPPING_INCOMPLETE',
      message: '该观测缺少 Screenshot Region / Original Size，图片像素无法换算成屏幕坐标；请改用 UI 树里给出的屏幕坐标，或重新 Snapshot。',
    })
  }

  if (config.requireProcessMatch !== false) {
    const drift = diffProcess(observation.process, request.screenObservation?.process ?? observation.process)
    if (drift.changed) {
      problems.push({
        code: 'PROCESS_CHANGED',
        message: `目标窗口在观测之后发生了变化（${drift.fields.join(', ')}）。点击很可能落到别的程序上，请重新 Snapshot 确认。`,
      })
    }
  }

  return problems
}

/**
 * 便捷入口：把一次观测做成「可点击」条目，记录其映射。
 * 返回的记录供 index.js 放入状态与审计。
 */
export function makeObservationRecord(agentKey, observation, store) {
  const stored = store.record(agentKey, observation)
  const mapping = buildMapping(stored)
  return { observation: stored, mapping }
}

/** 空观测（导出以便测试与诊断共用同一形状）。 */
export { emptyObservation }
