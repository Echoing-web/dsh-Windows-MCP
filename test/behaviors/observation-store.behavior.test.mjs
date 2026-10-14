/**
 * BDD 行为测试：features/observation-store.feature
 *
 * 观测是闸门的唯一依据，因此它的编号唯一性、会话隔离与解析容错
 * 都是对外契约——这里按场景逐条断言，不依赖内部函数名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createObservationStore } from '../../lib/gate.js'
import { buildObservation } from '../../lib/observe.js'
import { coverage } from '../harness/link.js'
import { createHost, REAL_SNAPSHOT_TEXT } from '../harness/host.js'

coverage({
  spec: ['S-OBS-01', 'S-OBS-02', 'S-OBS-03', 'S-OBS-04', 'S-OBS-05', 'S-OBS-06'],
  covers: [
    '观测存储与解析 :: 观测编号在进程内全局唯一',
    '观测存储与解析 :: 代次按会话各自单调递增',
    '观测存储与解析 :: 会话之间观测互相不可见',
    '观测存储与解析 :: 按编号查询只能查到本会话的观测',
    '观测存储与解析 :: 观测历史有界',
    '观测存储与解析 :: 历史查询遵守数量上限',
    '观测存储与解析 :: 解析真实文本不虚构坐标',
    '观测存储与解析 :: 解析出窗口与元素信息',
    '观测存储与解析 :: 解析对残缺区块容错',
  ],
})

/** 造一条最小观测。 */
function obs(at = 1000) {
  return buildObservation({ value: 'Cursor Position: (1, 2)', content: [], tool: 'mcp__winmcp__Snapshot', at })
}

// ── Scenario: 观测编号在进程内全局唯一 ──────────────────────────────────────
test('观测存储与解析 :: 观测编号在进程内全局唯一', () => {
  const store = createObservationStore()
  const a1 = store.record('A', obs())
  const b1 = store.record('B', obs())
  const a2 = store.record('A', obs())
  assert.equal(new Set([a1.id, b1.id, a2.id]).size, 3)
  assert.equal(a1.id, 'obs-1')
  assert.equal(a2.id, 'obs-3')
  assert.notEqual(a1.id, b1.id)
})

// ── Scenario: 代次按会话各自单调递增 ────────────────────────────────────────
test('观测存储与解析 :: 代次按会话各自单调递增', () => {
  const store = createObservationStore()
  const a1 = store.record('A', obs())
  store.record('B', obs())
  const a2 = store.record('A', obs())
  const b2 = store.record('B', obs())
  assert.equal(a1.generation, 1)
  assert.equal(a2.generation, 2)
  assert.equal(b2.generation, 2)
})

// ── Scenario: 会话之间观测互相不可见 ────────────────────────────────────────
test('观测存储与解析 :: 会话之间观测互相不可见', () => {
  const store = createObservationStore()
  store.record('A', obs())
  assert.equal(store.current('B'), null)
  assert.equal(store.previous('B'), null)
  assert.deepEqual(store.history('B'), [])
})

// ── Scenario: 按编号查询只能查到本会话的观测 ────────────────────────────────
test('观测存储与解析 :: 按编号查询只能查到本会话的观测', () => {
  const store = createObservationStore()
  const a1 = store.record('A', obs())
  assert.equal(store.byId('A', a1.id).id, a1.id)
  assert.equal(store.byId('B', a1.id), null)
})

// ── Scenario: 观测历史有界 ──────────────────────────────────────────────────
test('观测存储与解析 :: 观测历史有界', () => {
  const store = createObservationStore()
  for (let i = 0; i < 30; i++) store.record('A', obs())
  const history = store.history('A', 100)
  assert.equal(history.length, 20)
  assert.equal(history.at(-1).id, 'obs-30')
})

// ── Scenario: 历史查询遵守数量上限 ──────────────────────────────────────────
test('观测存储与解析 :: 历史查询遵守数量上限', () => {
  const store = createObservationStore()
  for (let i = 0; i < 10; i++) store.record('A', obs())
  const recent = store.history('A', 3)
  assert.equal(recent.length, 3)
  assert.deepEqual(recent.map((o) => o.id), ['obs-8', 'obs-9', 'obs-10'])
})

// ── Scenario: 解析真实文本不虚构坐标 ────────────────────────────────────────
test('观测存储与解析 :: 解析真实文本不虚构坐标', () => {
  const observation = buildObservation({
    value: 'Command completed successfully.',
    content: [],
    tool: 'mcp__winmcp__Click',
  })
  assert.equal(observation.cursor, null)
  assert.equal(observation.region, null)
  assert.equal(observation.originalSize, null)
  assert.deepEqual(observation.uiElements, [])
})

// ── Scenario: 解析出窗口与元素信息 ──────────────────────────────────────────
test('观测存储与解析 :: 解析出窗口与元素信息', () => {
  const observation = buildObservation({
    value: REAL_SNAPSHOT_TEXT,
    content: [],
    tool: 'mcp__winmcp__Snapshot',
  })
  assert.equal(observation.focusedWindow.name, 'Notepad')
  assert.equal(observation.focusedWindow.handle, '4242')
  assert.ok(observation.uiElements.length >= 3)
  assert.equal(observation.uiElements.find((element) => element.label === '关闭').x, 2520)
})

// ── Scenario: 解析对残缺区块容错 ────────────────────────────────────────────
test('观测存储与解析 :: 解析对残缺区块容错', () => {
  const text = 'Cursor Position: (100, 200)\nScreenshot Region: (0,0,2560,1440)\n'
  const observation = buildObservation({ value: text, content: [], tool: 'mcp__winmcp__Snapshot' })
  assert.deepEqual(observation.cursor, { x: 100, y: 200 })
  assert.equal(observation.region.width, 2560)
  assert.deepEqual(observation.uiElements, [])
  assert.equal(observation.focusedWindow, null)
})

// ── 补强：post-execute 只把真正的观测写进存储 ────────────────────────────────
test('补强｜非观测类结果不会污染观测存储', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    const execution = host.exec('mcp__winmcp__Click', { loc: [1, 2] })
    await host.post(execution, { isError: false, value: { content: [{ type: 'text', text: 'Clicked' }] }, content: [] })
    const observations = host.audit.read({ limit: 50 }).filter((entry) => entry.decision === 'observed')
    assert.equal(observations.length, 0, 'Click 的结果不是观测，不应写进观测存储')
  } finally {
    host.cleanup()
  }
})
