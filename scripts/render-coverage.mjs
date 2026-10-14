#!/usr/bin/env node
/**
 * render-coverage.mjs —— 生成 spec/COVERAGE.md。
 *
 * 与门禁的分工：
 * - 门禁（test/spec/spec-coverage.test.mjs）**直接读源码**判断覆盖是否成立，不依赖本文件；
 * - 本脚本只负责把同一份分析渲染成人能读的 Markdown，方便评审时快速看到缺口。
 *
 * 这样做的原因：如果门禁改成"读取 COVERAGE.md"，那份报告就成了一份可以被手改的
 * 假证据；读源码则无法伪造。报告只是视图，不是真源。
 *
 * 用法：
 *   node scripts/render-coverage.mjs           # 写入 spec/COVERAGE.md
 *   node scripts/render-coverage.mjs --check   # 只检查，不写文件；有缺口时退出码 1
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { analyzeCoverage, renderCoverageReport, walk, PROJECT_ROOT } from '../test/spec/coverage.js'
import { parseFeature } from '../test/spec/gherkin.js'

const result = analyzeCoverage({
  specFiles: [join(PROJECT_ROOT, 'spec', 'SYS_SPEC.md')],
  featureFiles: walk(join(PROJECT_ROOT, 'features'), ['.feature']),
  testFiles: walk(join(PROJECT_ROOT, 'test'), ['.test.mjs', '.mjs']),
  parseFeature,
})

const target = join(PROJECT_ROOT, 'spec', 'COVERAGE.md')
const report = renderCoverageReport(result, { generatedAt: new Date().toISOString() })

const gaps = result.missingSpecs.length + result.missingScenarios.length
const dangling = result.unknownSpecs.length + result.unknownScenarios.length

if (process.argv.includes('--check')) {
  if (gaps > 0 || dangling > 0) {
    console.error(`覆盖缺口：${result.missingSpecs.length} 条需求、${result.missingScenarios.length} 个场景未被测试引用`)
    if (dangling > 0) console.error(`悬空引用：${dangling} 处`)
    process.exit(1)
  }
  console.log(`覆盖完整：${result.requirements.size} 条需求、${result.scenarios.size} 个行为场景全部有测试`)
  process.exit(0)
}

const previous = existsSync(target) ? readFileSync(target, 'utf8') : ''
writeFileSync(target, report)
console.log(`已写入 ${target}`)
console.log(`  需求 ${result.requirements.size} 条，未覆盖 ${result.missingSpecs.length} 条`)
console.log(`  场景 ${result.scenarios.size} 个，未覆盖 ${result.missingScenarios.length} 个`)
if (previous !== report) console.log('（内容有变化）')
if (gaps > 0) {
  console.log('\n未覆盖项：')
  for (const id of result.missingSpecs) console.log(`  需求 ${id}`)
  for (const id of result.missingScenarios) console.log(`  场景 ${id}`)
}
