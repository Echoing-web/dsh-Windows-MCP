#!/usr/bin/env node
/**
 * sanitize-check.mjs —— 发布面脱敏检查（把"脱敏"变成可强制的门，而不是一次性手工）。
 *
 * ## 为什么要有这道门
 * 一次性手工替换的问题是：**下一个人（或下一轮的我）会重新引入**。
 * 本项目就发生过：文档里写了真机主机名与个人目录，测试夹具里放了真实截图的
 * 落盘路径与内容哈希。这些在开发时毫无痛感，一旦公开就是隐私泄漏。
 *
 * 因此这里把"哪些字符串不允许出现在发布面"写成**规则表 + 自动扫描**，
 * 由 `functional-test.mjs` 第 5 轮调用，也应在 CI 里跑。
 *
 * ## 允许的例外
 * 规则可带 `allow` 白名单（按文件路径前缀）。当前白名单只有本文件自身与
 * 检查脚本的文档 —— 它们必须描述这些模式才能做检查。
 *
 * 用法：
 *   node scripts/sanitize-check.mjs          # 人读
 *   node scripts/sanitize-check.mjs --json   # 机读
 * 退出码：0 = 干净，1 = 有命中。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const wantsJson = process.argv.includes('--json')

/** 不参与扫描的路径（相对项目根）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', '.test-receipts'])
/** 只扫文本类文件。 */
const TEXT_SUFFIXES = ['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.feature', '.ps1', '.cmd', '.txt', '.html', '.css']

/**
 * 规则表。每条：`{ id, why, test(line), allow? }`
 *
 * 原则：宁可**过度**命中，也不要漏。命中后由人判断是否真泄漏；
 * 漏掉则是无声泄漏，代价高得多（这也是本插件审计脱敏模块自己的取向）。
 */
const RULES = [
  {
    id: 'personal-home-path',
    why: '个人 Windows 用户目录绝对路径',
    test: (line) => /[A-Za-z]:\\+Users\\+(?!<|\$\{|me\b|user\b|you\b|%|\\\\)[A-Za-z0-9._-]+/i.test(line),
  },
  {
    id: 'hostname-like',
    why: '真机主机名（形如 LAPTOP-XXXXXXX 的默认 Windows 计算机名）',
    test: (line) => /\b(LAPTOP|DESKTOP|WIN)-[A-Z0-9]{5,}\b/.test(line),
  },
  {
    id: 'personal-email',
    why: '个人邮箱地址',
    test: (line) => /[A-Za-z0-9._%+-]+@(qq|163|126|gmail|outlook|hotmail|foxmail)\.(com|cn)\b/i.test(line),
  },
  {
    id: 'credential-token',
    why: '凭据样式字符串（GitHub / OpenAI / Slack / AWS 等）',
    test: (line) =>
      // 允许项目自己的脱敏测试夹具（形如 sk-live-xxx 的短占位）
      /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/.test(line),
  },
  {
    id: 'private-key-block',
    why: '私钥/证书块',
    test: (line) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line),
  },
  {
    id: 'local-attachment-path',
    why: '本机附件缓存路径与真实截图内容哈希',
    test: (line) => /attachments[\\/]v\d+[\\/]objects/i.test(line),
  },
  {
    id: 'local-install-root',
    why: '本机 DSH 安装根目录（已发现的个人环境特有的绝对路径）',
    // 刻意**窄**：测试夹具里合法地存在大量合成的绝对路径（`C:\tmp\a.txt`、
    // `D:\projects\build` 等），用"任意绝对路径"当规则会产生大量假阳性，
    // 而假阳性会让人整体忽略这道门 —— 那比漏报更糟。
    // 因此只挡"已知的**本机**安装根"，它是真正会泄漏环境信息的那个。
    test: (line) => /[A-Za-z]:\\+Deepseek Harness/i.test(line),
  },
]

/** 收集待扫描文件。 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (TEXT_SUFFIXES.some((s) => entry.endsWith(s))) out.push(full)
  }
  return out
}

const files = collect(ROOT)
const findings = []
let checkedRules = 0

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  // 检查脚本自身必须引用这些模式才能做检查 —— 唯一白名单
  if (rel === 'scripts/sanitize-check.mjs') continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  for (const rule of RULES) {
    checkedRules += 1
    if (rule.allow?.some((prefix) => rel.startsWith(prefix))) continue
    for (let i = 0; i < lines.length; i++) {
      if (rule.test(lines[i])) {
        findings.push({ file: rel, line: i + 1, rule: rule.id, why: rule.why, excerpt: lines[i].trim().slice(0, 120) })
      }
    }
  }
}

if (wantsJson) {
  console.log(JSON.stringify({ scanned: files.length, rules: RULES.length, findings }, null, 2))
} else {
  console.log(`脱敏检查：扫描 ${files.length} 个文本文件 × ${RULES.length} 条规则`)
  if (findings.length === 0) {
    console.log('✓ 未发现个人路径、主机名、邮箱、凭据或本机附件路径')
  } else {
    console.log(`✗ 发现 ${findings.length} 处命中：\n`)
    for (const f of findings) {
      console.log(`  ${f.file}:${f.line}  [${f.rule}] ${f.why}`)
      console.log(`      ${f.excerpt}`)
    }
    console.log('\n处置建议：把个人路径换成占位符（如 C:\\Users\\<you>\\…），')
    console.log('主机名换成 <host>，真实截图哈希换成合成值。')
  }
}
process.exit(findings.length > 0 ? 1 : 0)
