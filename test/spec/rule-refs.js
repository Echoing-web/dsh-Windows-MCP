/**
 * rule-refs.js —— 校验 feature 场景里**点名引用的规则编号**真实存在。
 *
 * ## 为什么需要这道门（它修的是一个真实漏洞）
 * 覆盖率门只按**场景名**把 feature 与测试对应起来，从不看步骤文本。
 * 于是出现了这样的事：
 *
 * ```gherkin
 * Scenario: 删除注册表根被拒绝
 *   Then 决策应为拒绝并给出规则编号 registry-delete-hk   # ← 代码里没有这个 id
 * ```
 *
 * 对应测试把 `action` 伪造成一个不存在的注册表动作，
 * 于是"场景通过、覆盖率 100%"，而真机上这条规则**永远不会命中**（对抗性验证 V2）。
 * 这个洞让一个未兑现的安全承诺在两个批次里保持全绿。
 *
 * ## 这道门做什么 / 不做什么
 * **做**：场景文本里凡是以 `规则编号 <id>` 形式点名的编号，必须在代码里真实存在。
 * 这把"文档/场景声称会拦"与"代码真的会拦"钉在一起——正是 V2 缺失的那一环。
 *
 * **不做**：它无法证明测试真的断言了该编号。要证明那一点需要把场景步骤
 * 编译成可执行断言，代价与收益不成比例。诚实地说：
 * 这道门堵住了 V2 的**具体形状**（引用了不存在的规则），
 * 而不是"假断言"这个一般性问题。一般性问题的真正防线是
 * **测试数据必须来自真实 schema**（见 S-CMD-12 与 `WINDOWS_MCP_ARGUMENTS`）。
 *
 * @module dsh_Windows_MCP/test/spec/rule-refs
 */

import { readFileSync } from 'node:fs'

/**
 * 形如 `规则编号 <id>` / `rule id <id>` 的引用。
 * id 允许的字符集刻意收窄：规则 id 都是小写字母/数字/连字符。
 */
const RULE_REF_RE = /(?:规则编号|规则\s*id|rule\s*id)\s*[:：]?\s*`?([a-z][a-z0-9-]{2,})`?/gi

/**
 * 从 feature 文本里提取被点名的规则编号。
 * @returns {Array<{id: string, line: number, text: string}>}
 */
export function extractRuleRefs(text) {
  const refs = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(RULE_REF_RE)) {
      refs.push({ id: match[1], line: i + 1, text: lines[i].trim() })
    }
  }
  return refs
}

/**
 * 校验所有 feature 里点名的规则编号都在给定的规则集里存在。
 *
 * @param {object} input
 * @param {string[]} input.featureFiles
 * @param {Iterable<string>} input.knownRuleIds 代码里真实存在的规则 id
 * @returns {{checked: number, unknown: Array<{file: string, id: string, line: number, text: string}>}}
 */
export function checkRuleRefs({ featureFiles, knownRuleIds }) {
  const known = new Set(knownRuleIds)
  const unknown = []
  let checked = 0
  for (const file of featureFiles) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const ref of extractRuleRefs(text)) {
      checked += 1
      if (!known.has(ref.id)) unknown.push({ file, ...ref })
    }
  }
  return { checked, unknown }
}
