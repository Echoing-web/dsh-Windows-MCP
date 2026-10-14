/**
 * BDD 行为测试：features/concurrency.feature
 *
 * ## 为什么并发必须真的"交错"而不是顺序调用
 * 顺序调用两次互相隔离是平凡的。真正危险的形状是：A 观测 → B 观测 → A 点击 → B 点击。
 * 此时若存储用「全局当前观测」而不是「按 agent 分桶」，A 的点击就会落在 B 的观测上，
 * 而**两次调用都会成功**——没有任何报错，只是点错了地方。
 * 所以场景 1 用两次不同光标位置的观测把「串桶」变成可判定的失败。
 *
 * ## 审计的并发在测什么
 * 审计是 append-only JSONL。如果实现是「读全文 → 拼接 → 覆盖写」，
 * 并发下必然丢行或写出半截行。场景 4 直接断言行数与每行的 JSON 合法性，
 * 不依赖实现用了什么 I/O 原语。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { createHost } from '../harness/host.js'
import { createFakeMcpServer } from '../harness/fake-mcp.js'
import { coverage } from '../harness/link.js'

coverage({
  spec: ['S-BRIDGE-07'],
  covers: [
    '并发一致性 :: 两个 agent 交错观测与点击不互相污染',
    '并发一致性 :: 引用别的 agent 的观测会被拒绝',
    '并发一致性 :: 多路并发写入观测不丢不重',
    '并发一致性 :: 并发写入的审计每一行都是合法 JSON',
  ],
})

/** 从状态报告里取出「最新观测: <id>」的编号。 */
function observationIdOf(text) {
  const match = /最新观测: (obs-\d+)/.exec(text)
  return match ? match[1] : null
}

// ── Scenario: 两个 agent 交错观测与点击不互相污染 ───────────────────────────
test('并发一致性 :: 两个 agent 交错观测与点击不互相污染', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    // 真实形状、但两台「机器」的光标不同：串桶时坐标会立刻露馅
    const serverA = createFakeMcpServer({ cursor: { x: 100, y: 200 } })
    const serverB = createFakeMcpServer({ cursor: { x: 900, y: 800 } })

    const a1 = await host.callTool(serverA, 'Screenshot', {}, 'agent-A')
    const b1 = await host.callTool(serverB, 'Screenshot', {}, 'agent-B')
    assert.equal(a1.decision.kind, 'accept')
    assert.equal(b1.decision.kind, 'accept')

    const idA = observationIdOf((await host.runTool('winmcp_state', {}, 'agent-A')).text)
    const idB = observationIdOf((await host.runTool('winmcp_state', {}, 'agent-B')).text)
    assert.notEqual(idA, idB, '两个 agent 必须各自拿到自己的观测编号')

    // 各自的光标与映射都在自己的桶里
    const stateA = (await host.runTool('winmcp_state', {}, 'agent-A')).text
    const stateB = (await host.runTool('winmcp_state', {}, 'agent-B')).text
    assert.match(stateA, /光标: \(100, 200\)/)
    assert.match(stateB, /光标: \(900, 800\)/)
    assert.equal(host.audit.read({ limit: 50 }).find((e) => e.observationId === idA).screen.x, 100)
    assert.equal(host.audit.read({ limit: 50 }).find((e) => e.observationId === idB).screen.x, 900)

    // 交错点击：谁都不该被拒
    const gateA = await host.pre(host.exec('mcp__winmcp__Click', { loc: [100, 200], based_on: idA }, 'agent-A'))
    const gateB = await host.pre(host.exec('mcp__winmcp__Click', { loc: [900, 800], based_on: idB }, 'agent-B'))
    assert.equal(gateA.kind, 'allow', JSON.stringify(gateA))
    assert.equal(gateB.kind, 'allow', JSON.stringify(gateB))

    const denials = host.audit.read({ limit: 50 }).filter((entry) => entry.decision === 'deny')
    assert.deepEqual(denials, [], '交叉引用自己桶里的观测不该被拒')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 引用别的 agent 的观测会被拒绝 ─────────────────────────────────
test('并发一致性 :: 引用别的 agent 的观测会被拒绝', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    const serverA = createFakeMcpServer()
    const serverB = createFakeMcpServer()

    await host.callTool(serverA, 'Screenshot', {}, 'agent-A')
    const idA = observationIdOf((await host.runTool('winmcp_state', {}, 'agent-A')).text)

    // B 先观测一次，好让它**有**自己的观测（否则拒绝理由会是 NO_OBSERVATION 而不是串会话）
    await host.callTool(serverB, 'Screenshot', {}, 'agent-B')
    const idB = observationIdOf((await host.runTool('winmcp_state', {}, 'agent-B')).text)
    assert.notEqual(idA, idB)

    // B 拿 A 的编号当依据
    const gate = await host.pre(host.exec('mcp__winmcp__Click', { loc: [1, 2], based_on: idA }, 'agent-B'))
    assert.equal(gate.kind, 'deny')
    assert.equal(gate.info.code, 'UNKNOWN_OBSERVATION')
    assert.match(gate.reason, new RegExp(idA), '拒绝原因必须给出模型写的那个 id')

    const denial = host.audit.read({ limit: 50 }).find((entry) => entry.decision === 'deny')
    assert.equal(denial.code, 'UNKNOWN_OBSERVATION')
    assert.equal(denial.observationId, idB, '拒绝记录里的观测必须是 B 自己的')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 多路并发写入观测不丢不重 ──────────────────────────────────────
test('并发一致性 :: 多路并发写入观测不丢不重', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4']
    const perAgent = 10
    // 每个 agent 一台自己的"服务器"，光标各不相同（值 = agent 序号 * 1000 + 序号）
    const jobs = []
    for (const [agentIndex, agent] of agents.entries()) {
      for (let i = 0; i < perAgent; i++) {
        const server = createFakeMcpServer({ cursor: { x: agentIndex * 1000 + i, y: 7 } })
        jobs.push(host.callTool(server, 'Screenshot', {}, agent))
      }
    }
    const results = await Promise.all(jobs)
    assert.ok(results.every(({ decision }) => decision.kind === 'accept'), '全部观测都应当被接受')

    const observedEntries = host.audit.read({ limit: 200 }).filter((entry) => entry.decision === 'observed')
    assert.equal(observedEntries.length, agents.length * perAgent, '观测条数不得丢')
    const ids = observedEntries.map((entry) => entry.observationId)
    assert.equal(new Set(ids).size, ids.length, '观测编号不得重复')
    assert.deepEqual([...ids].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4))), ids, '编号应按提交顺序单调')

    // 每个会话桶恰好 10 条，且当前观测各不相同
    const current = []
    for (const agent of agents) {
      const state = (await host.runTool('winmcp_state', {}, agent)).text
      assert.match(state, new RegExp(`本会话代次 generation=${perAgent}`), `${agent} 代次不对：${state}`)
      current.push(observationIdOf(state))
    }
    assert.equal(new Set(current).size, agents.length, '四个会话的当前观测必须互不相同')

    // 桶内容也要点对点核对：每个桶的当前观测光标值必须与它自己的最后一次写入相符
    for (const [agentIndex, agent] of agents.entries()) {
      const state = (await host.runTool('winmcp_state', {}, agent)).text
      assert.match(
        state,
        new RegExp(`光标: \\(${agentIndex * 1000 + perAgent - 1}, 7\\)`),
        `${agent} 的当前观测串桶了：${state}`,
      )
    }
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 并发写入的审计每一行都是合法 JSON ─────────────────────────────
test('并发一致性 :: 并发写入的审计每一行都是合法 JSON', async () => {
  const host = createHost({ config: { serverName: 'winmcp' }, audit: 'file' })
  try {
    const file = host.audit.file
    const server = createFakeMcpServer()
    const total = 20
    const agents = ['agent-1', 'agent-2', 'agent-3', 'agent-4']

    // 20 次 post-execute 同时在途：真实文件后端 + 真实插件 + 真实审计
    const jobs = []
    for (let i = 0; i < total; i++) {
      jobs.push(host.callTool(server, 'Screenshot', { callIndex: i }, agents[i % agents.length]))
    }
    const results = await Promise.all(jobs)
    assert.ok(results.every(({ decision }) => decision.kind === 'accept'))

    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n').filter((line) => line !== '')
    assert.equal(lines.length, total, `文件行数必须等于写入次数：${lines.length} != ${total}`)

    const parsed = []
    for (const [index, line] of lines.entries()) {
      assert.doesNotThrow(() => JSON.parse(line), `第 ${index + 1} 行不是合法 JSON：${line.slice(0, 120)}`)
      // 半截行通常表现为「能解析但缺字段」，所以再核对一次关键字段
      const entry = JSON.parse(line)
      assert.equal(typeof entry, 'object')
      assert.equal(entry.at, '2023-11-14T22:13:20.000Z', 'ISO 时间戳必须完整')
      assert.equal(entry.decision, 'observed')
      assert.ok(typeof entry.observationId === 'string' && entry.observationId.startsWith('obs-'))
      parsed.push(entry)
    }
    assert.equal(new Set(parsed.map((entry) => entry.observationId)).size, total, '每行都是独立完整的一条')

    // 审计的读回视图与实际文件一致（S-AUDIT-05 的容错不得把完整文件读丢）
    assert.equal(host.audit.read({ limit: 100 }).length, total)
  } finally {
    host.cleanup()
  }
})
