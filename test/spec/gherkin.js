/**
 * gherkin.js —— 无依赖的 Gherkin 子集解析器。
 *
 * ## 为什么自己写而不是引依赖
 * 本项目声称"零运行时依赖"，测试基建也一样。我们只需要 Gherkin 的一个受限子集：
 * Feature / Scenario / Scenario Outline / Examples / Given-When-Then-And-But /
 * `@tag` / `# 注释` / feature 级描述。这些用不到 200 行就能可靠实现，
 * 且能精确控制"哪些写错了必须报错"——引一个宽松的库反而会让写错的场景静默通过。
 *
 * ## 设计立场：**宽进严出**
 * 解析阶段尽量接受；但一旦发现结构性错误（如 Scenario 没有步骤、
 * 步骤出现在任何 Scenario 之前、重复的 Scenario 名）就**立即抛错**。
 * 原因是覆盖门依赖场景名做键：重复名会让覆盖率统计悄悄失真，
 * 这种错误必须比"某个场景没覆盖"更早暴露。
 *
 * @module dsh_Windows_MCP/test/spec/gherkin
 */

/** Gherkin 步骤关键字，按长度降序以免 `Given` 抢先匹配 `Given that`。 */
export const STEP_KEYWORDS = Object.freeze(['Given', 'When', 'Then', 'And', 'But'])

const FEATURE_RE = /^\s*Feature:\s*(.+?)\s*$/
const SCENARIO_RE = /^\s*Scenario:\s*(.+?)\s*$/
const OUTLINE_RE = /^\s*Scenario Outline:\s*(.+?)\s*$/
const BACKGROUND_RE = /^\s*Background:\s*$/
const EXAMPLES_RE = /^\s*Examples?:\s*$/
const TAG_RE = /^\s*((?:@[^\s@]+\s*)+)$/
const STEP_RE = /^\s*(Given|When|Then|And|But)\s+(.+?)\s*$/

/**
 * 解析一份 feature 文本。
 *
 * 关键设计：**feature 描述段优先于背景步骤**。
 * 描述里常常会写 "Given/When/Then" 这类词来解释规格（本项目的第一份 feature
 * 就是这么写的），如果按关键字先行匹配，它们会被误当成 Background 步骤，
 * 导致"背景在没有任何场景时凭空多出步骤"这种静默错误。
 * 因此描述段只在遇到显式区块（Background/Scenario/Feature 结束）时才收束。
 *
 * @param {string} text
 * @param {string} [source] 来源标识（文件名），用于错误信息
 * @returns {{feature: string, description: string, tags: string[], background: object[], scenarios: object[]}}
 * @throws {Error} 结构非法时抛出，消息里带来源与行号
 */
export function parseFeature(text, source = '<inline>') {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error(`${source}: feature 文件为空`)
  }
  const lines = text.split(/\r?\n/)

  let feature = null
  const description = []
  const featureTags = []
  let pendingTags = []
  let background = []
  let backgroundSeen = false
  const scenarios = []
  let current = null
  let inDescription = false
  let inExamples = false

  const fail = (lineNo, message) => {
    throw new Error(`${source}:${lineNo}: ${message}`)
  }
  const closeDescription = () => {
    inDescription = false
  }

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1
    const raw = lines[index]
    const line = raw.trim()

    if (line === '' || line.startsWith('#')) continue

    const tagMatch = TAG_RE.exec(raw)
    if (tagMatch) {
      pendingTags.push(...tagMatch[1].trim().split(/\s+/))
      continue
    }

    const featureMatch = FEATURE_RE.exec(raw)
    if (featureMatch) {
      if (feature !== null) fail(lineNo, '一个文件只能有一个 Feature')
      feature = featureMatch[1]
      featureTags.push(...pendingTags)
      pendingTags = []
      inDescription = true
      continue
    }

    const outlineMatch = OUTLINE_RE.exec(raw)
    const scenarioMatch = SCENARIO_RE.exec(raw)
    if (outlineMatch || scenarioMatch) {
      if (feature === null) fail(lineNo, 'Scenario 出现在 Feature 之前')
      closeDescription()
      if (current !== null) finishScenario()
      current = {
        name: (outlineMatch ?? scenarioMatch)[1],
        tags: [...pendingTags],
        steps: [],
        outline: outlineMatch !== null,
        examples: [],
        line: lineNo,
      }
      pendingTags = []
      inExamples = false
      continue
    }

    if (BACKGROUND_RE.test(raw)) {
      if (feature === null) fail(lineNo, 'Background 出现在 Feature 之前')
      if (backgroundSeen) fail(lineNo, '一个 Feature 只能有一个 Background')
      if (current !== null) fail(lineNo, 'Background 必须出现在所有 Scenario 之前')
      backgroundSeen = true
      closeDescription()
      background = []
      continue
    }

    if (EXAMPLES_RE.test(raw)) {
      if (current === null) fail(lineNo, 'Examples 出现在 Scenario 之前')
      inExamples = true
      closeDescription()
      continue
    }

    // Feature 描述段：优先收下，避免把描述里的 Given/When/Then 误当步骤。
    //
    // 但描述有一个必须结束的时机：**遇到 Gherkin 步骤关键字却没声明 Background**。
    // 否则 `Feature:` 后面直接写 `Given x` 这种畸形输入会被静默吸收成描述文本，
    // 用户以为背景生效了、其实一步都没跑——这类静默错误比报错危险得多。
    if (inDescription && current === null && background.length === 0) {
      if (STEP_RE.test(raw)) {
        inDescription = false
        fail(lineNo, '在这里出现了步骤文本，但它既不在 Background（未声明）里，也不属于任何 Scenario')
      }
      description.push(line)
      continue
    }

    // Examples 表格行：| a | b |
    if (inExamples) {
      if (/^\s*\|/.test(raw)) {
        const cells = line
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim())
        current.examples.push(cells)
        continue
      }
      fail(lineNo, `Examples 段内出现无法识别的内容: ${line.slice(0, 60)}`)
    }

    const stepMatch = STEP_RE.exec(raw)
    if (stepMatch) {
      const step = { keyword: stepMatch[1], text: stepMatch[2], line: lineNo }
      if (current === null) {
        if (feature === null) fail(lineNo, '步骤出现在 Feature 之前')
        if (!backgroundSeen) fail(lineNo, '步骤出现在任何场景之前，且没有 Background 声明')
        background.push(step)
        continue
      }
      current.steps.push(step)
      continue
    }

    fail(lineNo, `无法识别的行: ${line.slice(0, 80)}`)
  }

  if (current !== null) finishScenario()
  if (feature === null) throw new Error(`${source}: 缺少 Feature:`)

  function finishScenario() {
    if (current.steps.length === 0) {
      fail(current.line, `Scenario "${current.name}" 没有任何步骤`)
    }
    const duplicate = scenarios.find((entry) => entry.name === current.name)
    if (duplicate) {
      // 覆盖门用场景名做键，重名会让统计静默失真——必须硬失败。
      fail(current.line, `Scenario 名称重复: "${current.name}"（已出现在第 ${duplicate.line} 行）`)
    }
    scenarios.push({
      feature,
      name: current.name,
      tags: current.tags,
      outline: current.outline,
      examples: current.examples,
      steps: current.steps,
      line: current.line,
      id: `${feature} :: ${current.name}`,
    })
    current = null
  }

  if (scenarios.length === 0) throw new Error(`${source}: 没有任何 Scenario`)

  return {
    feature,
    description: description.join('\n').trim(),
    tags: featureTags,
    background,
    scenarios,
  }
}

/**
 * 从一段文本里解析出全部步骤（供测试断言 Gherkin 步骤与测试是一一对应的）。
 * @returns {string[]} 形如 `Given xxx` 的步骤文本
 */
export function stepTexts(feature) {
  const out = []
  for (const step of feature.background) out.push(`${step.keyword} ${step.text}`)
  for (const scenario of feature.scenarios) {
    for (const step of scenario.steps) out.push(`${step.keyword} ${step.text}`)
  }
  return out
}
