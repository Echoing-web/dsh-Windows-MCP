// dsh-windows-mcp self-check —— 真实环境的只读自检
//
// 它做三件事，全部是只读的（不写 profile、不改任何配置）：
//   1. 解析出插件会用的解释器路径（与运行期同一套发现逻辑）；
//   2. 真的启动该解释器，执行 `import windows_mcp` 探测；
//   3. `--probe` 时再真的启动一次 Windows-MCP，走 MCP stdio 握手读它的 tools/list。
//
// 用法：
//   node scripts/selfcheck.mjs            # 只验证解释器
//   node scripts/selfcheck.mjs --probe    # 额外做一次真实 tools/list 握手
//   node scripts/selfcheck.mjs --json     # 只输出 JSON（便于脚本消费）
//
// 退出码：0 = 解释器可用；1 = 不可用（并打印确切原因）。
import { probeInterpreter, resolveInterpreter, installHint } from '../lib/interpreter.js'
import { probeToolsList } from '../lib/probe.js'
import { normalizeConfig, buildServerArgs, diagnose, readRowFacts, readRegisteredTools, buildStatus } from '../index.js'

const argv = process.argv.slice(2)
const wantProbe = argv.includes('--probe')
const jsonOnly = argv.includes('--json')

const config = normalizeConfig({})

// 只读的“组合事实”来源：这里显式用空 Loader + 已知的行配置，避免碰到真实 profile。
const loader = {
  entries: () =>
    [
      {
        options: {
          id: config.rowId,
          name: '@deepseek-ai/dsh-mcp-client',
          config: {
            transport: 'stdio',
            serverName: config.serverName,
            command: resolveInterpreter(config).path,
            args: buildServerArgs(config),
            toolCallTimeoutMs: 120000,
            failOnStartupError: false,
          },
        },
        disabled: false,
        fiber: { state: 2 },
      },
    ][Symbol.iterator](),
}

const resolution = resolveInterpreter(config)
const probe = resolution.exists ? await probeInterpreter(resolution.path, { timeoutMs: config.probeTimeoutMs }) : null

let live = null
if (wantProbe && probe?.ok === true) {
  live = await probeToolsList({
    command: resolution.path,
    args: buildServerArgs(config),
    timeoutMs: config.liveProbeTimeoutMs,
  })
}

const row = readRowFacts(loader, config)
// 没有实时握手时，工具注册表按“不可读”处理：selfcheck 不假装知道已注册了什么。
const tools = live === null
  ? readRegisteredTools(undefined, config.serverName)
  : readRegisteredTools(
      { schemas: () => live.toolNames.map((name) => ({ name: `mcp__${config.serverName}__${name}` })) },
      config.serverName,
    )

const interpreterFacts = {
  path: resolution.path,
  source: resolution.source,
  exists: resolution.exists,
  verified: probe !== null,
  ok: probe === null ? false : probe.ok,
  pythonVersion: probe?.pythonVersion ?? null,
  windowsMcpVersion: probe?.windowsMcpVersion ?? null,
  windowsMcpPath: probe?.windowsMcpPath ?? null,
  importError: probe?.importError ?? null,
  error: probe?.error ?? (resolution.exists ? null : `interpreter not found at "${resolution.path}"`),
  checkedAt: probe?.checkedAt ?? Date.now(),
  timedOut: probe?.timedOut ?? false,
  candidates: resolution.candidates.map((candidate) => ({ ...candidate, exists: false })),
}

const status = buildStatus(
  {
    config,
    interpreter: interpreterFacts,
    row,
    recheck: { enabled: false, intervalMs: 0, cycles: 1, probes: 1, lastAt: Date.now(), nextAt: null, lastReason: 'selfcheck' },
    diagnosis: diagnose({ config, interpreter: interpreterFacts, row, tools }),
  },
  { readTools: () => tools },
)

const report = {
  interpreter: {
    path: resolution.path,
    source: resolution.source,
    exists: resolution.exists,
    importOk: probe?.ok ?? false,
    pythonVersion: probe?.pythonVersion ?? null,
    windowsMcpVersion: probe?.windowsMcpVersion ?? null,
    importError: probe?.importError ?? null,
    error: probe?.error ?? null,
  },
  liveProbe: live,
  verdict: status.diagnosis.verdict,
  summary: status.diagnosis.summary,
}

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n\n`)
  if (status.diagnosis.actions.length > 0) {
    process.stdout.write('需要处理：\n')
    for (const action of status.diagnosis.actions) process.stdout.write(`  - [${action.code}] ${action.text}\n`)
    process.stdout.write('\n')
  }
  if (probe?.ok !== true) process.stdout.write(`${installHint()}\n`)
  process.stdout.write(
    `\n结论：${status.diagnosis.verdict} —— ${status.diagnosis.summary}\n` +
      (live === null ? '（未做实时握手；加 --probe 可验证服务器本身）\n' : ''),
  )
}

process.exit(probe?.ok === true ? 0 : 1)
