/**
 * index.js 集成测试：用假的 Cordis 上下文验证四条 DSH 接缝真的被接上了。
 *
 * 这些测试不碰真实桌面、不写真实文件（审计注入内存实现），
 * 只验证「装配是否正确」——即 pre-execute 真的能拦、post-execute 真的会富化、
 * guard 真的兜底、辅助工具真的注册。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, normalizeConfig, ownsTool, DEFAULTS } from '../index.js'
import { OFFERED_TOOLS } from './helpers/config-surface.mjs'

/** 最小可用的假 ctx：记录注册了什么、暴露 on/effect/tools。 */
function createFakeCtx() {
  const listeners = new Map()
  const registered = []
  const guards = []
  const effects = []
  return {
    listeners,
    registered,
    guards,
    effects,
    logger: { info() {}, warn() {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((h) => h !== handler))
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
    async emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) await handler(...args)
    },
  }
}

/** 内存审计替身，避免测试写文件。 */
function createMemoryAudit() {
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

/** 一个总是 allow 的 policy 替身（本文件测装配，不测策略细节）。 */
function allowPolicy() {
  return { evaluate: () => ({ kind: 'allow' }) }
}

const SCREENSHOT_TEXT = `Cursor Position: (1290, 651)
Screenshot Original Size: (2560,1440)
Screenshot Coordinate Scale: 1.333333 — x
Screenshot Region: (0,0,2560,1440)
Coordinate Space: Virtual desktop coordinates
Normalized copy (1920x1080px, image/png)`

const SCREENSHOT_VALUE = {
  content: [
    { type: 'text', text: SCREENSHOT_TEXT },
    { type: 'image', data: 'aGVsbG8=' },
  ],
}

const SCREENSHOT_CONTENT = [
  { type: 'text', text: SCREENSHOT_TEXT },
  { type: 'image', attachment: { id: 'att-1' } },
]

function mount(overrides = {}) {
  const ctx = createFakeCtx()
  const audit = createMemoryAudit()
  const dispose = apply(ctx, overrides.config ?? {}, {
    env: { DSH_HOME: 'C:\\fake\\dsh' },
    log: ctx.logger,
    now: overrides.now ?? (() => 1000),
    audit,
    policy: overrides.policy ?? allowPolicy(),
    ...overrides.options,
  })
  return { ctx, audit, dispose }
}

function execFor(name, args = {}, agentId = 'agent-1') {
  return { name, arguments: args, callId: `call-${Math.random()}`, agent: { id: agentId } }
}

/** 直接调用注册在假 ctx 上的 post-execute 监听器。 */
async function runPost(ctx, exec, result) {
  let decision = { kind: 'accept' }
  for (const handler of ctx.listeners.get('tools/post-execute') ?? []) {
    const out = await handler(exec, result, async () => decision)
    if (out) decision = out
  }
  return decision
}

async function runPre(ctx, exec) {
  let result
  for (const handler of ctx.listeners.get('tools/pre-execute') ?? []) {
    const out = await handler(exec, async () => {
      result = { kind: 'allow' }
      return result
    })
    if (out) result = out
  }
  return result ?? { kind: 'allow' }
}

// ── 配置 ────────────────────────────────────────────────────────────────────

test('normalizeConfig 使用文档化的默认值', () => {
  const config = normalizeConfig({}, { DSH_HOME: 'C:\\x' })
  assert.equal(config.serverName, DEFAULTS.serverName)
  assert.equal(config.maxObservationAgeMs, DEFAULTS.maxObservationAgeMs)
  assert.equal(config.requireObservation, true)
  assert.equal(config.annotateResults, true)
  assert.equal(config.auditFile, 'C:\\x\\logs\\windows-mcp-audit.jsonl')
})

test('normalizeConfig 允许显式关闭审计与富化', () => {
  const config = normalizeConfig({ autoAudit: false, annotateResults: false, registerTools: false }, { DSH_HOME: 'C:\\x' })
  assert.equal(config.auditFile, '')
  assert.equal(config.annotateResults, false)
  assert.equal(config.registerTools, false)
})

test('normalizeConfig 接受自定义 serverName 与时间上限', () => {
  const config = normalizeConfig({ serverName: 'mywin', maxObservationAgeMs: 5000 }, {})
  assert.equal(config.serverName, 'mywin')
  assert.equal(config.maxObservationAgeMs, 5000)
})

test('ownsTool 只认配置的 serverName 前缀', () => {
  assert.equal(ownsTool('mcp__winmcp__Click', 'winmcp'), true)
  assert.equal(ownsTool('mcp__other__Click', 'winmcp'), false)
  assert.equal(ownsTool('read', 'winmcp'), false)
})

// ── 装配 ────────────────────────────────────────────────────────────────────

test('apply 注册两个监听器、一个 guard 和全部辅助工具', () => {
  const { ctx } = mount()
  assert.equal(ctx.listeners.get('tools/pre-execute')?.length, 1)
  assert.equal(ctx.listeners.get('tools/post-execute')?.length, 1)
  assert.equal(ctx.guards.length, 1)
  assert.deepEqual(ctx.registered.map((d) => d.name).sort(), [...OFFERED_TOOLS].sort())
})

test('registerTools=false 时不注册辅助工具，但闸门仍然生效', () => {
  const { ctx } = mount({ config: { registerTools: false } })
  assert.deepEqual(ctx.registered, [])
  assert.equal(ctx.listeners.get('tools/pre-execute')?.length, 1)
  assert.equal(ctx.guards.length, 1)
})

test('dispose 回收所有注册与监听器（HMR 安全）', () => {
  const { ctx, dispose } = mount()
  assert.ok(ctx.registered.length > 0)
  dispose()
  assert.equal(ctx.registered.length, 0)
  assert.equal(ctx.guards.length, 0)
  assert.equal(ctx.listeners.get('tools/pre-execute').length, 0)
  assert.equal(ctx.listeners.get('tools/post-execute').length, 0)
})

// ── post-execute：观测与富化 ────────────────────────────────────────────────

test('Screenshot 结果被解析为观测，并在结果后追加映射块', async () => {
  const { ctx } = mount()
  const exec = execFor('mcp__winmcp__Screenshot')
  const result = { isError: false, value: SCREENSHOT_VALUE, content: SCREENSHOT_CONTENT }
  const decision = await runPost(ctx, exec, result)
  assert.equal(decision.kind, 'accept')
  assert.ok(Array.isArray(decision.content), '应返回富化后的内容块')
  const appended = decision.content.slice(SCREENSHOT_CONTENT.length)
  assert.equal(appended.length >= 1, true)
  const text = appended.map((b) => b.text).join('\n')
  assert.match(text, /\[mcp\]/)
  assert.match(text, /scale=1\.333/)
  assert.match(text, /based_on=obs-1/)
  // 原始内容必须原样保留在前
  assert.deepEqual(decision.content.slice(0, SCREENSHOT_CONTENT.length), SCREENSHOT_CONTENT)
})

test('追加块只发生在 Snapshot/Screenshot，不会污染 Click 这类工具', async () => {
  const { ctx } = mount()
  const exec = execFor('mcp__winmcp__Click', { loc: [10, 20] })
  const result = { isError: false, value: { content: [{ type: 'text', text: 'Clicked' }] }, content: [{ type: 'text', text: 'Clicked' }] }
  const decision = await runPost(ctx, exec, result)
  assert.equal(decision.content, undefined, '不应改写结果内容')
})

test('annotateResults=false 时只观测、不追加内容', async () => {
  const { ctx } = mount({ config: { annotateResults: false } })
  const exec = execFor('mcp__winmcp__Screenshot')
  const result = { isError: false, value: SCREENSHOT_VALUE, content: SCREENSHOT_CONTENT }
  const decision = await runPost(ctx, exec, result)
  assert.equal(decision.content, undefined)
})

test('不归本插件管的工具完全不受影响', async () => {
  const { ctx } = mount()
  const exec = execFor('read')
  const result = { isError: false, value: 'x', content: [{ type: 'text', text: 'x' }] }
  const decision = await runPost(ctx, exec, result)
  assert.equal(decision.content, undefined)
})

test('工具自身报错时如实记录，且不改写结果', async () => {
  const { ctx, audit } = mount()
  const exec = execFor('mcp__winmcp__Click')
  const result = { isError: true, error: { message: 'boom' }, content: [] }
  const decision = await runPost(ctx, exec, result)
  assert.equal(decision.content, undefined)
  const last = audit.entries.at(-1)
  assert.equal(last.decision, 'error')
  assert.equal(last.reason, 'boom')
})

test('post-execute 内部异常不会波及结果（返回原决定）', async () => {
  const { ctx } = mount()
  // 构造一个会让解析炸掉的畸形值
  const exec = execFor('mcp__winwcp__Screenshot')
  const result = { isError: false, value: { get content() { throw new Error('malformed') } }, content: [] }
  const decision = await runPost(ctx, exec, result)
  assert.equal(decision.kind, 'accept')
})

// ── pre-execute：闸门 ───────────────────────────────────────────────────────

test('没有观测时的 Click 被拒绝，并给出「先 Snapshot」的指引', async () => {
  const { ctx } = mount()
  const decision = await runPre(ctx, execFor('mcp__winmcp__Click', { loc: [1, 2] }))
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /Snapshot/)
  assert.equal(decision.info.code, 'NO_OBSERVATION')
})

test('先观测再点击可以通过', async () => {
  const { ctx } = mount()
  await runPost(ctx, execFor('mcp__winmcp__Screenshot'), {
    isError: false, value: SCREENSHOT_VALUE, content: SCREENSHOT_CONTENT,
  })
  const decision = await runPre(ctx, execFor('mcp__winmcp__Click', { loc: [1, 2] }))
  assert.equal(decision.kind, 'allow')
})

test('观测过期后点击被拒绝（STALE_OBSERVATION）', async () => {
  let clock = 1000
  const { ctx } = mount({ now: () => clock })
  await runPost(ctx, execFor('mcp__winmcp__Screenshot'), {
    isError: false, value: SCREENSHOT_VALUE, content: SCREENSHOT_CONTENT,
  })
  clock = 1000 + 120000
  const decision = await runPre(ctx, execFor('mcp__winmcp__Click', { loc: [1, 2] }))
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, 'STALE_OBSERVATION')
})

test('只读工具永远不会因为缺观测被拦', async () => {
  const { ctx } = mount()
  for (const tool of ['mcp__winmcp__Snapshot', 'mcp__winmcp__Screenshot', 'mcp__winmcp__DisplayInventory', 'mcp__winmcp__WaitFor']) {
    const decision = await runPre(ctx, execFor(tool))
    assert.equal(decision.kind, 'allow', `${tool} 被拦了`)
  }
})

test('别的 server 的工具不经本插件闸门', async () => {
  const { ctx } = mount()
  const decision = await runPre(ctx, execFor('mcp__other__Click', { loc: [1, 2] }))
  assert.equal(decision.kind, 'allow')
})

test('拒绝会被写入审计，原因与 code 都在记录里', async () => {
  const { ctx, audit } = mount()
  await runPre(ctx, execFor('mcp__winmcp__Click', { loc: [1, 2] }))
  const last = audit.entries.at(-1)
  assert.equal(last.decision, 'deny')
  assert.equal(last.allowed, false)
  assert.equal(last.code, 'NO_OBSERVATION')
  assert.equal(last.tool, 'Click')
})

test('policy 抛异常时按失败关闭（deny），不允许静默放行', async () => {
  const { ctx } = mount({ policy: { evaluate: () => { throw new Error('policy broke') } } })
  const decision = await runPre(ctx, execFor('mcp__winmcp__Click', { loc: [1, 2] }))
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, 'POLICY_ERROR')
})

test('policy 返回 ask 时如实转达（交给 DSH 审批）', async () => {
  const { ctx } = mount({ policy: { evaluate: () => ({ kind: 'ask', reason: '需要审批' }) } })
  const decision = await runPre(ctx, execFor('mcp__winmcp__PowerShell', { command: 'dir' }))
  assert.equal(decision.kind, 'ask')
  assert.equal(decision.reason, '需要审批')
})

// ── guard：同步兜底 ─────────────────────────────────────────────────────────

test('guard 在急停启用时拦住输入类工具，放行只读工具', () => {
  const { ctx } = mount()
  const guard = ctx.guards[0]
  // 未急停：放行
  assert.equal(guard(execFor('mcp__winmcp__Click')), undefined)
  // 通过 winmcp_kill 工具启用急停
  const killTool = ctx.registered.find((d) => d.name === 'winmcp_kill')
  return killTool.execute({ action: 'engage', reason: 'test' }, execFor('winmcp_kill')).then(() => {
    assert.match(guard(execFor('mcp__winmcp__Click')), /急停/)
    assert.match(guard(execFor('mcp__winmcp__PowerShell')), /急停/)
    assert.equal(guard(execFor('mcp__winmcp__Snapshot')), undefined, '只读工具必须仍可用')
    assert.equal(guard(execFor('read')), undefined, '别人的工具不受影响')
  })
})

test('guard 自身异常时返回 undefined，绝不炸掉工具调用', () => {
  const { ctx } = mount()
  const guard = ctx.guards[0]
  assert.equal(guard(null), undefined)
  assert.equal(guard({}), undefined)
})

// ── 辅助工具的行为 ──────────────────────────────────────────────────────────

test('winmcp_state 在无观测时明确说「无」，不编造数据', async () => {
  const { ctx } = mount()
  const tool = ctx.registered.find((d) => d.name === 'winmcp_state')
  const out = await tool.execute({}, execFor('winmcp_state'))
  const text = out.content[0].text
  assert.match(text, /最新观测: 无/)
  assert.match(text, /先 Snapshot/)
})

test('winmcp_state 在有观测时给出映射细节', async () => {
  const { ctx } = mount()
  await runPost(ctx, execFor('mcp__winmcp__Screenshot'), {
    isError: false, value: SCREENSHOT_VALUE, content: SCREENSHOT_CONTENT,
  })
  const tool = ctx.registered.find((d) => d.name === 'winmcp_state')
  const out = await tool.execute({}, execFor('winmcp_state'))
  const text = out.content[0].text
  assert.match(text, /obs-1/)
  assert.match(text, /scale=1\.333/)
  assert.match(text, /2560x1440/)
  assert.match(text, /1920x1080/)
})

test('winmcp_to_screen 做正算，并附带反查确认', async () => {
  const { ctx } = mount()
  await runPost(ctx, execFor('mcp__winmcp__Screenshot'), {
    isError: false, value: SCREENSHOT_VALUE, content: SCREENSHOT_CONTENT,
  })
  const tool = ctx.registered.find((d) => d.name === 'winmcp_to_screen')
  // 实测锚点：图片 x=1890 处正是屏幕上 (2520,35) 的「关闭」按钮
  const out = await tool.execute({ x: 1890, y: 26.25 }, execFor('winmcp_to_screen'))
  const text = out.content[0].text
  assert.match(text, /→ 屏幕 \(2520/)
  assert.match(text, /loc=\[2520/)
  assert.match(text, /反查确认/)
})

test('winmcp_to_screen 在没有观测时明确拒绝而不是猜', async () => {
  const { ctx } = mount()
  const tool = ctx.registered.find((d) => d.name === 'winmcp_to_screen')
  const out = await tool.execute({ x: 1, y: 2 }, execFor('winmcp_to_screen'))
  assert.match(out.content[0].text, /还没有任何桌面观测/)
})

test('winmcp_screen_to_image 做反算（实测锚点 2520 → 1890）', async () => {
  const { ctx } = mount()
  await runPost(ctx, execFor('mcp__winmcp__Screenshot'), {
    isError: false, value: SCREENSHOT_VALUE, content: SCREENSHOT_CONTENT,
  })
  const tool = ctx.registered.find((d) => d.name === 'winmcp_screen_to_image')
  const out = await tool.execute({ x: 2520, y: 35 }, execFor('winmcp_screen_to_image'))
  const text = out.content[0].text
  assert.match(text, /→ 图片像素 \(1890, 26\.25\)/)
})

test('winmcp_audit 返回审计条目', async () => {
  const { ctx } = mount()
  await runPre(ctx, execFor('mcp__winmcp__Click', { loc: [1, 2] }))
  const tool = ctx.registered.find((d) => d.name === 'winmcp_audit')
  const out = await tool.execute({ limit: 5 }, execFor('winmcp_audit'))
  assert.match(out.content[0].text, /NO_OBSERVATION/)
})

test('winmcp_kill 支持 engage/release/status', async () => {
  const { ctx } = mount()
  const tool = ctx.registered.find((d) => d.name === 'winmcp_kill')
  let out = await tool.execute({ action: 'status' }, execFor('winmcp_kill'))
  assert.match(out.content[0].text, /急停状态：未启用/)
  out = await tool.execute({ action: 'engage', reason: '冒烟测试' }, execFor('winmcp_kill'))
  assert.match(out.content[0].text, /急停状态：已启用/)
  out = await tool.execute({ action: 'release' }, execFor('winmcp_kill'))
  assert.match(out.content[0].text, /急停状态：未启用/)
})

test('每个辅助工具都有合法 schema 与 render，且都是只读语义', () => {
  const { ctx } = mount()
  for (const definition of ctx.registered) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 10, `${definition.name} 描述太短`)
    assert.equal(typeof definition.execute, 'function')
    assert.ok(definition.parameters && typeof definition.parameters === 'object')
    assert.ok(definition.output?.schema, `${definition.name} 缺 output.schema`)
    assert.equal(typeof definition.output.render, 'function')
  }
})
