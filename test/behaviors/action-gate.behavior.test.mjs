/**
 * BDD 行为测试：features/action-gate.feature
 *
 * 这一组是**安全契约**，所以每个场景都必须真的走一遍插件的公开路径
 * （通过 host 装置喂 post-execute 制造观测，再走 pre-execute 请求动作），
 * 而不是直接调用内部函数——否则"闸门确实生效"这件事就没有被验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHost, REAL_SNAPSHOT_TEXT, REAL_SCREENSHOT_TEXT, createMemoryAudit } from '../harness/host.js'
import { coverage } from '../harness/link.js'
import { createVirtualClock } from '../harness/clock.js'

coverage({
  spec: [
    'S-GATE-01', 'S-GATE-02', 'S-GATE-03', 'S-GATE-04', 'S-GATE-05',
    'S-GATE-06', 'S-GATE-07', 'S-GATE-08', 'S-GATE-09', 'S-GATE-10', 'S-GATE-11',
  ],
  covers: [
    '动作闸门 :: 没有观测就想点击会被拒绝',
    '动作闸门 :: 先观测再点击可以通过',
    '动作闸门 :: 观测超过年龄上限会被拒绝',
    '动作闸门 :: 观测年龄恰好等于上限时不算过期',
    '动作闸门 :: 存在更新的观测时旧观测被判定为过期',
    '动作闸门 :: 目标窗口发生变化会被拒绝',
    '动作闸门 :: 目标窗口未变化时不报漂移',
    '动作闸门 :: 引用了不存在的观测会被拒绝',
    '动作闸门 :: 引用别的会话的观测会被拒绝',
    '动作闸门 :: 引用真实存在的观测会被放行',
    '动作闸门 :: 不带依据声明的点击不做该校验',
    '动作闸门 :: 策略评估抛异常时必须失败关闭',
    '动作闸门 :: 只读工具在任何情况下都不被闸门拦截',
    '动作闸门 :: 只读工具在观测过期时同样不被拦截',
    '动作闸门 :: 别的服务器的工具不经本闸门',
    '动作闸门 :: 非 MCP 工具完全不受影响',
    '动作闸门 :: 缺少坐标映射只提示不阻断',
    '动作闸门 :: 拒绝会被写入审计',
    '动作闸门 :: 放行的输入类动作同样会被写入审计',
  ],
})

const GATE_CONFIG = { serverName: 'winmcp', maxObservationAgeMs: 60000 }

/** 建一台带虚拟时钟的装置；返回 { host, clock }。 */
function mount(config = GATE_CONFIG, options = {}) {
  const clock = createVirtualClock(1_000_000)
  const host = createHost({ config, clock, ...options })
  return { host, clock, done: () => host.cleanup() }
}

/** 从审计里取最近一条观测记录的 observationId。 */
function latestObservationId(host) {
  const entries = host.audit.read({ limit: 50 })
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].observationId) return entries[i].observationId
  }
  return null
}

/** 断言一次拒绝：code 与原因都可读。 */
function assertDenied(decision, code) {
  assert.equal(decision.kind, 'deny', `期望拒绝，实际 ${JSON.stringify(decision)}`)
  assert.equal(decision.info?.code, code, `期望代码 ${code}，实际 ${decision.info?.code}`)
  assert.ok(typeof decision.reason === 'string' && decision.reason.length > 0, '拒绝必须带原因')
}

// ── Scenario: 没有观测就想点击会被拒绝 ──────────────────────────────────────
test('动作闸门 :: 没有观测就想点击会被拒绝', async () => {
  const m = mount()
  try {
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assertDenied(decision, 'NO_OBSERVATION')
    assert.match(decision.reason, /Snapshot/)
  } finally {
    m.done()
  }
})

// ── Scenario: 先观测再点击可以通过 ──────────────────────────────────────────
test('动作闸门 :: 先观测再点击可以通过', async () => {
  const m = mount()
  try {
    await m.host.observeSnapshot()
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assert.equal(decision.kind, 'allow')
  } finally {
    m.done()
  }
})

// ── Scenario: 观测超过年龄上限会被拒绝 ──────────────────────────────────────
test('动作闸门 :: 观测超过年龄上限会被拒绝', async () => {
  const m = mount()
  try {
    await m.host.observeSnapshot()
    m.clock.advance(61_000)
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assertDenied(decision, 'STALE_OBSERVATION')
  } finally {
    m.done()
  }
})

// ── Scenario: 观测年龄恰好等于上限时不算过期 ────────────────────────────────
test('动作闸门 :: 观测年龄恰好等于上限时不算过期', async () => {
  const m = mount()
  try {
    await m.host.observeSnapshot()
    m.clock.advance(60_000)
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assert.equal(decision.kind, 'allow', '边界值必须放行，否则规格与实现差一毫秒都会漂')
  } finally {
    m.done()
  }
})

// ── Scenario: 存在更新的观测时旧观测被判定为过期 ────────────────────────────
test('动作闸门 :: 存在更新的观测时旧观测被判定为过期', async () => {
  const m = mount()
  try {
    await m.host.observeSnapshot()
    const firstId = latestObservationId(m.host)
    await m.host.observeSnapshot()
    const decision = await m.host.pre(
      m.host.exec('mcp__winmcp__Click', { loc: [10, 20], based_on: firstId }),
    )
    assertDenied(decision, 'STALE_OBSERVATION')
    assert.match(decision.reason, new RegExp(firstId))
  } finally {
    m.done()
  }
})

// ── Scenario: 目标窗口发生变化会被拒绝 ──────────────────────────────────────
test('动作闸门 :: 目标窗口发生变化会被拒绝', async () => {
  const clock = createVirtualClock(1_000_000)
  // 实时进程事实由宿主采集后注入（本插件不做会阻塞输入动作的额外系统调用）。
  const host = createHost({
    config: GATE_CONFIG,
    clock,
    currentProcess: { title: '另一个程序', handle: '9999', pid: null, executable: null },
  })
  try {
    await host.observeSnapshot()
    const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assertDenied(decision, 'PROCESS_CHANGED')
    assert.match(decision.reason, /发生了变化/)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 目标窗口未变化时不报漂移 ──────────────────────────────────────
test('动作闸门 :: 目标窗口未变化时不报漂移', async () => {
  const clock = createVirtualClock(1_000_000)
  const host = createHost({
    config: GATE_CONFIG,
    clock,
    // 与 REAL_SNAPSHOT_TEXT 里的焦点窗口一致
    currentProcess: { title: 'Notepad', handle: '4242', pid: null, executable: null },
  })
  try {
    await host.observeSnapshot()
    const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assert.equal(decision.kind, 'allow')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 引用了不存在的观测会被拒绝 ────────────────────────────────────
test('动作闸门 :: 引用了不存在的观测会被拒绝', async () => {
  const m = mount()
  try {
    await m.host.observeSnapshot()
    const real = latestObservationId(m.host)
    const decision = await m.host.pre(
      m.host.exec('mcp__winmcp__Click', { loc: [10, 20], based_on: 'obs-99' }),
    )
    assertDenied(decision, 'UNKNOWN_OBSERVATION')
    assert.match(decision.reason, /obs-99/)
    assert.match(decision.reason, new RegExp(real), '拒绝原因必须给出真正可用的编号')
  } finally {
    m.done()
  }
})

// ── Scenario: 引用别的会话的观测会被拒绝 ────────────────────────────────────
test('动作闸门 :: 引用别的会话的观测会被拒绝', async () => {
  const m = mount()
  try {
    await m.host.observeSnapshot('agent-other')
    const otherId = latestObservationId(m.host)
    await m.host.observeSnapshot('agent-1')
    const decision = await m.host.pre(
      m.host.exec('mcp__winmcp__Click', { loc: [10, 20], based_on: otherId }, 'agent-1'),
    )
    assertDenied(decision, 'UNKNOWN_OBSERVATION')
  } finally {
    m.done()
  }
})

// ── Scenario: 引用真实存在的观测会被放行 ────────────────────────────────────
test('动作闸门 :: 引用真实存在的观测会被放行', async () => {
  const m = mount()
  try {
    await m.host.observeSnapshot()
    const real = latestObservationId(m.host)
    const decision = await m.host.pre(
      m.host.exec('mcp__winmcp__Click', { loc: [10, 20], based_on: real }),
    )
    assert.equal(decision.kind, 'allow')
  } finally {
    m.done()
  }
})

// ── Scenario: 不带依据声明的点击不做该校验 ──────────────────────────────────
test('动作闸门 :: 不带依据声明的点击不做该校验', async () => {
  const m = mount()
  try {
    await m.host.observeSnapshot()
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assert.equal(decision.kind, 'allow')
  } finally {
    m.done()
  }
})

// ── Scenario: 策略评估抛异常时必须失败关闭 ──────────────────────────────────
test('动作闸门 :: 策略评估抛异常时必须失败关闭', async () => {
  const m = mount(GATE_CONFIG, {
    policy: { evaluate: () => { throw new Error('策略炸了') } },
  })
  try {
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Click', { loc: [1, 2] }))
    assertDenied(decision, 'POLICY_ERROR')
  } finally {
    m.done()
  }
})

// ── Scenario: 只读工具在任何情况下都不被闸门拦截 ────────────────────────────
test('动作闸门 :: 只读工具在任何情况下都不被闸门拦截', async () => {
  const m = mount()
  try {
    for (const tool of ['Snapshot', 'Screenshot', 'DisplayInventory', 'Wait']) {
      const decision = await m.host.pre(m.host.exec(`mcp__winmcp__${tool}`))
      assert.equal(decision.kind, 'allow', `${tool} 被拦了`)
    }
  } finally {
    m.done()
  }
})

// ── Scenario: 只读工具在观测过期时同样不被拦截 ──────────────────────────────
test('动作闸门 :: 只读工具在观测过期时同样不被拦截', async () => {
  const m = mount()
  try {
    await m.host.observeSnapshot()
    m.clock.advance(120_000)
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Snapshot'))
    assert.equal(decision.kind, 'allow')
  } finally {
    m.done()
  }
})

// ── Scenario: 别的服务器的工具不经本闸门 ────────────────────────────────────
test('动作闸门 :: 别的服务器的工具不经本闸门', async () => {
  const m = mount()
  try {
    const decision = await m.host.pre(m.host.exec('mcp__other__Click', { loc: [1, 2] }))
    assert.equal(decision.kind, 'allow')
  } finally {
    m.done()
  }
})

// ── Scenario: 非 MCP 工具完全不受影响 ───────────────────────────────────────
test('动作闸门 :: 非 MCP 工具完全不受影响', async () => {
  const m = mount()
  try {
    const decision = await m.host.pre(m.host.exec('read', { file_path: 'x' }))
    assert.equal(decision.kind, 'allow')
  } finally {
    m.done()
  }
})

// ── Scenario: 缺少坐标映射只提示不阻断 ──────────────────────────────────────
test('动作闸门 :: 缺少坐标映射只提示不阻断', async () => {
  const m = mount()
  try {
    // 只有光标、没有 Region/Size 的观测
    await m.host.observeSnapshot('agent-1', 'Cursor Position: (1, 2)')
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assert.equal(decision.kind, 'allow', '映射缺失不得阻断（UI 树坐标仍可用）')
  } finally {
    m.done()
  }
})

// ── Scenario: 拒绝会被写入审计 ──────────────────────────────────────────────
test('动作闸门 :: 拒绝会被写入审计', async () => {
  const audit = createMemoryAudit()
  const m = mount(GATE_CONFIG, { audit, options: { audit } })
  try {
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assertDenied(decision, 'NO_OBSERVATION')
    const denial = audit.entries.find((entry) => entry.decision === 'deny')
    assert.ok(denial, '审计里必须有拒绝记录')
    assert.equal(denial.allowed, false)
    assert.equal(denial.code, 'NO_OBSERVATION')
    assert.ok(typeof denial.reason === 'string' && denial.reason.length > 0)
    assert.equal(denial.tool, 'Click')
  } finally {
    m.done()
  }
})

// ── Scenario: 放行的输入类动作同样会被写入审计 ──────────────────────────────
// ── 补强｜S-GATE-11：只有这三个显式开关能让闸门失效 ────────────────────────
test('补强｜三个显式开关各自关闭对应判定，且只有它们能削弱闸门', async () => {
  // (1) requireObservation=false 关闭「无观测拒绝」
  {
    const host = createHost({ config: { serverName: 'winmcp', requireObservation: false } })
    try {
      const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [1, 2] }))
      assert.equal(decision.kind, 'allow', 'requireObservation=false 应关闭无观测拒绝')
    } finally {
      host.cleanup()
    }
  }
  // (2) requireCoordinateMapping=false 关闭「映射不完整提示」
  {
    const host = createHost({ config: { serverName: 'winmcp', requireCoordinateMapping: false } })
    try {
      await host.observeSnapshot('agent-1', 'Cursor Position: (1, 2)')
      const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [1, 2] }))
      assert.equal(decision.kind, 'allow')
    } finally {
      host.cleanup()
    }
  }
  // (3) requireProcessMatch=false 关闭「窗口漂移复核」
  {
    const host = createHost({
      config: { serverName: 'winmcp', requireProcessMatch: false },
      currentProcess: { title: '完全不同的窗口', handle: '999', pid: null, executable: null },
    })
    try {
      await host.observeSnapshot()
      const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [1, 2] }))
      assert.equal(decision.kind, 'allow', 'requireProcessMatch=false 应关闭漂移复核')
    } finally {
      host.cleanup()
    }
  }
  // (4) 反向：**未知/无关**配置项不得削弱任何判定
  {
    const host = createHost({
      config: { serverName: 'winmcp', somethingUnknown: true, skipChecks: true, disableGate: true },
      currentProcess: { title: '别的窗口', handle: '1', pid: null, executable: null },
    })
    try {
      await host.observeSnapshot()
      const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [1, 2] }))
      assert.equal(decision.kind, 'deny', '未知配置项不得让闸门失效')
      assert.equal(decision.info?.code, 'PROCESS_CHANGED')
    } finally {
      host.cleanup()
    }
  }
})

test('动作闸门 :: 放行的输入类动作同样会被写入审计', async () => {  const audit = createMemoryAudit()
  const m = mount(GATE_CONFIG, { audit, options: { audit } })
  try {
    await m.host.observeSnapshot()
    const decision = await m.host.pre(m.host.exec('mcp__winmcp__Click', { loc: [2520, 35] }))
    assert.equal(decision.kind, 'allow')
    // S-AUDIT-07：放行的**改动类**动作必须留痕。
    // 否则审计只记"被拒绝的"，而真正改动了桌面的那些反而查不到——复盘时最缺的就是它们。
    const allowed = audit.entries.find(
      (entry) => entry.decision === 'allow' && entry.tool === 'Click' && entry.allowed === true,
    )
    assert.ok(allowed, `放行的 Click 必须留审计条目；实际条目：${JSON.stringify(audit.entries.map((e) => e.decision))}`)
    assert.equal(allowed.action, 'input')
    assert.ok(allowed.observationId, '放行条目应带上所依据的观测 id')
  } finally {
    m.done()
  }
})
