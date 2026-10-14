#!/usr/bin/env node
/**
 * mutation-test.mjs —— 用变异测试**证明测试套件真的能杀死缺陷**。
 *
 * ## 为什么需要它
 * 覆盖率门证明的是"每个需求都有一条声明"，但**声明 ≠ 真的在验证**。
 * 实测过：78 条需求里有 60 条只在 `coverage({ spec: [...] })` 里出现过一次，
 * 在任何测试里都没有被引用。这意味着把某条需求的代码整个删掉，
 * 套件很可能依然全绿——而"全绿"会被当作"已验证"。
 *
 * 变异测试直接回答这个问题：**故意把代码改坏，套件必须变红。**
 * 没变红 = 那条路径根本没被测到 = 那条覆盖是假的。
 *
 * ## 安全设计（必须严格）
 * - 每个变异体：先备份原文件 → 写入变异 → 跑目标测试 → **无论如何都还原** → 比对还原结果。
 * - 用 `try/finally` 保证还原；还原后校验文件内容与备份逐字节相同。
 * - 任何一步失败都立即停止，绝不留变异体在仓库里。
 * - 只改 `lib/` 与 `index.js`；每个变异体只改一处。
 *
 * 用法：
 *   node scripts/mutation-test.mjs            # 跑全部变异体
 *   node scripts/mutation-test.mjs --list     # 只列出变异体
 *   node scripts/mutation-test.mjs --only cmd-unevaluable-disabled
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath

/**
 * 变异体表。每个变异体：把 `find` 替换为 `replace`，然后必须让 `tests` 里的至少一个失败。
 * `description` 说明它模拟的是哪种真实缺陷。
 */
const MUTANTS = [
  {
    id: 'cmd-rules-disabled',
    file: 'lib/commands.js',
    description: '命令级策略整体失效（等效于"规则表写了但没人用"）',
    find: 'if (config?.commandRulesEnabled === false) {',
    replace: 'if (true) {',
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'cmd-unevaluable-disabled',
    file: 'lib/commands.js',
    description: '取不到命令文本时静默放行（fail-open）',
    find: "  if (categoryNeedsText(operation.category) && operation.normalized === '') {",
    replace: '  if (false) {',
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'cmd-allowlist-ignored',
    file: 'lib/commands.js',
    description: '显式豁免被忽略（allowRules 形同虚设）',
    find: '    if (exempt.has(rule.id)) {',
    replace: '    if (false) {',
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'cmd-lowercase-dropped',
    file: 'lib/commands.js',
    // 说明：原本这里放的是"斜杠归一化改坏"（`[\\/]+` → `[\\]+`）。
    // 实测发现那是**等价变异体** —— 把连续分隔符折叠成一个、与逐个替换成 `/`，
    // 结果字符串完全相同（`\\` → `/` 两种情况都是 `/`），所以不可能被任何测试杀死。
    // 替换成真正可观察的缺陷：不转小写。
    description: '规范化不再转小写（大小写变体可以绕过规则）',
    find: "    .toLowerCase()\n    .replace(/\\s+/g, ' ')",
    replace: "    .replace(/\\s+/g, ' ')",
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'cmd-boolean-flags-dropped',
    file: 'lib/commands.js',
    description: '布尔修饰符不进入操作文本（递归与普通删除无法区分）',
    find: '      if (isTruthyFlag(value)) values.push(key)',
    replace: '      if (false) values.push(key)',
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'safe-ttl-off-by-one',
    file: 'lib/policy.js',
    description: '审批在恰好等于 TTL 时失效（A-11 边界回归）',
    find: 'if (approval.expiresAt !== null && at > approval.expiresAt) {',
    replace: 'if (approval.expiresAt !== null && at >= approval.expiresAt) {',
    tests: ['test/behaviors/fail-closed.behavior.test.mjs'],
  },
  {
    id: 'cmd-beats-approval-broken',
    file: 'lib/policy.js',
    description: '命令级拒绝让位给审批（危险命令被拿去问人）',
    find: '      if (command.kind === \'deny\') {',
    replace: '      if (false) {',
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'audit-range-throws-again',
    file: 'lib/audit.js',
    description: '越界时间戳重新抛错（审计条目彻底丢失，V6 回归）',
    find: '    const date = new Date(value)\n    if (Number.isNaN(date.getTime())) return { at: null, coerced: true }',
    replace: '    const date = new Date(value)',
    tests: ['test/behaviors/fail-closed.behavior.test.mjs'],
  },
  {
    id: 'view-sort-loses-tiebreaker',
    file: 'lib/auditview.js',
    // 注意：`right.ms - left.ms`（丢掉 index tiebreaker）是**等价变异体** ——
    // V8 的 Array.sort 本来就是稳定排序，所以行为与带 tiebreaker 时相同。
    // 因此这里改成打乱数组后排序：只有 tiebreaker 能把输入顺序找回来。
    description: '排序丢失 tiebreaker（若底层排序不稳定则等时间戳顺序不确定）',
    find: 'withTime.sort((left, right) => (right.ms - left.ms) || (left.index - right.index))',
    replace: 'withTime.sort((left, right) => (right.ms - left.ms) || (Math.random() - 0.5))',
    tests: ['test/behaviors/audit-view.behavior.test.mjs'],
  },
  {
    id: 'view-singleline-dropped',
    file: 'lib/auditview.js',
    description: '换行不被折叠（可伪造审计行，V7 回归）',
    find: "export function toSingleLine(text) {\n  // 覆盖 CR/LF、U+2028/U+2029 与其余 C0 控制字符\n  // eslint-disable-next-line no-control-regex\n  return String(text ?? '').replace(/[\\r\\n\\u2028\\u2029\\u0000-\\u001f\\u007f]+/g, ' ')\n}",
    replace: "export function toSingleLine(text) {\n  return String(text ?? '')\n}",
    tests: ['test/behaviors/audit-view.behavior.test.mjs'],
  },
  {
    id: 'view-time-out-of-range',
    file: 'lib/auditview.js',
    description: '越界时间戳显示 NaN 并被当成最新（V5 回归）',
    find: 'return Number.isNaN(new Date(value).getTime()) ? null : value',
    replace: 'return value',
    tests: ['test/behaviors/audit-view.behavior.test.mjs'],
  },
  {
    id: 'ctx-newline-not-flattened',
    file: 'lib/context.js',
    description: '注入文本不再保证单行（V11 回归）',
    find: "  return String(text).replace(/[\\r\\n\\u2028\\u2029\\u0000-\\u001f\\u007f]+/g, ' ')",
    replace: '  return String(text)',
    tests: ['test/behaviors/context-injection.behavior.test.mjs'],
  },
  {
    id: 'host-upstream-fallback-dropped',
    file: 'index.js',
    description: '富化不再回退到 value.content（上游原文被替换，V9 回归）',
    find: "  if (value && typeof value === 'object' && Array.isArray(value.content)) return value.content",
    replace: '  if (false) return value.content',
    tests: ['test/behaviors/bridge-boundary.behavior.test.mjs', 'test/behaviors/audit-and-host.behavior.test.mjs'],
  },
  {
    id: 'coords-snap-always',
    file: 'lib/coords.js',
    description: '吸附不再按缩放分叉（小缩放下误差被放大，A-04 回归）',
    find: '  if (per >= 1) {',
    replace: '  if (true) {',
    tests: ['test/behaviors/fail-closed.behavior.test.mjs', 'test/coords.test.mjs'],
  },
  {
    id: 'gate-freshness-disabled',
    file: 'lib/gate.js',
    description: '新鲜度校验整体失效（过期观测也能点）',
    find: 'export function assessFreshness(',
    replace: 'export function assessFreshnessDISABLED(',
    tests: ['test/behaviors/action-gate.behavior.test.mjs', 'test/gate.test.mjs'],
  },
  // ── Batch 6/7 新增守卫（schema 驱动字段名、复合规则、布尔修饰符、双入口）──
  {
    id: 'schema-registry-mode-dropped',
    file: 'lib/commands.js',
    description: 'Registry 不再读真实字段 mode（真机上规则永不命中的那个缺陷回归）',
    find: "  Registry: [['mode'], ['path'], ['name'], ['value']],",
    replace: "  Registry: [['path'], ['name'], ['value']],",
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'schema-filesystem-mode-dropped',
    file: 'lib/commands.js',
    description: 'FileSystem 不再读真实字段 mode',
    find: "  FileSystem: [['mode'], ['path'], ['destination']],",
    replace: "  FileSystem: [['path'], ['destination']],",
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'schema-guard-weakened',
    file: 'lib/commands.js',
    description: '拼装字段名不再校验（S-CMD-12 的守门失效）',
    find: 'export const WINDOWS_MCP_ARGUMENTS = Object.freeze({',
    replace: 'export const WINDOWS_MCP_ARGUMENTS = null; const _UNUSED_ARGUMENTS = Object.freeze({',
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'registry-rule-loses-action-condition',
    file: 'lib/commands.js',
    description: '复合规则丢掉"首位删除动作"条件（只读查询或值名为 Remove 都会被误拦 = 假阳性）',
    find: "requires: [/^(?:delete|remove|del|rm|clear|rename|move)\\b/, /hklm:|hkey_local_machine/]",
    replace: "requires: [/hklm:|hkey_local_machine/]",
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'registry-rule-loses-hive-alias',
    file: 'lib/commands.js',
    description: '配置单元别名不再覆盖（HKEY_LOCAL_MACHINE 成为绕过路径）',
    find: 'requires: [/^(?:delete|remove|del|rm|clear|rename|move)\\b/, /hklm:|hkey_local_machine/]',
    replace: "requires: [/^(?:delete|remove|del|rm|clear|rename|move)\\b/, /hklm:/]",
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'filesystem-root-rule-dropped',
    file: 'lib/commands.js',
    description: '驱动器根递归删除规则失效（清空整个分区不再被拦）',
    find: "  { id: 'filesystem-wipe-drive-root', pattern: '', requires: [/^delete /, /(?:^| )recursive(?: |$)/, /(?:^| )\\/?[a-z]:\\/?(?: |$)/], risk: 'recursive-delete', reason: '对驱动器根做递归删除会清空整个分区，且不可撤销。' },\n",
    replace: '',
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'ctx-scope-index-not-id-keyed',
    file: 'lib/context.js',
    description: 'untrack 按 id 整键清空（同 id 下仍在世的会话被误伤）',
    find: '      const remaining = stack.filter((item) => item !== scope)\n      if (remaining.length > 0) scopesByAgentId.set(key, remaining)\n      else scopesByAgentId.delete(key)',
    replace: '      scopesByAgentId.delete(key)',
    tests: ['test/behaviors/context-injection.behavior.test.mjs'],
  },
  {
    id: 'view-audit-limit-mismatch',
    file: 'lib/auditview.js',
    description: '两个入口的默认条数不一致（同一日志渲染出不同结果，V13 回归）',
    find: 'export const DEFAULT_AUDIT_LIMIT = DEFAULT_RECENT',
    replace: 'export const DEFAULT_AUDIT_LIMIT = 30',
    tests: ['test/behaviors/audit-view.behavior.test.mjs'],
  },
  {
    id: 'audit-at-invalid-not-marked',
    file: 'lib/audit.js',
    // 说明：原先这里是"无条件标 atCoerced"。那是**等价变异体** ——
    // 该行只在兜底分支里执行，而兜底分支恰恰是"at 不可解析"的情形，
    // 于是 `coerced.coerced` 在那里恒为 true，去掉条件不改变行为。
    // 换成真正可观察的缺陷：非法 at 不再打标记。
    description: 'at 非法时不再标 atCoerced（静默替换时间，A-08/N8 回归）',
    find: '    if (coerced.coerced) out.atCoerced = true',
    replace: '    out.atCoerced = false',
    tests: ['test/behaviors/audit-view.behavior.test.mjs'],
  },
  {
    id: 'cmd-unevaluable-accepts-empty',
    file: 'lib/commands.js',
    description: '空命令文本重新被判为"取到了"（静默放行，N1 回归）',
    find: "  if (categoryNeedsText(operation.category) && operation.normalized === '') {",
    replace: '  if (categoryNeedsText(operation.category) && operation.fields === 0 && false) {',
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'process-force-rule-dropped',
    file: 'lib/commands.js',
    description: 'Process 强杀规则失效（force 可区分却没人拦，V3 回归）',
    find: "  { id: 'process-force-kill', pattern: '', requires: [/^kill(?: |$)/, /(?:^| )force(?: |$)/], risk: 'force-kill', reason: '无条件强杀进程会丢失未保存数据，且可能命中系统关键进程。' },\n",
    replace: '',
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'normalize-extended-prefix-dropped',
    file: 'lib/commands.js',
    description: '命名空间前缀不再归一化（\\\\?\\C:\\ 绕过卷根规则，V1 回归）',
    find: "    .replace(/(^| )\\/{1,2}[.?]\\//g, '$1')",
    replace: "    .replace(/(^| )\\/{1,2}[.?]\\//g, '$1__never_matches__')",
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'truthy-dialect-loosened',
    file: 'lib/commands.js',
    description: '真值判断放宽（recursive:"yes"/"1" 被误拦 = 假阳性，V2 回归）',
    find: "  if (typeof value === 'string') return value.toLowerCase() === 'true'",
    replace: "  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase())",
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'app-launch-rule-dropped',
    file: 'lib/commands.js',
    description: 'App 启动解释器的规则失效（绕过命令级策略的执行路径重新开放）',
    find: "  { id: 'app-launch-interpreter',",
    replace: "  { id: 'app-launch-interpreter-DISABLED',",
    tests: ['test/behaviors/command-policy.behavior.test.mjs'],
  },
  {
    id: 'doctor-schema-check-dropped',
    file: 'index.js',
    description: 'doctor 不再比对 schema 漂移（最该发现的那类缺陷重新隐形）',
    find: '      if (missing.length > 0) {',
    replace: '      if (false) {',
    tests: ['test/behaviors/doctor.behavior.test.mjs'],
  },
  {
    id: 'doctor-unknown-reported-healthy',
    file: 'index.js',
    description: 'doctor 把"查不到"当成"正常"（虚假健康结论，比没有自检更糟）',
    find: '    : hasUnknown\n      ? DOCTOR_VERDICT.UNKNOWN\n',
    replace: '    : false\n      ? DOCTOR_VERDICT.UNKNOWN\n',
    tests: ['test/behaviors/doctor.behavior.test.mjs'],
  },
]

/**
 * 在**影子副本**里跑一次测试，返回是否通过。
 *
 * 为什么必须在副本里跑（对抗性验证 N17，实测复现）：
 * 就地改文件时，进程被**强行终止**（取消长命令 / CI 超时 / 关终端 / 重启）
 * 会让变异体**永久留在工作树里**。对抗性验证者用 `taskkill /T /F` 实测，
 * 第 1 次试验就命中：留下的是一处**语法正确**的安全缺陷
 * （`allowRules` 豁免永久失效），stdout 只到"杀死 2/26"，
 * **没有任何失败信号**，`git status` 只显示一行 ` M`——一次 `git commit -a` 就会入库。
 *
 * `finally` 挡不住强杀。唯一可靠的边界是"根本不在真实工作树里改文件"。
 */
function testsPass(files, cwd) {
  try {
    execFileSync(NODE, ['--test', '--experimental-test-isolation=none', ...files], {
      cwd,
      stdio: 'ignore',
      timeout: 240_000,
    })
    return true
  } catch {
    return false
  }
}

/** 变异后的文件是否仍是合法 JS；不合法说明变异体本身写坏了，不算"被杀死"。 */
function parses(file) {
  try {
    execFileSync(NODE, ['--check', file], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const mutant of MUTANTS) console.log(`${mutant.id}\t${mutant.file}\t${mutant.description}`)
  process.exit(0)
}
const onlyIndex = args.indexOf('--only')
const selected = onlyIndex >= 0 ? MUTANTS.filter((m) => m.id === args[onlyIndex + 1]) : MUTANTS
if (selected.length === 0) {
  console.error(`没有匹配的变异体：${args[onlyIndex + 1]}`)
  process.exit(2)
}

// 建影子副本：真实工作树在整个运行期间**一个文件都不碰**。
const shadow = mkdtempSync(join(tmpdir(), 'dsh-mutants-'))
cpSync(ROOT, shadow, {
  recursive: true,
  filter: (src) => {
    const base = basename(src)
    return base !== '.git' && base !== 'node_modules'
  },
})

/** 读一次 git 工作树状态（非 git 仓库返回 null）。 */
function gitStatus() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
  } catch {
    return null
  }
}

// 记录**运行前**的状态。收尾时只比较"有没有变化"——
// 直接断言"必须为空"是错的：开发者自己的未提交改动会被误报成装置污染
// （第一次实现就踩了这个，白报一次警）。
const statusBefore = gitStatus()

console.log(`变异测试：${selected.length} 个变异体（影子副本：${shadow}）\n`)
console.log('真实工作树不会被修改；强行终止最多留下一个临时目录。\n')

let killed = 0
let survived = []
let broken = []

const failedToParse = []

for (const mutant of selected) {
  // 只在影子副本里改文件
  const path = join(shadow, mutant.file)
  const original = readFileSync(path, 'utf8')
  if (!original.includes(mutant.find)) {
    console.log(`✗ ${mutant.id}：找不到待替换片段（变异体定义已过期）`)
    broken.push(mutant.id)
    continue
  }
  try {
    writeFileSync(path, original.replace(mutant.find, mutant.replace))
    if (!parses(path)) {
      // 变异体把源码改成语法错误：套件必然失败，但那是"变异体写坏了"，
      // 不是"测试抓到了缺陷"。分开报，避免虚增杀死数。
      console.log(`⚠ 变异体语法错误  ${mutant.id}`)
      failedToParse.push(mutant.id)
      continue
    }
    const passed = testsPass(mutant.tests, shadow)
    if (passed) {
      console.log(`✗ 存活  ${mutant.id}  —— ${mutant.description}`)
      survived.push(mutant)
    } else {
      console.log(`✓ 杀死  ${mutant.id}`)
      killed += 1
    }
  } finally {
    writeFileSync(path, original)
    const restored = readFileSync(path, 'utf8')
    if (restored !== original) {
      console.error(`\n!!! 还原失败：${mutant.file} —— 立即停止`)
      process.exit(3)
    }
  }
}

// 收尾：删掉影子副本，并确认工作树在本次运行**期间**没有被改动。
try {
  rmSync(shadow, { recursive: true, force: true })
} catch {
  console.error(`(影子副本未能删除，可手动清理：${shadow})`)
}
const statusAfter = gitStatus()
if (statusBefore !== null && statusAfter !== null && statusBefore !== statusAfter) {
  console.error(
    '\n!!! 工作树在本次运行期间发生了变化（本装置本不该改动它）：\n' +
      `运行前：\n${statusBefore}\n运行后：\n${statusAfter}\n` +
      '请检查是否有并发修改或残留变异体。',
  )
}

console.log(`\n结果：杀死 ${killed} / ${selected.length}`)
if (broken.length > 0) {
  console.log(
    `\n变异体定义失效：${broken.join(', ')}\n` +
      '这些变异体**根本没有被测到**（find 片段已不存在）。' +
      '这是"绿灯里的空洞"：失效的定义会与"全部杀死"同时出现，让人以为覆盖很扎实。' +
      '请更新 find 片段（通常是实现被重构过），然后重跑。',
  )
}
if (survived.length > 0) {
  console.log('\n存活的变异体说明这些路径**没有被测试真正验证**：')
  for (const mutant of survived) console.log(`  - ${mutant.id}: ${mutant.description}`)
}
if (failedToParse.length > 0) {
  console.log(
    `\n变异体本身语法错误：${failedToParse.join(', ')}\n` +
      '这些不计入"杀死"——一个连解析都过不了的变异体没有验证任何东西。请修好 replace 片段。',
  )
}
// 失效定义、存活变异体、语法错误的变异体都必须导致失败退出码，
// 且不得打印"全部杀死"。曾经只判 survived，于是"定义失效 + 全部杀死"
// 会一起出现并返回 0 —— 一个会产生虚假信心的信号（对抗性复核第 5 项）。
if (broken.length > 0 || survived.length > 0 || failedToParse.length > 0) process.exit(1)
console.log('全部变异体被杀死：测试套件对这些缺陷是有效的。')
