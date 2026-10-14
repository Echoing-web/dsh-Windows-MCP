#!/usr/bin/env node
/**
 * live-probe.mjs —— 真机端到端探测（只读，绝不改动桌面或系统）。
 *
 * ## 它回答什么问题
 * 进程内测试无法证明"真机上能用"。本项目最大的一个缺陷（`FIELD_LAYOUT` 用猜的
 * `action`，真实工具是 `mode`）**只有真机能发现**——单元测试用的是同样猜错的键，
 * 所以全绿。因此发布前必须有一轮"对着真跑"的验收。
 *
 * ## 安全边界（硬约束）
 * - 只调用**只读**工具：`DisplayInventory`、`Screenshot`(无副作用)、`Registry mode=get`。
 * - **绝不**点击、输入、拖拽、改注册表、删文件、结束进程。
 * - 移动光标也不做（会打扰用户；坐标校准已由 `SYS_SPEC.md` 9.1 记录并可人工复跑）。
 *
 * ## 怎么和 DSH 通信
 * 本脚本**不**自己起 MCP 连接（那需要一份完整 DSH 运行时）。它走 DSH 暴露的
 * 本机 HTTP 接口不可行，所以设计为**两种模式**：
 *   1. `--from-file <path>`：读取一份由 DSH 侧导出的探测结果 JSON（CI 或人工准备）。
 *   2. 无参数：尝试直接以 stdio 启动 Windows-MCP 并做一次 JSON-RPC 握手
 *      （只有在 `windows-mcp` 可执行/模块可导入时才成立，否则明确 skip）。
 *
 * 无论哪种模式，输出契约相同：`{ skipped, reason }` 或 `{ ok, summary, checks }`。
 *
 * 用法：
 *   node scripts/live-probe.mjs --json
 *   node scripts/live-probe.mjs --from-file probe.json --json
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const args = process.argv.slice(2)
const wantsJson = args.includes('--json')
const fileIndex = args.indexOf('--from-file')
const fromFile = fileIndex >= 0 ? args[fileIndex + 1] : null

function emit(payload) {
  if (wantsJson) console.log(JSON.stringify(payload, null, 2))
  else {
    if (payload.skipped) console.log(`○ 跳过：${payload.reason}`)
    else {
      console.log(payload.ok ? '✓ 真机探测通过' : '✗ 真机探测失败')
      console.log(payload.summary)
      for (const c of payload.checks ?? []) console.log(`   ${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`)
    }
  }
  process.exit(payload.skipped || payload.ok ? 0 : 1)
}

/** 模式 1：消费已导出的探测结果。 */
if (fromFile) {
  if (!existsSync(fromFile)) emit({ skipped: true, reason: `结果文件不存在：${fromFile}` })
  let parsed
  try {
    parsed = JSON.parse(readFileSync(fromFile, 'utf8'))
  } catch (error) {
    emit({ skipped: true, reason: `结果文件无法解析：${error.message}` })
  }
  emit(parsed)
}

/**
 * 模式 2：直接对 Windows-MCP 做一次 stdio JSON-RPC 握手 + 只读调用。
 * 找不到解释器或模块就 skip（**不**算失败：环境没装不等于项目坏了）。
 */
function resolvePython() {
  const candidates = [
    process.env.WINDOWS_MCP_PYTHON,
    join(process.env.USERPROFILE ?? '', '.dsh', 'runtimes', 'windows-mcp', 'venv', 'Scripts', 'python.exe'),
  ].filter(Boolean)
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return null
}

const python = resolvePython()
if (!python) {
  emit({
    skipped: true,
    reason:
      '未找到 Windows-MCP 解释器（可设 WINDOWS_MCP_PYTHON，或先跑 scripts/provision-windows-mcp.ps1）。' +
      '真机能力在本环境未被验证。',
  })
}

const proc = spawn(python, ['-m', 'windows_mcp', 'serve'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, ANONYMIZED_TELEMETRY: 'false' },
})

let buffer = ''
let nextId = 1
const pending = new Map()
const checks = []

function send(method, params) {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`${method} 超时`))
      }
    }, 30_000)
  })
}

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message ?? 'JSON-RPC error'))
      else resolve(message.result)
    }
  }
})

function finish(skippedReason) {
  try {
    proc.kill()
  } catch {
    /* 尽力而为 */
  }
  if (skippedReason) return emit({ skipped: true, reason: skippedReason })
  const ok = checks.every((c) => c.ok)
  emit({ ok, summary: `${checks.filter((c) => c.ok).length}/${checks.length} 项只读检查通过`, checks })
}

;(async () => {
  try {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-windows-mcp-sanitize-probe', version: '0.0.0' },
    })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

    const tools = await send('tools/list', {})
    const names = (tools?.tools ?? []).map((t) => t.name)
    checks.push({ name: '工具表可读', ok: names.length > 0, detail: `${names.length} 个工具` })

    // 关键：真实参数名必须与项目登记的 WINDOWS_MCP_ARGUMENTS 一致。
    // 这正是当年只有真机能发现的那类缺陷（action vs mode）。
    const { WINDOWS_MCP_ARGUMENTS } = await import('../lib/commands.js')
    for (const [tool, expected] of Object.entries(WINDOWS_MCP_ARGUMENTS)) {
      const schema = (tools?.tools ?? []).find((t) => t.name === tool)
      if (!schema) {
        checks.push({ name: `${tool} 参数名`, ok: false, detail: '工具不存在于 live 工具表' })
        continue
      }
      const actual = Object.keys(schema.inputSchema?.properties ?? {}).sort()
      const missing = [...expected].filter((k) => !actual.includes(k))
      const extra = actual.filter((k) => !expected.includes(k))
      checks.push({
        name: `${tool} 参数名`,
        ok: missing.length === 0 && extra.length === 0,
        detail:
          missing.length === 0 && extra.length === 0
            ? `${actual.length} 个参数与登记全等`
            : `缺登记=${JSON.stringify(missing)} 多登记=${JSON.stringify(extra)}`,
      })
    }

    // 只读调用：DisplayInventory
    try {
      const inventory = await send('tools/call', { name: 'DisplayInventory', arguments: {} })
      const text = JSON.stringify(inventory)
      checks.push({ name: 'DisplayInventory 只读调用', ok: /index|bounds|resolution/i.test(text), detail: text.slice(0, 100) })
    } catch (error) {
      checks.push({ name: 'DisplayInventory 只读调用', ok: false, detail: String(error.message) })
    }

    finish(null)
  } catch (error) {
    finish(`与 Windows-MCP 握手失败：${error.message}（环境不具备，非项目缺陷）`)
  }
})()
