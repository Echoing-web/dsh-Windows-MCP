/**
 * BDD 行为测试：features/fail-closed.feature
 *
 * 这一组是**对抗性验证逼出来的**：验证者构造出一个反例——当策略返回一个
 * 无法识别的决策形状时，闸门会**整个跳过**新鲜度检查，于是"没有观测也能点击"
 * 被静默放行。这属于失败开放（fail-open），是安全类组件最不可接受的缺陷类型。
 *
 * 这些场景刻意覆盖"决策形状契约"：闸门只能接受**明确定义**的决策，
 * 其它一切都是拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHost, createMemoryAudit } from '../harness/host.js'
import { createVirtualClock } from '../harness/clock.js'
import { coverage } from '../harness/link.js'
import { createKillSwitch, createPolicy, DECISION_CODES } from '../../lib/policy.js'

coverage({
  spec: ['S-FAIL-01', 'S-FAIL-02', 'S-FAIL-03'],
  covers: [
    '失败关闭 :: 策略返回无法识别的决策形状时一律拒绝',
    '失败关闭 :: 无法识别的决策形状不得绕过新鲜度检查',
    '失败关闭 :: 策略抛异常或返回畸形值时不得让闸门崩掉',
    '失败关闭 :: 策略对象本身是畸形值时挂载不得抛异常',
    '失败关闭 :: 配置对象带抛错 getter 时挂载不得抛异常',
    '失败关闭 :: 已放行的输入动作必须已经过完整的新鲜度检查',
  ],
})

const CONFIG = { serverName: 'winmcp', maxObservationAgeMs: 60000 }

function hostWith(policy, config = CONFIG) {
  return createHost({ config, policy })
}

// ── Scenario: 策略返回无法识别的决策形状时一律拒绝 ──────────────────────────
test('失败关闭 :: 策略返回无法识别的决策形状时一律拒绝', async () => {
  // 对抗性验证者的原始反例：返回 `{}`。
  // 期望：没有观测的 Click 必须被拒（而不是因为策略"没说话"就放行）。
  const shapes = [
    { label: 'empty object', value: {} },
    { label: 'unknown kind', value: { kind: 'maybe' } },
    { label: 'allow-like but wrong kind', value: { kind: 'ok' } },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'string', value: 'allow' },
    { label: 'number', value: 1 },
    { label: 'array', value: [] },
  ]
  for (const { label, value } of shapes) {
    const host = hostWith({ evaluate: () => value })
    try {
      const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
      assert.equal(
        decision.kind,
        'deny',
        `策略返回 ${label} 时必须拒绝（失败关闭），实际 ${JSON.stringify(decision)}`,
      )
      assert.equal(
        decision.info?.code,
        'POLICY_ERROR',
        `策略返回 ${label} 时应给出机器可读的 POLICY_ERROR，实际 ${JSON.stringify(decision.info)}`,
      )
    } finally {
      host.cleanup()
    }
  }
})

test('失败关闭 :: 无法识别的决策形状不得绕过新鲜度检查', async () => {
  // 关键：即使策略"看起来在放行"，新鲜度也必须被评估。
  // 这里用一个会返回 {} 的策略 + 一个过期观测，期望不是 allow。
  const host = hostWith({ evaluate: () => ({}) })
  try {
    const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assert.notEqual(decision.kind, 'allow', '策略返回畸形形状时绝不能放行没有观测的点击')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 策略抛异常或返回畸形值时不得让闸门崩掉 ────────────────────────
test('失败关闭 :: 策略抛异常或返回畸形值时不得让闸门崩掉', async () => {
  const thowers = [
    { label: 'throws Error', value: () => { throw new Error('策略内部错误') } },
    { label: 'throws string', value: () => { throw '策略抛了个字符串' } },
    { label: 'throws null', value: () => { throw null } },
  ]
  for (const { label, value } of thowers) {
    const host = hostWith({ evaluate: value })
    try {
      let decision
      await assert.doesNotReject(async () => {
        decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
      }, `${label}：闸门不得把异常抛给调用方`)
      assert.equal(decision.kind, 'deny', `${label}：必须失败关闭`)
      assert.equal(decision.info?.code, 'POLICY_ERROR')
    } finally {
      host.cleanup()
    }
  }
})

test('失败关闭 :: 策略对象本身是畸形值时挂载不得抛异常', async () => {
  // S-HOST-04：插件自身的失败不得让宿主启动失败
  const brokenPolicies = [
    { label: 'no evaluate', value: {} },
    { label: 'evaluate is not a function', value: { evaluate: 42 } },
    { label: 'null', value: null },
  ]
  for (const { label, value } of brokenPolicies) {
    const host = hostWith(value)
    try {
      const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
      assert.equal(decision.kind, 'deny', `${label}：必须失败关闭`)
    } finally {
      host.cleanup()
    }
  }
})

test('失败关闭 :: 配置对象带抛错 getter 时挂载不得抛异常', () => {
  const hostile = {
    get serverName() { throw new Error('恶意 getter') },
    get maxObservationAgeMs() { throw new Error('恶意 getter') },
  }
  assert.doesNotThrow(() => {
    const host = createHost({ config: hostile })
    host.cleanup()
  }, 'S-HOST-04：配置读取失败不得让插件挂载失败')
})

// ── Scenario: 已放行的输入动作必须已经过完整的新鲜度检查 ────────────────────
test('失败关闭 :: 已放行的输入动作必须已经过完整的新鲜度检查', async () => {
  // 反向证明：当策略**明确**返回 allow 时才放行，且新鲜度仍然生效。
  const host = hostWith({ evaluate: () => ({ kind: 'allow' }) })
  try {
    // 无观测 → 必须被新鲜度拒掉，而不是被策略的 allow 直接带过
    const withoutObservation = await host.pre(host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assert.equal(withoutObservation.kind, 'deny')
    assert.equal(withoutObservation.info?.code, 'NO_OBSERVATION')

    // 有观测 → 放行
    await host.observeSnapshot()
    const allowed = await host.pre(host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    assert.equal(allowed.kind, 'allow')
  } finally {
    host.cleanup()
  }
})

test('补强｜放行与拒绝都留下审计（含 POLICY_ERROR）', async () => {
  const audit = createMemoryAudit()
  const host = createHost({ config: CONFIG, policy: { evaluate: () => ({}) }, audit, options: { audit } })
  try {
    await host.pre(host.exec('mcp__winmcp__Click', { loc: [10, 20] }))
    const denial = audit.entries.find((entry) => entry.decision === 'deny')
    assert.ok(denial, '必须留拒绝记录')
    assert.equal(denial.code, 'POLICY_ERROR')
  } finally {
    host.cleanup()
  }
})

// ── 补强｜对抗性验证报告中的其余发现 ────────────────────────────────────────
test('补强｜常见凭据键名必须全部被脱敏', async () => {
  const { redact } = await import('../../lib/audit.js')
  // 对抗性验证者指出最初的名单漏了这些词
  const secretKeys = [
    'authorization',
    'Authorization',
    'cookie',
    'session_id',
    'jwt',
    'bearer',
    'signature',
    'passwd',
    'pwd',
    'apiKey',
    'api_key',
    'SECRET_KEY',
    'token',
  ]
  for (const key of secretKeys) {
    const out = redact({ [key]: 'super-secret-value-1234' })
    assert.ok(
      !String(JSON.stringify(out)).includes('super-secret-value-1234'),
      `键名 ${key} 的值必须被脱敏，实际 ${JSON.stringify(out)}`,
    )
  }
  // 普通字段不得被误伤（否则审计会失去可读性）
  const benign = redact({ durationMs: 12, tool: 'Click', decision: 'allow', backend: 'dxcam', author: 'me' })
  assert.equal(benign.durationMs, 12)
  assert.equal(benign.tool, 'Click')
  assert.equal(benign.decision, 'allow')
  assert.equal(benign.backend, 'dxcam')
  assert.equal(benign.author, 'me')
})

test('补强｜非字符串的 based_on 必须被拒绝而不是静默忽略', async () => {
  const { extractBasedOn } = await import('../../lib/gate.js')
  const host = createHost({ config: CONFIG })
  try {
    await host.observeSnapshot()
    // 数字/数组这类"看起来像 id"的值不得被当成"没声明"而放行
    for (const bad of [99, ['obs-1'], { id: 'obs-1' }, true]) {
      const decision = await host.pre(host.exec('mcp__winmcp__Click', { loc: [1, 2], based_on: bad }))
      assert.equal(decision.kind, 'deny', `based_on=${JSON.stringify(bad)} 必须被拒绝而不是忽略`)
      assert.match(String(decision.reason), /based_on/i)
    }
    assert.equal(extractBasedOn({ based_on: 99 }), undefined, '非字符串应显式标记为非法')
  } finally {
    host.cleanup()
  }
})

test('补强｜history 的数量上限必须被遵守（含 0 与负数）', async () => {
  const { createObservationStore } = await import('../../lib/gate.js')
  const { buildObservation } = await import('../../lib/observe.js')
  const store = createObservationStore()
  for (let i = 0; i < 5; i++) {
    store.record('a', buildObservation({ value: 'Cursor Position: (1, 2)', content: [], tool: 'Snapshot', at: i }))
  }
  assert.equal(store.history('a', 0).length, 0, 'limit=0 必须返回空，而不是全部')
  assert.equal(store.history('a', -1).length, 0, '负数必须返回空')
  assert.equal(store.history('a', 2).length, 2)
})

test('补强｜requireApprovalForInput 单独设置也必须生效', async () => {
  const { createPolicy, createKillSwitch, DECISION_CODES } = await import('../../lib/policy.js')
  // 对抗性验证发现的配置静默失效：只设 requireApprovalForInput、不设 requireApproval 时，
  // 审批分支曾被整个跳过 → 输入动作一路放行。
  const config = { serverName: 'winmcp', requireApproval: false, requireApprovalForInput: true, approvalTtlMs: 60000 }
  const policy = createPolicy({
    config,
    killSwitch: createKillSwitch({}),
    audit: null,
    ask: undefined, // 无审批通道 → 必须失败关闭
    now: () => 1000,
  })
  const input = policy.evaluate({
    tool: 'mcp__winmcp__Click',
    action: 'input',
    observation: { id: 'obs-1', at: 1000 },
    config,
  })
  assert.equal(input.kind, 'deny', 'requireApprovalForInput 单独设置时输入动作必须被拦')
  assert.equal(input.code, DECISION_CODES.APPROVAL_UNAVAILABLE)

  // 只读工具不受影响
  const observe = policy.evaluate({
    tool: 'mcp__winmcp__Snapshot',
    action: 'observe',
    observation: null,
    config,
  })
  assert.equal(observe.kind, 'allow')
})

test('补强｜坐标换算系数为非法值时诊断不得谎称"缺少该行"', async () => {
  const { buildObservation } = await import('../../lib/observe.js')
  const { buildMapping } = await import('../../lib/coords.js')
  const obs = buildObservation({
    value: 'Screenshot Coordinate Scale: 0\nScreenshot Region: (0,0,100,100)',
    content: [],
    tool: 'Screenshot',
  })
  const mapping = buildMapping(obs)
  const text = mapping.diagnostics.join(' ')
  assert.match(text, /非法|无效|0/, `诊断应指出值非法，实际：${text}`)
  assert.doesNotMatch(text, /缺少/, '行是存在的，不得谎称缺少该行')
})

// ── 对抗性验证报告的「不可判定」项：把规格改成可判定 ────────────────────────

test('补强｜吸附只在小数缩放时启用，且往返误差界成立', async () => {
  const { buildObservation } = await import('../../lib/observe.js')
  const { buildMapping, imageToScreen, screenToImage } = await import('../../lib/coords.js')

  // scale >= 1：落在整数附近的吸附掉浮点噪声，其余保留 3 位小数
  const big = buildMapping(
    buildObservation({ value: 'Screenshot Coordinate Scale: 2\nScreenshot Region: (0,0,100,100)', content: [], tool: 'S' }),
  )
  // 100.0005 × 2 = 200.001，与整数相差 0.001 ≤ 0.002 → 吸附成 200
  assert.equal(imageToScreen(100.0005, 0, big).x, 200, '贴近整数时应吸附')
  // 100.005 × 2 = 200.01，离整数 0.01 > 0.002 → 保留 3 位
  assert.equal(imageToScreen(100.005, 0, big).x, 200.01, '远离整数时保留 3 位小数')

  // scale << 1 时吸附会把误差放大到远超 1 图像像素（实测最大 19.9）——
  // 因此必须**关闭**吸附，保证往返小误差。
  const tiny = buildMapping(
    buildObservation({ value: 'Screenshot Coordinate Scale: 0.0001\nScreenshot Region: (0,0,100,100)', content: [], tool: 'S' }),
  )
  let worst = 0
  for (const px of [1, 123, 4567, 89.5, 12345.678]) {
    const round = screenToImage(imageToScreen(px, 0, tiny).x, 0, tiny).x
    worst = Math.max(worst, Math.abs(round - px))
  }
  assert.ok(worst < 1, `小数缩放时往返误差必须 < 1 图像像素，实际最大 ${worst}`)
  // 误差界须满足 |Δpx| <= 0.002 / screenPerImagePx
  assert.ok(worst <= 0.002 / tiny.screenPerImagePx + 1e-9, `误差界不成立：${worst}`)
})

test('补强｜上游图片尺寸出现非正值时视为缺失', async () => {
  const { buildObservation } = await import('../../lib/observe.js')
  const { buildMapping } = await import('../../lib/coords.js')
  for (const line of ['Screenshot Original Size: (0,0)', 'Screenshot Original Size: (0,1440)']) {
    const obs = buildObservation({ value: `${line}\nScreenshot Region: (0,0,100,100)`, content: [], tool: 'S' })
    assert.equal(obs.originalSize, null, `${line} 应视为缺失`)
    const mapping = buildMapping(obs)
    assert.ok(mapping.diagnostics.some((d) => /Original Size|原始尺寸|非正/.test(d)), '应给出诊断')
  }
})

test('补强｜Region 行存在但不可解析时诊断必须说明"存在但无法解析"', async () => {
  const { buildObservation } = await import('../../lib/observe.js')
  const { buildMapping } = await import('../../lib/coords.js')
  const obs = buildObservation({
    value: 'Screenshot Region: (a,b,c,d)\nScreenshot Original Size: (100,100)',
    content: [],
    tool: 'S',
  })
  assert.equal(obs.region, null)
  assert.equal(obs.rawRegionInvalid, '(a,b,c,d)', '应保留非法原文供诊断')
  const text = buildMapping(obs).diagnostics.join(' ')
  assert.match(text, /存在但无法解析|无法解析/, `诊断应说明行存在但解析失败，实际：${text}`)
})

test('补强｜read() 只返回 JSON 对象记录，非对象行计入 skipped', async () => {
  const { createAuditLog } = await import('../../lib/audit.js')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-shape-'))
  try {
    const file = join(dir, 'a.jsonl')
    // 混合形状：合法对象 + 各种"是合法 JSON 但不是记录"的行
    writeFileSync(
      file,
      ['{"action":"ok","at":"2026-01-01T00:00:00.000Z"}', '5', '"x"', 'null', '[]', 'true', ''].join('\n'),
    )
    const audit = createAuditLog({ file, clock: () => 1_700_000_000_000 })
    const entries = audit.read({ limit: 50 })
    assert.equal(entries.length, 1, `只应返回对象记录，实际 ${JSON.stringify(entries)}`)
    assert.equal(entries[0].action, 'ok')
    // 非对象行必须被计入 skipped，而不是静默忽略（否则"丢了多少行"无从得知）
    const stats = audit.stats()
    assert.ok(stats.skipped >= 5, `应统计被跳过的行数，实际 ${stats.skipped}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('补强｜豁免必须留下 ruleExempted 审计（对抗性 V3 死赋值）', async () => {
  // 规格 S-CMD-07 承诺"谁在什么情况下用了豁免"可复盘。
  // 修之前 policy.js 只给 context.ruleExempted 赋值、emitAudit 从不读它 —— 死赋值。
  const config = {
    serverName: 'winmcp',
    requireApproval: false,
    commandRulesEnabled: true,
    allowRules: ['recursive-delete'],
  }
  const policy = createPolicy({
    config,
    killSwitch: createKillSwitch({}),
    audit: null,
    ask: undefined,
    now: () => 1_700_000_000_000,
  })
  const host = createHost({ config, policy })
  try {
    const decision = await host.pre(
      host.exec('mcp__winmcp__PowerShell', { command: 'Remove-Item -Recurse -Force C:\\tmp' }),
    )
    assert.equal(decision.kind, 'allow', '豁免后不应被拒')
    const entries = host.audit.read({ limit: 50 })
    const exemptedEntry = entries.find((entry) => entry.ruleExempted === 'recursive-delete')
    assert.ok(exemptedEntry, `审计里必须出现 ruleExempted（实际条目：${JSON.stringify(entries)}）`)
    assert.match(exemptedEntry.tool, /PowerShell/)
  } finally {
    host.cleanup()
  }
})

test('补强｜审批授权在恰好等于 TTL 时仍然有效（对抗性 V4）', () => {
  // A-11：`now - grantedAt > approvalTtlMs` 才失效；**恰好等于时仍然有效**。
  // 每个边界用**独立的策略实例**，否则"先推进 999 再推进 1000"会变成
  // 累计 +1999ms，测的就不是边界了（本测试第一版就踩了这个坑）。
  const boundary = (advanceMs) => {
    const config = { serverName: 'winmcp', requireApproval: true, approvalTtlMs: 1000 }
    const clock = createVirtualClock(10_000)
    const policy = createPolicy({
      config,
      killSwitch: createKillSwitch({}),
      audit: null,
      ask: () => 'allowed-once',
      now: () => clock.now(),
    })
    policy.grant('mcp__winmcp__PowerShell')
    clock.advance(advanceMs)
    return policy.evaluate({ tool: 'mcp__winmcp__PowerShell', args: { command: 'Get-Date' }, config })
  }

  assert.equal(boundary(0).kind, 'allow', '刚授权应立即有效')
  assert.equal(boundary(999).kind, 'allow', '未到 TTL 应有效')
  assert.equal(boundary(1000).kind, 'allow', '恰好等于 TTL 时授权仍然有效（A-11 裁决）')
  assert.notEqual(boundary(1001).kind, 'allow', '超过 TTL 必须失效')
})

test('补强｜越界有限时间戳不得抛错，也不得丢条目（对抗性 V6）', async () => {
  const { createAuditLog, normaliseEntry } = await import('../../lib/audit.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-range-'))
  try {
    // 有限但越界：new Date(1e20) 是 Invalid Date，曾经抛 RangeError
    for (const bad of [Number.MAX_SAFE_INTEGER * 100, 1e20, -1e20]) {
      assert.doesNotThrow(() => normaliseEntry({ action: 'x', at: bad }, 1), `at=${bad} 抛异常`)
      const entry = normaliseEntry({ action: 'x', at: bad }, 1_700_000_000_000)
      assert.equal(entry.at, new Date(1_700_000_000_000).toISOString(), `at=${bad} 应用写入时刻兜底`)
      assert.equal(entry.atCoerced, true, `at=${bad} 必须标记 atCoerced`)
    }
    // 端到端：条目必须真的落盘，而不是被吞掉并计 writeFailures
    const audit = createAuditLog({ file: join(dir, 'a.jsonl'), clock: () => 1_700_000_000_000 })
    const result = audit.record({ action: 'x', at: 1e20 })
    assert.equal(result.ok, true, `越界时间戳不得让条目写入失败：${JSON.stringify(result)}`)
    const entries = audit.read({ limit: 10 })
    assert.equal(entries.length, 1, '越界时间戳的条目必须仍然被写入（S-AUDIT-07）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('补强｜未提供 args 与提供了空 args 的区分（V8 契约 + N1 边界）', async () => {
  const { evaluateCommand } = await import('../../lib/commands.js')
  // 未提供 args：这次判定没有内容依据 → 跳过
  assert.equal(evaluateCommand({ tool: 'Registry', config: {} }).kind, 'allow')
  // 提供了 args 但取不到字段 → 不可评估 → 拒绝
  assert.equal(evaluateCommand({ tool: 'Registry', args: {}, config: {} }).code, 'CMD_UNEVALUABLE')
  // N1：值为空/空白 → 规范化后为空 → **也是**不可评估。
  // 曾经判为"取到了字段"→ 放行；而"命令文本为空"恰恰是判定不了。
  assert.equal(
    evaluateCommand({ tool: 'PowerShell', args: { command: '' }, config: {} }).code,
    'CMD_UNEVALUABLE',
    '空命令文本必须判为不可评估，而不是静默放行',
  )
  assert.equal(
    evaluateCommand({ tool: 'PowerShell', args: { command: '   ' }, config: {} }).code,
    'CMD_UNEVALUABLE',
  )
  // 取到非空值 → 走规则匹配
  assert.equal(evaluateCommand({ tool: 'PowerShell', args: { command: 'Get-Date' }, config: {} }).kind, 'allow')
})

test('补强｜配置值被强转或回退默认时必须留下警告', () => {
  // S-HOST-04 的"可执行修复信息"要求：静默把 `'x'` 变成 60000 是危险的——
  // 用户以为改了配置，实际被悄悄忽略。必须留下含"键名/收到值/采用值"的日志。
  const warnings = []
  const host = createHost({
    config: { serverName: 'winmcp', maxObservationAgeMs: 'x', annotateResults: 'nope' },
    log: { info: () => {}, warn: (message) => warnings.push(String(message)) },
  })
  try {
    const joined = warnings.join('\n')
    assert.match(joined, /maxObservationAgeMs/, '应指出是哪个键')
    assert.match(joined, /"x"|'x'/, '应指出收到的值')
    assert.match(joined, /60000/, '应指出采用的值')
    assert.match(joined, /annotateResults/, '布尔字段被强转同样应警告')
  } finally {
    host.cleanup()
  }
})

test('补强｜不可解析的 at 必须打上 atCoerced 标记', async () => {
  const { createAuditLog } = await import('../../lib/audit.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-at-'))
  try {
    const audit = createAuditLog({ file: join(dir, 'a.jsonl'), clock: () => 1_700_000_000_000 })
    audit.record({ at: 'garbage-not-a-date', action: 'x' })
    const [entry] = audit.read({ limit: 5 })
    assert.equal(entry.at, new Date(1_700_000_000_000).toISOString(), '不可解析时应落到写入时刻')
    assert.equal(entry.atCoerced, true, '必须标记该条目被强制转换过')
    // 正常的时间戳不应带这个标记
    audit.record({ at: 1_700_000_001_000, action: 'y' })
    const entries = audit.read({ limit: 5 })
    assert.equal(entries[1].atCoerced, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('补强｜急停的累计尝试次数与成功启用序号分离', async () => {
  const host = createHost({ config: CONFIG })
  try {
    await host.runTool('winmcp_kill', { action: 'engage', reason: '第一次' })
    await host.runTool('winmcp_kill', { action: 'engage', reason: '第二次' })
    const status = JSON.parse((await host.runTool('winmcp_kill', { action: 'status' })).text.replace(/^[^{]*/, ''))
    // engageCount 必须是**累计尝试次数**（含重复），这样"谁在反复尝试停手"才可诊断
    assert.equal(status.engageCount, 2, '重复 engage 也应计入累计尝试次数')
    // engageSeq 是成功启用序号，重复启用不递增
    assert.equal(status.engageSeq, 1, '成功启用序号不得被重复 engage 递增')
    // 首次启用的原因与时间保持不变（保持现场）
    assert.equal(status.reason, '第一次')
    assert.equal(status.releasedAt, null)
  } finally {
    host.cleanup()
  }
})

// ── 补强｜真实策略在急停下的行为（验证者的自我修正点）──────────────────────
test('补强｜真实策略下急停对输入拒绝并给出 KILL_SWITCH', async () => {
  const config = { serverName: 'winmcp', requireApproval: false, approvalTtlMs: 60000, maxObservationAgeMs: 60000 }
  // 装置创建急停实例，插件与策略共用同一个（见 host.js 的说明）
  const host = createHost({ config })
  const killSwitch = createKillSwitch({})
  const policy = createPolicy({ config, killSwitch, audit: null, ask: undefined, now: () => 1000 })
  // 用同一个 killSwitch 重新挂一台装置，确保策略与插件共享状态
  host.cleanup()
  const shared = createHost({ config, policy, killSwitch })
  try {
    await shared.runTool('winmcp_kill', { action: 'engage', reason: '验证' })
    const input = await shared.pre(shared.exec('mcp__winmcp__Click', { loc: [1, 2] }))
    assert.equal(input.kind, 'deny')
    assert.equal(input.info?.code, DECISION_CODES.KILL_SWITCH)
    // 只读工具仍然放行
    const observe = await shared.pre(shared.exec('mcp__winmcp__Snapshot'))
    assert.equal(observe.kind, 'allow')
  } finally {
    shared.cleanup()
  }
})
