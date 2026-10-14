/**
 * coverage.js —— 规格覆盖分析（SDD + BDD 的执行门）。
 *
 * ## 它解决什么问题
 * "所有行为都有测试"和"README 和代码一致"这两件事，靠人工检查必然随时间腐化。
 * 本模块把它们变成**可计算的**：从规格、feature、测试源码三处提取事实并做集合运算，
 * 输出缺口清单。`test/spec/coverage.test.mjs` 把缺口变成失败。
 *
 * ## 三张表
 * 1. **需求表**：`spec/SYS_SPEC.md` 里的 `S-XXX-00` 编号；
 * 2. **场景表**：`features/*.feature` 的 `Feature :: Scenario`；
 * 3. **测试表**：测试文件里 `spec:[...]` 与 `covers:[...]` 声明（见 test/harness/link.js）。
 *
 * 门禁：需求表 ⊆ 测试表、场景表 ⊆ 测试表，且两表都非空。
 * 测试表里出现需求表/场景表不存在的条目也算失败（防止改规格后忘记清理测试声明）。
 *
 * @module dsh_Windows_MCP/test/spec/coverage
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = join(here, '..', '..')

/**
 * 规格编号的合法域白名单。
 *
 * 为什么要白名单而不是 `S-[A-Z]+-\d{2}`：规格文档自身的**书写约定**里会出现
 * `S-<域>-<序号>` 这类占位说明，宽松正则会把它们当成真实需求，
 * 于是门禁会要求"给一个占位符写测试"。白名单让占位符天然不匹配。
 */
export const SPEC_DOMAINS = Object.freeze([
  'MAP',
  'GATE',
  'OBS',
  'SAFE',
  'AUDIT',
  'HOST',
  'CFG',
  // 桥接边界：MCP 形状的结果 → 观测 → 闸门 这一段链路（SYS_SPEC 第 8 章）。
  // 新增域必须同时加进这里，否则该域的规格不会被覆盖门统计（静默漏检）。
  'BRIDGE',
  // 失败关闭：对抗性验证者逼出来的决策形状契约（SYS_SPEC 第 2 章 S-FAIL-*）。
  'FAIL',
  // 持久上下文注入：把观测状态做成每轮重建的运行时上下文（SYS_SPEC 第 10 章 S-CTX-*）。
  'CTX',
  // 命令级策略：按内容判定危险操作（SYS_SPEC 第 11 章 S-CMD-*）。
  'CMD',
  // 审计可视化：把 JSONL 渲染成人能一眼看懂的视图（SYS_SPEC 第 12 章 S-VIEW-*）。
  'VIEW',
])

/** 需求编号：仅接受白名单域。 */
const SPEC_ID_RE = new RegExp(`\\bS-(?:${SPEC_DOMAINS.join('|')})-\\d{2}\\b`, 'g')

/** 测试声明块：只认 `coverage({ ... })` 的实参文本。 */
const COVERAGE_CALL_START = /\bcoverage\s*\(/g
const SPEC_DECL_RE = /\bspec:\s*\[([^\]]*)\]/g
const COVERS_DECL_RE = /\bcovers:\s*\[([^\]]*)\]/g
const QUOTED_RE = /'([^']*)'|"([^"]*)"|([^,\s][^,]*)/g
/** 占位符（文档示例专用），绝不当作真实声明。 */
const PLACEHOLDER = new Set(['...', '…', 'S-XXX-00', 'S-A-01'])

/**
 * 从 `coverage(` 的位置起，取出一层配平的花括号内容。
 *
 * 为什么不能用一个正则 `\{\s*([\s\S]*?)\}`：声明体里可能出现嵌套的 `{}` 或
 * 字符串里的 `}`，非贪婪匹配会在第一个 `}` 处截断，导致解析出的声明**静默缺失**。
 * 静默缺失是覆盖门最不能接受的错误类型，所以这里手工配平，并跳过字符串字面量。
 *
 * @returns {string|null} 花括号内的文本；找不到配平的括号时返回 null
 */
export function readBraceBody(text, openIndex) {
  const open = text.indexOf('{', openIndex)
  if (open === -1) return null
  let depth = 0
  let quote = null
  for (let i = open; i < text.length; i++) {
    const char = text[i]
    if (quote !== null) {
      if (char === '\\') {
        i += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return null
}

/** 递归列出目录下匹配后缀的文件（跳过 node_modules 与点目录）。 */
export function walk(dir, suffixes, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) walk(full, suffixes, out)
    else if (suffixes.some((suffix) => entry.endsWith(suffix))) out.push(full)
  }
  return out
}

/**
 * 从规格文档提取需求编号，并抓取每条编号所在行的文本作为摘要。
 * @returns {Map<string, string>} id → 标题/摘要
 */
export function extractRequirements(specFiles) {
  const requirements = new Map()
  for (const file of specFiles) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    let inFence = false
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 围栏代码块里的示例（如 `{'spec': [...]}` 的用法演示）不算规格，
      // 否则文档里每给一个例子就会凭空多出一条"需求"。
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue
      const matches = line.match(SPEC_ID_RE)
      if (!matches) continue
      for (const id of matches) {
        // 摘要取该行去掉编号后的内容；若该行只有标题就取标题。
        const summary = line
          .replace(SPEC_ID_RE, '')
          .replace(/^[\s#*\-—:]+/, '')
          .replace(/[（(]\s*[）)]$/, '')
          .trim()
        if (!requirements.has(id) || requirements.get(id) === '') {
          requirements.set(id, summary || '(无摘要)')
        }
      }
    }
  }
  return requirements
}

/** 从测试源码提取声明。返回 Map<file, {spec: string[], covers: string[]}>。 */
export function extractTestDeclarations(testFiles) {
  const declarations = new Map()
  for (const file of testFiles) {
    const text = readFileSync(file, 'utf8')
    const spec = []
    const covers = []
    // 只解析 `coverage({ ... })` 的实参，避免把文档、注释、报错文本里的
    // `spec: [...]` 示例当成真实声明（本项目自己就踩过这个坑）。
    for (const call of text.matchAll(COVERAGE_CALL_START)) {
      const body = readBraceBody(text, call.index)
      if (body === null) continue
      for (const match of body.matchAll(SPEC_DECL_RE)) spec.push(...splitList(match[1]))
      for (const match of body.matchAll(COVERS_DECL_RE)) covers.push(...splitList(match[1]))
    }
    if (spec.length === 0 && covers.length === 0) continue
    declarations.set(relative(PROJECT_ROOT, file).replaceAll('\\', '/'), { spec, covers })
  }
  return declarations
}

/** 拆分 `'a', 'b'` / `"a"` / `a, b` 这类列表。 */
function splitList(body) {
  const out = []
  for (const match of body.matchAll(QUOTED_RE)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (value === '' || PLACEHOLDER.has(value)) continue
    out.push(value)
  }
  return out
}

/** 把声明表折叠成两个集合：被测试引用的需求、被测试引用的场景。 */
export function foldDeclarations(declarations) {
  const coveredSpecs = new Set()
  const coveredScenarios = new Set()
  for (const { spec, covers } of declarations.values()) {
    for (const id of spec) coveredSpecs.add(id)
    for (const scenario of covers) coveredScenarios.add(scenario)
  }
  return { coveredSpecs, coveredScenarios }
}

/**
 * 计算覆盖缺口。
 * @returns {{requirements: Map, scenarios: Map, missingSpecs: string[], missingScenarios: string[], unknownSpecs: string[], unknownScenarios: string[]}}
 */
export function analyzeCoverage({ specFiles, featureFiles, testFiles, parseFeature }) {
  const requirements = extractRequirements(specFiles)
  const scenarios = new Map()
  for (const file of featureFiles) {
    const parsed = parseFeature(readFileSync(file, 'utf8'), relative(PROJECT_ROOT, file))
    for (const scenario of parsed.scenarios) {
      scenarios.set(scenario.id, {
        feature: parsed.feature,
        name: scenario.name,
        tags: scenario.tags,
        steps: scenario.steps.length,
        file: relative(PROJECT_ROOT, file).replaceAll('\\', '/'),
        line: scenario.line,
      })
    }
  }

  const declarations = extractTestDeclarations(testFiles)
  const { coveredSpecs, coveredScenarios } = foldDeclarations(declarations)

  const missingSpecs = [...requirements.keys()].filter((id) => !coveredSpecs.has(id)).sort()
  const missingScenarios = [...scenarios.keys()].filter((id) => !coveredScenarios.has(id)).sort()
  const unknownSpecs = [...coveredSpecs].filter((id) => !requirements.has(id)).sort()
  const unknownScenarios = [...coveredScenarios].filter((id) => !scenarios.has(id)).sort()

  return { requirements, scenarios, declarations, missingSpecs, missingScenarios, unknownSpecs, unknownScenarios }
}

/** 生成 Markdown 覆盖报告。 */
export function renderCoverageReport(result, { generatedAt = new Date().toISOString() } = {}) {
  const { requirements, scenarios, missingSpecs, missingScenarios, unknownSpecs, unknownScenarios } = result
  const lines = []
  lines.push('# 规格覆盖报告')
  lines.push('')
  lines.push('> **本文件由 `npm test` 自动校验一致性**，但内容建议手工刷新：')
  lines.push('> `node scripts/render-coverage.mjs`。手改内容不会影响门禁（门禁直接读源码）。')
  lines.push('')
  lines.push(`- 生成时间：${generatedAt}`)
  lines.push(`- 需求条目：${requirements.size}，其中**未被任何测试引用**：${missingSpecs.length}`)
  lines.push(`- 行为场景：${scenarios.size}，其中**未被任何测试引用**：${missingScenarios.length}`)
  lines.push('')

  lines.push('## 需求覆盖')
  lines.push('')
  lines.push('| 需求 | 摘要 | 状态 |')
  lines.push('|---|---|---|')
  for (const [id, summary] of requirements) {
    const covered = !missingSpecs.includes(id)
    lines.push(`| \`${id}\` | ${escapeCell(summary)} | ${covered ? '✅' : '❌ **缺测试**'} |`)
  }
  lines.push('')

  lines.push('## 行为场景覆盖')
  lines.push('')
  lines.push('| Feature | 场景 | 步骤数 | 来源 | 状态 |')
  lines.push('|---|---|---|---|---|')
  for (const [id, info] of scenarios) {
    const covered = !missingScenarios.includes(id)
    lines.push(
      `| ${escapeCell(info.feature)} | ${escapeCell(info.name)} | ${info.steps} | \`${info.file}:${info.line}\` | ${covered ? '✅' : '❌ **缺测试**'} |`,
    )
  }
  lines.push('')

  if (unknownSpecs.length > 0 || unknownScenarios.length > 0) {
    lines.push('## 悬空引用（测试声明的规格/场景不存在）')
    lines.push('')
    for (const id of unknownSpecs) lines.push(`- 需求 \`${id}\` 在规格文档里不存在`)
    for (const id of unknownScenarios) lines.push(`- 场景 \`${id}\` 在任何 feature 里不存在`)
    lines.push('')
  }

  return lines.join('\n')
}

function escapeCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\s+/g, ' ').trim()
}
