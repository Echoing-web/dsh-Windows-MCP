/**
 * BDD 行为测试：features/bridge-boundary.feature
 *
 * ## 这一层测什么、不测什么
 * 测的是**桥接边界**的对外行为：上游给一个形状，模型看到什么、观测里有什么、
 * 闸门放不放行、审计记了什么。不测上游本身（那由 SYS_SPEC 第 9 章的未验证项兜着）。
 *
 * ## 为什么用假 MCP 服务器而不是直接喂字符串
 * 直接喂字符串会跳过「桥投影」这一步，而这一步恰恰是真实故障高发区
 * （图片进不来、结果形状畸形）。用 `fake-mcp.js` 走 `host.callTool()`，
 * 链路上的每一环都是真实实现，只有"服务器的响应"是数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createHost } from '../harness/host.js'
import { createFakeMcpServer, KNOWN_BLOCKS, projectContent } from '../harness/fake-mcp.js'
import { coverage } from '../harness/link.js'

coverage({
  spec: ['S-BRIDGE-01', 'S-BRIDGE-02', 'S-BRIDGE-03', 'S-BRIDGE-04', 'S-BRIDGE-05', 'S-BRIDGE-06', 'S-BRIDGE-08'],
  covers: [
    '桥接边界 :: 带图片的截图走完整条链路',
    '桥接边界 :: 纯文本快照也能立即可点击',
    '桥接边界 :: 焦点窗口已打开窗口与界面元素都被解析出来',
    '桥接边界 :: 结果文本逐字节保真',
    '桥接边界 :: 畸形响应既不能抛也不能被当成观测',
    '桥接边界 :: 上游报错如实入库且不产生观测',
    '桥接边界 :: 图片无法被桥接纳时不谎报',
    '桥接边界 :: UI 树占位空树不产生任何元素',
    '桥接边界 :: UI 树完整时元素照常解析',
    '桥接边界 :: UI 树占位行混入属性也不该被当成元素',
    '桥接边界 :: 服务器不响应时不得产生半条观测',
    '桥接边界 :: 响应中途断线不得产生半条观测',
  ],
})

/** 起一个宿主；返回 {host, server, done}。 */
function setup(server = createFakeMcpServer(), options = {}) {
  const host = createHost({ config: { serverName: 'winmcp', ...(options.config ?? {}) } })
  return { host, server, done: () => host.cleanup() }
}

/**
 * 断言富化没有对上游结果做出本插件不该做的改动。
 *
 * 只比较上游结果自己表达过的事实：`isError` 是否被翻转、`value` 是否被换掉、
 * `content` 是否被本插件塞进了内容块。宿主决定对象上的其它键（`kind` 等）与
 * 测试宿主自身的默认值不在本断言范围。
 */
function assertUnchanged(decision, result, label) {
  if ('isError' in result) {
    assert.equal(decision.isError, result.isError, `${label}：isError 被改写了`)
  }
  if ('value' in result) {
    assert.deepEqual(decision.value, result.value, `${label}：value 被改写了`)
  }
  if (result.content !== undefined) {
    assert.deepEqual(decision.content, result.content, `${label}：content 被改写了`)
  }
}

// ── 补强：上游内容只在 value 里时，富化必须把原文放在最前面（V9）─────────────
test('补强｜上游内容只在 value 里时富化仍以上游原文开头（V9）', async () => {
  // 变异测试发现：把 `upstreamContentOf` 的 value.content 回退分支删掉，
  // 套件依然全绿 —— 因为所有既有用例都提供了 `result.content`，
  // 而 `result.content` 存在时会在回退之前直接返回。
  // 这条用例专门走"没有 result.content"的路径。
  const host = createHost({ config: { serverName: 'winmcp', annotateResults: true } })
  try {
    const upstreamText = 'Cursor Position: (1290, 651)\nScreenshot Region: (0,0,2560,1440)\nScreenshot Coordinate Scale: 1.333333'
    const upstreamBlocks = [{ type: 'text', text: upstreamText }]

    // 形状 1：上游内容在 value.content（没有顶层 content）
    const exec = host.exec('mcp__winmcp__Screenshot', {})
    const resultOnlyValueContent = { isError: false, value: { content: upstreamBlocks } }
    const decision = await host.post(exec, resultOnlyValueContent)
    assert.equal(decision.kind, 'accept')
    assert.ok(Array.isArray(decision.content), '应产生 content 数组')
    assert.deepEqual(
      decision.content.slice(0, 1),
      upstreamBlocks,
      '富化结果必须以上游原文开头，而不是只剩追加块',
    )
    assert.ok(decision.content.length > upstreamBlocks.length, '应追加映射块')
    assert.match(decision.content.at(-1).text, /\[mcp\]/)

    // 形状 2：上游内容是 value 上的字符串
    const exec2 = host.exec('mcp__winmcp__Screenshot', {})
    const resultValueString = { isError: false, value: upstreamText }
    const decision2 = await host.post(exec2, resultValueString)
    assert.equal(decision2.content[0].text, upstreamText, '字符串型上游内容也必须保留在最前')
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 带图片的截图走完整条链路 ──────────────────────────────────────
test('桥接边界 :: 带图片的截图走完整条链路', async () => {  const { host, server, done } = setup()
  try {
    const { result, decision } = await host.callTool(server, 'Screenshot')
    assert.equal(result.isError, false)
    assert.deepEqual(result.content.map((block) => block.type), ['text', 'image'])

    // 1) 富化只追加
    assert.equal(decision.kind, 'accept')
    assert.deepEqual(decision.content.slice(0, result.content.length), result.content)
    const appended = decision.content.slice(result.content.length)
    assert.ok(appended.length > 0, '应追加映射块')
    assert.ok(appended.every((block) => block.type === 'text'))
    assert.match(appended[0].text, /\[mcp\]/)
    assert.match(appended[0].text, /scale=1\.333/)
    assert.match(appended[0].text, /based_on=obs-1/)

    // 2) 观测携带图片标记与映射
    const state = await host.runTool('winmcp_state')
    assert.match(state.text, /最新观测: obs-1（Screenshot/)
    assert.match(state.text, /上游图片: 2560x1440/)
    assert.match(state.text, /附件尺寸: 1920x1080/)
    assert.match(state.text, /坐标映射: \[mcp\] scale=1\.333/)

    // 3) 闸门放行 + 观测留痕
    const click = host.exec('mcp__winmcp__Click', { loc: [2520, 35], based_on: 'obs-1' })
    const gate = await host.pre(click)
    assert.equal(gate.kind, 'allow', JSON.stringify(gate))
    const entries = host.audit.read({ limit: 50 })
    const observed = entries.find((entry) => entry.decision === 'observed')
    assert.ok(observed, '应记录观测条目')
    assert.equal(observed.observationId, 'obs-1')
    assert.equal(observed.tool, 'Screenshot')
    assert.deepEqual(observed.screen, { x: 1290, y: 651 })
    assert.equal(observed.coordScale, 1.333333)
    assert.equal(observed.screenPerImagePx, 1.333333)
    assert.equal(entries.filter((entry) => entry.decision === 'deny').length, 0, '闸门不应拒绝')

    // 4) 放行之后，观测仍然可被引用（同一 id 再点一次也放行）
    const second = await host.pre(host.exec('mcp__winmcp__Click', { loc: [2520, 35], based_on: 'obs-1' }))
    assert.equal(second.kind, 'allow', JSON.stringify(second))
  } finally {
    done()
  }
})

// ── Scenario: 纯文本快照也能立即可点击 ──────────────────────────────────────
test('桥接边界 :: 纯文本快照也能立即可点击', async () => {
  // image=false：Snapshot 不带图片块（真实上游在不请求视觉时就是这样）
  const { host, server, done } = setup(createFakeMcpServer({ image: false }))
  try {
    const { result, decision } = await host.callTool(server, 'Snapshot')
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0].type, 'text')
    assert.equal(decision.kind, 'accept')

    const state = await host.runTool('winmcp_state')
    assert.match(state.text, /光标: \(1290, 651\)/)
    assert.match(state.text, /坐标映射: \[mcp\] scale=1\.333/)

    // 紧接着的点击放行（纯文本也能定位 —— 因为元数据齐）
    const gate = await host.pre(host.exec('mcp__winmcp__Click', { loc: [1, 2], based_on: 'obs-1' }))
    assert.equal(gate.kind, 'allow', JSON.stringify(gate))
  } finally {
    done()
  }
})

// ── Scenario: 焦点窗口已打开窗口与界面元素都被解析出来 ──────────────────────
test('桥接边界 :: 焦点窗口已打开窗口与界面元素都被解析出来', async () => {
  const { host, server, done } = setup()
  try {
    const { decision } = await host.callTool(server, 'Snapshot')
    const state = await host.runTool('winmcp_state')
    assert.match(state.text, /焦点窗口: Notepad/)
    assert.match(state.text, /可交互元素: 3/)

    const uiBlock = decision.content.find((block) => block.type === 'text' && /个可交互元素/.test(block.text))
    assert.ok(uiBlock, '应给出元素数量提示块')
    assert.match(uiBlock.text, /3 个可交互元素/)
  } finally {
    done()
  }
})

// ── Scenario: 结果文本逐字节保真 ────────────────────────────────────────────
test('桥接边界 :: 结果文本逐字节保真', async () => {
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    // 真实上游的两类行尾噪音：CRLF 与残留 \r；外加中文控件名与 em dash（S-OBS-05 同源）
    const text =
      'Cursor Position: (100, 200)\r\n' +
      'Screenshot Coordinate Scale: 1.333333 — 说明文字\r\n' +
      '\r\n' +
      'UI Tree:\n' +
      '└── (10,20) 按钮 "关闭"\r'
    const execution = host.exec('mcp__winmcp__Snapshot')
    const result = { isError: false, value: { content: [{ type: 'text', text }] }, content: [{ type: 'text', text }] }
    const decision = await host.post(execution, result)
    assert.equal(decision.kind, 'accept')
    assert.equal(decision.content[0].text, text, '上游文本必须逐字符相同（含 CRLF 与残留 \\r）')
    assert.equal(decision.content[0].text.length, text.length)
    const appended = decision.content.slice(result.content.length)
    assert.ok(appended.length > 0, '追加块必须存在')
    assert.ok(appended.every((block) => block.type === 'text'))
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 畸形响应既不能抛也不能被当成观测 ──────────────────────────────
test('桥接边界 :: 畸形响应既不能抛也不能被当成观测', async () => {
  // 每一例都是「真实桥可能给出的坏形状」，不是随手编的字符串
  const malformed = [
    { label: 'value 是裸字符串', result: { isError: false, value: 'not-an-object', content: [] } },
    { label: 'content 不是数组', result: { isError: false, value: { content: 'nope' }, content: [] } },
    { label: 'content 是 null', result: { isError: false, value: { content: null }, content: [] } },
    { label: 'content 数组里是 null', result: { isError: false, value: { content: [null, 42] }, content: [] } },
    { label: 'text 字段不是字符串', result: { isError: false, value: { content: [{ type: 'text', text: 12345 }] }, content: [] } },
    { label: 'value 整个缺失', result: { isError: false, content: [] } },
  ]
  for (const { label, result } of malformed) {
    const host = createHost({ config: { serverName: 'winmcp' } })
    try {
      const execution = host.exec('mcp__winmcp__Snapshot')
      let decision
      await assert.doesNotReject(async () => {
        decision = await host.post(execution, result)
      }, `${label}：富化抛异常了`)
      assertUnchanged(decision, result, label)
      // 没有观测：状态工具必须说「无」
      const state = await host.runTool('winmcp_state')
      assert.match(state.text, /最新观测: 无/, `${label}：畸形结果被当成了观测`)
      // 也没有观测审计条目
      assert.equal(
        host.audit.read({ limit: 50 }).filter((entry) => entry.decision === 'observed').length,
        0,
        `${label}：畸形结果不应产生观测条目`,
      )
    } finally {
      host.cleanup()
    }
  }
})

// ── Scenario: 上游报错如实入库且不产生观测 ──────────────────────────────────
test('桥接边界 :: 上游报错如实入库且不产生观测', async () => {
  const { host, server, done } = setup(createFakeMcpServer({ error: { message: 'UIA 访问被拒绝', code: 'E_UIA' } }))
  try {
    const { result, decision } = await host.callTool(server, 'Click', { loc: [1, 2] })
    assert.equal(result.isError, true)
    assert.equal(decision.kind, 'accept')
    assert.deepEqual(decision.content, result.content, '报错结果不应被追加内容')
    assert.equal(decision.isError, true)

    const entries = host.audit.read({ limit: 50 })
    const errorEntry = entries.find((entry) => entry.decision === 'error')
    assert.ok(errorEntry, '必须留下 error 条目')
    assert.equal(errorEntry.reason, 'UIA 访问被拒绝')
    assert.equal(errorEntry.tool, 'Click')
    assert.equal(entries.filter((entry) => entry.decision === 'observed').length, 0, '报错不得产生观测')

    const state = await host.runTool('winmcp_state')
    assert.match(state.text, /最新观测: 无/)
  } finally {
    done()
  }
})

// ── Scenario: 图片无法被桥接纳时不谎报 ──────────────────────────────────────
test('桥接边界 :: 图片无法被桥接纳时不谎报', async () => {
  // 上游给了图，但媒体类型不在桥的允许列表里 → 桥整块丢弃
  const server = createFakeMcpServer({ image: true, mediaType: 'image/heif' })
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    const { result } = await host.callToolRaw(server, 'Screenshot')
    assert.deepEqual(result.value.content.map((block) => block.type), ['text', 'image'])
    assert.equal(projectContent(result.value.content).filter((block) => block.type === 'image').length, 0)

    const decision = await host.post(
      host.exec('mcp__winmcp__Screenshot'),
      result,
    )
    assert.equal(decision.kind, 'accept')
    assert.equal(
      decision.content.filter((block) => block.type === 'image').length,
      0,
      '桥不接纳的图片不得出现在内容块里',
    )
    // 元数据文本必须完整保留
    assert.match(decision.content[0].text, /Screenshot Coordinate Scale: 1\.333333/)
    assert.match(decision.content[0].text, /\(1920x1080px, image\/heif\)/)

    // 观测成立，但图片标记为假 —— 不把「确认不了」写成「确认有图」
    const state = await host.runTool('winmcp_state')
    assert.match(state.text, /最新观测: obs-1/)
    assert.doesNotMatch(state.text, /图片标记/, '状态报告不应声称有图')
    assert.equal(
      host.audit.read({ limit: 50 }).filter((entry) => entry.decision === 'observed').length,
      1,
      '观测本身仍应成立',
    )
  } finally {
    host.cleanup()
  }
})

// ── Scenario: UI 树占位空树不产生任何元素 ───────────────────────────────────
test('桥接边界 :: UI 树占位空树不产生任何元素', async () => {
  const { host, server, done } = setup(createFakeMcpServer({ uiTree: null }))
  try {
    const { result, decision } = await host.callTool(server, 'Snapshot')
    assert.match(result.value.content[0].text, /UI Tree:\nNo elements/)

    const state = await host.runTool('winmcp_state')
    assert.match(state.text, /最新观测: obs-1/)
    assert.match(state.text, /可交互元素: 0/)
    assert.match(state.text, /光标: \(1290, 651\)/)
    assert.match(state.text, /坐标映射: \[mcp\] scale=1\.333/)
    // 空树不得触发元素数量提示块
    assert.equal(
      decision.content.filter((block) => block.type === 'text' && /个可交互元素/.test(block.text)).length,
      0,
    )
  } finally {
    done()
  }
})

// ── Scenario: UI 树完整时元素照常解析 ───────────────────────────────────────
test('桥接边界 :: UI 树完整时元素照常解析', async () => {
  const { host, server, done } = setup()
  try {
    const { result, decision } = await host.callTool(server, 'Snapshot')
    const text = result.value.content[0].text
    assert.match(text, /\(2520,35\) 按钮 "关闭"  \[action: click\]/)

    const state = await host.runTool('winmcp_state')
    assert.match(state.text, /可交互元素: 3/)
    const hint = decision.content.find((block) => block.type === 'text' && /个可交互元素/.test(block.text))
    assert.ok(hint, '完整树应给出元素数量提示')
    assert.match(hint.text, /3 个可交互元素/)
  } finally {
    done()
  }
})

// ── Scenario: UI 树占位行混入属性也不该被当成元素 ────────────────────────────
test('桥接边界 :: UI 树占位行混入属性也不该被当成元素', async () => {
  // 退化形状：占位行带坐标与属性时，坐标正则会在占位文字里"找到"一个控件类型。
  // 两种写法都要判成空树 —— 这是「宁可判不出元素，也不能凭空造出元素」的执行点。
  const degenerate = ['No elements  [action: click]', '(0,0) No elements  [action: click]']
  for (const placeholder of degenerate) {
    const server = createFakeMcpServer({ uiTree: null, treePlaceholder: placeholder })
    const host = createHost({ config: { serverName: 'winmcp' } })
    try {
      const { result } = await host.callToolRaw(server, 'Snapshot')
      assert.ok(result.value.content[0].text.includes(placeholder), `占位文本必须真的出现在结果里：${placeholder}`)
      const decision = await host.post(host.exec('mcp__winmcp__Snapshot'), result)
      assert.equal(decision.kind, 'accept')

      const state = await host.runTool('winmcp_state')
      assert.match(state.text, /可交互元素: 0/, `占位行不得被解析成元素：${placeholder}`)
      assert.match(state.text, /光标: \(1290, 651\)/)
      assert.match(state.text, /坐标映射: \[mcp\]/)
    } finally {
      host.cleanup()
    }
  }
})

// ── Scenario: 服务器不响应时不得产生半条观测 ────────────────────────────────
test('桥接边界 :: 服务器不响应时不得产生半条观测', async () => {
  const server = createFakeMcpServer({ neverSpeak: true })
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    const execution = host.exec('mcp__winmcp__Snapshot')
    const inflight = server.respond('Snapshot')
    assert.equal(server.pendingCount(), 1, '这一次调用应当悬着')

    // 插件不应收到任何结果：宿主把它当成「空结果」继续是可接受的，但绝不能产生观测
    const empty = { isError: false, value: { content: [] }, content: [] }
    const decision = await host.post(execution, empty)
    assert.equal(decision.kind, 'accept')
    assert.deepEqual(decision.content, empty.content, '没有结果就不该追加内容块')

    const state = await host.runTool('winmcp_state')
    assert.match(state.text, /最新观测: 无/, '不响应的调用不得变成观测')
    assert.equal(
      host.audit.read({ limit: 50 }).filter((entry) => entry.decision === 'observed').length,
      0,
    )

    // 假服务器本身仍然悬着（这就是「不响应」的可观测定义）
    assert.equal(server.pendingCount(), 1)
    assert.ok(inflight instanceof Promise)
    // 显式静音：这不是「修复」，只是让测试进程不为一个刻意不 settle 的 promise 悬着
    inflight.then(() => {}, () => {})
  } finally {
    host.cleanup()
  }
})

// ── Scenario: 响应中途断线不得产生半条观测 ──────────────────────────────────
test('桥接边界 :: 响应中途断线不得产生半条观测', async () => {
  const server = createFakeMcpServer({ disconnectAfterChunks: 1 })
  const host = createHost({ config: { serverName: 'winmcp' } })
  try {
    const execution = host.exec('mcp__winmcp__Screenshot')

    // 上游断线：respond 抛错，宿主不会把结果交给插件
    await assert.rejects(() => server.respond('Screenshot'), /传输中断/)
    assert.deepEqual(server.sentChunks().map((block) => block.type), ['text'], '断线前只送出了文本块')

    // 即使宿主把传输错误交进 post-execute，插件也不得留下半条观测。
    // 注意：`next()` 抛错必须**原样向上抛**（那是宿主的失败语义），插件只负责不落盘半条观测。
    await assert.rejects(
      () => host.postRejects(execution, Object.assign(new Error('MCP 传输中断'), { code: 'MCP_DISCONNECT' })),
      /MCP 传输中断/,
    )
    const state0 = await host.runTool('winmcp_state')
    assert.match(state0.text, /最新观测: 无/)
    assert.equal(host.audit.read({ limit: 50 }).length, 0, '失败调用不得留下审计条目')

    // 后续一次完整响应必须从 obs-1 开始（没有半条观测留下的空洞或错位）
    const ok = await host.callTool(createFakeMcpServer(), 'Screenshot')
    assert.equal(ok.decision.kind, 'accept')
    const state1 = await host.runTool('winmcp_state')
    assert.match(state1.text, /最新观测: obs-1（Screenshot/)
    const observedIds = host.audit.read({ limit: 50 }).filter((entry) => entry.decision === 'observed').map((entry) => entry.observationId)
    assert.deepEqual(observedIds, ['obs-1'])
  } finally {
    host.cleanup()
  }
})

// ── 补强：假服务器的旋钮白名单（防止旋钮拼错后静默退化成默认形状） ──────────
test('补强｜假服务器拒绝未知区块旋钮', () => {
  assert.throws(
    () => createFakeMcpServer({ blocks: ['cursor', 'not-a-block'] }),
    /未知的 blocks 项/,
  )
  // 已知区块必须全部可用
  const server = createFakeMcpServer({ blocks: ['cursor', 'originalSize', 'uiTree'] })
  assert.deepEqual([...KNOWN_BLOCKS].filter((name) => !KNOWN_BLOCKS.includes(name)), [])
  return server.respond('Snapshot').then((result) => {
    const text = result.value.content[0].text
    assert.match(text, /Cursor Position:/)
    assert.doesNotMatch(text, /Screenshot Region:/)
    assert.doesNotMatch(text, /Coordinate Space:/)
  })
})
