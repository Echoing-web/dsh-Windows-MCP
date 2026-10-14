/**
 * Gherkin 解析器测试。
 *
 * 测试策略：不只测"能解析正常文件"，更要测**必须失败的输入**。
 * 覆盖门用场景名做键，所以「重名」「空场景」这类错误必须在解析阶段就炸，
 * 而不是让覆盖率统计悄悄失真。这些是解析器真正的价值所在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseFeature, stepTexts } from './gherkin.js'
import { coverage } from '../harness/link.js'

coverage({
  spec: ['S-CFG-01'],
})

const SIMPLE = `# 顶部注释
@featuretag
Feature: 示例能力
  这段描述会包含 Given/When/Then 这类词，
  它们必须被当作描述，而不是 Background 步骤。

  Background:
    Given 一个已挂载的插件

  @tag1 @tag2
  Scenario: 第一个场景
    Given 前置条件
    When 触发动作
    Then 出现结果

  Scenario: 第二个场景
    Given 前置条件
    Then 另一个结果
`

test('解析出 feature 名、标签、描述与全部场景', () => {
  const parsed = parseFeature(SIMPLE, 'simple.feature')
  assert.equal(parsed.feature, '示例能力')
  assert.deepEqual(parsed.tags, ['@featuretag'])
  assert.equal(parsed.scenarios.length, 2)
  assert.equal(parsed.scenarios[0].name, '第一个场景')
  assert.equal(parsed.scenarios[0].id, '示例能力 :: 第一个场景')
  assert.deepEqual(parsed.scenarios[0].tags, ['@tag1', '@tag2'])
  assert.equal(parsed.scenarios[1].tags.length, 0)
})

test('描述里的 Given/When/Then 不会被误当作 Background 步骤（关键回归）', () => {
  const parsed = parseFeature(SIMPLE, 'simple.feature')
  assert.match(parsed.description, /Given\/When\/Then/)
  // 真正的 Background 只有 1 步；描述里的关键词一步都不算
  assert.equal(parsed.background.length, 1)
  assert.equal(parsed.background[0].text, '一个已挂载的插件')
  assert.equal(parsed.scenarios[0].steps.length, 3)
})

test('步骤的关键字与文本被分开保存，且保留行号（错误信息要靠它）', () => {
  const parsed = parseFeature(SIMPLE, 'simple.feature')
  const first = parsed.scenarios[0]
  assert.deepEqual(first.steps.map((s) => s.keyword), ['Given', 'When', 'Then'])
  assert.deepEqual(first.steps.map((s) => s.text), ['前置条件', '触发动作', '出现结果'])
  assert.ok(first.line > 0)
  assert.ok(first.steps[0].line > first.line)
})

test('stepTexts 汇总 Background 与所有场景步骤', () => {
  const parsed = parseFeature(SIMPLE, 'simple.feature')
  const texts = stepTexts(parsed)
  assert.ok(texts.includes('Given 一个已挂载的插件'))
  assert.ok(texts.includes('Given 前置条件'))
  assert.ok(texts.includes('Then 另一个结果'))
  assert.equal(texts.length, 1 + 3 + 2)
})

test('Scenario Outline 与 Examples 被解析', () => {
  const text = `Feature: 大纲
  Scenario Outline: 多组参数
    Given 输入 <a>
    Then 得到 <b>

    Examples:
      | a | b |
      | 1 | 2 |
      | 3 | 4 |
`
  const parsed = parseFeature(text, 'outline.feature')
  const scenario = parsed.scenarios[0]
  assert.equal(scenario.outline, true)
  assert.deepEqual(scenario.examples, [['a', 'b'], ['1', '2'], ['3', '4']])
})

test('CRLF 行尾可解析（真实文件常见的形态）', () => {
  const parsed = parseFeature(SIMPLE.replace(/\n/g, '\r\n'), 'crlf.feature')
  assert.equal(parsed.scenarios.length, 2)
  assert.equal(parsed.scenarios[0].steps[0].text, '前置条件')
})

test('同名场景必须解析失败（否则覆盖率会静默失真）', () => {
  const text = `Feature: 重名
  Scenario: 一样
    Given a
  Scenario: 一样
    Given b
`
  assert.throws(() => parseFeature(text, 'dup.feature'), /名称重复: "一样"/)
})

test('没有步骤的场景必须解析失败', () => {
  assert.throws(
    () => parseFeature('Feature: 空\n  Scenario: 没有步骤\n', 'empty.feature'),
    /没有任何步骤/,
  )
})

test('没有任何场景的 feature 必须解析失败', () => {
  assert.throws(() => parseFeature('Feature: 完全空\n', 'none.feature'), /没有任何 Scenario/)
})

test('空文件与缺少 Feature 的输入必须解析失败', () => {
  assert.throws(() => parseFeature('', 'blank.feature'), /feature 文件为空/)
  assert.throws(() => parseFeature('   \n\n', 'ws.feature'), /feature 文件为空/)
  assert.throws(() => parseFeature('Scenario: 没有 feature\n  Given a\n', 'nof.feature'), /Scenario 出现在 Feature 之前/)
})

test('无法识别的行必须报错并带上行号', () => {
  const text = `Feature: 坏行
  Scenario: 有坏行
    Given a
    This is not gherkin
`
  assert.throws(() => parseFeature(text, 'bad.feature'), /bad\.feature:4: 无法识别的行/)
})

test('场景之前、没有 Background 声明的裸步骤必须报错', () => {
  const text = `Feature: 裸步骤
    Given 没有 background 声明
  Scenario: s
    Given a
`
  assert.throws(() => parseFeature(text, 'bare.feature'), /既不在 Background（未声明）里，也不属于任何 Scenario/)
})

test('Background 出现在场景之后必须报错', () => {
  const text = `Feature: 顺序
  Scenario: s
    Given a
  Background:
    Given b
`
  assert.throws(() => parseFeature(text, 'order.feature'), /Background 必须出现在所有 Scenario 之前|Scenario 出现在 Feature 之前|无法识别的行/)
})

test('多个 Background 必须报错', () => {
  const text = `Feature: 双背景
  Background:
    Given a
  Background:
    Given b
  Scenario: s
    Given c
`
  assert.throws(() => parseFeature(text, 'twobg.feature'), /只能有一个 Background/)
})
