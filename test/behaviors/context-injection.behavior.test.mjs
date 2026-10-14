/**
 * BDD 行为测试：features/context-injection.feature
 *
 * 这一组验证的是「坐标换算系数是否真的每轮都在」——它是本轮唯一的增益项，
 * 也是最容易被做成"看起来注入了、其实只注入一次"的地方，所以全部按行为断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHost } from '../harness/host.js'
import { createVirtualClock } from '../harness/clock.js'
import { coverage } from '../harness/link.js'
import { buildRuntimeContextText, createAgentScopeIndex, MAX_CONTEXT_CHARS } from '../../lib/context.js'
import { buildObservation } from '../../lib/observe.js'

coverage({
  spec: ['S-CTX-01', 'S-CTX-02', 'S-CTX-03', 'S-CTX-04', 'S-CTX-05', 'S-CTX-06'],
  covers: [
    '持久上下文注入 :: 有观测时注入编号与换算系数',
    '持久上下文注入 :: 注入文本只占一行',
    '持久上下文注入 :: 无观测时不产生任何文本',
    '持久上下文注入 :: 上下文按会话隔离',
    '持久上下文注入 :: 系统提示服务缺失时不影响对话',
    '持久上下文注入 :: 组装时取值失败不得中断组装',
    '持久上下文注入 :: 关闭注入后不再注册该贡献',
  ],
})

const CONFIG = { serverName: 'winmcp', injectContext: true }

/** 造一个「scope 已有对应 agent」的装置。 */
async function hostWithAgent(agentId = 'agent-1', config = CONFIG) {
  const clock = createVirtualClock(1_000_000)
  const host = createHost({ config, clock })
  const scope = { sessionId: agentId }
  const agent = { id: agentId, ctx: scope }
  await host.emit('agent/created', { agent })
  return { host, scope, agent, clock }
}

// ── Scenario: 有观测时注入编号与换算系数 ────────────────────────────────────
test('持久上下文注入 :: 有观测时注入编号与换算系数', async () => {
  const { host, scope } = await hostWithAgent()
  try {
    await host.observeScreenshot('agent-1')
    const texts = host.assembleContextFor(scope)
    assert.equal(texts.length, 1, `应恰好有一条非空上下文，实际 ${texts.length}`)
    const text = texts[0]
    assert.match(text, /obs=obs-\d+/, '必须给出观测编号')
    assert.match(text, /scale=1\.333/, '必须给出换算系数')
    assert.match(text, /origin=0,0/, '必须给出原点')
    assert.match(text, /based_on=obs-\d+/, '必须给出可直接使用的 based_on')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 注入文本只占一行 ──────────────────────────────────────────────
test('持久上下文注入 :: 注入文本只占一行', async () => {
  const { host, scope } = await hostWithAgent()
  try {
    await host.observeScreenshot('agent-1')
    const [text] = host.assembleContextFor(scope)
    assert.equal(text.split('\n').length, 1, `上下文必须单行，实际 ${JSON.stringify(text)}`)
    assert.ok(text.length <= MAX_CONTEXT_CHARS, `必须有长度上限，实际 ${text.length}`)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 无观测时不产生任何文本 ────────────────────────────────────────
test('持久上下文注入 :: 无观测时不产生任何文本', async () => {
  const { host, scope } = await hostWithAgent()
  try {
    const texts = host.assembleContextFor(scope)
    assert.deepEqual(texts, [], '没有观测时不应产生占位文本')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 上下文按会话隔离 ──────────────────────────────────────────────
test('持久上下文注入 :: 上下文按会话隔离', async () => {
  const clock = createVirtualClock(1_000_000)
  const host = createHost({ config: CONFIG, clock })
  const scopeA = { name: 'A' }
  const scopeB = { name: 'B' }
  try {
    await host.emit('agent/created', { agent: { id: 'A', ctx: scopeA } })
    await host.emit('agent/created', { agent: { id: 'B', ctx: scopeB } })
    await host.observeScreenshot('A')
    await host.observeScreenshot('B')

    const a = host.assembleContextFor(scopeA)[0]
    const b = host.assembleContextFor(scopeB)[0]
    const idOf = (text) => /obs=(\S+)/.exec(text)?.[1]
    assert.ok(a && b, '两个会话都应有上下文')
    assert.notEqual(idOf(a), idOf(b), '两个会话必须拿到各自那一次观测')

    // agent 释放后该 scope 不再注入
    await host.emit('agent/disposed', { agent: { id: 'A', ctx: scopeA } })
    assert.deepEqual(host.assembleContextFor(scopeA), [], '释放后不应再注入')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 系统提示服务缺失时不影响对话 ──────────────────────────────────
test('持久上下文注入 :: 系统提示服务缺失时不影响对话', () => {
  let host
  assert.doesNotThrow(() => {
    host = createHost({ config: CONFIG, systemPrompt: false })
  }, 'S-CTX-05：服务缺失必须退化为不注入，而不是抛错')
  try {
    assert.deepEqual(host.contextContributions(), [], '服务缺失时不应注册任何贡献')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 组装时取值失败不得中断组装 ────────────────────────────────────
test('持久上下文注入 :: 组装时取值失败不得中断组装', async () => {
  const clock = createVirtualClock(1_000_000)
  const throwingStore = {
    current() {
      throw new Error('观测存储炸了')
    },
  }
  // 直接构造一个「已注册且 store 会抛错」的环境，验证组装期不抛错
  const index = createAgentScopeIndex()
  const scope = { name: 'X' }
  index.track({ id: 'X', ctx: scope })
  const warnings = []
  const { registerContext } = await import('../../lib/context.js')
  const fakeCtx = {
    get: () => ({
      context(contribution) {
        fakeContributions.push(contribution)
        return () => {}
      },
    }),
  }
  const fakeContributions = []
  registerContext({
    ctx: fakeCtx,
    store: throwingStore,
    index,
    now: () => clock.now(),
    warn: (message) => warnings.push(message),
  })
  const text = fakeContributions[0].text({ scope })
  assert.equal(text, '', '取值失败时必须退化为空文本')
  assert.ok(warnings.some((w) => /上下文取值失败/.test(w)), '必须留下警告而不是静默')
})

test('补强｜buildRuntimeContextText 对畸形输入不抛错', () => {
  assert.equal(buildRuntimeContextText(null), '')
  assert.equal(buildRuntimeContextText(undefined), '')
  assert.equal(buildRuntimeContextText({}), '', '没有 id 就不该注入')
  assert.equal(buildRuntimeContextText({ id: 'obs-1' }).length > 0, true)
  // 超长窗口名必须被截断且总长有界
  const long = buildObservation({
    value: `Cursor Position: (1, 2)\nScreenshot Region: (0,0,9,9)\nFocused Window:\nName  Depth  Status  Width  Height  Handle\n${'W'.repeat(500)}  1  Normal  1  1  1`,
    content: [],
    tool: 'S',
    id: 'obs-9',
  })
  const text = buildRuntimeContextText(long)
  assert.ok(text.length <= MAX_CONTEXT_CHARS, `长度必须有界，实际 ${text.length}`)
  assert.equal(text.includes('W'.repeat(500)), false, '超长字段必须被截断')
})

test('补强｜同 id 多 scope 时不得误伤仍在世的会话（变异测试逼出来的）', () => {
  // 变异测试发现：`untrack` 原先按 id 保存**单个** scope 并整键删除，
  // 于是同 id 下另一个仍在世的会话也会被清掉——那个会话会突然丢掉上下文。
  // 规格 S-CTX-02 的前提是"同一时刻一个 id 至多一个 scope"，但那属宿主违约；
  // **插件在违约输入下也不能误伤无害的一方**。
  const index = createAgentScopeIndex()
  const s1 = { name: 'first' }
  const s2 = { name: 'second' }
  index.track({ id: 'dup', ctx: s1 })
  index.track({ id: 'dup', ctx: s2 })
  assert.equal(index.size(), 2)

  // 处置第一个：只应移除 s1
  index.untrack({ id: 'dup', ctx: s1 })
  assert.equal(index.resolve({ scope: s1 }), null, 's1 应被移除')
  assert.deepEqual(index.resolve({ scope: s2 }), { id: 'dup' }, 's2 仍在世，不得被误伤')

  // 再处置第二个
  index.untrack({ id: 'dup', ctx: s2 })
  assert.equal(index.size(), 0)

  // 事件不带 ctx 时按"最后注册的那个"移除（栈顶），同样只移除一个
  const index2 = createAgentScopeIndex()
  index2.track({ id: 'dup', ctx: s1 })
  index2.track({ id: 'dup', ctx: s2 }) // 后注册 → 栈顶
  index2.untrack({ id: 'dup' })
  assert.equal(index2.size(), 1, '只移除一个作用域')
  assert.equal(index2.resolve({ scope: s2 }), null, '栈顶（最后注册的）应被移除')
  assert.deepEqual(index2.resolve({ scope: s1 }), { id: 'dup' }, '较早注册的仍在')
})

test('补强｜窗口名含换行时注入文本仍必须是一行（V11，变异测试加强了用例）', () => {
  // 变异测试的教训：只在**超长**窗口名上断言"单行"是不够的 ——
  // `truncate(name, 60)` 会先把含换行的名字截短，于是折叠逻辑根本没被走到，
  // 删掉折叠函数套件依然全绿。必须用**短但含换行**的名字。
  const withName = (name) => ({ id: 'obs-1', at: 1000, focusedWindow: { name } })
  for (const name of ['A\nB', 'A\r\nB', 'A\rB', 'A\u2028B', 'A\u0000B', 'A\n\nB']) {
    const text = buildRuntimeContextText(withName(name), 1000)
    assert.equal(
      text.split(/\r\n|\r|\n|\u2028|\u2029/).length,
      1,
      `窗口名 ${JSON.stringify(name)} 让注入文本变成了多行：${JSON.stringify(text)}`,
    )
  }
  // 内容是折叠而不是删除
  assert.match(buildRuntimeContextText(withName('A\nB'), 1000), /window=A B/)
})

// ── Scenario: 关闭注入后不再注册该贡献 ──────────────────────────────────────
test('持久上下文注入 :: 关闭注入后不再注册该贡献', () => {
  const host = createHost({ config: { serverName: 'winmcp', injectContext: false } })
  try {
    assert.deepEqual(host.contextContributions(), [], 'injectContext=false 时不应注册')
  } finally {
    host.cleanup()
  }
})
