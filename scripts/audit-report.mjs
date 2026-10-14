#!/usr/bin/env node
/**
 * audit-report.mjs —— 把 Windows-MCP 审计日志渲染成人可读的报告。
 *
 * ## 为什么要有这个脚本（而不是只做成工具）
 * 工具 `winmcp_audit` 只能被**模型**调用；而"看看最近被拦了什么"是**人**的需求，
 * 且常常发生在会话之外（甚至模型不可用时）。脚本给了人一条独立的路径。
 *
 * ## 与工具的关系
 * 两者共用 `lib/auditview.js` 的同一批纯函数（S-VIEW-06），
 * 因此不会出现"工具里看到一套、脚本里看到另一套"。
 *
 * 用法：
 *   node scripts/audit-report.mjs                       # 默认读 $DSH_HOME/logs/windows-mcp-audit.jsonl
 *   node scripts/audit-report.mjs --file <path>         # 指定文件
 *   node scripts/audit-report.mjs --recent 20           # 最近条目条数
 *   node scripts/audit-report.mjs --json                # 输出统计 JSON 而不是文本报告
 *   node scripts/audit-report.mjs --check               # 有拒绝记录时退出码 1（可用于巡检）
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseLines } from '../lib/audit.js'
import { renderReport, summarize, DEFAULT_RECENT } from '../lib/auditview.js'

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
const file = arg('file', join(dshHome, 'logs', 'windows-mcp-audit.jsonl'))
// S-VIEW-06 / V13：默认值必须与工具侧一致，否则"同一份日志渲染出同样的文本"不成立
const recent = Number(arg('recent', String(DEFAULT_RECENT)))

/** 读文件；不存在或不可读时按空处理（脚本不得因为"没有日志"而失败）。 */
function readEntries(path) {
  if (!existsSync(path)) return { entries: [], skipped: 0, missing: true }
  try {
    const parsed = parseLines(readFileSync(path, 'utf8'))
    return { ...parsed, missing: false }
  } catch (error) {
    console.error(`读取审计文件失败：${error?.message ?? error}`)
    return { entries: [], skipped: 0, missing: false, unreadable: true }
  }
}

const { entries, skipped, missing, unreadable } = readEntries(file)

if (process.argv.includes('--json')) {
  const stats = summarize(entries)
  console.log(JSON.stringify({ file, missing, unreadable, skipped, ...stats }, null, 2))
} else {
  if (missing) {
    console.log(`# Windows-MCP 审计报告（0 条记录）`)
    console.log('')
    console.log(`审计文件不存在：${file}`)
    console.log('可能原因：autoAudit 被关闭，或本进程尚未产生任何动作。')
  } else {
    console.log(renderReport(entries, { recent: Number.isFinite(recent) ? recent : DEFAULT_RECENT }))
    if (skipped > 0) {
      console.log('')
      console.log(`（另有 ${skipped} 行因损坏或非对象被跳过）`)
    }
  }
}

if (process.argv.includes('--check')) {
  const stats = summarize(entries)
  if (stats.denied > 0) {
    console.error(`\n巡检结果：存在 ${stats.denied} 条拒绝记录（见上方报告）。`)
    process.exit(1)
  }
  console.log('\n巡检结果：没有拒绝记录。')
}
