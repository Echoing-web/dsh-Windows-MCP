/**
 * BDD 行为测试：features/doctor.feature
 *
 * 这一组验证"自检工具必须能发现假设漂移，而且不许给出虚假的健康结论"。
 * 后者比前者更重要：一个会说"全部正常"的自检工具，比没有自检更糟——
 * 它会让人停止怀疑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { diagnose, buildDoctorReport, DOCTOR_VERDICT } from '../../index.js'
import { coverage } from '../harness/link.js'
import { WINDOWS_MCP_ARGUMENTS } from '../../lib/commands.js'

coverage({
  spec: ['S-HOST-06', 'S-HOST-07', 'S-HOST-08'],
  covers: [
    '运行时自检 :: 上游参数与登记一致时报告通过',
    '运行时自检 :: 上游缺少本插件要读的字段时判为严重',
    '运行时自检 :: 上游多出未登记的字段时给出警告',
    '运行时自检 :: 自检必须只读',
    '运行时自检 :: 注册表不可读时必须报未知而不是正常',
    '运行时自检 :: 自检报告包含观测与策略状态',
  ],
})

/** 造一份与登记完全一致的工具 schema（形状对齐真实注册表）。 */
function conformingSchemas(serverName = 'winmcp') {
  const schemas = []
  for (const [tool, keys] of Object.entries(WINDOWS_MCP_ARGUMENTS)) {
    schemas.push({
      name: `mcp__${serverName}__${tool}`,
      inputSchema: { type: 'object', properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])) },
    })
  }
  return schemas
}

/** 最小可用的诊断输入。 */
function diagnoseWith(overrides = {}) {
  const store = {
    current: () => null,
    generation: () => 0,
    size: () => 0,
    history: () => [],
  }
  const killSwitch = { isEngaged: () => false, snapshot: () => ({ engaged: false }) }
  const audit = { stats: () => ({ entries: 0, bytes: 0, writeFailures: 0 }) }
  return diagnose({
    config: { serverName: 'winmcp', auditFile: '', commandRulesEnabled: true, annotateResults: true, injectContext: true },
    store,
    killSwitch,
    audit,
    agentKey: 'agent-1',
    toolSchemas: conformingSchemas(),
    now: () => 1_700_000_000_000,
    ...overrides,
  })
}

// ── Scenario: 上游参数与登记一致时报告通过 ──────────────────────────────────
test('运行时自检 :: 上游参数与登记一致时报告通过', () => {
  const result = diagnoseWith()
  assert.equal(result.verdict, DOCTOR_VERDICT.HEALTHY)
  assert.equal(result.ok, true)
  const schemaChecks = result.checks.filter((c) => c.kind === 'schema')
  assert.ok(schemaChecks.length > 0, '必须有 schema 比对项')
  for (const check of schemaChecks) {
    assert.equal(check.level, 'ok', `${check.name} 应为一致：${check.detail}`)
  }
  const text = buildDoctorReport(result)
  assert.match(text, /参数名与登记全等/)
})

// ── Scenario: 上游缺少本插件要读的字段时判为严重 ────────────────────────────
test('运行时自检 :: 上游缺少本插件要读的字段时判为严重', () => {
  // 这正是历史上 action/mode 那个缺陷的形状：插件读的键在真实注册表里不存在。
  const schemas = conformingSchemas().map((s) =>
    s.name.endsWith('__PowerShell')
      ? { ...s, inputSchema: { type: 'object', properties: { timeout: { type: 'number' } } } }
      : s,
  )
  const result = diagnoseWith({ toolSchemas: schemas })
  assert.notEqual(result.verdict, DOCTOR_VERDICT.HEALTHY, '缺字段必须判为不健康')
  assert.equal(result.ok, false)
  const failing = result.checks.find((c) => c.kind === 'schema' && c.level === 'critical')
  assert.ok(failing, '必须存在严重级 schema 差异')
  assert.match(failing.detail, /command/, '应指出缺的是 command')
  assert.match(failing.detail, /静默失效/, '应说明后果是规则静默失效')
})

// ── Scenario: 上游多出未登记的字段时给出警告 ────────────────────────────────
test('运行时自检 :: 上游多出未登记的字段时给出警告', () => {
  // 形状与历史上 `Process.force` 那个缺陷一致：上游新增了一个可区分字段，
  // 而插件登记表里没有它（于是相关规则可能漏拦）。
  // 注意：`force` 现在**已经登记**，所以这里必须用一个真正未登记的名字。
  const UNREGISTERED = 'undocumentedToggle'
  assert.equal(
    WINDOWS_MCP_ARGUMENTS.Process.includes(UNREGISTERED),
    false,
    '本测试需要一个确实未登记的名字（前提变了就换一个）',
  )
  const schemas = conformingSchemas().map((s) =>
    s.name.endsWith('__Process')
      ? {
          ...s,
          inputSchema: {
            type: 'object',
            properties: { ...s.inputSchema.properties, [UNREGISTERED]: { type: 'boolean' } },
          },
        }
      : s,
  )
  const result = diagnoseWith({ toolSchemas: schemas })
  const warning = result.checks.find((c) => c.kind === 'schema' && c.level === 'warn')
  assert.ok(warning, '未登记字段必须给出警告')
  assert.match(warning.detail, new RegExp(UNREGISTERED))
  // 结论是"降级"而不是"损坏"：多了字段不等于坏了，只是可能漏用。
  // 但 ok 仍为 false —— ok 的含义是"完全健康"，降级不该冒充健康。
  assert.equal(result.verdict, DOCTOR_VERDICT.DEGRADED)
  assert.equal(result.ok, false)
  assert.notEqual(result.verdict, DOCTOR_VERDICT.BROKEN)
})

// ── Scenario: 自检必须只读 ──────────────────────────────────────────────────
test('运行时自检 :: 自检必须只读', () => {
  let engaged = false
  let observed = false
  const killSwitch = {
    isEngaged: () => engaged,
    snapshot: () => ({ engaged }),
    engage: () => {
      engaged = true
    },
  }
  const store = {
    current: () => {
      observed = true
      return null
    },
    generation: () => 0,
    size: () => 0,
    history: () => [],
    record: () => {
      throw new Error('自检不得写观测桶')
    },
  }
  const before = engaged
  diagnoseWith({ killSwitch, store })
  assert.equal(engaged, before, '不得改变急停状态')
  assert.equal(observed, true, '允许读观测')
})

// ── Scenario: 注册表不可读时必须报未知而不是正常 ────────────────────────────
test('运行时自检 :: 注册表不可读时必须报未知而不是正常', () => {
  for (const toolSchemas of [null, undefined, [], 'not-an-array']) {
    const result = diagnoseWith({ toolSchemas })
    assert.notEqual(
      result.verdict,
      DOCTOR_VERDICT.HEALTHY,
      `注册表为 ${JSON.stringify(toolSchemas)} 时不得报健康——虚假健康结论比没有自检更糟`,
    )
    assert.equal(result.ok, false)
    assert.ok(
      result.checks.some((c) => c.level === 'unknown' || c.level === 'critical'),
      '应明确说明哪一项查不到',
    )
  }
})

// ── Scenario: 自检报告包含观测与策略状态 ────────────────────────────────────
test('运行时自检 :: 自检报告包含观测与策略状态', () => {
  const observation = {
    id: 'obs-7',
    tool: 'Screenshot',
    at: 1_700_000_000_000 - 5_000,
    cursor: { x: 10, y: 20 },
    region: { left: 0, top: 0, right: 2560, bottom: 1440 },
    originalSize: { width: 2560, height: 1440 },
    uiElements: [],
    focusedWindow: null,
    image: {},
  }
  const store = {
    current: () => observation,
    generation: () => 3,
    size: () => 1,
    history: () => [observation],
  }
  const result = diagnoseWith({ store })
  const text = buildDoctorReport(result)
  assert.match(text, /obs-7/, '报告应包含观测编号')
  assert.match(text, /5s|age/, '报告应包含观测年龄')
  assert.match(text, /命令级策略/, '报告应包含命令级策略状态')
})

test('补强｜任何检查抛错都不得让自检整体崩掉或报健康', () => {
  const hostile = {
    current: () => {
      throw new Error('store 炸了')
    },
    generation: () => 0,
    size: () => 0,
    history: () => [],
  }
  let result
  assert.doesNotThrow(() => {
    result = diagnoseWith({ store: hostile })
  }, '自检必须吞掉单项异常')
  assert.notEqual(result.verdict, DOCTOR_VERDICT.HEALTHY, '有检查失败时不得报健康')
  assert.ok(result.checks.some((c) => c.level === 'critical' || c.level === 'unknown'))
})

test('补强｜判定优先级：critical > unknown > warn > ok', () => {
  const schemas = conformingSchemas().map((s) =>
    s.name.endsWith('__PowerShell')
      ? { ...s, inputSchema: { type: 'object', properties: { timeout: { type: 'number' } } } }
      : s,
  )
  const withCritical = diagnoseWith({ toolSchemas: schemas })
  assert.equal(withCritical.verdict, DOCTOR_VERDICT.BROKEN)
})
