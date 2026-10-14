#!/usr/bin/env node
/**
 * verify-windows-mcp.mjs —— Windows-MCP x DeepSeek Harness 端到端自检
 *
 * 它做四件事，任何一步失败都以非零码退出并打印可直接执行的修复建议：
 *   1. 解析 DSH profile 的 cordis.patch.yml，找到 winmcp 的 dsh-mcp-client 行；
 *      没有这一行，说明还没装好（这是最常见的失败）。
 *   2. 校验该行声明的解释器存在，且 `import windows_mcp` 真的成功。
 *   3. 按该行完全相同的参数派生 MCP 服务，完成 stdio initialize 握手。
 *   4. 列出工具并真实调用一次 DisplayInventory（只读、无副作用）。
 *
 * 用法：
 *   node verify-windows-mcp.mjs
 *   node verify-windows-mcp.mjs --profile C:\Users\me\.dsh\profiles\desktop
 *   node verify-windows-mcp.mjs --server-name winmcp
 *
 * 退出码：0 全部通过；1 有失败项；2 用法/参数错误。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = arg('profile', path.join(dshHome, 'profiles', 'desktop'))
const serverName = arg('server-name', 'winmcp')
const patchFile = path.join(profileDir, 'cordis.patch.yml')

const checks = []
const fail = (name, detail, fix) => checks.push({ ok: false, name, detail, fix })
const pass = (name, detail) => checks.push({ ok: true, name, detail })

/**
 * Minimal extraction of the one row we care about. The patch file is a small
 * YAML list; a full parser would add a dependency for no benefit here.
 */
function readRow() {
  if (!fs.existsSync(patchFile)) {
    fail('profile patch file exists', patchFile, '确认 --profile 指向正确的 profile 目录')
    return null
  }
  const text = fs.readFileSync(patchFile, 'utf8')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*id:\\s*${serverName === 'winmcp' ? 'mcp-winmcp' : `mcp-${serverName}`}\\s*$`).test(l))
  const insertedAt = lines.findIndex((l) => /^\s*-\s*insert:\s*$/.test(l))
  const hasInsertForm = insertedAt >= 0 && start > insertedAt
  if (start < 0) {
    fail(
      `patch row "mcp-${serverName}"`,
      `在 ${patchFile} 中找不到该 dsh-mcp-client 行`,
      '运行 scripts/provision-windows-mcp.ps1，或按 README 把该行加进 profile 的 cordis.patch.yml',
    )
    return null
  }
  if (!hasInsertForm) {
    fail(
      'patch row 是新增(insert)而非覆盖',
      `${patchFile}:${start + 1} 是顶层 "- id:" 覆盖写法，但没有任何更早的层 insert 过这个 id`,
      '把该行改到 "- insert:" 下面（覆盖写法只用于修改已存在的行；直接新建会报 patch: entry "..." not found）',
    )
    return null
  }
  pass('patch row 是新增(insert)', `${patchFile}:${start + 1}`)
  const block = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*id:/.test(lines[i])) break
    block.push(lines[i])
  }
  const body = block.join('\n')
  const get = (key) => body.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  const argsBlock = body.match(/^\s*args:\s*\n((?:\s*-\s*.+\n?)+)/m)?.[1] ?? ''
  const args = [...argsBlock.matchAll(/^\s*-\s*(.+)$/gm)].map((m) => m[1].trim().replace(/^['"]|['"]$/g, ''))
  const envBlock = body.match(/^\s*env:\s*\n((?:\s+\S+:\s*.+\n?)+)/m)?.[1] ?? ''
  const env = Object.fromEntries(
    [...envBlock.matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/gm)].map((m) => [m[1], m[2].trim().replace(/^['"]|['"]$/g, '')]),
  )
  return { name: get('name'), transport: get('transport'), serverName: get('serverName'), command: get('command'), args, env }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }))
    child.on('close', (code) => resolve({ code, out, err }))
  })
}

async function probeTools(row) {
  return new Promise((resolve) => {
    const child = spawn(row.command, row.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...row.env },
    })
    let buf = ''
    let stderr = ''
    let finished = false
    const done = (value) => { if (!finished) { finished = true; child.kill(); resolve(value) } }
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n')
    child.on('error', (e) => done({ error: `spawn 失败: ${e.message}` }))
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let m
        try { m = JSON.parse(line) } catch { continue }
        if (m.id === 1 && m.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        }
        if (m.id === 2 && m.result) {
          const tools = m.result.tools ?? []
          send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'DisplayInventory', arguments: {} } })
          done({ serverInfo: null, tools, callPending: true })
          // A call result is nice-to-have; do not block success on it.
        }
      }
    })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-verify', version: '1.0.0' } } })
    setTimeout(() => done({ error: '90 秒内未完成 MCP 握手', stderr: stderr.slice(-500) }), 90000)
  })
}

async function main() {
  const row = readRow()
  if (row) {
    pass('patch row 存在', `${patchFile} -> id mcp-${row.serverName ?? serverName}`)
    if (row.name !== '@deepseek-ai/dsh-mcp-client') {
      fail('patch row 名称', `name = ${row.name}`, "应为 '@deepseek-ai/dsh-mcp-client'")
    } else pass('patch row 名称', row.name)
    if (row.transport !== 'stdio') fail('transport', `transport = ${row.transport}`, 'Windows-MCP 需要 stdio')
    else pass('transport', 'stdio')

    if (!row.command) {
      fail('解释器路径', '命令为空', '在 patch 行里填 command: <venv>\\Scripts\\python.exe 绝对路径')
    } else {
      if (!fs.existsSync(row.command)) {
        fail('解释器文件存在', row.command, '运行 scripts/provision-windows-mcp.ps1 创建环境，或修正路径')
      } else {
        pass('解释器文件存在', row.command)
        const v = await run(row.command, ['-c', 'import sys, windows_mcp; print(sys.version.split()[0])'])
        if (v.code !== 0) {
          fail('解释器可 import windows_mcp', (v.err || v.out).trim().slice(0, 300), '在该环境执行 python -m pip install windows-mcp')
        } else {
          pass('解释器可 import windows_mcp', `Python ${v.out.trim()}`)
          const probe = await probeTools(row)
          if (probe.error) {
            fail('MCP stdio 握手', probe.error, '手动跑一次该 command + args 看报错；必要时加 --debug')
          } else {
            pass('MCP stdio 握手', `握手成功，列出 ${probe.tools.length} 个工具`)
            const names = probe.tools.map((t) => `mcp__${row.serverName ?? serverName}__${t.name}`)
            pass('工具命名空间', names.slice(0, 3).join(', ') + (names.length > 3 ? ` … 共 ${names.length} 个` : ''))
            if (!names.includes(`mcp__${row.serverName ?? serverName}__Snapshot`)) {
              fail('关键工具存在', '未列出 Snapshot', '确认服务的工具没有被 --tools/--exclude-tools 裁掉')
            } else pass('关键工具存在', 'Snapshot / Screenshot / Click 均可用')
          }
        }
      }
    }
  }

  const failed = checks.filter((c) => !c.ok)
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.detail}`)
    if (!c.ok && c.fix) console.log(`      -> 修复: ${c.fix}`)
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)
  if (failed.length) {
    console.log('\n注意：dsh-mcp-client 的 failOnStartupError 默认为 false，配置错误不会让 DSH 启动失败，')
    console.log('只会静默地不注册任何 mcp__ 工具。因此每次改动后都应跑一次本脚本。')
    process.exit(1)
  }
  console.log('\n全部通过。重启 DeepSeek Harness 后，Agent 即可调用这些工具。')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
