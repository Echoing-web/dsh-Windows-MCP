/**
 * 规格覆盖门（SDD × BDD 的执行点）。
 *
 * ## 它阻止的三类腐化
 * 1. **改了规格没加测试**：规格里新增 `S-XXX-00`，但没有测试声明它 → 失败。
 * 2. **写了场景没实现验收**：feature 里新增场景，但没有测试声明覆盖它 → 失败。
 * 3. **声明还在但测试没跑**：测试文件里 `covers: [...]` 仍在，但对应测试被删/被跳过
 *    → 运行时登记缺失 → 失败。（这是只靠正则扫源码会漏掉的盲点。）
 *
 * 另外还会检查**悬空引用**：测试声明了一个规格里不存在的编号或 feature 里不存在的
 * 场景（通常是改名后忘了同步），也算失败。
 *
 * 门禁失败信息必须给出**下一步动作**，而不是只说"覆盖率不足"。
 *
 * ## ⚠️ 必须单进程运行
 * 「运行时覆盖」这一层依赖所有测试文件在**同一个进程**里执行，这样
 * `harness/link.js` 的登记表才能看到全部声明。默认的每文件一个子进程会把它隔离掉。
 * 因此统一用：`node --test --experimental-test-isolation=none`
 * （已写进 package.json 的 `scripts.test`）。
 * 下面的「单进程前置检查」会在误用时立刻失败并说明原因，而不是让覆盖门给出误导性结论。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { parseFeature } from './gherkin.js'
import { analyzeCoverage, renderCoverageReport, walk, PROJECT_ROOT } from './coverage.js'
import { registered, coverage } from '../harness/link.js'

coverage({
  spec: ['S-CFG-01'],
  covers: [],
})

const SPEC_FILES = [join(PROJECT_ROOT, 'spec', 'SYS_SPEC.md')]
const FEATURE_DIR = join(PROJECT_ROOT, 'features')
const TEST_DIR = join(PROJECT_ROOT, 'test')

function analyze() {
  return analyzeCoverage({
    specFiles: SPEC_FILES,
    featureFiles: walk(FEATURE_DIR, ['.feature']),
    testFiles: walk(TEST_DIR, ['.test.mjs', '.mjs']),
    parseFeature,
  })
}

test('规格文档存在且包含可判定的需求编号', () => {
  const result = analyze()
  assert.ok(result.requirements.size >= 25, `需求条目太少：${result.requirements.size}`)
  // 每个编号的摘要必须非空——空的编号说明只是被提到，而不是一条规格
  for (const [id, summary] of result.requirements) {
    assert.notEqual(summary, '', `需求 ${id} 没有摘要文本`)
  }
})

test('feature 目录存在且每个 feature 都能被解析', () => {
  const files = walk(FEATURE_DIR, ['.feature'])
  assert.ok(files.length >= 1, 'features/ 下没有任何 .feature 文件')
  for (const file of files) {
    const parsed = parseFeature(readFileSync(file, 'utf8'), file)
    assert.ok(parsed.scenarios.length >= 1)
  }
})

test('场景里点名的规则编号必须真实存在（V2 缺陷形状的根治）', async () => {
  // 覆盖率门只按**场景名**对应 feature 与测试，从不看步骤文本。
  // 于是出现过：场景写 `规则编号 registry-delete-hk`（代码里没有这个 id），
  // 测试把 action 伪造成不存在的动作 → 全绿，而真机上规则永远命中不了。
  // 这道门把"场景声称会拦"与"代码真的会拦"钉在一起。
  const { checkRuleRefs } = await import('./rule-refs.js')
  const { DEFAULT_COMMAND_RULES } = await import('../../lib/commands.js')
  const result = checkRuleRefs({
    featureFiles: walk(FEATURE_DIR, ['.feature']),
    knownRuleIds: DEFAULT_COMMAND_RULES.map((rule) => rule.id),
  })
  assert.ok(result.checked >= 3, `应至少校验到 3 处规则编号引用，实际 ${result.checked}`)
  assert.deepEqual(
    result.unknown.map((item) => `${relative(PROJECT_ROOT, item.file)}:${item.line} → ${item.id}`),
    [],
    '以下场景点名的规则编号在 lib/commands.js 里不存在（改名后忘了同步？）',
  )
})

test('静态覆盖：每条规格都有测试声明', () => {
  const result = analyze()
  assert.deepEqual(
    result.missingSpecs,
    [],
    `以下规格条目没有任何测试声明（在测试文件里用 coverage({ spec: [...] }) 声明）：\n  ${result.missingSpecs.join('\n  ')}`,
  )
})

test('静态覆盖：每个行为场景都有测试声明', () => {
  const result = analyze()
  assert.deepEqual(
    result.missingScenarios,
    [],
    `以下行为场景没有测试覆盖（在测试文件里用 coverage({ covers: [...] }) 声明，并写出同名 test）：\n  ${result.missingScenarios.join('\n  ')}`,
  )
})

test('没有悬空引用：测试声明的规格与场景都必须真实存在', () => {
  const result = analyze()
  assert.deepEqual(result.unknownSpecs, [], `测试声明了不存在的规格编号：${result.unknownSpecs.join(', ')}`)
  assert.deepEqual(
    result.unknownScenarios,
    [],
    `测试声明了不存在的场景（通常是改名后忘了同步）：\n  ${result.unknownScenarios.join('\n  ')}`,
  )
})

/**
 * 反向门：行为测试文件里**每一个** `test('Feature :: Scenario')` 都必须被声明。
 *
 * 为什么需要这一条：已有的门只检查"声明的场景是否有测试"，是单向的。
 * 于是新写一个行为测试却忘了加 `coverage({ covers: [...] })` 时，门会自动放行——
 * 覆盖率看起来还是 100%，而规格与测试的对应关系已经悄悄脱节。
 * 这条门把"忘了声明"从静默变成失败。
 *
 * ## 命名约定（本文件同时是约定的执行点）
 * - `test('Feature :: Scenario')` —— **场景测试**，必须与 feature 里的场景一字不差，
 *   且必须被 `coverage({ covers: [...] })` 声明；
 * - `test('补强｜说明')` —— **补强测试**，是可选的额外断言，不参与场景覆盖统计。
 *
 * 这个约定让"哪些测试是场景的验收、哪些是额外保险"变成机器可判定的，
 * 而不是靠人记。任何不带 `::` 或不带 `补强｜` 前缀的名字都会在这里失败。
 */
const SCENARIO_TEST_RE = /^\s*(?:test|it)\(\s*['"`]([^'"`]*::[^'"`]*)['"`]/gm
const REINFORCE_PREFIX = '补强｜'
const ANY_TEST_RE = /^\s*(?:test|it)\(\s*['"`]([^'"`]+)['"`]/gm

test('反向覆盖：行为测试里出现的场景名都必须被 coverage() 声明', () => {
  const behaviorFiles = walk(join(PROJECT_ROOT, 'test', 'behaviors'), ['.test.mjs'])
  assert.ok(behaviorFiles.length >= 1, '没有找到任何行为测试文件')

  const declared = new Set([...registered().covers, ...analyze().scenarios.keys()])
  const undeclared = []
  for (const file of behaviorFiles) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(SCENARIO_TEST_RE)) {
      const name = match[1].trim()
      if (!declared.has(name)) undeclared.push(`${relative(PROJECT_ROOT, file).replaceAll('\\', '/')} → ${name}`)
    }
  }
  assert.deepEqual(
    undeclared,
    [],
    '以下行为测试的场景名没有在 coverage({ covers: [...] }) 里声明，覆盖率会因此虚高：\n  ' +
      undeclared.join('\n  ') +
      '\n修法：在对应测试文件顶部的 coverage({ covers: [...] }) 里补上该场景名（并与 feature 文件一字不差）。',
  )
})

test('正向实现门：每个被声明的场景都必须真的有一个同名 test', () => {
  const behaviorFiles = walk(join(PROJECT_ROOT, 'test', 'behaviors'), ['.test.mjs'])
  const implemented = new Set()
  for (const file of behaviorFiles) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(SCENARIO_TEST_RE)) implemented.add(match[1].trim())
  }
  const declared = analyze().scenarios.keys()
  const missing = [...declared].filter((id) => !implemented.has(id)).sort()
  assert.deepEqual(
    missing,
    [],
    '以下场景被声明为"已覆盖"，但没有对应的同名 test：\n  ' +
      missing.join('\n  ') +
      '\n修法：补上同名 test，或从 coverage({ covers: [...] }) 里移除该声明。',
  )
})

test('命名约定：行为测试名要么是场景名，要么带「补强｜」前缀', () => {
  const behaviorFiles = walk(join(PROJECT_ROOT, 'test', 'behaviors'), ['.test.mjs'])
  const offenders = []
  for (const file of behaviorFiles) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(ANY_TEST_RE)) {
      const name = match[1].trim()
      if (name.includes('::') || name.startsWith(REINFORCE_PREFIX)) continue
      offenders.push(`${relative(PROJECT_ROOT, file).replaceAll('\\', '/')} → ${name}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下行为测试既不是场景测试（缺 "Feature :: Scenario"），也没有 "${REINFORCE_PREFIX}" 前缀：\n  ` +
      offenders.join('\n  ') +
      `\n修法：要么改成场景名并与 feature 对齐，要么加 "${REINFORCE_PREFIX}" 前缀表明它是补强断言（不参与覆盖统计）。`,
  )
})

test('单进程前置检查：运行时登记必须能看到多个测试文件', () => {
  const runtime = registered()
  assert.ok(
    runtime.files.size >= 2,
    `运行时登记只看到 ${runtime.files.size} 个文件，说明测试被按文件隔离成多个进程在跑。\n` +
      '请用：node --test --experimental-test-isolation=none\n' +
      '（package.json 的 scripts.test 已经这么设了；若你是手工跑的，请补上该参数。）\n' +
      '为什么必须这样：覆盖门的「运行时」层要确认每个声明都真的被执行过，跨进程看不到彼此。',
  )
})

test('运行时覆盖：每个声明了场景的测试文件都必须真的执行过', () => {
  // 先做前置检查：否则在隔离模式下这条会给出误导性的"缺覆盖"结论
  const runtime = registered()
  assert.ok(runtime.files.size >= 2, '需要单进程模式，见上一条测试的说明')
  assert.ok(runtime.covers.size > 0, '没有任何运行时场景登记，说明测试文件没有调用 coverage()')
  // 运行时登记的必须真实存在
  const result = analyze()
  for (const id of runtime.covers) {
    assert.ok(result.scenarios.has(id), `运行时登记的 "${id}" 不对应任何 feature 场景`)
  }
  // 反向：每个 feature 场景都必须被运行时登记过
  for (const id of result.scenarios.keys()) {
    assert.ok(runtime.covers.has(id), `场景 "${id}" 有静态声明但运行时没有登记——测试可能被跳过或未执行`)
  }
})

test('运行时覆盖：每个需求都必须被运行时登记', () => {
  const runtime = registered()
  assert.ok(runtime.files.size >= 2, '需要单进程模式，见前述说明')
  const result = analyze()
  for (const id of result.requirements.keys()) {
    assert.ok(runtime.spec.has(id), `需求 ${id} 有静态声明但运行时没有登记——测试可能被跳过或未执行`)
  }
})

test('覆盖报告渲染器输出可读的 Markdown（含缺口高亮）', () => {
  const result = analyze()
  const report = renderCoverageReport(result, { generatedAt: '2026-01-01T00:00:00.000Z' })
  assert.match(report, /^# 规格覆盖报告/)
  assert.match(report, /生成时间：2026-01-01T00:00:00\.000Z/)
  assert.match(report, /## 需求覆盖/)
  assert.match(report, /## 行为场景覆盖/)
  // 表格行数应与条目数一致（+2 行表头）
  const specRows = report.split('\n').filter((line) => /^\| `S-[A-Z]+-\d{2}`/.test(line))
  assert.equal(specRows.length, result.requirements.size)
})
