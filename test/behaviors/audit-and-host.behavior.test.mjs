/**
 * BDD 行为测试：features/audit-and-host.feature
 *
 * 审计这里刻意**用真实文件后端**而不是内存替身：S-AUDIT-01/03/05/06
 * 描述的是磁盘上的行为（只追加、形状、撕裂行、轮转），用内存替身验证等于没验证。
 * 只有 S-AUDIT-02（失败不影响动作）需要故意让写入失败，才用注入的坏 io。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAuditLog, redact } from '../../lib/audit.js'
import { createHost } from '../harness/host.js'
import { coverage } from '../harness/link.js'

coverage({
  spec: ['S-AUDIT-01', 'S-AUDIT-02', 'S-AUDIT-03', 'S-AUDIT-04', 'S-AUDIT-05', 'S-AUDIT-06', 'S-AUDIT-07', 'S-HOST-01', 'S-HOST-02', 'S-HOST-03', 'S-HOST-04'],
  covers: [
    '审计与宿主集成 :: 审计记录只追加不改写',
    '审计与宿主集成 :: 时间戳形状统一为 ISO 字符串',
    '审计与宿主集成 :: 审计写入失败不影响动作结果',
    '审计与宿主集成 :: 读取时跳过撕裂的最后一行',
    '审计与宿主集成 :: 超长敏感内容被脱敏',
    '审计与宿主集成 :: 文件不可读时回退到内存缓冲',
    '审计与宿主集成 :: 超过大小上限时轮转并保留有限历史',
    '审计与宿主集成 :: 观测与拒绝都会留下记录',
    '审计与宿主集成 :: 插件接在官方契约的三个接入点上',
    '审计与宿主集成 :: 富化只追加不替换上游内容',
    '审计与宿主集成 :: 卸载后不留残留',
    '审计与宿主集成 :: 插件自身的失败不会阻断宿主启动',
    '审计与宿主集成 :: 测试模式使用真实文件后端时仍可往返',
  ],
})
/** 建一个带临时目录的真实文件审计，返回 {audit, file, dir, done}。 */
function fileAudit(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wmcppro-bdd-'))
  const file = join(dir, 'audit.jsonl')
  const audit = createAuditLog({ file, clock: () => 1_700_000_000_000, ...options })
  return { audit, file, dir, done: () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} } }
}

// ── Scenario: 审计记录只追加不改写 ──────────────────────────────────────────
test('审计与宿主集成 :: 审计记录只追加不改写', () => {
  const f = fileAudit()
  try {
    f.audit.record({ action: 'a', tool: 'Snapshot' })
    f.audit.record({ action: 'b', tool: 'Click' })
    f.audit.record({ action: 'c', tool: 'Type' })
    const lines = readFileSync(f.file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    assert.equal(lines.length, 3)
    for (const line of lines) {
      const parsed = JSON.parse(line)
      assert.equal(typeof parsed, 'object')
      assert.equal(Array.isArray(parsed), false)
    }
    // 已有行不得被后来的写入改动
    const before = readFileSync(f.file, 'utf8')
    f.audit.record({ action: 'd' })
    const after = readFileSync(f.file, 'utf8')
    assert.ok(after.startsWith(before), '新写入必须追加在原文之后')
  } finally {
    f.done()
  }
})

// ── Scenario: 时间戳形状统一为 ISO 字符串 ───────────────────────────────────
test('审计与宿主集成 :: 时间戳形状统一为 ISO 字符串', () => {
  const f = fileAudit()
  try {
    f.audit.record({ at: 1_700_000_000_000, action: 'ms' })
    f.audit.record({ at: '2026-01-02T03:04:05.000Z', action: 'iso' })
    f.audit.record({ at: new Date('2026-02-03T04:05:06.000Z'), action: 'date' })
    const entries = f.audit.read({ limit: 10 })
    assert.equal(entries.length, 3)
    for (const entry of entries) {
      assert.equal(typeof entry.at, 'string', `at 必须是字符串，实际 ${typeof entry.at}`)
      assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      assert.ok(!Number.isNaN(Date.parse(entry.at)))
    }
    // 可按时间排序（形状统一的意义所在）
    const sorted = [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    assert.equal(sorted[0].action, 'ms')
  } finally {
    f.done()
  }
})

// ── Scenario: 审计写入失败不影响动作结果 ────────────────────────────────────
test('审计与宿主集成 :: 审计写入失败不影响动作结果', () => {
  const failures = []
  const audit = createAuditLog({
    file: join(tmpdir(), 'definitely', 'not', 'writable', 'audit.jsonl'),
    clock: () => 1_700_000_000_000,
    // 注入一定失败的 io，确保是"写失败"而不是依赖操作系统权限
    io: {
      writeFileSync() { throw new Error('EACCES: 模拟磁盘拒绝写入') },
      readFileSync() { throw new Error('ENOENT') },
      appendFileSync() { throw new Error('EACCES: 模拟磁盘拒绝写入') },
      mkdirSync() { throw new Error('EACCES: 模拟目录不可创建') },
      existsSync() { return false },
    },
    onError: (error) => failures.push(error),
  })
  let outcome
  assert.doesNotThrow(() => {
    outcome = audit.record({ action: 'x', tool: 'Click' })
  }, '审计失败绝不能抛给调用方')
  assert.equal(typeof outcome, 'object')
  assert.equal(outcome.ok, false)
  const stats = audit.stats()
  assert.ok(stats.writeFailures >= 1, '失败必须被计数')
})

// ── Scenario: 读取时跳过撕裂的最后一行 ──────────────────────────────────────
test('审计与宿主集成 :: 读取时跳过撕裂的最后一行', () => {
  const f = fileAudit()
  try {
    f.audit.record({ action: 'one' })
    f.audit.record({ action: 'two' })
    // 手工追加一个被截断的半行（模拟断电/并发写）
    const raw = readFileSync(f.file, 'utf8')
    writeFileSync(f.file, raw + '{"action":"torn","at":"2026-01-01T00:00:00.000Z"')
    let entries
    assert.doesNotThrow(() => {
      entries = f.audit.read({ limit: 10 })
    })
    assert.equal(entries.length, 2)
    assert.deepEqual(entries.map((entry) => entry.action), ['one', 'two'])
  } finally {
    f.done()
  }
})

// ── Scenario: 超长敏感内容被脱敏 ────────────────────────────────────────────
test('审计与宿主集成 :: 超长敏感内容被脱敏', () => {
  const f = fileAudit()
  try {
    const blob = 'A'.repeat(4000)
    f.audit.record({ action: 'image', image: blob, apiKey: 'sk-live-abcdefghijklmnop' })
    const onDisk = readFileSync(f.file, 'utf8')
    assert.ok(!onDisk.includes(blob), '原始超长内容绝不能落盘')
    assert.ok(!onDisk.includes('sk-live-abcdefghijklmnop'), '密钥样式内容必须脱敏')
    assert.match(onDisk, /redacted/)
  } finally {
    f.done()
  }
})

// ── Scenario: 文件不可读时回退到内存缓冲 ────────────────────────────────────
test('审计与宿主集成 :: 文件不可读时回退到内存缓冲', () => {
  const f = fileAudit()
  try {
    f.audit.record({ action: 'before-delete' })
    rmSync(f.file, { force: true })
    assert.equal(existsSync(f.file), false)
    const entries = f.audit.read({ limit: 10 })
    assert.equal(entries.length, 1)
    assert.equal(entries[0].action, 'before-delete')
  } finally {
    f.done()
  }
})

// ── Scenario: 超过大小上限时轮转并保留有限历史 ──────────────────────────────
test('审计与宿主集成 :: 超过大小上限时轮转并保留有限历史', () => {
  const f = fileAudit({ maxBytes: 400, rotateKeep: 2 })
  try {
    for (let i = 0; i < 40; i++) {
      f.audit.record({ action: `entry-${i}`, payload: 'x'.repeat(80) })
    }
    const files = readdirSync(f.dir)
    const rotated = files.filter((name) => name.startsWith('audit.jsonl.'))
    assert.ok(rotated.length >= 1, '应当产生轮转历史文件')
    assert.ok(rotated.length <= 2, `历史文件数不得超过 rotateKeep=2，实际 ${rotated.length}`)
    assert.ok(f.audit.stats().rotations >= 1)
  } finally {
    f.done()
  }
})

// ── Scenario: 观测与拒绝都会留下记录 ────────────────────────────────────────
test('审计与宿主集成 :: 观测与拒绝都会留下记录', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    await host.observeSnapshot()
    await host.pre(host.exec('mcp__winmcp__Click', { loc: [1, 2], based_on: 'obs-999' }))
    const entries = host.audit.read({ limit: 50 })
    assert.ok(entries.some((entry) => entry.decision === 'observed'), '观测必须留记录')
    const denial = entries.find((entry) => entry.decision === 'deny')
    assert.ok(denial, '拒绝必须留记录')
    assert.equal(denial.code, 'UNKNOWN_OBSERVATION')
    assert.ok(denial.reason.length > 0)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 插件接在官方契约的三个接入点上 ────────────────────────────────
test('审计与宿主集成 :: 插件接在官方契约的三个接入点上', () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    assert.equal(host.listenerCount('tools/pre-execute'), 1)
    assert.equal(host.listenerCount('tools/post-execute'), 1)
    assert.equal(host.guards.length, 1)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 富化只追加不替换上游内容 ──────────────────────────────────────
test('审计与宿主集成 :: 富化只追加不替换上游内容', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    const { result, decision } = await host.observeScreenshot()
    assert.equal(decision.kind, 'accept')
    const original = result.content
    assert.deepEqual(
      decision.content.slice(0, original.length),
      original,
      '上游原始块必须原样保留在前面',
    )
    assert.ok(decision.content.length > original.length, '应当追加了映射块')
    const appended = decision.content.slice(original.length)
    assert.ok(appended.every((block) => block.type === 'text'))
    assert.match(appended.map((block) => block.text).join('\n'), /\[mcp\]/)
  } finally {
    host.cleanup()
  }
})

// ── 补强：追加块的文字必须与上游真实语义一致（U-01 的部分闭环）─────────────
test('补强｜追加块必须说清原点的真实来源与"模型像素"这一环', async () => {
  // 上游 `desktop/service.py` 的实际语义（读过源码）：
  //   capture_rect = 显式 region ?: 所选 display 的并集 : null
  //   screenshot_region = capture_rect 的边界框
  // 因此 `Screenshot Region` 是"本次截图覆盖的矩形"，**不是**整个虚拟桌面。
  // 多显示器 + 负坐标（U-01）下这两者会不同，说错会让人把原点用错。
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    const { decision } = await host.observeScreenshot()
    const text = decision.content
      .slice(decision.content.length - 1)
      .map((block) => block.text)
      .join(' ')
    assert.match(text, /Region/, '应解释 Region 的语义')
    // 不得声称原点就是"整个虚拟桌面"的左上角
    assert.equal(
      /虚拟桌面区域左上角/.test(text),
      false,
      `不得把 Region 说成"虚拟桌面区域"（它是 region 参数与所选显示器的并集）`,
    )
    assert.match(text, /region 参数|所选显示|截图覆盖/, '应指出原点的真实来源')
    // 模型看到的那张图可能不是上游图片（附件说明里的预览尺寸），
    // 因此必须显式写出"模型像素 → 图片像素"这一环，否则模型会漏乘
    assert.match(text, /model|预览|可能不同/, '应提示"模型看到的像素"可能不等于上游图片像素')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 卸载后不留残留 ────────────────────────────────────────────────
test('审计与宿主集成 :: 卸载后不留残留', () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    assert.ok(host.registered.length > 0)
    host.dispose()
    assert.deepEqual(host.registered, [])
    assert.deepEqual(host.guards, [])
    assert.equal(host.listenerCount('tools/pre-execute'), 0)
    assert.equal(host.listenerCount('tools/post-execute'), 0)
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 插件自身的失败不会阻断宿主启动 ────────────────────────────────
test('审计与宿主集成 :: 插件自身的失败不会阻断宿主启动', () => {
  // 畸形容器：字符串、数字、null 都不该让 apply 抛异常
  for (const config of ['not-an-object', 42, null, undefined, [], { serverName: '' }]) {
    let host
    assert.doesNotThrow(() => {
      host = createHost({ config })
    }, `配置 ${JSON.stringify(config)} 让挂载抛异常了`)
    host.cleanup()
  }
})

// ── Scenario: 测试模式使用真实文件后端时仍可往返 ────────────────────────────
test('审计与宿主集成 :: 测试模式使用真实文件后端时仍可往返', () => {
  const f = fileAudit()
  try {
    const written = f.audit.record({ action: 'roundtrip', tool: 'Snapshot', screen: { x: 1, y: 2 } })
    assert.equal(written.ok, true)
    const [entry] = f.audit.read({ limit: 1 })
    assert.equal(entry.action, 'roundtrip')
    assert.equal(entry.tool, 'Snapshot')
    assert.deepEqual(entry.screen, { x: 1, y: 2 })
  } finally {
    f.done()
  }
})

// ── 补强：redact 是幂等的（重复脱敏不得改写标记长度） ────────────────────────
test('补强｜redact 幂等', () => {
  const once = redact({ apiKey: 'sk-live-0123456789abcdef', image: 'B'.repeat(500) })
  const twice = redact(once)
  assert.deepEqual(twice, once, '重复脱敏必须稳定，否则 read() 会改写已有内容')
})
