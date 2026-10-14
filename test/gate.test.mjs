/**
 * gate.js 测试：动作分类、观测存储、新鲜度判定。
 *
 * 这里验证的是**安全属性**：什么情况下必须拒绝一次点击。
 * 每一条都对应一种真实事故场景（点到别的窗口、依据过期截图、没有看过屏幕就点）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTION,
  classifyAction,
  isMutating,
  diffProcess,
  createObservationStore,
  buildGateRequest,
  assessFreshness,
  makeObservationRecord,
  extractBasedOn,
} from '../lib/gate.js'
import { buildObservation } from '../lib/observe.js'

const SCREENSHOT_TEXT = `Cursor Position: (1290, 651)
Screenshot Original Size: (2560,1440)
Screenshot Coordinate Scale: 1.333333 — x
Screenshot Region: (0,0,2560,1440)
Coordinate Space: Virtual desktop coordinates
Normalized copy (1920x1080px, image/png)`

const SNAPSHOT_TEXT = `Cursor Position: (755, 733)
Screenshot Original Size: (2560,1440)
Screenshot Coordinate Scale: 1.333333 — x
Screenshot Region: (0,0,2560,1440)
Coordinate Space: Virtual desktop coordinates

Focused Window:
Name        Depth  Status   Width  Height  Handle
------      -----  -------  -----  ------  ------
Notepad     10     Normal   800    600     4242

UI Tree:
├── (100,200) 按钮 "保存"  [action: click]`

function makeObservation(overrides = {}, at = 1000) {
  const base = buildObservation({
    value: overrides.text ?? SNAPSHOT_TEXT,
    content: [],
    tool: overrides.tool ?? 'mcp__winmcp__Snapshot',
    at,
  })
  return { ...base, ...overrides.patch }
}

// ── 分类 ────────────────────────────────────────────────────────────────────

test('classifyAction 识别只读/输入/系统/未知四类', () => {
  assert.equal(classifyAction('mcp__winmcp__Snapshot'), ACTION.OBSERVE)
  assert.equal(classifyAction('Snapshot'), ACTION.OBSERVE)
  assert.equal(classifyAction('mcp__winmcp__Click'), ACTION.INPUT)
  assert.equal(classifyAction('mcp__winmcp__Shortcut'), ACTION.INPUT)
  assert.equal(classifyAction('mcp__winmcp__PowerShell'), ACTION.SYSTEM)
  assert.equal(classifyAction('mcp__winmcp__Registry'), ACTION.SYSTEM)
  assert.equal(classifyAction('mcp__winmcp__SomethingNew'), ACTION.UNKNOWN)
  assert.equal(classifyAction(undefined), ACTION.UNKNOWN)
})

test('分类大小写不敏感；别的 server 上的同名动作同样按「会改动」分类（失败关闭）', () => {
  assert.equal(classifyAction('mcp__winmcp__click'), ACTION.INPUT)
  assert.equal(classifyAction('MCP__WINMCP__CLICK'), ACTION.INPUT)
  assert.equal(classifyAction('Click'), ACTION.INPUT)
  // 别的 server 暴露的 Click 仍然是会改动桌面的动作，不该降级成 unknown
  assert.equal(classifyAction('mcp__other__Click'), ACTION.INPUT)
  // 真正决定拦不拦的是 ownsTool()，分类不能成为绕过点
  assert.equal(classifyAction('mcp__other__SomethingElse'), ACTION.UNKNOWN)
})

test('isMutating：只有输入与系统类算「会改动状态」', () => {
  assert.equal(isMutating('mcp__winmcp__Click'), true)
  assert.equal(isMutating('mcp__winmcp__PowerShell'), true)
  assert.equal(isMutating('mcp__winmcp__Snapshot'), false)
  assert.equal(isMutating('mcp__winmcp__Wait'), false)
})

// ── 进程漂移 ────────────────────────────────────────────────────────────────

test('diffProcess 只在关键字段变化时报漂移', () => {
  const before = { pid: 1, executable: 'a.exe', title: 'T', handle: '7' }
  assert.deepEqual(diffProcess(before, { ...before }).changed, false)
  const changed = diffProcess(before, { ...before, title: 'Other' })
  assert.equal(changed.changed, true)
  assert.deepEqual(changed.fields, ['title'])
  // 任一侧缺失不算漂移，避免「没数据」被当成「变了」
  assert.equal(diffProcess(null, before).changed, false)
  assert.equal(diffProcess(before, null).changed, false)
})

// ── 观测存储 ────────────────────────────────────────────────────────────────

test('store 按 agent 隔离，代次单调递增，附带 id', () => {
  const store = createObservationStore()
  assert.equal(store.generation('a'), 0)
  const first = store.record('a', makeObservation())
  assert.equal(first.id, 'obs-1')
  assert.equal(first.generation, 1)
  const second = store.record('a', makeObservation())
  assert.equal(second.id, 'obs-2')
  assert.equal(store.current('a').id, 'obs-2')
  assert.equal(store.previous('a').id, 'obs-1')
  // 另一个 agent 互不影响
  assert.equal(store.generation('b'), 0)
  assert.equal(store.current('b'), null)
  assert.equal(store.size(), 2)
})

test('观测 id 全局唯一（跨 agent 不重复）——否则审计日志会分不清是哪一次', () => {
  const store = createObservationStore()
  const a1 = store.record('a', makeObservation())
  const b1 = store.record('b', makeObservation())
  const a2 = store.record('a', makeObservation())
  assert.equal(a1.id, 'obs-1')
  assert.equal(b1.id, 'obs-2', '另一个 agent 不能也从 obs-1 开始')
  assert.equal(a2.id, 'obs-3')
  const ids = new Set([a1.id, b1.id, a2.id])
  assert.equal(ids.size, 3)
  // generation 仍然是「每个 agent 各自单调」的语义
  assert.equal(a1.generation, 1)
  assert.equal(b1.generation, 1)
  assert.equal(a2.generation, 2)
})

test('store.history 保留最近若干条且不超过上限', () => {
  const store = createObservationStore()
  for (let i = 0; i < 30; i++) store.record('a', makeObservation())
  assert.equal(store.history('a', 5).length, 5)
  assert.equal(store.history('a', 5).at(-1).id, 'obs-30')
  assert.equal(store.history('a', 100).length, 20, '内存里最多留 20 条')
})

test('store.clear 让「急停后必须重新观测」成立', () => {
  const store = createObservationStore()
  store.record('a', makeObservation())
  store.clear('a')
  assert.equal(store.current('a'), null)
  assert.equal(store.generation('a'), 0)
})

test('makeObservationRecord 同时给出观测与映射', () => {
  const store = createObservationStore()
  const { observation, mapping } = makeObservationRecord(
    'a',
    makeObservation({ text: SCREENSHOT_TEXT, tool: 'mcp__winmcp__Screenshot' }),
    store,
  )
  assert.equal(observation.id, 'obs-1')
  assert.equal(mapping.ok, true)
  // 实测确认：coord_scale 本身就是完整因子，不叠加附件比例
  assert.equal(mapping.screenPerImagePx, 1.333333)
  assert.deepEqual(mapping.origin, { x: 0, y: 0 })
})

// ── 闸门请求 ────────────────────────────────────────────────────────────────

const CONFIG = Object.freeze({
  serverName: 'winmcp',
  maxObservationAgeMs: 60000,
  requireObservation: true,
  requireCoordinateMapping: true,
  requireProcessMatch: true,
})

test('buildGateRequest 计算观测年龄与代次', () => {
  const store = createObservationStore()
  store.record('a', makeObservation({}, 1000))
  const request = buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__Click', store, now: 5000, config: CONFIG })
  assert.equal(request.action, ACTION.INPUT)
  assert.equal(request.observationAgeMs, 4000)
  assert.equal(request.storeGeneration, 1)
  assert.equal(request.observation.id, 'obs-1')
})

test('buildGateRequest 检测「之后又有了更新的观测」', () => {
  const store = createObservationStore()
  const older = store.record('a', makeObservation({}, 1000))
  const newer = store.record('a', makeObservation({}, 2000))
  const request = buildGateRequest({
    agentKey: 'a',
    tool: 'mcp__winmcp__Click',
    store,
    now: 3000,
    config: CONFIG,
    screenObservation: newer,
  })
  assert.equal(request.observation.id, newer.id)
  assert.equal(request.newerObservationExists, false)
  // 若依据的是旧的（模拟请求发出时观测还没更新）
  const staleReq = { ...request, observation: older, newerObservationExists: newer.generation > older.generation }
  assert.equal(staleReq.newerObservationExists, true)
})

// ── 新鲜度判定（核心安全属性） ──────────────────────────────────────────────

test('输入动作没有任何观测 → NO_OBSERVATION', () => {
  const store = createObservationStore()
  const request = buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__Click', store, now: 1000, config: CONFIG })
  const problems = assessFreshness(request, CONFIG)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].code, 'NO_OBSERVATION')
  assert.match(problems[0].message, /Snapshot/)
})

test('只读观测工具永不因「没有观测」被拦', () => {
  const store = createObservationStore()
  for (const tool of ['mcp__winmcp__Snapshot', 'mcp__winmcp__Screenshot', 'mcp__winmcp__DisplayInventory', 'mcp__winmcp__Wait']) {
    const request = buildGateRequest({ agentKey: 'a', tool, store, now: 1000, config: CONFIG })
    assert.deepEqual(assessFreshness(request, CONFIG), [], `${tool} 不该被拦`)
  }
})

test('观测年龄超上限 → STALE_OBSERVATION', () => {
  const store = createObservationStore()
  store.record('a', makeObservation({}, 1000))
  const request = buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__Click', store, now: 1000 + 61000, config: CONFIG })
  const problems = assessFreshness(request, CONFIG)
  assert.ok(problems.some((p) => p.code === 'STALE_OBSERVATION'))
})

test('年龄刚好等于上限时不算过期（边界）', () => {
  const store = createObservationStore()
  store.record('a', makeObservation({}, 1000))
  const request = buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__Click', store, now: 1000 + 60000, config: CONFIG })
  assert.deepEqual(assessFreshness(request, CONFIG).filter((p) => p.code === 'STALE_OBSERVATION'), [])
})

test('引用较早的观测（已有更新的一次）→ STALE_OBSERVATION', () => {
  const store = createObservationStore()
  const older = store.record('a', makeObservation({}, 1000))
  store.record('a', makeObservation({}, 1500))
  // S-GATE-04：模型显式声明依据的是较早那次观测时，必须判定过期——
  // 它手上拿的是一张已经被刷新过的旧截图。
  const request = buildGateRequest({
    agentKey: 'a',
    tool: 'mcp__winmcp__Click',
    store,
    now: 2000,
    config: CONFIG,
    args: { based_on: older.id, loc: [10, 20] },
  })
  assert.equal(request.newerObservationExists, true)
  const problems = assessFreshness(request, CONFIG)
  assert.ok(problems.some((p) => p.code === 'STALE_OBSERVATION'))
  assert.match(problems.find((p) => p.code === 'STALE_OBSERVATION').message, /取代/)
})

test('引用最新观测时不报过期', () => {
  const store = createObservationStore()
  store.record('a', makeObservation({}, 1000))
  const latest = store.record('a', makeObservation({}, 1500))
  const request = buildGateRequest({
    agentKey: 'a',
    tool: 'mcp__winmcp__Click',
    store,
    now: 2000,
    config: CONFIG,
    args: { based_on: latest.id },
  })
  assert.equal(request.newerObservationExists, false)
  assert.deepEqual(assessFreshness(request, CONFIG), [])
})

test('目标窗口变化 → PROCESS_CHANGED', () => {
  const store = createObservationStore()
  const obs = store.record('a', makeObservation())
  const request = {
    ...buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__Click', store, now: 2000, config: CONFIG }),
    screenObservation: { ...obs, process: { title: '另一个程序', handle: '999', pid: null, executable: null } },
  }
  const problems = assessFreshness(request, CONFIG)
  assert.ok(problems.some((p) => p.code === 'PROCESS_CHANGED'))
})

test('window 未变时不报 PROCESS_CHANGED', () => {
  const store = createObservationStore()
  const obs = store.record('a', makeObservation())
  const request = {
    ...buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__Click', store, now: 2000, config: CONFIG }),
    screenObservation: obs,
  }
  assert.deepEqual(assessFreshness(request, CONFIG), [])
})

test('缺少坐标映射信息只给 MAPPING_INCOMPLETE 提示，不当作阻断原因', () => {
  const store = createObservationStore()
  // 只有光标、没有 Region/Size 的观测量（真实场景：上游没输出 Region 行）
  store.record('a', makeObservation({ text: 'Cursor Position: (1, 2)' }))
  const request = buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__Click', store, now: 1100, config: CONFIG })
  const problems = assessFreshness(request, CONFIG)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].code, 'MAPPING_INCOMPLETE')
  // 调用方（index.js）会把它降级为警告
  const blocking = problems.filter((p) => p.code !== 'MAPPING_INCOMPLETE')
  assert.deepEqual(blocking, [])
})

test('系统类动作不受新鲜度闸门约束（由 policy 的审批负责）', () => {
  const store = createObservationStore()
  const request = buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__PowerShell', store, now: 1000, config: CONFIG })
  assert.deepEqual(assessFreshness(request, CONFIG), [])
})

test('可以通过配置关掉坐标映射要求', () => {
  const store = createObservationStore()
  store.record('a', makeObservation({ text: 'Cursor Position: (1, 2)' }))
  const request = buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__Click', store, now: 1100, config: CONFIG })
  assert.deepEqual(assessFreshness(request, { ...CONFIG, requireCoordinateMapping: false }), [])
})

test('可以通过配置关掉进程漂移复核', () => {
  const store = createObservationStore()
  const obs = store.record('a', makeObservation())
  const request = {
    ...buildGateRequest({ agentKey: 'a', tool: 'mcp__winmcp__Click', store, now: 2000, config: CONFIG }),
    screenObservation: { ...obs, process: { title: '别的窗口', handle: '1', pid: null, executable: null } },
  }
  assert.deepEqual(assessFreshness(request, { ...CONFIG, requireProcessMatch: false }), [])
})

// ── based_on：拦住「凭空引用观测 id」 ───────────────────────────────────────

test('extractBasedOn 支持三种自然写法；非法值用 undefined 显式标记', () => {
  assert.equal(extractBasedOn({ based_on: 'obs-2' }), 'obs-2')
  assert.equal(extractBasedOn({ basedOn: 'obs-3' }), 'obs-3')
  assert.equal(extractBasedOn({ observation_id: 'obs-4' }), 'obs-4')
  assert.equal(extractBasedOn({ based_on: '  obs-5  ' }), 'obs-5', '应去空白')
  // 三态契约（对抗性验证逼出来的）：
  //   null      = 没声明（合法）
  //   undefined = 声明了但值非法（必须拒绝，不得静默忽略）
  assert.equal(extractBasedOn({}), null, '没这个字段 → 没声明')
  assert.equal(extractBasedOn(null), null)
  assert.equal(extractBasedOn({ based_on: '' }), undefined, '空串 → 非法')
  assert.equal(extractBasedOn({ based_on: 42 }), undefined, '数字 → 非法')
  assert.equal(extractBasedOn({ based_on: ['obs-1'] }), undefined, '数组 → 非法')
  assert.equal(extractBasedOn({ based_on: { id: 'x' } }), undefined, '对象 → 非法')
  assert.equal(extractBasedOn({ based_on: true }), undefined, '布尔 → 非法')
  // 显式 null 视为"明确不声明"而不是非法
  assert.equal(extractBasedOn({ based_on: null }), null)
})

test('store.byId 精确查观测，未知 id 返回 null', () => {
  const store = createObservationStore()
  store.record('a', makeObservation())
  const second = store.record('a', makeObservation())
  assert.equal(store.byId('a', 'obs-1').id, 'obs-1')
  assert.equal(store.byId('a', second.id).id, second.id)
  assert.equal(store.byId('a', 'obs-999'), null)
  assert.equal(store.byId('a', ''), null)
  assert.equal(store.byId('a', null), null)
  // 别的 agent 的观测查不到，避免跨会话引用
  assert.equal(store.byId('b', 'obs-1'), null)
})

test('store.newest 跨桶取最新，并带出所属 agentKey', () => {
  const store = createObservationStore()
  assert.equal(store.newest(), null)
  store.record('a', makeObservation({}, 1000))
  store.record('b', makeObservation({}, 5000))
  const newest = store.newest()
  assert.equal(newest.agentKey, 'b')
  assert.equal(newest.observation.at, 5000)
})

test('引用存在的观测 id → 不报错', () => {
  const store = createObservationStore()
  store.record('a', makeObservation({}, 1000))
  const request = buildGateRequest({
    agentKey: 'a',
    tool: 'mcp__winmcp__Click',
    store,
    now: 2000,
    config: CONFIG,
    args: { based_on: 'obs-1', loc: [10, 20] },
  })
  assert.equal(request.basedOn, 'obs-1')
  assert.equal(request.referencedObservation.id, 'obs-1')
  assert.deepEqual(assessFreshness(request, CONFIG), [])
})

test('引用不存在的观测 id → UNKNOWN_OBSERVATION（这是拦幻觉的唯一检查）', () => {
  const store = createObservationStore()
  store.record('a', makeObservation({}, 1000))
  const request = buildGateRequest({
    agentKey: 'a',
    tool: 'mcp__winmcp__Click',
    store,
    now: 2000,
    config: CONFIG,
    args: { based_on: 'obs-99', loc: [10, 20] },
  })
  const problems = assessFreshness(request, CONFIG)
  assert.equal(problems.length, 1)
  assert.equal(problems[0].code, 'UNKNOWN_OBSERVATION')
  // 拒绝原因必须同时给出「你写错了」和「正确的最新 id 是什么」
  assert.match(problems[0].message, /obs-99/)
  assert.match(problems[0].message, /obs-1/)
})

test('引用别的 agent 的观测 id 同样被拒绝（防跨会话串用）', () => {
  const store = createObservationStore()
  store.record('other', makeObservation({}, 1000))
  store.record('a', makeObservation({}, 1500))
  const request = buildGateRequest({
    agentKey: 'a',
    tool: 'mcp__winmcp__Click',
    store,
    now: 2000,
    config: CONFIG,
    args: { basedOn: 'obs-1' }, // obs-1 属于 'other'
  })
  const problems = assessFreshness(request, CONFIG)
  assert.ok(problems.some((p) => p.code === 'UNKNOWN_OBSERVATION'))
})

test('不带 based_on 时不做这项校验（保持向后兼容）', () => {
  const store = createObservationStore()
  store.record('a', makeObservation({}, 1000))
  const request = buildGateRequest({
    agentKey: 'a',
    tool: 'mcp__winmcp__Click',
    store,
    now: 2000,
    config: CONFIG,
    args: { loc: [10, 20] },
  })
  assert.equal(request.basedOn, null)
  assert.deepEqual(assessFreshness(request, CONFIG), [])
})

test('只读工具参数里带 based_on 也不校验（校验只针对输入类动作）', () => {
  const store = createObservationStore()
  store.record('a', makeObservation({}, 1000))
  const request = buildGateRequest({
    agentKey: 'a',
    tool: 'mcp__winmcp__Snapshot',
    store,
    now: 2000,
    config: CONFIG,
    args: { based_on: 'obs-does-not-exist' },
  })
  assert.deepEqual(assessFreshness(request, CONFIG), [])
})
