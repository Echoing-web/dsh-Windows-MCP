#!/usr/bin/env node
/**
 * functional-test.mjs —— 多轮功能测试运行器（发布前验收的执行点）。
 *
 * ## 为什么要"分轮"而不是一个大 `npm test`
 * 单一测试命令只能回答"有没有红"。发布前真正需要回答的是：
 *
 * 1. **能不能加载**（语法/导入层）；这一层坏了，后面几轮的"通过"都是假的 ——
 *    本项目就撞过：一次空白编辑把两行粘成一行，导致整个套件加载失败。
 * 2. **行为对不对**（BDD 场景 + 单元）。
 * 3. **需求有没有被覆盖**（双向覆盖门）。
 * 4. **覆盖是不是真的**（变异测试：把代码改坏，套件必须变红）。
 * 5. **进程外能不能用**（真机端到端；环境不具备时**明确跳过**，不假装通过）。
 * 6. **发布面干不干净**（脱敏检查；见 scripts/sanitize-check.mjs）。
 *
 * 分轮的价值在于**失败定位**：第 1 轮就红说明是加载问题，第 4 轮才红说明是覆盖质量问题。
 * 一个合并命令给出的"红"没有这个信息量。
 *
 * ## 设计约束
 * - **不伪造通过**：无法执行的轮次必须显式标 `SKIP` 并说明原因，绝不静默算过。
 * - **可机读**：`--json` 输出结构化结果，便于 CI 或打包脚本消费。
 * - **有界**：每轮有超时；超时算 `FAIL`（不是 `SKIP`）——跑不完就是没验证。
 * - **退出码诚实**：任何 `FAIL` → 退出 1；只有 `SKIP` → 退出 0 但摘要里明确列出。
 *
 * 用法：
 *   node scripts/functional-suite.mjs                 # 跑全部轮次
 *   node scripts/functional-suite.mjs --rounds 1,2    # 只跑指定轮
 *   node scripts/functional-suite.mjs --json          # 机读输出
 *   node scripts/functional-suite.mjs --fast          # 跳过慢轮（变异测试）
 *
 * ## ⚠️ 这个文件不能叫 `*-test.mjs`（踩过的坑）
 * Node 的测试发现 glob 包含 `**​/*-test.mjs`。本脚本原名 `functional-test.mjs`，
 * 于是第 2 轮执行的 `node --test` **把它当成一个测试文件**去跑 → 它内部又跑
 * `node --test` → **递归**，第 2 轮稳定 300s 超时。
 * 教训：**验证脚本不要用 `-test` 结尾**，否则会被测试发现机制吞掉。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath

const args = process.argv.slice(2)
const wantsJson = args.includes('--json')
const fast = args.includes('--fast')
const onlyIndex = args.indexOf('--rounds')
const only = onlyIndex >= 0 && args[onlyIndex + 1] ? args[onlyIndex + 1].split(',').map((s) => s.trim()) : null

/**
 * 轮次定义。`run` 返回 `{ status, detail }`，status ∈ pass | fail | skip。
 * `timeoutMs` 超时后判 FAIL —— "没跑完"不等于"没问题"。
 */
const ROUNDS = [
  {
    id: '1',
    name: '加载与语法',
    why: '所有 JS 能被解析、能被 import。这一层坏了，后续任何"通过"都没有意义。',
    timeoutMs: 60_000,
    async run() {
      const files = []
      const { readdirSync, statSync } = await import('node:fs')
      const walk = (dir, suffixes) => {
        for (const entry of readdirSync(dir)) {
          if (entry === 'node_modules' || entry.startsWith('.')) continue
          const full = join(dir, entry)
          if (statSync(full).isDirectory()) walk(full, suffixes)
          else if (suffixes.some((s) => entry.endsWith(s))) files.push(full)
        }
      }
      walk(join(ROOT, 'lib'), ['.js'])
      walk(join(ROOT, 'test'), ['.mjs', '.js'])
      walk(join(ROOT, 'scripts'), ['.mjs'])
      files.push(join(ROOT, 'index.js'))

      const bad = []
      for (const file of files) {
        const result = spawnSync(NODE, ['--check', file], { stdio: 'ignore' })
        if (result.status !== 0) bad.push(file.slice(ROOT.length + 1))
      }
      if (bad.length > 0) return { status: 'fail', detail: `语法错误：${bad.join(', ')}` }
      // 真正 import 一次入口，确认没有缺失依赖
      const entryOk = spawnSync(NODE, ['-e', `import(${JSON.stringify('file://' + join(ROOT, 'index.js').replace(/\\/g, '/'))})`], {
        stdio: 'ignore',
      }).status === 0
      if (!entryOk) return { status: 'fail', detail: 'index.js 无法被 import' }
      return { status: 'pass', detail: `${files.length} 个文件解析通过，入口可加载` }
    },
  },
  {
    id: '2',
    name: '行为与单元回归（单进程）',
    why: 'BDD 场景 + 单元测试全套。必须单进程：覆盖率门的运行时层依赖它。',
    timeoutMs: 300_000,
    run() {
      // execFileSync 在**非零退出**时会抛错，而测试失败恰恰是非零退出 ——
      // 所以必须从抛出的错误里取 stdout，否则失败时拿不到计数，
      // 报告只能写一句没信息量的 "Command failed"。可诊断性是这道门的一半价值。
      let out = ''
      let exitCode = 0
      try {
        out = execFileSync(NODE, ['--test', '--experimental-test-isolation=none'], {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: this.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
        })
      } catch (error) {
        exitCode = error?.status ?? 1
        out = String(error?.stdout ?? '')
      }
      // Node 的报告格式在不同版本间变过：`# tests 5`（TAP）与 `ℹ tests 5`（spec）。
      // 两者都要认。**曾经只认 `#`**，于是解析失败 → fail 为 undefined → 判为 pass，
      // 也就是说套件真失败时这一轮会报"通过"。那是本 harness 自己的假通过，
      // 现已改为：**解析不出数字就是 FAIL**（宁可误报失败，不可漏报失败）。
      const num = (pattern) => {
        const m = pattern.exec(out)
        return m ? Number(m[1]) : null
      }
      const tests = num(/(?:^|\n)\s*(?:#|ℹ)\s*tests\s+(\d+)/)
      const pass = num(/(?:^|\n)\s*(?:#|ℹ)\s*pass\s+(\d+)/)
      const fail = num(/(?:^|\n)\s*(?:#|ℹ)\s*fail\s+(\d+)/)
      const detail = `tests=${tests ?? '解析失败'} pass=${pass ?? '?'} fail=${fail ?? '?'} exit=${exitCode}`
      if (tests === null || fail === null) {
        return { status: 'fail', detail: `${detail} —— 无法从输出解析测试计数，不能判定为通过` }
      }
      if (tests === 0) {
        return { status: 'fail', detail: `${detail} —— 一个测试都没跑到（发现机制坏了？）` }
      }
      // 计数与退出码**都得**说通过才算通过：两者不一致说明报告本身有问题，
      // 那种情况下不该给绿灯（例如 stdout 被截断却恰好含有旧的成功摘要）。
      if (fail > 0 || exitCode !== 0) {
        return { status: 'fail', detail: `${detail} —— 有失败用例` }
      }
      return { status: 'pass', detail }
    },
  },
  {
    id: '3',
    name: '覆盖门（双向）',
    why: '每条需求都有测试声明、每个场景都有同名测试、无悬空引用。',
    timeoutMs: 120_000,
    run() {
      const out = execFileSync(NODE, ['scripts/render-coverage.mjs', '--check'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: this.timeoutMs,
      })
      const line = out.trim().split('\n').pop()
      return { status: /覆盖完整/.test(out) ? 'pass' : 'fail', detail: line }
    },
  },
  {
    id: '4',
    name: '变异测试（覆盖质量）',
    why: '把代码故意改坏，套件必须变红。存活=那条覆盖是假的。',
    timeoutMs: 1_800_000,
    skip: () => (fast ? '--fast 已跳过' : null),
    run() {
      const out = execFileSync(NODE, ['scripts/mutants.mjs'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: this.timeoutMs,
      })
      const killed = /杀死 (\d+) \/ (\d+)/.exec(out)
      return {
        status: /全部变异体被杀死/.test(out) ? 'pass' : 'fail',
        detail: killed ? `杀死 ${killed[1]}/${killed[2]}` : '结果无法解析',
      }
    },
  },
  {
    id: '5',
    name: '发布面脱敏',
    why: '公开仓库不得含个人路径、主机名、凭据或仅本机有效的内容。',
    timeoutMs: 60_000,
    run() {
      if (!existsSync(join(ROOT, 'scripts', 'sanitize-check.mjs'))) {
        return { status: 'skip', detail: 'scripts/sanitize-check.mjs 不存在' }
      }
      const result = spawnSync(NODE, ['scripts/sanitize-check.mjs', '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: this.timeoutMs,
      })
      let parsed = null
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        return { status: 'fail', detail: '脱敏检查输出无法解析' }
      }
      return {
        status: parsed.findings.length === 0 ? 'pass' : 'fail',
        detail:
          parsed.findings.length === 0
            ? `${parsed.scanned} 个文件、${parsed.rules} 条规则，无命中`
            : `${parsed.findings.length} 处命中：${parsed.findings.slice(0, 3).map((f) => `${f.file}:${f.line} ${f.rule}`).join('；')}`,
      }
    },
  },
  {
    id: '6',
    name: '真机端到端（live Windows-MCP）',
    why: '进程内测试无法证明"真机上能用"——本项目最大的一个缺陷正是只有真机能发现。',
    timeoutMs: 90_000,
    run() {
      // 只做**只读**探测：绝不点击/输入/改系统。环境不具备就明确跳过。
      const probe = join(ROOT, 'scripts', 'live-probe.mjs')
      if (!existsSync(probe)) return { status: 'skip', detail: 'scripts/live-probe.mjs 不存在' }
      const result = spawnSync(NODE, [probe, '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: this.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      })
      let parsed = null
      try {
        parsed = JSON.parse(result.stdout)
      } catch {
        // **关键**：探针的契约是"无论成功、跳过还是失败都输出 JSON"。
        // 拿不到 JSON 说明**探针脚本自己坏了**（崩了/导入错误），
        // 那不是"环境不具备"。曾经这里返回 skip，于是把自己脚本的
        // `ReferenceError: join is not defined` 掩盖成"环境未就绪"——
        // 与第 2 轮那个假通过是同一类错误：把失败说成了无害状态。
        const stderr = String(result.stderr ?? '').trim().split('\n').slice(0, 3).join(' | ')
        return {
          status: 'fail',
          detail: `live 探针没有输出 JSON（exit=${result.status ?? '?'}）：${stderr || '无 stderr'}`,
        }
      }
      if (parsed.skipped) return { status: 'skip', detail: parsed.reason }
      return { status: parsed.ok ? 'pass' : 'fail', detail: parsed.summary }
    },
  },
]

const selected = only ? ROUNDS.filter((r) => only.includes(r.id)) : ROUNDS
if (selected.length === 0) {
  console.error(`没有匹配的轮次：${only?.join(',')}`)
  process.exit(2)
}

const results = []
if (!wantsJson) {
  console.log(`多轮功能测试：${selected.length} 轮（项目根 ${ROOT}）\n`)
}

for (const round of selected) {
  const skipReason = typeof round.skip === 'function' ? round.skip() : null
  const startedAt = Date.now()
  let outcome
  if (skipReason) {
    outcome = { status: 'skip', detail: skipReason }
  } else {
    try {
      outcome = await round.run.call(round)
    } catch (error) {
      const timedOut = error?.code === 'ETIMEDOUT' || /timed out/i.test(String(error?.message))
      outcome = {
        status: 'fail',
        detail: timedOut ? `超时（>${round.timeoutMs}ms）` : `异常：${error?.message ?? error}`,
      }
    }
  }
  const elapsed = Date.now() - startedAt
  results.push({ id: round.id, name: round.name, why: round.why, elapsed, ...outcome })
  if (!wantsJson) {
    const mark = outcome.status === 'pass' ? '✓' : outcome.status === 'skip' ? '○' : '✗'
    console.log(`${mark} 第 ${round.id} 轮  ${round.name}  (${elapsed}ms)`)
    console.log(`    ${outcome.detail}`)
    if (outcome.status === 'skip') console.log(`    跳过原因：${round.why}`)
  }
}

const failed = results.filter((r) => r.status === 'fail')
const skipped = results.filter((r) => r.status === 'skip')
const passed = results.filter((r) => r.status === 'pass')

if (wantsJson) {
  console.log(JSON.stringify({ project: 'dsh-windows-mcp', rounds: results, passed: passed.length, failed: failed.length, skipped: skipped.length }, null, 2))
} else {
  console.log(`\n结果：通过 ${passed.length} / 失败 ${failed.length} / 跳过 ${skipped.length}`)
  if (skipped.length > 0) {
    console.log('跳过的轮次**不等于通过**，其覆盖的能力在本环境下未被验证：')
    for (const r of skipped) console.log(`  - 第 ${r.id} 轮 ${r.name}：${r.detail}`)
  }
}
process.exit(failed.length > 0 ? 1 : 0)
