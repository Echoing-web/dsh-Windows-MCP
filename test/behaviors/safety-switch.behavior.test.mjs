/**
 * BDD 行为测试：features/safety-switch.feature
 *
 * 急停是"立刻停手"的手段，所以必须验证三件事：
 * 它拦得住、它不拦只读工具、它自己坏了也不能阻断调用。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHost } from '../harness/host.js'
import { coverage } from '../harness/link.js'
import { createPolicy, createKillSwitch, DECISION_CODES } from '../../lib/policy.js'

coverage({
  spec: ['S-SAFE-01', 'S-SAFE-02', 'S-SAFE-03', 'S-SAFE-04'],
  covers: [
    '安全开关 :: 启用急停后输入类动作被拒绝',
    '安全开关 :: 急停期间只读观测工具仍可用',
    '安全开关 :: 急停期间其他服务器的工具不受影响',
    '安全开关 :: 解除急停后恢复正常',
    '安全开关 :: 重复启用急停是幂等的',
    '安全开关 :: 急停状态可查询并带出原因与时间',
    '安全开关 :: 守卫自身异常时不得阻断调用',
    '安全开关 :: 审批通道不可用时失败关闭',
  ],
})

/** 取同步守卫（唯一的那个）。 */
function guardOf(host) {
  assert.equal(host.guards.length, 1, '必须恰好注册一个同步守卫')
  return host.guards[0]
}

// ── Scenario: 启用急停后输入类动作被拒绝 ────────────────────────────────────
test('安全开关 :: 启用急停后输入类动作被拒绝', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    await host.runTool('winmcp_kill', { action: 'engage', reason: '冒烟' })
    const reason = guardOf(host)(host.exec('mcp__winmcp__Click', { loc: [1, 2] }))
    assert.equal(typeof reason, 'string')
    assert.match(reason, /急停/)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 急停期间只读观测工具仍可用 ────────────────────────────────────
test('安全开关 :: 急停期间只读观测工具仍可用', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    await host.runTool('winmcp_kill', { action: 'engage' })
    assert.equal(guardOf(host)(host.exec('mcp__winmcp__Snapshot')), undefined)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 急停期间其他服务器的工具不受影响 ──────────────────────────────
test('安全开关 :: 急停期间其他服务器的工具不受影响', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    await host.runTool('winmcp_kill', { action: 'engage' })
    assert.equal(guardOf(host)(host.exec('read', { file_path: 'x' })), undefined)
    assert.equal(guardOf(host)(host.exec('mcp__other__Click')), undefined)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 解除急停后恢复正常 ────────────────────────────────────────────
test('安全开关 :: 解除急停后恢复正常', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    await host.runTool('winmcp_kill', { action: 'engage' })
    await host.runTool('winmcp_kill', { action: 'release' })
    assert.equal(guardOf(host)(host.exec('mcp__winmcp__Click', { loc: [1, 2] })), undefined)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 重复启用急停是幂等的 ──────────────────────────────────────────
test('安全开关 :: 重复启用急停是幂等的', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    await host.runTool('winmcp_kill', { action: 'engage', reason: '第一次' })
    await host.runTool('winmcp_kill', { action: 'engage', reason: '第二次' })
    const last = await host.runTool('winmcp_kill', { action: 'engage', reason: '第三次' })
    const status = JSON.parse(last.text.slice(last.text.indexOf('{')))
    assert.equal(status.engaged, true)
    // S-SAFE-01：两个计数语义分开
    // - engageCount = 累计 engage 调用次数（3 次调用 → 3）
    // - engageSeq   = 成功启用序号（重复启用不递增 → 1）
    assert.equal(status.engageCount, 3, '累计尝试次数应包含重复 engage')
    assert.equal(status.engageSeq, 1, '成功启用序号不得被重复 engage 递增')
    // 幂等的第二层含义：保持第一次启用的现场，不刷新时间、不覆盖原因
    assert.equal(status.reason, '第一次', '第一次的原因才是"为什么喊停"的答案，不得被覆盖')
    const first = await host.runTool('winmcp_kill', { action: 'status' })
    const firstStatus = JSON.parse(first.text.slice(first.text.indexOf('{')))
    assert.equal(firstStatus.engagedAt, status.engagedAt, '重复启用不得刷新启用时间')
  } finally {
    host.cleanup()
  }
})

// ── 补强：release 后再 engage 是一次新的启用 ────────────────────────────────
test('补强｜release 后再次启用会刷新时间与原因', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    await host.runTool('winmcp_kill', { action: 'engage', reason: '第一次' })
    await host.runTool('winmcp_kill', { action: 'release' })
    const second = await host.runTool('winmcp_kill', { action: 'engage', reason: '第二次' })
    const status = JSON.parse(second.text.slice(second.text.indexOf('{')))
    assert.equal(status.reason, '第二次')
    assert.equal(status.engageSeq, 2, 'release 后再启用是新的一次')
    assert.equal(status.engageCount, 2)
    // 再次启用必须清掉上一次的释放时刻，否则状态自相矛盾
    assert.equal(status.releasedAt, null)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 急停状态可查询并带出原因与时间 ────────────────────────────────
test('安全开关 :: 急停状态可查询并带出原因与时间', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    await host.runTool('winmcp_kill', { action: 'engage', reason: '用户要求停手' })
    const out = await host.runTool('winmcp_kill', { action: 'status' })
    const status = JSON.parse(out.text.slice(out.text.indexOf('{')))
    assert.equal(status.reason, '用户要求停手')
    assert.equal(typeof status.engagedAt, 'number')
    assert.equal(status.releasedAt, null)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 守卫自身异常时不得阻断调用 ────────────────────────────────────
test('安全开关 :: 守卫自身异常时不得阻断调用', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    await host.runTool('winmcp_kill', { action: 'engage' })
    const guard = guardOf(host)
    // 畸形输入不得让守卫抛异常（抛异常会打断工具调用链路）
    assert.equal(guard(null), undefined)
    assert.equal(guard({}), undefined)
    assert.equal(guard({ name: 123 }), undefined)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 审批通道不可用时失败关闭 ──────────────────────────────────────
test('安全开关 :: 审批通道不可用时失败关闭', () => {
  const killSwitch = createKillSwitch({})
  // ask 缺席 = 审批通道不可用
  const policy = createPolicy({
    config: { serverName: 'winmcp', requireApproval: true, approvalTtlMs: 60000 },
    killSwitch,
    audit: null,
    ask: undefined,
    now: () => 1000,
  })
  const decision = policy.evaluate({
    tool: 'mcp__winmcp__PowerShell',
    action: 'system',
    observation: null,
    config: { serverName: 'winmcp', requireApproval: true, approvalTtlMs: 60000 },
  })
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.code, DECISION_CODES.APPROVAL_UNAVAILABLE)
})

// ── 补强：审批通道可用时给出 ask，并且授权是一次性、会过期 ──────────────────
test('补强｜审批通道可用时返回 ask，授权一次性且会过期', () => {
  let clock = 1000
  const config = { serverName: 'winmcp', requireApproval: true, approvalTtlMs: 5000 }
  const policy = createPolicy({
    config,
    killSwitch: createKillSwitch({}),
    audit: null,
    ask: () => 'allowed-once',
    now: () => clock,
  })
  const request = { tool: 'mcp__winmcp__PowerShell', action: 'system', observation: null, config }

  assert.equal(policy.evaluate(request).kind, 'ask')

  policy.grant('mcp__winmcp__PowerShell')
  assert.equal(policy.evaluate(request).kind, 'allow', '授权后应放行')
  assert.equal(policy.evaluate(request).kind, 'ask', '一次性授权应已被消耗')

  policy.grant('mcp__winmcp__PowerShell')
  clock += 6000
  assert.equal(policy.evaluate(request).kind, 'ask', '过期后应重新要求审批')
})
