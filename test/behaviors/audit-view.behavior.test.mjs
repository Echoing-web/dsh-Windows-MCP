/**
 * BDD 行为测试：features/audit-view.feature
 *
 * 这一组验证"同一份日志渲染出同样的、不骗人的视图"：
 * 统计口径必须闭合（各类合计 == 总数），畸形输入不得让渲染抛错，
 * 时间不可解析的条目不得被丢弃。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { coverage } from '../harness/link.js'
import {
  representEntry,
  summarize,
  renderReport,
  formatTime,
  parseTime,
  truncate,
  orderRecent,
  toSingleLine,
  normalizeToolForDisplay,
  DEFAULT_RECENT,
  DEFAULT_AUDIT_LIMIT,
  REASON_MAX_CHARS,
} from '../../lib/auditview.js'

coverage({
  spec: ['S-VIEW-01', 'S-VIEW-02', 'S-VIEW-03', 'S-VIEW-04', 'S-VIEW-05', 'S-VIEW-06', 'S-VIEW-07'],
  covers: [
    '审计可视化 :: 摘要统计给出固定口径',
    '审计可视化 :: 分类计数的合计等于总数',
    '审计可视化 :: 渲染结果包含标题与分区',
    '审计可视化 :: 最近条目按时间倒序',
    '审计可视化 :: 空日志给出明确说明而不是空白',
    '审计可视化 :: 时间不可解析的条目不被丢弃',
    '审计可视化 :: 畸形输入不得让渲染抛异常',
    '审计可视化 :: 两个入口共用同一实现',
    '审计可视化 :: 原因过长时截断并标注',
    '审计可视化 :: 同一工具的两种写法归一到一行',
  ],
})

// ══ 补强：统计与排序的边界 ═════════════════════════════════════════════════

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

test('补强｜等时间戳必须稳定（对抗性 N6，变异测试加强版）', () => {
  // "稳定"必须定义。采用最常用的含义：等时间戳保持**输入顺序**。
  //
  // 变异测试的教训：`sort((a,b)=>b.ms-a.ms)`（去掉 index tiebreaker）是
  // **等价变异体** —— V8 的 Array.sort 本就稳定，两者行为相同，所以那个变异体
  // 存活的"锅"不在测试。真正能区分的是"底层排序不稳定"的情形，
  // 因此这里构造**交替**时间戳，把同组内的相对顺序钉死。
  const interleaved = [
    { at: '2026-01-01T00:00:00.000Z', tool: 'A-old' },
    { at: '2026-01-01T00:00:05.000Z', tool: 'B-new' },
    { at: '2026-01-01T00:00:00.000Z', tool: 'C-old' },
    { at: '2026-01-01T00:00:05.000Z', tool: 'D-new' },
  ]
  const ordered = orderRecent(interleaved.map(representEntry), 10).map((item) => item.tool)
  assert.deepEqual(ordered, ['B-new', 'D-new', 'A-old', 'C-old'])
  assert.equal(ordered.indexOf('B-new') < ordered.indexOf('D-new'), true, '同时间戳保持输入顺序')
  assert.equal(ordered.indexOf('A-old') < ordered.indexOf('C-old'), true, '同时间戳保持输入顺序')

  // 反复渲染必须完全一致（确定性）：若排序引入随机性，这里会抖
  const render = () => orderRecent(interleaved.map(representEntry), 10).map((item) => item.tool).join(',')
  const first = render()
  for (let i = 0; i < 8; i++) assert.equal(render(), first, '同一输入必须渲染出同样的顺序')
})

test('补强｜at 缺失与 at 非法必须区分（对抗性 N8）', async () => {
  const { normaliseEntry } = await import('../../lib/audit.js')
  const NOW = 1_700_000_000_000
  // 缺失/null = "未提供" → 用写入时刻，**不**标 atCoerced
  for (const missing of [undefined, null]) {
    const entry = normaliseEntry({ action: 'x', at: missing }, NOW)
    assert.equal(entry.at, new Date(NOW).toISOString())
    assert.equal(entry.atCoerced, undefined, 'at 缺失是"未提供"，不是"被替换"')
  }
  // 存在但非法（含有限越界）= "被替换" → 用写入时刻并标 atCoerced
  for (const bad of ['garbage', Number.MAX_SAFE_INTEGER * 100, NaN, Infinity, {}, []]) {
    const entry = normaliseEntry({ action: 'x', at: bad }, NOW)
    assert.equal(entry.at, new Date(NOW).toISOString(), `at=${String(bad)} 应兜底`)
    assert.equal(entry.atCoerced, true, `at=${String(bad)} 必须标记`)
  }
})

test('补强｜纯数字字符串按毫秒解析（对抗性 N9）', async () => {
  const { toIsoTime } = await import('../../lib/audit.js')
  // `Date.parse('1700000000000')` 是 NaN，而 `Date.parse('0')` 会被解释成 2000-01-01，
  // 这就是"方言行为"。纯数字串必须按毫秒时间戳处理。
  assert.equal(toIsoTime('1700000000000'), new Date(1_700_000_000_000).toISOString())
  assert.equal(toIsoTime('0'), new Date(0).toISOString(), "'0' 必须是纪元 0，而不是 2000-01-01")
  assert.equal(toIsoTime('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z')
})

/** 一份典型日志：放行、拒绝、未标注结果各若干。 */
const SAMPLE = [
  { at: '2026-01-01T10:00:00.000Z', decision: 'observed', action: 'observe', tool: 'Snapshot', allowed: true },
  {
    at: '2026-01-01T10:00:05.000Z',
    decision: 'allow',
    action: 'input',
    tool: 'Click',
    allowed: true,
    observationId: 'obs-1',
  },
  {
    at: '2026-01-01T10:00:09.000Z',
    decision: 'deny',
    action: 'input',
    tool: 'Click',
    allowed: false,
    code: 'NO_OBSERVATION',
    reason: '输入类操作缺少屏幕观察记录：请先调用 Snapshot 获取当前屏幕状态，再重试该操作。',
  },
  {
    at: '2026-01-01T10:00:12.000Z',
    decision: 'deny',
    action: 'system',
    tool: 'PowerShell',
    allowed: false,
    code: 'COMMAND_RULE',
    reason: '命中危险操作规则「format-volume」：格式化卷会清空该分区上的全部数据。',
  },
  { at: '2026-01-01T10:00:15.000Z', decision: 'ok', action: 'observe', tool: 'DisplayInventory', allowed: true },
]

// ── Scenario: 摘要统计给出固定口径 ──────────────────────────────────────────
test('审计可视化 :: 摘要统计给出固定口径', () => {
  const stats = summarize(SAMPLE)
  assert.equal(stats.total, 5)
  assert.ok(Array.isArray(stats.byDecision))
  assert.ok(Array.isArray(stats.byAction))
  assert.ok(Array.isArray(stats.byTool))
  assert.equal(stats.allowed, 3)
  assert.equal(stats.denied, 2)
  // 放行 + 拒绝 + 未标注 = 总数
  assert.equal(stats.allowed + stats.denied + stats.unknownOutcome, stats.total)
})

// ── Scenario: 分类计数的合计等于总数 ────────────────────────────────────────
test('审计可视化 :: 分类计数的合计等于总数', () => {
  const stats = summarize(SAMPLE)
  const sum = (rows) => rows.reduce((total, row) => total + row.count, 0)
  assert.equal(sum(stats.byDecision), stats.total, '按判定分组必须闭合')
  assert.equal(sum(stats.byTool), stats.total, '按工具分组必须闭合')
  // 字段残缺的条目也不能漏掉
  const ragged = summarize([
    { decision: 'deny' }, // 没有 tool/action/allowed
    { tool: 'Click' }, // 没有 decision
    null, // 完全空
    'not-an-object',
    42,
  ])
  assert.equal(ragged.total, 5, '任何形状的条目都要计入总数')
  assert.equal(sum(ragged.byDecision), ragged.total)
  assert.equal(sum(ragged.byTool), ragged.total)
})

// ── Scenario: 渲染结果包含标题与分区 ────────────────────────────────────────
test('审计可视化 :: 渲染结果包含标题与分区', () => {
  const report = renderReport(SAMPLE)
  const lines = report.split('\n')
  assert.match(lines[0], /^# Windows-MCP 审计报告（5 条记录）$/, `首行应带条目数，实际 ${JSON.stringify(lines[0])}`)
  assert.match(report, /## 概览/)
  assert.match(report, /## 分类/)
  assert.match(report, /## 最近条目/)
  // 分区顺序固定
  assert.ok(report.indexOf('## 概览') < report.indexOf('## 分类'))
  assert.ok(report.indexOf('## 分类') < report.indexOf('## 最近条目'))
})

// ── Scenario: 最近条目按时间倒序 ────────────────────────────────────────────
test('审计可视化 :: 最近条目按时间倒序', () => {
  const ordered = orderRecent(SAMPLE.map(representEntry), 10)
  const times = ordered.map((item) => item.at)
  const parsed = times.map((value) => Date.parse(value))
  for (let i = 1; i < parsed.length; i++) {
    assert.ok(parsed[i - 1] >= parsed[i], `第 ${i} 条比前一条更早，倒序被破坏`)
  }
  // 渲染里第一条最近条目应是最后发生的那件事
  const report = renderReport(SAMPLE)
  const recentSection = report.slice(report.indexOf('## 最近条目'))
  const firstBullet = recentSection.split('\n').find((line) => line.startsWith('- '))
  assert.match(firstBullet, /DisplayInventory/, '最新的应是 DisplayInventory 那条')
})

// ── Scenario: 空日志给出明确说明而不是空白 ──────────────────────────────────
test('审计可视化 :: 空日志给出明确说明而不是空白', () => {
  for (const empty of [[], undefined, null]) {
    const report = renderReport(empty)
    assert.ok(report.length > 0, '空输入不得渲染成空串')
    assert.match(report, /暂无记录/)
    assert.match(report, /0 条记录/)
  }
})

// ── Scenario: 时间不可解析的条目不被丢弃 ────────────────────────────────────
test('审计可视化 :: 时间不可解析的条目不被丢弃', () => {
  const withBadTime = [...SAMPLE, { at: 'garbage', decision: 'deny', tool: 'Registry', allowed: false, code: 'X' }]
  const stats = summarize(withBadTime)
  assert.equal(stats.total, 6, '时间坏掉的条目仍必须计入')
  const report = renderReport(withBadTime)
  assert.match(report, /6 条记录/)
  assert.match(report, /--:--:--/, '不可解析的时间必须用占位符而不是伪造时间')
  // 排最后：时间可用的都在它前面
  const ordered = orderRecent(withBadTime.map(representEntry), 10)
  assert.equal(ordered.at(-1).tool, 'Registry', '不可解析时间的条目应排在最后')
  assert.equal(formatTime('garbage'), '--:--:--')
  assert.equal(formatTime(null), '--:--:--')
})

// ── Scenario: 畸形输入不得让渲染抛异常 ──────────────────────────────────────
test('审计可视化 :: 畸形输入不得让渲染抛异常', () => {
  const hostile = [
    ['undefined', undefined],
    ['null', null],
    ['string', 'string'],
    ['number', 42],
    ['empty object', {}],
    ['wrong-typed fields', { at: {}, decision: 42, tool: [], reason: 999 }],
    ['null-prototype object', Object.create(null)],
    ['throwing getter', { get at() { throw new Error('恶意 getter') } }],
  ]
  for (const [label, input] of hostile) {
    // 注意：断言消息里不能 String(input) —— 恶意 getter 会在构造消息时先抛，
    // 那是测试自己的问题，会被误判成实现的问题（本测试第一版就踩了这个）。
    assert.doesNotThrow(() => summarize([input]), `summarize 对 ${label} 抛异常`)
    assert.doesNotThrow(() => renderReport([input]), `renderReport 对 ${label} 抛异常`)
    assert.doesNotThrow(() => representEntry(input), `representEntry 对 ${label} 抛异常`)
  }
  assert.doesNotThrow(() => summarize('not-an-array'))
  assert.doesNotThrow(() => renderReport('not-an-array'))
  // 非数组输入按空处理，不得崩
  assert.equal(summarize('not-an-array').total, 0)
  // 抛错 getter 的条目也要能渲染出可读文本
  const report = renderReport([{ get at() { throw new Error('恶意 getter') } }])
  assert.match(report, /1 条记录/)
})

// ── Scenario: 两个入口共用同一实现 ──────────────────────────────────────────
test('审计可视化 :: 两个入口共用同一实现', () => {
  // 工具侧必须引用本模块，而不是自己渲染
  const indexSource = readFileSync(join(ROOT, 'index.js'), 'utf8')
  assert.match(indexSource, /from '\.\/lib\/auditview\.js'/, 'index.js 必须从 lib/auditview.js 引入')
  assert.match(indexSource, /renderReport/, 'winmcp_audit 必须调用 renderReport')

  // 脚本侧同理
  const scriptSource = readFileSync(join(ROOT, 'scripts', 'audit-report.mjs'), 'utf8')
  assert.match(scriptSource, /auditview\.js/, '脚本必须从 lib/auditview.js 引入')
  assert.match(scriptSource, /renderReport/, '脚本必须调用 renderReport')
})

// ── Scenario: 原因过长时截断并标注 ──────────────────────────────────────────
test('审计可视化 :: 原因过长时截断并标注', () => {
  const longReason = 'X'.repeat(500)
  const long = truncate(longReason)
  assert.ok(long.length <= REASON_MAX_CHARS, `截断后长度应受控，实际 ${long.length}`)
  assert.ok(long.endsWith('…'), '必须带省略标记，而不是悄悄截断')
  const report = renderReport([{ at: '2026-01-01T00:00:00.000Z', decision: 'deny', tool: 'X', reason: longReason }])
  assert.equal(report.includes(longReason), false, '超长原因不得原样进入单行')
  assert.match(report, /…/)
})

test('补强｜越界时间戳必须占位并排尾，不得显示 NaN（对抗性 V5）', () => {
  // `new Date(1e20)` 是 Invalid Date。曾经它显示成 `NaN:NaN:NaN`，
  // 还因为"看着有值"被排到最前（当成最新）。两类错误同时发生。
  //
  // 变异测试的教训：只测 `1e20` / `Infinity` / `NaN` 是不够的 ——
  // 它们在前置的 `Number.isFinite` 就被挡住了，真正走到 `new Date(...)` 检查的
  // 是**有限但越界**的毫秒数（8640000000000001 = Date 上限 + 1）。
  // 必须把它放进用例，否则删掉那行检查套件依然全绿。
  for (const bad of [8640000000000001, -8640000000000001, Number.MAX_SAFE_INTEGER]) {
    assert.equal(formatTime(bad), '--:--:--', `有限越界 at=${bad} 必须显示占位符`)
    assert.equal(parseTime(bad), null, `有限越界 at=${bad} 必须判为不可解析`)
  }
  // 非有限值同样占位
  for (const bad of [1e20, -1e20, Infinity, -Infinity, NaN]) {
    assert.equal(formatTime(bad), '--:--:--', `at=${bad} 应显示占位符`)
  }
  const entries = [
    { at: '2026-01-01T10:00:00.000Z', decision: 'allow', tool: 'OLDEST-BY-CLOCK' },
    { at: 8640000000000001, decision: 'allow', tool: 'FINITE-BUT-OUT-OF-RANGE' },
    { at: 1e20, decision: 'allow', tool: 'BROKEN-CLOCK' },
    { at: 'garbage', decision: 'allow', tool: 'UNPARSEABLE-CLOCK' },
  ]
  const ordered = orderRecent(entries.map(representEntry), 10)
  assert.equal(ordered.at(0).tool, 'OLDEST-BY-CLOCK', '越界时间不得被当成最新')
  assert.equal(ordered.at(-1).tool !== 'OLDEST-BY-CLOCK', true, '时间可用的必须排在坏的之前')
  const report = renderReport(entries)
  assert.equal(report.includes('NaN'), false, '渲染里不得出现 NaN 时间')
  assert.equal(summarize(entries).total, 4, '越界时间条目仍须计入统计')
})

test('补强｜reason 含换行不得破坏"每条一行"（对抗性 V7）', () => {
  // 审计视图是给人复盘的；能注入伪造行等于复盘结论被污染。
  const forged = 'line1\nline2  |  deny  |  FORGED-TOOL  |  FORGED-CODE  |  forged-reason'
  const report = renderReport([{ at: '2026-01-01T00:00:00.000Z', decision: 'deny', tool: 'Real', reason: forged }])
  const recentSection = report.slice(report.indexOf('## 最近条目'))
  const bullets = recentSection.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(bullets.length, 1, `换行被折叠后应只有一条，实际 ${bullets.length}`)
  assert.equal(report.includes('FORGED-TOOL'), true, '内容仍应可见（只是不能伪造行结构）')
  assert.equal(toSingleLine('a\r\nb\u2028c'), 'a b c')
  assert.equal(toSingleLine('a\u0000b'), 'a b')
})

test('补强｜统计分区里的键也要压成单行', () => {
  const report = renderReport([
    { at: '2026-01-01T00:00:00.000Z', decision: 'deny', tool: 'X\n- forged', allowed: false },
  ])
  const bullets = report.split('\n').filter((line) => line.startsWith('- '))
  // 每个分区条目都是单行；不允许出现额外以 "- " 开头的伪造行
  assert.equal(bullets.some((line) => line.includes('\n')), false)
})

test('补强｜两个入口的默认条数必须相等（对抗性 V13）', () => {
  assert.equal(DEFAULT_AUDIT_LIMIT, DEFAULT_RECENT, '工具与脚本的默认条数必须一致')
  const scriptSource = readFileSync(join(ROOT, 'scripts', 'audit-report.mjs'), 'utf8')
  assert.match(scriptSource, /DEFAULT_RECENT/, '脚本必须引用共享默认值而不是写死数字')
  assert.equal(/'10'|"10"/.test(scriptSource), false, '脚本不应写死 10')
  const indexSource = readFileSync(join(ROOT, 'index.js'), 'utf8')
  assert.match(indexSource, /DEFAULT_AUDIT_LIMIT/, '工具必须引用共享默认值')
  // 工具 schema 里给模型看的"默认值"也必须是同一个数。否则模型读到 30、实际拿到 10，
  // 它会以为自己拿到了全部条目（对抗性探针 p03 发现 description 写 30 而实际默认 10）。
  assert.equal(
    /返回条数，默认\s*30/.test(indexSource),
    false,
    '工具描述不得写死一个与实际默认不同的数字',
  )
  assert.match(indexSource, /返回条数，默认 \$\{DEFAULT_AUDIT_LIMIT\}/, '描述应由共享常量插值')
})


// ── Scenario: 同一工具的两种写法归一到一行 ──────────────────────────────────
test('审计可视化 :: 同一工具的两种写法归一到一行', () => {
  const entries = [
    { tool: 'mcp__winmcp__PowerShell', decision: 'allow', allowed: true },
    { tool: 'PowerShell', decision: 'ok', allowed: true },
    { tool: 'mcp__winmcp__Snapshot', decision: 'observed', allowed: true },
  ]
  const stats = summarize(entries)
  assert.deepEqual(stats.byTool, [
    { key: 'PowerShell', count: 2 },
    { key: 'Snapshot', count: 1 },
  ], '带前缀与去前缀的同一工具必须合并')
  assert.equal(stats.total, 3, '归一化只影响展示，不影响总数')
  // 最近条目里也不应再出现带前缀的写法
  const report = renderReport(entries)
  assert.equal(report.includes('mcp__winmcp__'), false, '渲染里不应出现前缀写法')
})

test('补强｜normalizeToolForDisplay 的边界', () => {
  assert.equal(normalizeToolForDisplay('mcp__winmcp__PowerShell'), 'PowerShell')
  assert.equal(normalizeToolForDisplay('MCP__WINMCP__PowerShell'), 'PowerShell', '前缀匹配大小写不敏感')
  assert.equal(normalizeToolForDisplay('PowerShell'), 'PowerShell')
  assert.equal(normalizeToolForDisplay('mcp__other__Click'), 'Click', '别的 server 前缀同样剥掉')
  assert.equal(normalizeToolForDisplay('mcp__winmcp__'), '(unknown)', '剥完为空要退化为占位')
  assert.equal(normalizeToolForDisplay(''), '(unknown)')
  assert.equal(normalizeToolForDisplay(null), '(unknown)')
})

test('补强｜计数排序稳定：降序且同频按名称升序', () => {
  const entries = [
    { tool: 'B' }, { tool: 'A' }, { tool: 'B' }, { tool: 'C' },
  ]
  const stats = summarize(entries)
  assert.deepEqual(stats.byTool, [
    { key: 'B', count: 2 },
    { key: 'A', count: 1 },
    { key: 'C', count: 1 },
  ])
})

test('补强｜byCode 只统计真正带 code 的条目', () => {
  const stats = summarize([
    { code: 'A' }, { code: 'A' }, { code: 'B' }, { }, { code: null },
  ])
  assert.deepEqual(stats.byCode, [
    { key: 'A', count: 2 },
    { key: 'B', count: 1 },
  ])
  assert.equal(stats.total, 5, '没有 code 的条目仍然计入总数')
})

test('补强｜orderRecent 的 limit 边界', () => {
  assert.equal(orderRecent(SAMPLE.map(representEntry), 0).length, 0)
  assert.equal(orderRecent(SAMPLE.map(representEntry), -1).length, 5, '负数按"不限"处理')
  assert.equal(orderRecent(SAMPLE.map(representEntry), 2).length, 2)
})

test('补强｜representEntry 对字符串条目给出可读占位', () => {
  const represented = representEntry('loose string')
  assert.equal(represented.decision, 'unknown')
  assert.equal(represented.tool, '(unknown)')
  assert.equal(represented.reason, 'loose string')
})
