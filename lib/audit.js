/**
 * audit.js — Windows-MCP 动作审计（append-only JSONL 日志）
 *
 * 设计约束（很重要）：
 * 1. 审计绝不能改变动作的结果。`record()` 只返回状态对象，永远不向调用方抛错；
 *    任何 I/O 失败都被吞掉、计数，并通过注入的 `onError` 上报。
 * 2. 文件按需惰性创建（父目录递归创建）：没有动作时不会产生垃圾文件。
 * 3. 内存保留一个有界环形缓冲（默认最近 1000 条），文件不可写时 `read()` 依然可用。
 * 4. 落盘前一律经过 `redact()`：base64 截图、token、密码等不会进入日志。
 * 5. 所有 I/O 通过 `io` 注入（默认 node:fs），测试可换成内存实现，无需真实文件系统。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** 规范化条目的字段顺序：缺失补 null；未列出的字段原样保留。 */
export const ENTRY_FIELDS = Object.freeze([
  'at',
  'action',
  'tool',
  'serverName',
  'observationId',
  'target',
  'screen',
  'image',
  'stale',
  'decision',
  'allowed',
  'reason',
  'processBefore',
  'processAfter',
  'durationMs',
  'result',
  'sessionId',
])

/** 内存环形缓冲上限。 */
export const RING_LIMIT = 1000

/**
 * 密钥样式键名。
 *
 * 这个名单是**脱敏能力的上限**：漏一个词就意味着该字段可能明文落盘。
 * 对抗性验证证明最初只有 `/key|token|password|secret|credential/i` 是**不够的**——
 * `authorization`、`cookie`、`session`、`bearer`、`jwt`、`passwd`、`pwd`、`signature`
 * 都会明文写出。
 *
 * 但名单也不能无限放宽：第一版改成 `key|...|session|...` 之后，
 * `monkey` 这类普通键名会被误伤，审计可读性下降。因此这里用**词边界**约束，
 * 只对"整词或明确前缀"生效：
 * - `key` / `secret` 等用 `\b…\b`，避免匹配到 `monkey`、`backend`；
 * - `authoriz` / `credential` 用前缀匹配，覆盖 `authorization` / `credentials`；
 * - 全大写缩写（`JWT`、`API_KEY`）在 `i` 标志下同样命中。
 * 注意两个边界陷阱：
 * - `\b` 在 `session_id` 上失效（`_` 属于 `\w`）；
 * - camelCase 的 `accessKey` 里 `key` 前面也没有词边界。
 *
 * 因此这里**不锚定左边界**，只要求词尾成立（`key` / `key_` / `keyId` 都命中）。
 * 代价是 `monkey` 这类普通词会被误打码——这个方向的误判是可接受的：
 * 审计里多几个 `<redacted>` 只是难读，少打一个就是凭据明文落盘。
 */
const SECRET_KEY_RE =
  /(?:key|keys|token|tokens|secret|secrets|password|passwd|pwd|credential|credentials|cookie|cookies|session|sessions|jwt|bearer|signature|sig|auth|authentication|authorization|apikey|api_key|access_token|refresh_token|private_key)(?:[._-]|\b)|\bauthoriz/i
const BLOB_KEY_RE = /^(image|screenshot|dataurl|base64|blob|screenshot_base64)$/i
/** 已打码标记：read() 再次防御性打码时必须保持不变，否则长度会被反复改写。 */
const REDACT_MARK_RE = /^<redacted(?: \d+ chars)?>$/
/** 命中 BLOB_KEY_RE 的键，字符串超过这个长度就整体打码。 */
const BLOB_KEY_MIN = 64
/** 任意位置的长 base64/hex 串（连续无空白字符）超过这个长度就整体打码。 */
const BLOB_MIN = 200
const MAX_REDACT_DEPTH = 8

/** 默认 I/O：node:fs 同步实现。 */
function defaultIo() {
  return {
    ensureDir(dir) {
      mkdirSync(dir, { recursive: true })
    },
    exists(p) {
      return existsSync(p)
    },
    size(p) {
      return statSync(p).size
    },
    append(p, text) {
      appendFileSync(p, text, 'utf8')
    },
    read(p) {
      return readFileSync(p, 'utf8')
    },
    rename(from, to) {
      renameSync(from, to)
    },
    remove(p) {
      unlinkSync(p)
    },
  }
}

/** 判断一个字符串是否像 base64/hex 大块数据：存在长度 > BLOB_MIN 的连续编码字符。 */
function looksLikeBlob(value) {
  if (typeof value !== 'string' || value.length <= BLOB_MIN) return false
  let run = 0
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i)
    const encoded =
      (c >= 48 && c <= 57) || // 0-9
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      c === 43 || // +
      c === 47 || // /
      c === 61 || // =
      c === 95 || // _
      c === 45 // -
    if (encoded) {
      run += 1
      if (run > BLOB_MIN) return true
    } else {
      run = 0
    }
  }
  return false
}

function maskedFor(value) {
  if (typeof value === 'string') {
    if (REDACT_MARK_RE.test(value)) return value
    return `<redacted ${value.length} chars>`
  }
  return '<redacted>'
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 打码：返回新的值，不改动输入。
 * - 键名匹配 /key|token|password|secret|credential/i → 整体打码；
 * - image/screenshot/base64 之类的键，长字符串整体打码；
 * - 任意位置的超长 base64/hex 串 → `<redacted N chars>`；
 * - 循环引用 → `[circular]`（同一对象被两个字段引用时不会被误判）。
 */
export function redact(value, depth = 0, ancestors = []) {
  if (value === null || value === undefined) return null
  const type = typeof value
  if (type === 'string') {
    return looksLikeBlob(value) ? `<redacted ${value.length} chars>` : value
  }
  if (type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return String(value)
  if (type === 'function') return '<function>'
  if (type === 'symbol') return '<symbol>'
  if (value instanceof Date) return value.toISOString()
  if (depth >= MAX_REDACT_DEPTH) return '[truncated:depth]'
  if (ancestors.includes(value)) return '[circular]'

  ancestors.push(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redact(item, depth + 1, ancestors))
    }
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = maskedFor(item)
        continue
      }
      if (
        typeof item === 'string' &&
        item.length > BLOB_KEY_MIN &&
        BLOB_KEY_RE.test(key)
      ) {
        out[key] = REDACT_MARK_RE.test(item) ? item : `<redacted ${item.length} chars>`
        continue
      }
      out[key] = redact(item, depth + 1, ancestors)
    }
    return out
  } finally {
    ancestors.pop()
  }
}

/**
 * 规范化条目：固定字段齐全（缺失补 null），额外字段一并保留。
 * 非对象输入被包装成 `{ value }`，避免直接丢弃信息。
 */
export function normaliseEntry(input, now = null) {
  const source = isPlainRecord(input) ? input : { value: input }
  const out = {}
  for (const field of ENTRY_FIELDS) {
    const raw = Object.prototype.hasOwnProperty.call(source, field) ? source[field] : null
    out[field] = raw === undefined ? null : raw
  }
  if (out.at === null || out.at === undefined) out.at = now
  // `at` 一律规范成 ISO 字符串。
  // 为什么必须做：policy.js 用的是毫秒时间戳，插件主体用的是 new Date().toISOString()，
  // 两种形状混在同一个 JSONL 里会让「按时间读日志」变得不可靠（实测撞到过）。
  // 接受三种输入：毫秒数、Date、可解析字符串。
  const coerced = coerceTime(out.at)
  if (coerced.at === null) {
    // 不可解析（或被替换）时用写入时刻兜底，并**留下痕迹**：
    // 静默替换会让人以为这条记录本来就是这个时间。
    const fallback = coerceTime(now)
    out.at = fallback.at
    if (coerced.coerced) out.atCoerced = true
  } else {
    out.at = coerced.at
  }
  for (const [key, value] of Object.entries(source)) {
    if (Object.prototype.hasOwnProperty.call(out, key)) continue
    // 顶层自引用直接标记，避免把整个输入对象再嵌套一份进日志。
    if (value === source) {
      out[key] = '[circular]'
      continue
    }
    out[key] = value === undefined ? null : value
  }
  return out
}

/**
 * 把时间值规范成 ISO 字符串。
 * @returns {{at: string|null, coerced: boolean}} `coerced` 表示原值不可解析、已被替换
 */
function coerceTime(value) {
  if (value === null || value === undefined) return { at: null, coerced: false }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { at: null, coerced: true }
    // 有限但**越界**的毫秒数（|n| > 8.64e15）不是合法时间：
    // `new Date(n).toISOString()` 会抛 RangeError。曾经这一类直接抛错，
    // 而 record() 会把它吞掉并计一次 writeFailures —— 条目**彻底丢失**，
    // 与 S-AUDIT-07（任何动作都要留下条目）冲突。对抗性验证 V6。
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return { at: null, coerced: true }
    return { at: date.toISOString(), coerced: false }
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? { at: null, coerced: true } : { at: value.toISOString(), coerced: false }
  }
  if (typeof value === 'string') {
    // 纯数字串按**毫秒时间戳**解析，不能交给 `Date.parse`：
    // `Date.parse('1700000000000')` 是 NaN，而 `Date.parse('0')` 会被解释成
    // 2000-01-01（本地时区）——那是它的方言行为，不是我们想要的语义。
    // 对抗性验证 N9。
    const trimmed = value.trim()
    if (/^-?\d+$/.test(trimmed)) {
      const numeric = Number(trimmed)
      if (!Number.isFinite(numeric)) return { at: null, coerced: true }
      const date = new Date(numeric)
      if (Number.isNaN(date.getTime())) return { at: null, coerced: true }
      return { at: date.toISOString(), coerced: false }
    }
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) return { at: null, coerced: true }
    const date = new Date(parsed)
    if (Number.isNaN(date.getTime())) return { at: null, coerced: true }
    return { at: date.toISOString(), coerced: false }
  }
  return { at: null, coerced: true }
}

/** 兼容导出：把毫秒时间戳 / Date / 可解析字符串统一成 ISO 字符串。 */
export function toIsoTime(value) {
  return coerceTime(value).at
}

function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * 逐行解析 JSONL，并把「不是对象」的行计入 skipped。
 *
 * 为什么必须过滤非对象行：`5`、`"x"`、`null`、`[]`、`true` 都是**合法 JSON**，
 * 于是早期实现会把它们原样返回。消费方随后读 `entries[i].observationId` 就炸了
 * （对抗性验证把这个列为 S-AUDIT-05 的规格缺口）。
 *
 * 同时把 skipped 计数暴露出去：静默丢弃和"统计到丢弃了多少行"在排障时完全不同。
 */
export function parseLines(text) {
  if (typeof text !== 'string' || text.length === 0) return { entries: [], skipped: 0 }
  const entries = []
  let skipped = 0
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    let parsed
    try {
      // 撕裂/半截的行在这里被跳过，绝不向外抛错。
      parsed = JSON.parse(line)
    } catch {
      skipped += 1
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped += 1
      continue
    }
    entries.push(parsed)
  }
  return { entries, skipped }
}

/**
 * 创建审计日志。
 *
 * @param {object} options
 * @param {string} options.file              JSONL 文件路径（惰性创建）
 * @param {() => number} [options.clock]     时间源，默认 Date.now
 * @param {number} [options.maxBytes]        触发轮转的字节阈值
 * @param {number} [options.rotateKeep]      保留的历史文件个数（.1 … .N）
 * @param {object} [options.io]              I/O 适配器（默认 node:fs）
 * @param {(error: Error, entry?: unknown) => void} [options.onError] 失败上报
 * @param {number} [options.ringLimit]       内存环形缓冲上限
 */
export function createAuditLog({
  file,
  clock = Date.now,
  maxBytes = 8 * 1024 * 1024,
  rotateKeep = 3,
  io = null,
  onError = null,
  ringLimit = RING_LIMIT,
} = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    throw new TypeError('createAuditLog requires a non-empty `file` path')
  }

  const disk = io ?? defaultIo()
  const parentDir = dirname(file)
  const bound = Number.isFinite(ringLimit) && ringLimit > 0 ? Math.floor(ringLimit) : RING_LIMIT
  const ring = []

  let disposed = false
  let dirReady = false
  let accepted = 0
  let rotations = 0
  let writeFailures = 0
  /** 读取时被跳过的行数（撕裂行 + 合法 JSON 但非对象）。 */
  let skippedLines = 0
  let lastWriteAt = null

  function report(error, entry) {
    if (typeof onError !== 'function') return
    try {
      onError(error instanceof Error ? error : new Error(errorText(error)), entry)
    } catch {
      /* 上报失败也不能影响调用方 */
    }
  }

  function nowMs() {
    try {
      const value = clock()
      return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }

  function sizeOf() {
    try {
      return disk.exists(file) ? disk.size(file) : 0
    } catch {
      return 0
    }
  }

  function ensureParent() {
    if (dirReady) return
    if (parentDir && parentDir !== '.' && parentDir !== file) {
      disk.ensureDir(parentDir)
    }
    dirReady = true
  }

  /** 按大小轮转：file → file.1 → … → file.N，最旧的删除。 */
  function rotateIfNeeded() {
    try {
      const bytes = sizeOf()
      if (bytes < maxBytes) return { rotated: false, rotations, bytes }
      const keep = Number.isFinite(rotateKeep) ? Math.max(0, Math.floor(rotateKeep)) : 0
      if (keep < 1) {
        if (disk.exists(file)) disk.remove(file)
        rotations += 1
        return { rotated: true, rotations, bytes: 0 }
      }
      const oldest = `${file}.${keep}`
      if (disk.exists(oldest)) disk.remove(oldest)
      for (let index = keep - 1; index >= 1; index -= 1) {
        const from = `${file}.${index}`
        if (disk.exists(from)) disk.rename(from, `${file}.${index + 1}`)
      }
      if (disk.exists(file)) disk.rename(file, `${file}.1`)
      rotations += 1
      return { rotated: true, rotations, bytes: 0 }
    } catch (error) {
      writeFailures += 1
      report(error)
      return { rotated: false, rotations, bytes: sizeOf(), error: errorText(error) }
    }
  }

  /**
   * 追加一条记录。绝不抛错。
   * 返回 `{ ok, at, bytes, rotations, writeFailures, error?, reason? }`。
   */
  function record(entry) {
    if (disposed) {
      return { ok: false, reason: 'disposed', rotations, writeFailures }
    }

    const now = nowMs()
    let normalised
    let line
    try {
      normalised = redact(normaliseEntry(entry, now))
      line = JSON.stringify(normalised)
      if (typeof line !== 'string') throw new Error('entry is not JSON-serialisable')
    } catch (error) {
      writeFailures += 1
      report(error, entry)
      return { ok: false, error: errorText(error), rotations, writeFailures }
    }

    try {
      ring.push(normalised)
      while (ring.length > bound) ring.shift()
      accepted += 1
    } catch {
      /* 内存缓冲失败不影响落盘 */
    }

    try {
      ensureParent()
      rotateIfNeeded()
      disk.append(file, `${line}\n`)
      lastWriteAt = now
      return {
        ok: true,
        at: normalised.at ?? null,
        bytes: sizeOf(),
        rotations,
        writeFailures,
      }
    } catch (error) {
      writeFailures += 1
      report(error, entry)
      return { ok: false, error: errorText(error), rotations, writeFailures }
    }
  }

  /**
   * 读回条目。文件不可读/不可写时回退到内存环形缓冲；撕裂的最后一行被跳过。
   * `tail: true` 返回最近 limit 条（按时间正序），`tail: false` 返回最早 limit 条。
   */
  function read({ limit = 200, tail = true } = {}) {
    const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 200
    let parsed = null
    try {
      if (disk.exists(file)) parsed = parseLines(disk.read(file))
    } catch {
      parsed = null
    }
    // 文件读不到，或刚轮转出空文件时，环形缓冲是唯一可靠来源。
    const source = parsed && parsed.entries.length > 0 ? parsed.entries : ring.slice()
    skippedLines = parsed?.skipped ?? skippedLines
    const entries = source.map((item) => redact(item))
    if (max === 0) return []
    return tail ? entries.slice(Math.max(0, entries.length - max)) : entries.slice(0, max)
  }

  /**
   * `entries` = 被接受的条目数（含落盘失败但进入内存缓冲的）。
   * `skipped` = 读取时被跳过的行数（撕裂行 + 合法 JSON 但非对象的行）。
   * 为什么统计而非静默丢弃：审计的价值在于"能复盘"，包括"丢了多少行"。
   */
  function stats() {
    return {
      entries: accepted,
      bytes: disposed ? 0 : sizeOf(),
      rotations,
      lastWriteAt,
      writeFailures,
      skipped: skippedLines,
    }
  }

  function dispose() {
    if (disposed) return { ok: true, reason: 'already-disposed' }
    disposed = true
    ring.length = 0
    return { ok: true }
  }

  return { file, record, read, rotateIfNeeded, stats, dispose }
}
