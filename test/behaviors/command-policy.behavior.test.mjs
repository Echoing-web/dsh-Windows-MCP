/**
 * BDD 行为测试：features/command-policy.feature
 *
 * 这一组验证「按内容判定」的最小机制。刻意包含**否定性断言**
 * （正常命令必须放行、"没看懂"不得拒绝），因为命令级策略最常见的失败方式
 * 不是漏拦，而是**误拦到让人整体关掉它**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createHost } from '../harness/host.js'
import { coverage } from '../harness/link.js'
import {
  evaluateCommand,
  extractOperation,
  normalizeOperation,
  DEFAULT_COMMAND_RULES,
  ARGUMENT_LAYOUT,
  WINDOWS_MCP_ARGUMENTS,
  WINDOWS_MCP_BOOLEAN_ARGUMENTS,
} from '../../lib/commands.js'
import { createPolicy, createKillSwitch, DECISION_CODES } from '../../lib/policy.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

coverage({
  spec: ['S-CMD-01', 'S-CMD-02', 'S-CMD-03', 'S-CMD-04', 'S-CMD-05', 'S-CMD-06', 'S-CMD-07', 'S-CMD-08', 'S-CMD-09', 'S-CMD-10', 'S-CMD-11', 'S-CMD-12', 'S-CMD-13', 'S-CMD-14', 'S-CMD-15', 'S-CMD-16', 'S-CMD-17'],
  covers: [
    '命令级策略 :: 递归删除被拒绝',
    '命令级策略 :: 格式化卷被拒绝',
    '命令级策略 :: 删除注册表根被拒绝',
    '命令级策略 :: 只读查询注册表不被拒绝',
    '命令级策略 :: 正常只读命令放行',
    '命令级策略 :: 大小写与路径分隔符不影响判定',
    '命令级策略 :: 反斜杠与正斜杠写法都命中同一条规则',
    '命令级策略 :: 取不到操作文本时拒绝而不是放行',
    '命令级策略 :: 参数不是对象时拒绝',
    '命令级策略 :: 未命中任何规则时放行',
    '命令级策略 :: 显式豁免可以让内置规则不拒绝',
    '命令级策略 :: 命令级拒绝优先于审批',
    '命令级策略 :: 关闭命令级策略后不再判定内容',
    '命令级策略 :: 规格里的规则表与代码逐字一致',
  ],
})
/** 造一个只关心命令级判定的策略（不要求审批，避免审批结论干扰断言）。 */
function commandPolicy(overrides = {}) {
  const config = { serverName: 'winmcp', requireApproval: false, commandRulesEnabled: true, ...overrides }
  const policy = createPolicy({
    config,
    killSwitch: createKillSwitch({}),
    audit: null,
    ask: undefined,
    now: () => 1000,
  })
  return (tool, args) => policy.evaluate({ tool: `mcp__winmcp__${tool}`, action: 'system', observation: null, args, config })
}

// ── Scenario: 递归删除被拒绝 ────────────────────────────────────────────────
test('命令级策略 :: 递归删除被拒绝', () => {
  const decide = commandPolicy()
  const decision = decide('PowerShell', { command: 'Remove-Item -Recurse -Force C:\\' })
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.code, DECISION_CODES.COMMAND_RULE)
  assert.equal(decision.ruleId, 'recursive-delete')
  // S-CMD-05：理由必须说明为什么危险
  assert.match(decision.reason, /不可撤销|递归/)
})

// ── Scenario: 格式化卷被拒绝 ────────────────────────────────────────────────
test('命令级策略 :: 格式化卷被拒绝', () => {
  const decision = commandPolicy()('PowerShell', { command: 'Format-Volume -DriveLetter D' })
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.ruleId, 'format-volume')
})

// ── Scenario: 删除注册表根被拒绝 ────────────────────────────────────────────
test('命令级策略 :: 删除注册表根被拒绝', () => {
  const decision = commandPolicy()('Registry', { mode: 'delete', path: 'HKLM:\\Software\\Foo' })
  assert.equal(decision.kind, 'deny')
  // 规范化后是 `delete hklm:/software/foo`，命中复合规则（配置单元 ∧ 删除动作）
  assert.equal(decision.ruleId, 'registry-hive-destructive-hklm')
})

// ── Scenario: 正常只读命令放行 ──────────────────────────────────────────────
test('命令级策略 :: 只读查询注册表不被拒绝', () => {
  // 假阳性会让人整体关掉这个功能，所以反向断言和正向断言同等重要
  for (const mode of ['get', 'list']) {
    const decision = commandPolicy()('Registry', { mode, path: 'HKLM:\\Software\\Microsoft' })
    assert.equal(decision.kind, 'allow', `mode=${mode} 是只读查询，必须放行`)
  }
})

test('命令级策略 :: 正常只读命令放行', () => {
  const decision = commandPolicy()('PowerShell', { command: 'Get-Date' })
  assert.equal(decision.kind, 'allow')
})

// ── Scenario: 大小写与路径分隔符不影响判定 ──────────────────────────────────
test('命令级策略 :: 大小写与路径分隔符不影响判定', () => {
  const decision = commandPolicy()('PowerShell', { command: 'remove-item   -RECURSE  -force' })
  assert.equal(decision.kind, 'deny', '大小写与多余空白不得导致漏判')
  assert.equal(decision.ruleId, 'recursive-delete')
})

// ── Scenario: 反斜杠与正斜杠写法都命中同一条规则 ────────────────────────────
test('命令级策略 :: 反斜杠与正斜杠写法都命中同一条规则', () => {
  const decide = commandPolicy()
  const back = decide('Registry', { mode: 'delete', path: 'HKLM:\\Software\\A' })
  const forward = decide('Registry', { mode: 'delete', path: 'HKLM:/Software/A' })
  assert.equal(back.kind, 'deny')
  assert.equal(forward.kind, 'deny', '正斜杠写法不得绕过')
  assert.equal(back.ruleId, forward.ruleId, '两种写法应命中同一条规则')
})

// ── Scenario: 取不到操作文本时拒绝而不是放行 ────────────────────────────────
test('命令级策略 :: 取不到操作文本时拒绝而不是放行', () => {
  const decision = commandPolicy()('PowerShell', {})
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.code, DECISION_CODES.CMD_UNEVALUABLE)
  assert.match(decision.reason, /command|字段/, '理由应说明缺少哪个字段')
})

// ── Scenario: 参数不是对象时拒绝 ────────────────────────────────────────────
test('命令级策略 :: 参数不是对象时拒绝', () => {
  const decision = commandPolicy()('PowerShell', 'not-an-object')
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.code, DECISION_CODES.CMD_UNEVALUABLE)
})

// ── Scenario: 未命中任何规则时放行 ──────────────────────────────────────────
test('命令级策略 :: 未命中任何规则时放行', () => {
  const decision = commandPolicy()('PowerShell', { command: 'Get-Process explorer' })
  assert.equal(decision.kind, 'allow', '未命中必须放行，不得因"没看懂"拒绝')
})

// ── Scenario: 显式豁免可以让内置规则不拒绝 ──────────────────────────────────
test('命令级策略 :: 显式豁免可以让内置规则不拒绝', () => {
  const decide = commandPolicy({ allowRules: ['recursive-delete'] })
  const decision = decide('PowerShell', { command: 'Remove-Item -Recurse C:\\temp\\mine' })
  assert.notEqual(decision.code, DECISION_CODES.COMMAND_RULE, '豁免后不得因该规则拒绝')
  // 底层纯函数要能把"哪条规则被放过"报出来，供审计记录
  const raw = evaluateCommand({
    tool: 'PowerShell',
    args: { command: 'Remove-Item -Recurse C:\\temp\\mine' },
    config: { allowRules: ['recursive-delete'] },
  })
  assert.equal(raw.kind, 'exempt')
  assert.equal(raw.ruleId, 'recursive-delete')
})

// ── Scenario: 命令级拒绝优先于审批 ──────────────────────────────────────────
test('命令级策略 :: 命令级拒绝优先于审批', () => {
  // 要求审批 + 有审批通道：若命令级判定排在审批之后，这里会返回 ask
  const config = { serverName: 'winmcp', requireApproval: true, commandRulesEnabled: true }
  const policy = createPolicy({
    config,
    killSwitch: createKillSwitch({}),
    audit: null,
    ask: () => 'allowed-once',
    now: () => 1000,
  })
  const decision = policy.evaluate({
    tool: 'mcp__winmcp__PowerShell',
    action: 'system',
    observation: null,
    args: { command: 'Format-Volume -DriveLetter D' },
    config,
  })
  assert.equal(decision.kind, 'deny', '危险命令必须直接拒绝，而不是拿去问人')
  assert.equal(decision.code, DECISION_CODES.COMMAND_RULE)
})

// ── Scenario: 关闭命令级策略后不再判定内容 ──────────────────────────────────
test('命令级策略 :: 关闭命令级策略后不再判定内容', () => {
  const decision = commandPolicy({ commandRulesEnabled: false })('PowerShell', {
    command: 'Remove-Item -Recurse -Force C:\\',
  })
  assert.notEqual(decision.code, DECISION_CODES.COMMAND_RULE, '关闭后不应命中命令规则')
  assert.notEqual(decision.code, DECISION_CODES.CMD_UNEVALUABLE)
})

// ── Scenario: 规格里的规则表与代码逐字一致 ──────────────────────────────────
test('命令级策略 :: 规格里的规则表与代码逐字一致', () => {
  // S-CMD-11：这是关于**安全**的错误陈述——
  // 表里多写一条会让人以为某危险操作被拦（其实没有）；
  // 少写一条会让人以为某操作安全（其实被拦）。
  const spec = readFileSync(join(ROOT, 'spec', 'SYS_SPEC.md'), 'utf8')
  const documented = [...spec.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|\s*`([^`]+)`\s*\|/gm)]
    .map((match) => ({ id: match[1], pattern: match[2] }))
    .filter((row) => row.id !== 'recursive-delete' || row.pattern.startsWith('remove-item'))
  const codeById = new Map(DEFAULT_COMMAND_RULES.map((rule) => [rule.id, rule.pattern]))

  const missingFromSpec = DEFAULT_COMMAND_RULES.filter(
    (rule) => !documented.some((row) => row.id === rule.id),
  )
  // 复合规则（requires）在表里以 *(复合)* 说明条件，没有可逐字比对的单个子串
  const missingSimple = missingFromSpec.filter((rule) => !Array.isArray(rule.requires) || rule.requires.length === 0)
  assert.deepEqual(
    missingSimple.map((rule) => rule.id),
    [],
    '这些子串规则在代码里存在但规格表没写',
  )
  // 复合规则也必须在表里出现（只是 pattern 无法逐字比对）
  const missingCompound = missingFromSpec
    .filter((rule) => Array.isArray(rule.requires) && rule.requires.length > 0)
    .filter((rule) => !new RegExp(`\\\`${rule.id}\\\``).test(spec))
  assert.deepEqual(missingCompound.map((rule) => rule.id), [], '这些复合规则在规格表里没写')

  const documentedButAbsent = documented.filter((row) => !codeById.has(row.id))
  assert.deepEqual(
    documentedButAbsent.map((row) => row.id),
    [],
    '这些规则 id 规格表写了但代码里没有',
  )

  for (const row of documented) {
    // 复合规则在表里写的是 *(复合)* 说明，不做逐字比对
    if (row.id.startsWith('registry-hive-destructive-')) continue
    assert.equal(codeById.get(row.id), row.pattern, `规则 ${row.id} 的 pattern 与规格不一致`)
  }
})

// ══ 补强：纯函数层的边界 ═══════════════════════════════════════════════════

test('补强｜normalizeOperation 恰好做三件事', () => {
  assert.equal(normalizeOperation('  Remove-Item   -Recurse\t-Force  '), 'remove-item -recurse -force')
  assert.equal(normalizeOperation('HKLM:\\Software\\A'), 'hklm:/software/a')
  assert.equal(normalizeOperation('a/b\\c'), 'a/b/c')
  assert.equal(normalizeOperation(''), '')
  assert.equal(normalizeOperation(null), '')
  // 不去引号、不展开变量 —— 那是解析器的活，超出本模块立场
  assert.equal(normalizeOperation('"C:\\My Dir"'), '"c:/my dir"')
  assert.equal(normalizeOperation('$env:USERPROFILE'), '$env:userprofile')
})

test('补强｜斜杠归一化必须真的被规则依赖（变异测试逼出来的）', () => {
  // 变异测试发现：把 `[\\/]+` 改成 `[\\]+`（只归一化反斜杠）时套件依然全绿。
  // 原因是我原来的等价性测试用的是 `hklm:\` vs `hklm:/`，
  // 而规则 pattern 是 `hklm:`（斜杠在它**后面**），所以归一化对命中毫无影响
  // —— 那个测试"通过了"，但它测的东西与归一化无关。
  //
  // 这条测试要求 pattern **跨越**分隔符，这样只有归一化才能让两种写法都命中。
  const decide = commandPolicy()
  const back = decide('PowerShell', { command: 'remove-item -path hklm:\\Software\\A' })
  const forward = decide('PowerShell', { command: 'remove-item -path hklm:/Software/A' })
  assert.equal(back.kind, 'deny')
  assert.equal(forward.kind, 'deny', '正斜杠写法必须与反斜杠写法一样被拦')
  assert.equal(back.ruleId, 'registry-remove-hklm')
  assert.equal(forward.ruleId, 'registry-remove-hklm')
  // 直接断言拼装结果本身，让归一化失效时立刻可见
  const op = extractOperation('PowerShell', { command: 'remove-item -path hklm:\\A' })
  assert.equal(op.normalized, 'remove-item -path hklm:/a')
})

test('补强｜extractOperation 按类目拼装字段，缺失字段跳过', () => {
  const ps = extractOperation('PowerShell', { command: 'Get-Date' })
  assert.equal(ps.category, 'PowerShell')
  assert.equal(ps.normalized, 'get-date')
  assert.equal(ps.fields, 1)

  const reg = extractOperation('Registry', { mode: 'set', path: 'HKCU:\\A', name: 'X' })
  assert.equal(reg.normalized, 'set hkcu:/a x')

  const fs = extractOperation('FileSystem', { mode: 'delete', path: 'C:\\a', recursive: true })
  assert.equal(fs.normalized, 'delete c:/a recursive', '布尔修饰符必须进入操作文本')

  const fsSingle = extractOperation('FileSystem', { mode: 'delete', path: 'C:\\a', recursive: false })
  assert.equal(fsSingle.normalized, 'delete c:/a', 'false 不得进入操作文本（否则会误命中递归规则）')

  const none = extractOperation('Snapshot', {})
  assert.equal(none.fields, 0)
  assert.equal(none.normalized, '')
})

test('补强｜不需要操作文本的类目不做"取不到"判定', () => {
  // Snapshot 不属于需要命令文本的类目：即使参数为空也不该报 CMD_UNEVALUABLE
  const decision = evaluateCommand({ tool: 'Snapshot', args: {}, config: {} })
  assert.equal(decision.kind, 'allow')
})

test('补强｜"没传参数"与"传了空参数"必须区分', () => {
  // 没传 args：这次判定没有内容依据 → 跳过命令级判定
  const absent = evaluateCommand({ tool: 'PowerShell', config: {} })
  assert.equal(absent.kind, 'allow', '未提供参数时不应判为不可评估')

  // 传了 {}：调用方声称这是真实参数却给不出命令文本 → 必须拒绝
  const empty = evaluateCommand({ tool: 'PowerShell', args: {}, config: {} })
  assert.equal(empty.kind, 'deny')
  assert.equal(empty.code, 'CMD_UNEVALUABLE')

  // 传了非对象同理
  const wrongType = evaluateCommand({ tool: 'PowerShell', args: 'x', config: {} })
  assert.equal(wrongType.kind, 'deny')
  assert.equal(wrongType.code, 'CMD_UNEVALUABLE')

  // 传了可取到字段的参数 → 正常判定
  const ok = evaluateCommand({ tool: 'PowerShell', args: { command: 'Get-Date' }, config: {} })
  assert.equal(ok.kind, 'allow')
})

test('补强｜空/空白命令文本必须判为不可评估（对抗性 N1）', () => {
  // 这是真实可达的：`{command: ''}` 会被拼装成空串，
  // 于是所有规则都不命中 → 放行。但"命令文本为空"恰恰是**判定不了**，
  // 必须拒绝而不是放行。规范化后为空 ⇔ 一个字段都取不到。
  for (const args of [
    { command: '' },
    { command: '   ' },
    { command: '\t\n' },
    { mode: '' },
  ]) {
    const tool = 'command' in args ? 'PowerShell' : 'Registry'
    const decision = evaluateCommand({ tool, args, config: {} })
    assert.equal(decision.kind, 'deny', `${tool} ${JSON.stringify(args)} 必须拒绝`)
    assert.equal(decision.code, 'CMD_UNEVALUABLE', `${tool} ${JSON.stringify(args)} 应为不可评估`)
  }
  // 取到但值为 0 是"取到了字段"（String(0) = '0' 非空），走规则匹配而不是不可评估
  const zero = evaluateCommand({ tool: 'Registry', args: { path: 0 } , config: {} })
  assert.equal(zero.kind, 'allow', 'path=0 规范化后是 "0"，属"取到了"')
})

test('补强｜commandRulesEnabled=false 必须由策略层与纯函数层一致生效（对抗性 N2）', () => {
  // 规格未说明该开关由哪一层生效。实测过：策略层正确跳过，
  // 而直接调 evaluateCommand 仍然拒绝 —— 同一个开关两套行为是不可接受的。
  const dangerous = { command: 'Format-Volume -DriveLetter D' }
  const viaPolicy = commandPolicy({ commandRulesEnabled: false })('PowerShell', dangerous)
  assert.notEqual(viaPolicy.code, DECISION_CODES.COMMAND_RULE)
  const viaPure = evaluateCommand({ tool: 'PowerShell', args: dangerous, config: { commandRulesEnabled: false } })
  assert.notEqual(viaPure.code, 'COMMAND_RULE', '纯函数也必须尊重该开关')
  assert.equal(viaPure.kind, 'allow')
})

test('补强｜内置规则表本身必须自洽', () => {
  const ids = new Set()
  for (const rule of DEFAULT_COMMAND_RULES) {
    assert.ok(typeof rule.id === 'string' && rule.id !== '', '每条规则都要有 id')
    assert.equal(ids.has(rule.id), false, `规则 id 重复：${rule.id}`)
    ids.add(rule.id)
    assert.ok(typeof rule.reason === 'string' && rule.reason.length >= 6, `规则 ${rule.id} 的理由太短`)
    // 规则必须有命中条件（子串或复合），否则它永远不会生效 —— 等于"写了但没用"
    const hasPattern = typeof rule.pattern === 'string' && rule.pattern !== ''
    const hasRequires = Array.isArray(rule.requires) && rule.requires.length > 0
    assert.ok(hasPattern || hasRequires, `规则 ${rule.id} 既没有 pattern 也没有 requires`)
    // 子串型规则的 pattern 必须已是规范化形态，否则永远匹配不上
    if (hasPattern) {
      assert.equal(normalizeOperation(rule.pattern), rule.pattern, `规则 ${rule.id} 的 pattern 未规范化`)
    }
  }
})

test('补强｜Registry 类目下删除配置单元必须真的被拦（对抗性 V2，真机复核过）', () => {
  // 关键点：字段名必须来自**上游真实 schema**。实机 introspection：
  // Registry 用 `mode`（get/set/delete/list）+ `path`，没有 `action` 字段。
  //
  // 第一版这里用的是猜出来的 `action`，于是规则在真机上永远命中不了
  // （真机验证：`Registry mode=delete HKLM:\...` 一路走到了 PowerShell）。
  // 单元测试用了同样猜错的键，所以全绿 —— 测的是空气。
  const decide = commandPolicy()
  const decision = decide('Registry', { mode: 'delete', path: 'HKLM:\\Software\\Foo' })
  assert.equal(decision.kind, 'deny', 'Registry mode=delete 删除 HKLM 必须被拒绝')
  assert.equal(decision.ruleId, 'registry-hive-destructive-hklm')

  const hkcr = decide('Registry', { mode: 'delete', path: 'HKCR:\\Foo' })
  assert.equal(hkcr.kind, 'deny')
  assert.equal(hkcr.ruleId, 'registry-hive-destructive-hkcr')

  // 只读查询不能被杀掉（假阳性会让人整体关掉这个功能）
  for (const mode of ['get', 'list']) {
    const safe = decide('Registry', { mode, path: 'HKLM:\\Software\\Microsoft' })
    assert.equal(safe.kind, 'allow', `Registry mode=${mode} 是只读，必须放行`)
  }
  // 删除用户配置单元不受这条规则影响（HKCU 风险低得多，且这是常见操作）
  const hkcu = decide('Registry', { mode: 'delete', path: 'HKCU:\\Software\\Mine' })
  assert.equal(hkcu.kind, 'allow')
})

test('补强｜拼装用的字段名必须在上游真实 schema 里（真机验证的教训）', () => {
  // 这条测试的存在理由：真机验证发现 Registry 的删除根本没被拦，
  // 因为拼装读的是猜出来的 `action`，而真实工具用 `mode`。
  // "规则看起来对、真机上永远不触发"是最危险的一类缺陷，必须由测试守住。
  for (const [category, groups] of Object.entries(ARGUMENT_LAYOUT)) {
    const real = WINDOWS_MCP_ARGUMENTS[category]
    if (!real) continue
    for (const group of groups) {
      // 每条候选都必须在真实 schema 里 —— 不接受"猜的别名"。
      // 只要求"至少一个存在"是不够的：那会放过 `[['mode'], ['action'], …]` 里的
      // `action`，而它一旦被回退命中就是"静默用了一个不存在的键"。
      for (const key of group) {
        assert.ok(
          real.includes(key),
          `${category} 的候选字段 "${key}" 不在上游 schema 里（真实：${real.join(',')}）`,
        )
      }
    }
  }
  // 反向：真实 schema 里的**动作字段**必须被读到，否则规则永远命中不了
  for (const [category, required] of Object.entries({
    PowerShell: 'command',
    Registry: 'mode',
    FileSystem: 'mode',
    Process: 'mode',
  })) {
    const groups = ARGUMENT_LAYOUT[category] ?? []
    assert.ok(
      groups.some((group) => group.includes(required)),
      `${category} 没有读取真实字段 ${required}，规则将永远无法命中`,
    )
  }
  // 每个类目都不得留"猜的字段"：布局里出现的每个键都必须可追溯到真实 schema
  for (const category of Object.keys(ARGUMENT_LAYOUT)) {
    const real = WINDOWS_MCP_ARGUMENTS[category]
    if (!real) continue
    const used = ARGUMENT_LAYOUT[category].flat()
    const speculative = used.filter((key) => !real.includes(key))
    assert.deepEqual(speculative, [], `${category} 含未核实的字段：${speculative.join(', ')}`)
  }
})

test('补强｜FileSystem 递归删除驱动器根被拦，普通递归删除放行', () => {
  const decide = commandPolicy()
  for (const path of ['C:\\', 'D:\\', 'c:/']) {
    const decision = decide('FileSystem', { mode: 'delete', path, recursive: true })
    assert.equal(decision.kind, 'deny', `递归删除 ${path} 必须被拒绝`)
    assert.equal(decision.ruleId, 'filesystem-wipe-drive-root')
  }
  // 正常开发操作必须放行 —— 假阳性会让人整体关掉这个功能
  for (const path of ['D:\\projects\\build', 'C:\\Users\\me\\tmp\\x'] ) {
    const decision = decide('FileSystem', { mode: 'delete', path, recursive: true })
    assert.equal(decision.kind, 'allow', `递归删除 ${path} 是正常操作，必须放行`)
  }
  const single = decide('FileSystem', { mode: 'delete', path: 'C:\\tmp\\a.txt' })
  assert.equal(single.kind, 'allow')
})

test('补强｜recursive 的真值判断必须逐字照抄上游（V2：我曾把它放宽成假阳性）', () => {
  // 上游真源码（tools/filesystem.py:47）：
  //   recursive = recursive is True or (isinstance(recursive, str) and recursive.lower() == 'true')
  // 即**只有**布尔 True，或字符串 lower() 后恰好等于 'true'；**不 trim**。
  //
  // 我第一版为了"更安全"放宽成也认 '1'/'yes'/非零数，并把这条写进规格。
  // 那是**假阳性**：`recursive:'yes'` 被拒，而上游根本不会递归删除。
  // 对抗性验证把这处规格错误与实现一起抓了出来（V2）。
  const decide = commandPolicy()
  for (const flag of [true, 'true', 'True', 'TRUE']) {
    const decision = decide('FileSystem', { mode: 'delete', path: 'C:\\', recursive: flag })
    assert.equal(decision.kind, 'deny', `recursive=${JSON.stringify(flag)} 上游判为真，必须拦`)
    assert.equal(decision.ruleId, 'filesystem-wipe-drive-root')
  }
  // 上游判为**假**的写法：必须**在卷根上也放行**——只有用卷根才能区分真值判断，
  // 用普通目录测不出问题（普通目录本来就不命中卷根规则，宽严都一样）。
  // 我第一版正是在这里用了 `C:\tmp\a.txt`，于是变异测试发现该断言毫无鉴别力。
  for (const flag of [' true ', '1', 'yes', 1, false, 'false', 'False', '0', '', null, undefined]) {
    const decision = decide('FileSystem', { mode: 'delete', path: 'C:\\', recursive: flag })
    assert.equal(
      decision.kind,
      'allow',
      `recursive=${JSON.stringify(flag)} 在上游不是递归删除，卷根删除也不得误拦（V2 是假阳性）`,
    )
  }
  // 普通目录在所有取值下都不应命中卷根规则（反向对照）
  for (const flag of ['yes', '1']) {
    assert.equal(
      decide('FileSystem', { mode: 'delete', path: 'C:\\tmp\\a.txt', recursive: flag }).kind,
      'allow',
    )
  }
})

test('补强｜卷根的 Windows 命名空间写法不得绕过（V1 失败开放）', () => {
  // `\\?\C:\` 与 `\\.\C:\` 表示**同一个卷根**，只是要求不做路径规范化。
  // 上游 `Path('\\\\?\\C:\\').is_dir()` 为真 → 会走 `shutil.rmtree` 清空分区。
  // 不做前缀归一化时它们变成 `/?/c:/` / `/./c:/`，与规则的 `c:/` 不匹配 → 整条绕过。
  const decide = commandPolicy()
  for (const path of ['C:\\', 'C:', 'C:/', '\\\\?\\C:\\', '\\\\.\\C:\\', '//?/C:/', '//./C:/']) {
    const decision = decide('FileSystem', { mode: 'delete', path, recursive: true })
    assert.equal(decision.kind, 'deny', `递归删除卷根 ${JSON.stringify(path)} 必须被拒绝`)
    assert.equal(decision.ruleId, 'filesystem-wipe-drive-root')
  }
  // 前缀不得把非根路径也变成根
  const nested = decide('FileSystem', {
    mode: 'delete',
    path: '\\\\?\\C:\\Users\\me\\build',
    recursive: true,
  })
  assert.equal(nested.kind, 'allow', '带前缀的普通目录仍是普通目录，必须放行')
})

test('补强｜Process 的 force 必须被读到，否则强杀规则在该类目下不可达（V3）', () => {
  // 上游 tools/process.py：`force` 决定 `p.kill()`（无条件强杀）还是 `p.terminate()`。
  // 它是**可区分字段**；漏读它等于"有个能区分的字段却没人用"，
  // 于是 `Process {mode:kill, force:true}` 与普通 terminate 在规则眼里一样。
  const decide = commandPolicy()
  for (const flag of [true, 'true', 'True']) {
    const decision = decide('Process', { mode: 'kill', pid: 4, force: flag })
    assert.equal(decision.kind, 'deny', `Process 强杀（force=${JSON.stringify(flag)}）必须被拦`)
    assert.equal(decision.ruleId, 'process-force-kill')
  }
  // 不带 force 是 terminate：按 S-CMD-14 不在命令级拦截（交由审批层）
  assert.equal(decide('Process', { mode: 'kill', pid: 4 }).kind, 'allow')
  assert.equal(decide('Process', { mode: 'kill', pid: 4, force: false }).kind, 'allow')
  // list 模式即使带 force 也不是强杀
  assert.equal(decide('Process', { mode: 'list', force: true }).kind, 'allow')
})

test('补强｜参数表必须与上游真实 schema 全等（N15/N16：漏登记不得被容忍）', () => {
  // 把"真实 schema"抄写在测试里，与代码里的登记表**全等比对**。
  // 为什么需要：`WINDOWS_MCP_ARGUMENTS` 一度自称"只记录策略会读的键"，
  // 于是**漏登记永远查不出**——测试看到"布局没用到它"就通过，
  // 而规则因此永远命中不了。`Process` 的 `force` 正是这样漏掉的（对抗性 V3）。
  //
  // 来源：live 工具 schema（实测抓取）+ 上游源码
  // `tools/process.py`（含 sort_by/limit/force）、`tools/filesystem.py`、
  // `tools/registry.py`、`_recon_tools/REPORT-mcp-contract.md`。
  const AUTHORITATIVE = {
    PowerShell: ['command', 'timeout'],
    Registry: ['mode', 'path', 'name', 'value', 'type'],
    FileSystem: [
      'mode', 'path', 'destination', 'content', 'pattern',
      'recursive', 'append', 'overwrite', 'offset', 'limit', 'encoding', 'show_hidden',
    ],
    Process: ['mode', 'name', 'pid', 'sort_by', 'limit', 'force'],
    App: ['mode', 'name', 'window_loc', 'window_size', 'executable', 'args', 'cwd'],
    Clipboard: ['mode', 'text'],
  }
  for (const [category, keys] of Object.entries(AUTHORITATIVE)) {
    assert.deepEqual(
      [...(WINDOWS_MCP_ARGUMENTS[category] ?? [])].sort(),
      [...keys].sort(),
      `${category} 的参数登记与上游 schema 不一致（漏登记会让规则静默失效）`,
    )
  }
  const AUTHORITATIVE_BOOLEAN = {
    FileSystem: ['recursive', 'append', 'overwrite', 'show_hidden'],
    Process: ['force'],
    PowerShell: [],
    Registry: [],
    App: [],
    Clipboard: [],
  }
  for (const [category, keys] of Object.entries(AUTHORITATIVE_BOOLEAN)) {
    assert.deepEqual(
      [...(WINDOWS_MCP_BOOLEAN_ARGUMENTS[category] ?? [])].sort(),
      [...keys].sort(),
      `${category} 的布尔参数登记与上游不一致`,
    )
    for (const key of keys) {
      assert.ok(
        (WINDOWS_MCP_ARGUMENTS[category] ?? []).includes(key),
        `${category}.${key} 登记为布尔但不在参数表里`,
      )
    }
  }
  // 内部一致性：布局读取的键必须是参数表的子集
  for (const [category, groups] of Object.entries(ARGUMENT_LAYOUT)) {
    for (const key of groups.flat()) {
      assert.ok(
        (WINDOWS_MCP_ARGUMENTS[category] ?? []).includes(key),
        `布局读取了 ${category}.${key}，但它不在参数表里`,
      )
    }
  }
})

test('补强｜注册表配置单元别名不得绕过（HKEY_LOCAL_MACHINE 等）', () => {
  // PowerShell 接受 `HKEY_LOCAL_MACHINE:\...` 与 `Registry::HKEY_LOCAL_MACHINE\...`
  // 作为 `HKLM:` 的等价写法。只匹配 `hklm:` 会漏掉这些，等于留了一条绕过路径。
  const decide = commandPolicy()
  for (const path of [
    'HKEY_LOCAL_MACHINE:\\Software\\Foo',
    'HKEY_LOCAL_MACHINE:\\Software\\Foo',
    'Registry::HKEY_LOCAL_MACHINE\\Software\\Foo',
    'Registry::HKEY_LOCAL_MACHINE:\\Software\\Foo',
  ]) {
    const decision = decide('Registry', { mode: 'delete', path })
    assert.equal(decision.kind, 'deny', `${path} 是 HKLM 的等价写法，必须拦`)
  }
  for (const path of ['HKEY_CLASSES_ROOT\\Foo', 'Registry::HKEY_CLASSES_ROOT\\Foo']) {
    const decision = decide('Registry', { mode: 'delete', path })
    assert.equal(decision.kind, 'deny', `${path} 是 HKCR 的等价写法，必须拦`)
  }
})

test('补强｜注册表值名里的动作词不得造成假阳性', () => {
  // 操作文本是 `<mode> <path> <name> <value>`，因此 `name` 位里出现
  // `remove`/`clear` 这类词时规则不应命中——那是**值名**，不是动作。
  // 假阳性会让人整体关掉这个功能。
  const decide = commandPolicy()
  for (const name of ['Remove', 'clear', 'delete', 'Move', 'rename']) {
    const decision = decide('Registry', { mode: 'get', path: 'HKLM:\\Software\\App', name })
    assert.equal(decision.kind, 'allow', `读取值名为 ${name} 的值不是破坏操作，必须放行`)
  }
  for (const name of ['Remove', 'clear']) {
    const list = decide('Registry', { mode: 'list', path: 'HKLM:\\Software', name })
    assert.equal(list.kind, 'allow', `列出以 ${name} 为名的子项不是破坏操作，必须放行`)
  }
  // 真正的删除动作仍在首位，必须被拦
  const real = decide('Registry', { mode: 'delete', path: 'HKLM:\\Software\\App' })
  assert.equal(real.kind, 'deny')
})

test('补强｜App 启动解释器是一条绕过命令级策略的执行路径（真机自检发现）', () => {
  // 发现经过：`winmcp_doctor` 第一次真机运行就报出
  //   App 参数名：缺登记=[] 多登记=["args","cwd","executable","window_loc","window_size"]
  // 即 `App` 能带 `executable` + `args` 启动任意程序，而命令级策略读不到它 ——
  // 于是 `App(mode=launch_executable, executable="powershell.exe", args=[...])`
  // 完全绕过 PowerShell 的命令文本规则。这是**执行路径**，不是普通窗口操作。
  const decide = commandPolicy()
  const interpreters = [
    'powershell.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'pwsh',
    'cmd.exe',
    'C:\\Windows\\System32\\cmd.exe',
    'wscript.exe',
    'cscript.exe',
    'mshta.exe',
    'rundll32.exe',
    'regsvr32.exe',
    'msiexec.exe',
    'certutil.exe',
    'bitsadmin.exe',
    'installutil.exe',
    'wmic.exe',
  ]
  for (const executable of interpreters) {
    const decision = decide('App', {
      mode: 'launch_executable',
      executable,
      args: ['-Command', 'whoami'],
    })
    assert.equal(decision.kind, 'deny', `通过 App 启动 ${executable} 必须被拦（绕过路径）`)
    assert.equal(decision.ruleId, 'app-launch-interpreter')
  }
  // `launch` 模式（按开始菜单名启动）同样是执行路径
  const byName = decide('App', { mode: 'launch', name: 'powershell', args: ['-enc', 'AAAA'] })
  assert.equal(byName.kind, 'deny')

  // 反向：普通应用必须放行（假阳性会让人整体关掉这个功能）
  for (const args of [
    { mode: 'launch', name: 'notepad' },
    { mode: 'launch_executable', executable: 'C:\\Windows\\System32\\notepad.exe' },
    { mode: 'switch', name: 'Untitled - Notepad' },
    { mode: 'resize', name: 'Untitled - Notepad', window_loc: [0, 0], window_size: [800, 600] },
  ]) {
    const decision = decide('App', args)
    assert.equal(decision.kind, 'allow', `${JSON.stringify(args)} 是正常窗口操作，必须放行`)
  }
})

test('补强｜App 的参数登记必须与上游全等（S-CMD-16 的真机校验）', () => {
  // 真机 schema 实测：mode/name/window_loc/window_size/executable/args/cwd
  assert.deepEqual(
    [...WINDOWS_MCP_ARGUMENTS.App].sort(),
    ['args', 'cwd', 'executable', 'mode', 'name', 'window_loc', 'window_size'].sort(),
    'App 参数登记必须覆盖上游全部参数（漏登记会让规则静默失效）',
  )
})

test('补强｜配置规则只能追加，不能移除内置规则', () => {
  const config = { commandRules: [{ id: 'my-rule', pattern: 'danger-verb', reason: '自定义危险动词。' }] }
  // 自定义规则生效
  const custom = evaluateCommand({ tool: 'PowerShell', args: { command: 'Invoke danger-verb now' }, config })
  assert.equal(custom.kind, 'deny')
  assert.equal(custom.ruleId, 'my-rule')
  // 内置规则依然生效（配置里没有它，但不得被"覆盖掉"）
  const builtin = evaluateCommand({ tool: 'PowerShell', args: { command: 'Format-Volume -DriveLetter D' }, config })
  assert.equal(builtin.kind, 'deny')
  assert.equal(builtin.ruleId, 'format-volume')
})

test('补强｜畸形自定义规则被跳过而不是让判定崩掉', () => {
  const config = {
    commandRules: [null, 'x', { id: '' }, { pattern: 'y' }, { id: 'ok', pattern: '' }, { id: 'good', pattern: 'boom' }],
  }
  const decision = evaluateCommand({ tool: 'PowerShell', args: { command: 'say boom' }, config })
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.ruleId, 'good', '只有形态完整的自定义规则应生效')
})

test('补强｜命令级拒绝会写入审计条目', async () => {
  const config = { serverName: 'winmcp', requireApproval: false, commandRulesEnabled: true }
  // 用真实策略，才能同时验证「命令级拒绝」与「审计落条目」两件事
  const policy = createPolicy({
    config,
    killSwitch: createKillSwitch({}),
    audit: null,
    ask: undefined,
    now: () => 1000,
  })
  const host = createHost({ config, policy })
  try {
    const decision = await host.pre(
      host.exec('mcp__winmcp__PowerShell', { command: 'Format-Volume -DriveLetter D' }),
    )
    assert.equal(decision.kind, 'deny')
    assert.equal(decision.info?.code, 'COMMAND_RULE')
    const denial = host.audit.read({ limit: 20 }).find((entry) => entry.decision === 'deny')
    assert.ok(denial, '命令级拒绝必须留审计')
    assert.equal(denial.code, 'COMMAND_RULE')
  } finally {
    host.cleanup()
  }
})
