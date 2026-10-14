/**
 * 配置面一致性测试：index.js 的 DEFAULTS、cordis.patch.yml、README 三处必须对齐。
 *
 * 为什么值得单独测：这类「文档写着一套、代码跑另一套」的漂移是插件最常见的
 * 隐性 bug——用户照 README 改配置却不生效，排查成本极高。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DEFAULTS, normalizeConfig } from '../index.js'
import { OFFERED_TOOLS, DOCUMENTED_DEFAULTS } from './helpers/config-surface.mjs'
import { coverage } from './harness/link.js'

coverage({
  spec: ['S-CFG-01', 'S-CFG-02', 'S-HOST-05'],
  covers: [],
})

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const readmeText = readFileSync(join(root, 'README.md'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('package.json 的 dsh.bundle.patch 指向真实存在的 patch 文件', () => {
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(patchText.length > 0)
})

test('cordis.patch.yml 恰好插入本插件一行，且不重复插入 mcp-winmcp', () => {
  // 只有一处顶层 insert
  const insertCount = (patchText.match(/^-\s*insert:/gm) ?? []).length
  assert.equal(insertCount, 1, '应当只有一个顶层 insert 列表')
  // 本插件行存在
  assert.match(patchText, /id:\s*dsh-windows-mcp/)
  assert.match(patchText, /name:\s*'dsh-windows-mcp'/)
  // 桥接行必须被注释掉：本机 profile 已经 insert 过，重复会 duplicate loader entry id
  const activeLines = patchText
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  assert.doesNotMatch(
    activeLines,
    /id:\s*mcp-winmcp/,
    '桥接行不能在本 bundle 里激活插入（会与 profile 的 insert 冲突）',
  )
  assert.match(patchText, /#\s*- id: mcp-winmcp/, '桥接行示例应当以注释形式保留')
})

test('cordis.patch.yml 里的 config 键全部是已知键', () => {
  const known = new Set(Object.keys(DEFAULTS))
  const block = /- id: dsh-windows-mcp[\s\S]*?(?=\n\S|\n#|$)/.exec(patchText)?.[0] ?? ''
  const keys = [...block.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])
  assert.ok(keys.length >= 8, `解析出的配置键太少：${keys.join(',')}`)
  for (const key of keys) {
    assert.ok(known.has(key), `cordis.patch.yml 出现未知配置键 ${key}`)
  }
})

test('DEFAULTS 与文档化的默认值完全一致', () => {
  for (const [key, value] of Object.entries(DOCUMENTED_DEFAULTS)) {
    assert.ok(key in DEFAULTS, `DEFAULTS 缺少键 ${key}`)
    // 数组/对象型默认值必须比内容，不能比引用（`[] !== []` 会让这条测试假失败）
    if (value !== null && typeof value === 'object') {
      assert.deepEqual(DEFAULTS[key], value, `DEFAULTS.${key} 与文档不一致`)
    } else {
      assert.equal(DEFAULTS[key], value, `DEFAULTS.${key} 与文档不一致`)
    }
  }
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(key in DOCUMENTED_DEFAULTS, `文档缺少 DEFAULTS 里的键 ${key}`)
  }
})

test('README 记录了每一个配置键与默认值', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(readmeText.includes(key), `README 未提及配置键 ${key}`)
    const shown = value === '' ? '空' : String(value)
    assert.ok(
      readmeText.includes(shown) || readmeText.includes(`\`${shown}\``),
      `README 未写出 ${key} 的默认值 ${shown}`,
    )
  }
})

test('配置表列出的键集合与 DEFAULTS 完全一致（防"文档多写/少写一个键"）', () => {
  // 从 README 的**插件配置表**里抽键：形如 "| `key` | 默认 | 说明 |"。
  // 只取配置表那一段，否则命令级策略的类目映射表（`PowerShell` 等）会被误当配置键。
  const tableStart = readmeText.indexOf('| 键 | 默认 | 说明 |')
  assert.ok(tableStart >= 0, 'README 里找不到配置表')
  const tableEnd = readmeText.indexOf('\n\n', tableStart)
  const table = readmeText.slice(tableStart, tableEnd === -1 ? undefined : tableEnd)
  const documented = new Set([...table.matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|/gm)].map((m) => m[1]))
  assert.ok(documented.size >= 10, `从 README 配置表只解析出 ${documented.size} 个键`)
  const actual = new Set(Object.keys(DEFAULTS))
  const missingInReadme = [...actual].filter((key) => !documented.has(key))
  const missingInCode = [...documented].filter((key) => !actual.has(key))
  assert.deepEqual(missingInReadme, [], `README 配置表缺少：${missingInReadme.join(', ')}`)
  assert.deepEqual(missingInCode, [], `README 配置表多出（代码里没有）：${missingInCode.join(', ')}`)
})

test('README 记录了全部辅助工具名', () => {
  for (const tool of OFFERED_TOOLS) {
    assert.ok(readmeText.includes(tool), `README 未记录工具 ${tool}`)
  }
})

test('patch 里的显式值都能被 normalizeConfig 接受且不被默认覆盖', () => {
  const block = /- id: dsh-windows-mcp[\s\S]*?(?=\n\S|\n#|$)/.exec(patchText)?.[0] ?? ''
  const pairs = [...block.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):\s*(.+)$/gm)]
  const raw = {}
  for (const [, key, rawValue] of pairs) {
    const value = rawValue.trim()
    if (value === 'true') raw[key] = true
    else if (value === 'false') raw[key] = false
    else if (/^\d+$/.test(value)) raw[key] = Number(value)
    // 数组型默认值在 yml 里写作流式空数组 `[]`；文本比对时它是字符串，
    // 必须还原成数组类型，否则 `[] !== '[]'` 会造成假失败。
    else if (value === '[]') raw[key] = []
    else raw[key] = value
  }
  const config = normalizeConfig(raw, { DSH_HOME: 'C:\\fake' })
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'auditFile') continue
    if (Array.isArray(value)) {
      assert.deepEqual(config[key], value, `${key} 在归一化后被改动了`)
    } else {
      assert.equal(config[key], value, `${key} 在归一化后被改动了`)
    }
  }
})

// ── A-13 的另一半：yml 缺失键即不一致 ──────────────────────────────────────
test('A-13：yml 必须覆盖 DEFAULTS 的每一个键，派生键除外', () => {
  const block = /- id: dsh-windows-mcp[\s\S]*?(?=\n\S|\n#|$)/.exec(patchText)?.[0] ?? ''
  const ymlKeys = new Set([...block.matchAll(/^\s{8}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]))
  assert.ok(ymlKeys.size >= 10, `从 yml 只解析出 ${ymlKeys.size} 个键`)

  // A-13：取值由环境在运行期决定的派生键不要求在 yml 中出现
  const DERIVED_KEYS = new Set(['auditFile'])

  const missing = Object.keys(DEFAULTS).filter(
    (key) => !DERIVED_KEYS.has(key) && !ymlKeys.has(key),
  )
  assert.deepEqual(
    missing,
    [],
    `这些非派生键在 cordis.patch.yml 里缺失（A-13：缺失即不一致）：${missing.join(', ')}`,
  )

  const unknown = [...ymlKeys].filter((key) => !(key in DEFAULTS))
  assert.deepEqual(unknown, [], `yml 里有 DEFAULTS 不知道的键：${unknown.join(', ')}`)

  // 派生键必须在 README 里被标注为「派生」
  for (const key of DERIVED_KEYS) {
    const row = readmeText.split('\n').find((line) => line.includes(`\`${key}\``) && line.startsWith('|'))
    assert.ok(row, `README 配置表里找不到派生键 ${key} 的行`)
    assert.match(row, /派生/, `README 的 ${key} 行必须标注为「派生」（A-13）`)
  }
})

test('README 说明了两条方言陷阱（insert 才能新建 / 一个 id 只能插入一次）', () => {
  assert.match(readmeText, /insert/)
  assert.match(readmeText, /duplicate loader entry id|重复.*insert/)
})

// ── S-HOST-05：桥接行的所有权 ───────────────────────────────────────────────
test('S-HOST-05：本 bundle 不插入桥接行，只插入自己的行', () => {
  const active = patchText
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  // 桥接行必须只以注释形式存在
  assert.doesNotMatch(active, /id:\s*mcp-winmcp/, '本 bundle 绝不能激活插入桥接行')
  assert.match(patchText, /#\s*- id: mcp-winmcp/, '桥接行示例应以注释保留，供换机器时启用')
  // 且只插入自己这一行
  const insertedIds = [...active.matchAll(/^\s+-\s*id:\s*(\S+)/gm)].map((match) => match[1])
  assert.deepEqual(insertedIds, ['dsh-windows-mcp'])
})

test('S-HOST-05：README 写明了桥接行归 profile 所有', () => {
  assert.match(readmeText, /mcp-winmcp/)
  assert.match(readmeText, /profile/)
})

// ── S-CFG-02：默认值即安全值 ────────────────────────────────────────────────
test('S-CFG-02：默认配置就已经具备闸门与急停的保护', () => {
  const config = normalizeConfig({}, { DSH_HOME: 'C:\\x' })
  // 闸门默认开启
  assert.equal(config.requireObservation, true, '默认必须要求前置观测')
  assert.equal(config.requireProcessMatch, true, '默认必须复核窗口漂移')
  assert.equal(config.requireCoordinateMapping, true, '默认必须要求坐标映射信息')
  // 时间上限必须是个有限正数，不能是 Infinity 之类的"永不过期"
  assert.ok(Number.isFinite(config.maxObservationAgeMs))
  assert.ok(config.maxObservationAgeMs > 0)
  assert.ok(config.maxObservationAgeMs <= 300_000, '默认上限不宜过大，否则等于没闸门')
  // 审计默认开启（出问题才有复盘依据）
  assert.equal(config.autoAudit, true)
  assert.notEqual(config.auditFile, '', '默认应有审计落盘路径')
  // 富化默认开启（坐标映射必须默认可见）
  assert.equal(config.annotateResults, true)
})

test('S-CFG-02：默认的 serverName 与桥接行一致', () => {
  const config = normalizeConfig({}, { DSH_HOME: 'C:\\x' })
  assert.equal(config.serverName, 'winmcp')
  // cordis.patch.yml 里声明的 serverName 必须与代码默认值一致
  const declared = /serverName:\s*(\S+)/.exec(patchText)?.[1]
  assert.equal(declared, config.serverName, 'patch 与代码的 serverName 必须一致')
})
