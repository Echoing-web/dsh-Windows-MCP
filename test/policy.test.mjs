import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_CLASS,
  DECISION_CODES,
  classifyAction,
  createKillSwitch,
  createPolicy,
  describeDecision,
  diffProcessBeforeAfter,
  normalizeToolName,
  stripToolPrefix,
} from '../lib/policy.js'

const T0 = 1_000_000

function fakeClock(start = T0) {
  let value = start
  const now = () => value
  now.advance = (ms) => {
    value += ms
    return value
  }
  now.set = (next) => {
    value = next
    return value
  }
  return now
}

function observation(overrides = {}) {
  return {
    id: 'obs-1',
    at: T0,
    generation: 5,
    process: { pid: 100, executable: 'C:\\a.exe', title: 'Window A' },
    ...overrides,
  }
}

function screen(overrides = {}) {
  return {
    generation: 5,
    process: { pid: 100, executable: 'C:\\a.exe', title: 'Window A' },
    ...overrides,
  }
}

function collectingAudit() {
  const entries = []
  return { entries, record: (entry) => entries.push(entry) }
}

test('classifyAction handles prefixed, unprefixed, padded and unknown names', () => {
  assert.equal(classifyAction('Snapshot'), 'observe')
  assert.equal(classifyAction('mcp__winmcp__Snapshot'), 'observe')
  assert.equal(classifyAction('  mcp__winmcp__WaitFor  '), 'observe')
  assert.equal(classifyAction('DisplayInventory'), 'observe')
  assert.equal(classifyAction('Click'), 'input')
  assert.equal(classifyAction('mcp__winmcp__Click'), 'input')
  assert.equal(classifyAction('MultiEdit'), 'input')
  assert.equal(classifyAction('PowerShell'), 'system')
  assert.equal(classifyAction('mcp__other_server__Registry'), 'system')
  assert.equal(classifyAction('Clipboard'), 'system')
  assert.equal(classifyAction('Nope'), 'unknown')
  assert.equal(classifyAction(''), 'unknown')
  assert.equal(classifyAction(undefined), 'unknown')
  assert.equal(classifyAction(ACTION_CLASS.UNKNOWN), 'unknown')
  assert.equal(classifyAction('mcp__winmcp__'), 'unknown')
})

test('stripToolPrefix / normalizeToolName', () => {
  assert.equal(stripToolPrefix('mcp__winmcp__Click'), 'Click')
  assert.equal(stripToolPrefix('Click'), 'Click')
  assert.equal(stripToolPrefix('mcp__foo'), 'mcp__foo')
  assert.equal(stripToolPrefix('  Snapshot '), 'Snapshot')
  assert.equal(normalizeToolName('mcp__winmcp__PowerShell'), 'powershell')
  assert.equal(normalizeToolName(null), '')
})

test('kill switch: deny everything but observe, idempotent engage/release', () => {
  const clock = fakeClock()
  const killSwitch = createKillSwitch({ clock })

  assert.equal(killSwitch.isEngaged(), false)
  const first = killSwitch.engage('用户急停')
  assert.equal(first.engaged, true)
  assert.equal(first.reason, '用户急停')
  assert.equal(first.engagedAt, T0)
  assert.equal(first.engageCount, 1)
  assert.equal(first.engageSeq, 1)

  // 幂等：二次开启不覆盖首次的时间/原因，成功启用序号也不递增，
  // 但**累计尝试次数**要递增（用于诊断"谁在反复尝试停手"）。
  clock.advance(5000)
  const second = killSwitch.engage('另一个原因')
  assert.equal(second.engagedAt, T0)
  assert.equal(second.reason, '用户急停')
  assert.equal(second.engageCount, 2, '累计尝试次数必须递增')
  assert.equal(second.engageSeq, 1, '成功启用序号不得递增')

  const plain = createPolicy({ config: { requireApproval: false }, killSwitch, now: clock })
  const denied = plain.evaluate({ tool: 'mcp__winmcp__Click', observation: observation() })
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.code, DECISION_CODES.KILL_SWITCH)
  assert.match(denied.reason, /急停/)
  assert.match(denied.reason, /用户急停/)

  // observe 类在急停期间仍然放行。
  assert.deepEqual(plain.evaluate({ tool: 'Snapshot' }), { kind: 'allow' })
  // unknown 类不属于 observe，同样被拒。
  assert.equal(plain.evaluate({ tool: 'Mystery' }).code, DECISION_CODES.KILL_SWITCH)

  // 急停优先级高于白名单：白名单里有 Click，急停期间依然被拒。
  const listed = createPolicy({
    config: { allowTools: ['Click'], requireApproval: false },
    killSwitch,
    now: clock,
  })
  assert.equal(
    listed.evaluate({ tool: 'Click', observation: observation() }).code,
    DECISION_CODES.KILL_SWITCH,
  )

  clock.advance(1000)
  const released = killSwitch.release()
  assert.equal(released.engaged, false)
  assert.equal(released.releasedAt, T0 + 6000)
  assert.equal(killSwitch.isEngaged(), false)
  // 释放后放行。
  assert.deepEqual(
    listed.evaluate({ tool: 'Click', observation: observation() }),
    { kind: 'allow' },
  )
})

test('deny list beats allow list; non-empty allow list excludes everything else', () => {
  const both = createPolicy({
    config: { denyTools: ['Click'], allowTools: ['Click'], requireObservation: false, requireApproval: false },
  })
  const denial = both.evaluate({ tool: 'Click' })
  assert.equal(denial.kind, 'deny')
  assert.equal(denial.code, DECISION_CODES.TOOL_DENIED)

  const allowListed = createPolicy({ config: { allowTools: ['Snapshot'] } })
  const notAllowed = allowListed.evaluate({ tool: 'Click' })
  assert.equal(notAllowed.kind, 'deny')
  assert.equal(notAllowed.code, DECISION_CODES.TOOL_NOT_ALLOWED)
  assert.deepEqual(allowListed.evaluate({ tool: 'Snapshot' }), { kind: 'allow' })

  // 白名单/黑名单同时容忍前缀形式与大小写差异。
  const prefixed = createPolicy({ config: { allowTools: ['mcp__winmcp__Snapshot'] } })
  assert.deepEqual(prefixed.evaluate({ tool: 'Snapshot' }), { kind: 'allow' })
  const caseDeny = createPolicy({
    config: { denyTools: ['powershell'], requireApproval: false },
  })
  assert.equal(caseDeny.evaluate({ tool: 'PowerShell' }).code, DECISION_CODES.TOOL_DENIED)
})

test('NO_OBSERVATION only fires for the input class', () => {
  const policy = createPolicy({ config: { requireApproval: false } })

  const missing = policy.evaluate({ tool: 'Click' })
  assert.equal(missing.kind, 'deny')
  assert.equal(missing.code, DECISION_CODES.NO_OBSERVATION)
  // 报错信息必须告诉模型先调 Snapshot。
  assert.match(missing.reason, /Snapshot/)

  // observe 类不需要观察记录。
  assert.deepEqual(policy.evaluate({ tool: 'Snapshot' }), { kind: 'allow' })
  assert.deepEqual(policy.evaluate({ tool: 'mcp__winmcp__DisplayInventory' }), { kind: 'allow' })
  // system 类不受规则 4 约束。
  assert.deepEqual(policy.evaluate({ tool: 'PowerShell' }), { kind: 'allow' })
  // unknown 类不放行规则 4（也不属于 observe）。
  assert.deepEqual(policy.evaluate({ tool: 'Mystery' }), { kind: 'allow' })

  // requireObservation: false 时 input 类无需观察。
  const relaxed = createPolicy({ config: { requireObservation: false, requireApproval: false } })
  assert.deepEqual(relaxed.evaluate({ tool: 'Click' }), { kind: 'allow' })

  // 显式声明 action 时以声明为准。
  const declared = createPolicy({ config: { requireApproval: false } })
  assert.equal(declared.evaluate({ tool: 'Nope', action: 'input' }).code, DECISION_CODES.NO_OBSERVATION)
})

test('STALE_OBSERVATION by age and by newer generation', () => {
  const clock = fakeClock()
  const policy = createPolicy({
    config: { requireApproval: false, maxObservationAgeMs: 15000 },
    now: clock,
  })

  // 年龄在阈值内 → 放行。
  assert.deepEqual(
    policy.evaluate({ tool: 'Click', observation: observation(), screenObservation: screen() }),
    { kind: 'allow' },
  )

  clock.advance(20000)
  const tooOld = policy.evaluate({ tool: 'Click', observation: observation(), screenObservation: screen() })
  assert.equal(tooOld.kind, 'deny')
  assert.equal(tooOld.code, DECISION_CODES.STALE_OBSERVATION)
  assert.match(tooOld.reason, /过期/)

  // recordedAt 别名同样生效。
  clock.set(T0)
  clock.advance(16000)
  const alias = policy.evaluate({
    tool: 'Click',
    observation: { recordedAt: T0, generation: 5, process: { pid: 100 } },
    screenObservation: { generation: 5, process: { pid: 100 } },
  })
  assert.equal(alias.code, DECISION_CODES.STALE_OBSERVATION)

  // 有更新的截图 generation → 过期，即使时间很新。
  clock.set(T0)
  const newerShot = policy.evaluate({
    tool: 'Click',
    observation: observation({ generation: 5 }),
    screenObservation: screen({ generation: 6 }),
  })
  assert.equal(newerShot.kind, 'deny')
  assert.equal(newerShot.code, DECISION_CODES.STALE_OBSERVATION)
  assert.match(newerShot.reason, /generation 6 > 5/)

  // generation 相同 → 放行。
  assert.deepEqual(
    policy.evaluate({
      tool: 'Click',
      observation: observation({ generation: 7 }),
      screenObservation: screen({ generation: 7 }),
    }),
    { kind: 'allow' },
  )

  // 缺少 generation 信息时不误判。
  assert.deepEqual(
    policy.evaluate({
      tool: 'Click',
      observation: { at: T0, process: { pid: 100 } },
      screenObservation: { process: { pid: 100 } },
    }),
    { kind: 'allow' },
  )
})

test('PROCESS_CHANGED on pid / executable / title drift', () => {
  const policy = createPolicy({ config: { requireApproval: false }, now: fakeClock() })
  const base = { tool: 'Click', observation: observation() }

  const pidChange = policy.evaluate({
    ...base,
    screenObservation: screen({ process: { pid: 200, executable: 'C:\\a.exe', title: 'Window A' } }),
  })
  assert.equal(pidChange.kind, 'deny')
  assert.equal(pidChange.code, DECISION_CODES.PROCESS_CHANGED)
  assert.match(pidChange.reason, /pid 100 → 200/)

  const exeChange = policy.evaluate({
    ...base,
    screenObservation: screen({ process: { pid: 100, executable: 'C:\\B.EXE', title: 'Window A' } }),
  })
  assert.equal(exeChange.code, DECISION_CODES.PROCESS_CHANGED)

  const titleChange = policy.evaluate({
    ...base,
    screenObservation: screen({ process: { pid: 100, executable: 'C:\\a.exe', title: 'Window B' } }),
  })
  assert.equal(titleChange.code, DECISION_CODES.PROCESS_CHANGED)
  assert.match(titleChange.reason, /Window B/)

  // 一致 → 放行；进程信息缺失 → 不误判。
  assert.deepEqual(policy.evaluate({ ...base, screenObservation: screen() }), { kind: 'allow' })
  assert.deepEqual(
    policy.evaluate({ tool: 'Click', observation: observation({ process: null }), screenObservation: screen() }),
    { kind: 'allow' },
  )

  assert.equal(diffProcessBeforeAfter({ pid: 1 }, { pid: 2 }), 'pid 1 → 2')
  assert.equal(diffProcessBeforeAfter(null, { pid: 2 }), null)
})

test('approval: fail closed without an asker, ask with one', () => {
  const noAsker = createPolicy({ config: {} })
  const denied = noAsker.evaluate({ tool: 'PowerShell', args: { command: 'dir' } })
  assert.equal(denied.kind, 'deny')
  assert.equal(denied.code, DECISION_CODES.APPROVAL_UNAVAILABLE)
  assert.match(denied.reason, /fail closed/)

  const withAsker = createPolicy({ config: {}, ask: async () => true })
  const askable = withAsker.evaluate({ tool: 'mcp__winmcp__PowerShell' })
  assert.equal(askable.kind, 'ask')
  assert.equal(askable.code, DECISION_CODES.APPROVAL_REQUIRED)
  assert.match(askable.reason, /人工批准/)

  // observe 类永远不需要审批。
  assert.deepEqual(withAsker.evaluate({ tool: 'Snapshot' }), { kind: 'allow' })
  // requireApproval: false 直接放行 system 类。
  const noApproval = createPolicy({ config: { requireApproval: false } })
  assert.deepEqual(noApproval.evaluate({ tool: 'PowerShell' }), { kind: 'allow' })
})

test('grant() lets a retry through, is one-shot, and expires', () => {
  const clock = fakeClock()
  const policy = createPolicy({ config: { approvalTtlMs: 1000 }, now: clock })

  // 没有授权 → 无通道，fail closed。
  assert.equal(policy.evaluate({ tool: 'PowerShell' }).code, DECISION_CODES.APPROVAL_UNAVAILABLE)

  const record = policy.grant('PowerShell')
  assert.equal(record.tool, 'powershell')
  assert.equal(record.expiresAt, T0 + 1000)
  assert.equal(policy.listApprovals().length, 1)

  // 重试通过。
  assert.deepEqual(policy.evaluate({ tool: 'mcp__winmcp__PowerShell' }), { kind: 'allow' })
  // 一次性：已消耗，再次调用又需要审批。
  assert.equal(policy.evaluate({ tool: 'PowerShell' }).code, DECISION_CODES.APPROVAL_UNAVAILABLE)
  assert.equal(policy.listApprovals().length, 0)

  // 过期：时间推进超过 TTL 后授权失效。
  policy.grant('PowerShell')
  clock.advance(1001)
  assert.equal(policy.evaluate({ tool: 'PowerShell' }).code, DECISION_CODES.APPROVAL_UNAVAILABLE)
  assert.equal(policy.listApprovals().length, 0)

  // 未过期的授权 + 有审批通道 → 直接放行。
  const withAsker = createPolicy({ config: {}, ask: () => true, now: clock })
  withAsker.grant('PowerShell', { ttlMs: 5000 })
  assert.deepEqual(withAsker.evaluate({ tool: 'PowerShell' }), { kind: 'allow' })

  // 多次使用授权。
  withAsker.grant('Registry', { uses: 2 })
  assert.deepEqual(withAsker.evaluate({ tool: 'Registry' }), { kind: 'allow' })
  assert.deepEqual(withAsker.evaluate({ tool: 'Registry' }), { kind: 'allow' })
  assert.equal(withAsker.evaluate({ tool: 'Registry' }).kind, 'ask')

  // revoke 立即失效。
  withAsker.grant('App')
  assert.equal(withAsker.revoke('app'), true)
  assert.equal(withAsker.revoke('App'), false)
  assert.equal(withAsker.evaluate({ tool: 'App' }).kind, 'ask')
})

test('requireApprovalForInput gates mutating input but not observe', () => {
  const clock = fakeClock()
  const policy = createPolicy({
    config: { requireApprovalForInput: true },
    ask: () => true,
    now: clock,
  })
  const askable = policy.evaluate({
    tool: 'Click',
    observation: observation(),
    screenObservation: screen(),
  })
  assert.equal(askable.kind, 'ask')
  assert.equal(askable.code, DECISION_CODES.APPROVAL_REQUIRED)
  assert.match(askable.reason, /输入类/)

  policy.grant('Click')
  assert.deepEqual(
    policy.evaluate({ tool: 'Click', observation: observation(), screenObservation: screen() }),
    { kind: 'allow' },
  )
  assert.deepEqual(policy.evaluate({ tool: 'Snapshot' }), { kind: 'allow' })
})

test('evaluate reports every decision to the injected audit, and audit errors are swallowed', () => {
  const audit = collectingAudit()
  const policy = createPolicy({ config: { requireApproval: false }, audit, now: fakeClock() })
  const decision = policy.evaluate({ tool: 'Click', observation: observation() })
  assert.equal(decision.kind, 'allow')
  assert.equal(audit.entries.length, 1)
  assert.equal(audit.entries[0].decision, 'allow')
  assert.equal(audit.entries[0].allowed, true)
  assert.equal(audit.entries[0].action, 'policy.evaluate')
  assert.equal(audit.entries[0].observationId, 'obs-1')

  const denied = policy.evaluate({ tool: 'Click' })
  assert.equal(denied.code, DECISION_CODES.NO_OBSERVATION)
  assert.equal(audit.entries.length, 2)
  assert.equal(audit.entries[1].decision, 'deny')
  assert.equal(audit.entries[1].allowed, false)
  assert.equal(audit.entries[1].code, DECISION_CODES.NO_OBSERVATION)

  // 审计抛错绝不能影响决策。
  const broken = createPolicy({
    config: { requireApproval: false },
    now: fakeClock(),
    audit: {
      record() {
        throw new Error('audit exploded')
      },
    },
  })
  assert.doesNotThrow(() => broken.evaluate({ tool: 'Click', observation: observation() }))
  assert.equal(broken.evaluate({ tool: 'Click', observation: observation() }).kind, 'allow')

  // grant 也会写入审计。
  const grantAudit = collectingAudit()
  createPolicy({ config: {}, audit: grantAudit }).grant('PowerShell')
  assert.equal(grantAudit.entries[0].action, 'policy.grant')
})

test('request-level config overrides the policy-level config', () => {
  const policy = createPolicy({
    config: { requireApprovalForInput: true },
    ask: () => true,
    now: fakeClock(),
  })
  const askable = policy.evaluate({
    tool: 'Click',
    observation: observation(),
    screenObservation: screen(),
  })
  assert.equal(askable.kind, 'ask')
  assert.deepEqual(
    policy.evaluate({
      tool: 'Click',
      observation: observation(),
      screenObservation: screen(),
      config: { requireApprovalForInput: false },
    }),
    { kind: 'allow' },
  )
})

test('describeDecision produces one readable Chinese sentence', () => {
  assert.match(describeDecision({ kind: 'allow' }), /允许/)
  const deny = describeDecision({ kind: 'deny', code: 'TOOL_DENIED', reason: '在黑名单里' })
  assert.match(deny, /拒绝/)
  assert.match(deny, /TOOL_DENIED/)
  assert.match(deny, /在黑名单里/)
  const ask = describeDecision({ kind: 'ask', code: 'APPROVAL_REQUIRED', reason: '需要确认' })
  assert.match(ask, /人工确认/)
  assert.match(ask, /需要确认/)
  assert.equal(typeof describeDecision(null), 'string')
  assert.equal(typeof describeDecision({ kind: 'weird' }), 'string')
})
