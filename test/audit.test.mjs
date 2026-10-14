import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditLog, normaliseEntry, redact } from '../lib/audit.js'

/** 内存 I/O 适配器：让轮转/失败路径无需触碰真实文件系统。 */
function memoryIo({ failAppend = false, failRead = false } = {}) {
  const files = new Map()
  return {
    files,
    ensureDir() {},
    exists: (p) => files.has(p),
    size: (p) => Buffer.byteLength(files.get(p) ?? '', 'utf8'),
    append: (p, text) => {
      if (failAppend) {
        const error = new Error('EACCES: permission denied')
        error.code = 'EACCES'
        throw error
      }
      files.set(p, (files.get(p) ?? '') + text)
    },
    read: (p) => {
      if (failRead || !files.has(p)) {
        const error = new Error('ENOENT: no such file or directory')
        error.code = 'ENOENT'
        throw error
      }
      return files.get(p)
    },
    rename: (from, to) => {
      files.set(to, files.get(from))
      files.delete(from)
    },
    remove: (p) => {
      files.delete(p)
    },
  }
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-audit-'))
}

test('record/read round trip on a real temp dir, with lazy recursive creation', () => {
  const dir = tempDir()
  const file = join(dir, 'nested', 'deep', 'audit.jsonl')
  let tick = 1000
  const audit = createAuditLog({ file, clock: () => tick++ })
  try {
    // 惰性创建：没有 record 之前不应该有文件。
    assert.equal(existsSync(file), false)

    const first = audit.record({ action: 'tool.call', tool: 'Snapshot', allowed: true, decision: 'allow' })
    assert.equal(first.ok, true)
    // 父目录递归创建。
    assert.equal(existsSync(file), true)

    audit.record({ action: 'tool.call', tool: 'Click' })
    audit.record({ action: 'tool.call', tool: 'PowerShell', extra: { nested: 1 } })

    const all = audit.read()
    assert.equal(all.length, 3)
    assert.equal(all[0].tool, 'Snapshot')
    // clock 给的是毫秒时间戳，落盘时被规范成 ISO（shape 统一的回归点）
    assert.equal(all[0].at, new Date(1000).toISOString())
    assert.equal(Date.parse(all[0].at), 1000)
    // 缺失字段补 null，不丢字段。
    assert.equal(all[0].serverName, null)
    assert.equal(all[0].image, null)
    assert.equal(all[0].durationMs, null)
    // 未列出的字段原样保留。
    assert.equal(all[2].extra.nested, 1)

    assert.deepEqual(audit.read({ limit: 2 }).map((entry) => entry.tool), ['Click', 'PowerShell'])
    assert.deepEqual(audit.read({ limit: 1, tail: false }).map((entry) => entry.tool), ['Snapshot'])
    assert.equal(audit.read({ limit: 0 }).length, 0)

    const stats = audit.stats()
    assert.equal(stats.entries, 3)
    assert.equal(stats.rotations, 0)
    assert.equal(stats.writeFailures, 0)
    assert.equal(stats.lastWriteAt, 1002)
    assert.ok(stats.bytes > 0)

    // 文件是逐行合法 JSON，且以换行结尾。
    const raw = readFileSync(file, 'utf8')
    assert.ok(raw.endsWith('\n'))
    assert.equal(raw.trim().split('\n').length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('normaliseEntry fills missing fields with null and keeps extras', () => {
  const entry = normaliseEntry({ tool: 'Click', custom: 7 }, 42)
  // at 一律规范成 ISO 字符串（数值 42ms → 1970-01-01T00:00:00.042Z）
  assert.equal(entry.at, new Date(42).toISOString())
  assert.equal(entry.action, null)
  assert.equal(entry.decision, null)
  assert.equal(entry.sessionId, null)
  assert.equal(entry.custom, 7)
  // 显式 at 不会被时钟覆盖，但同样会被规范成 ISO
  assert.equal(normaliseEntry({ at: 5 }, 42).at, new Date(5).toISOString())
})

test('normaliseEntry 把毫秒时间戳 / Date / 字符串统一成 ISO（实机撞到的混合形状）', async () => {
  const { toIsoTime } = await import('../lib/audit.js')
  assert.equal(toIsoTime(1791663514524), new Date(1791663514524).toISOString())
  assert.equal(toIsoTime(new Date('2026-01-02T03:04:05.000Z')), '2026-01-02T03:04:05.000Z')
  assert.equal(toIsoTime('2026-01-02T03:04:05.000Z'), '2026-01-02T03:04:05.000Z')
  // 不可解析的字符串不再原样返回（那会让"按时间排序"失效）：
  // 统一为 null，由 normaliseEntry 用写入时刻兜底并打 atCoerced 标记。
  assert.equal(toIsoTime('not-a-date'), null)
  assert.equal(toIsoTime(null), null)

  // 同一个文件里两种来源的条目，读回来 at 形状必须一致、可按时间排序
  const numeric = normaliseEntry({ at: 1791663514524, action: 'policy.evaluate' })
  const iso = normaliseEntry({ at: '2026-10-10T20:18:28.131Z', action: 'observe' })
  assert.match(numeric.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(iso.at, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(typeof numeric.at, 'string')
  assert.equal(Date.parse(numeric.at), 1791663514524)
})

test('normaliseEntry 缺 at 时用注入的 now 兜底', () => {
  const entry = normaliseEntry({ action: 'x' }, new Date('2026-05-06T07:08:09.000Z'))
  assert.equal(entry.at, new Date('2026-05-06T07:08:09.000Z').toISOString())
})

test('normaliseEntry 对自引用做标记而不是无限嵌套', () => {
  const input = { action: 'x' }
  input.self = input
  const entry = normaliseEntry(input)
  assert.equal(entry.self, '[circular]')
})

test('torn partial last line (and corrupt middle line) are skipped, never thrown', () => {
  const file = 'mem://audit.jsonl'
  const io = memoryIo()
  const audit = createAuditLog({ file, io })

  audit.record({ tool: 'A' })
  audit.record({ tool: 'B' })
  // 模拟崩溃时写入一半的行。
  io.append(file, '{"tool":"C","act')

  assert.doesNotThrow(() => audit.read())
  assert.deepEqual(audit.read().map((entry) => entry.tool), ['A', 'B'])

  io.append(file, 'not json\n{"tool":"D"}\n')
  assert.deepEqual(audit.read().map((entry) => entry.tool), ['A', 'B', 'D'])
  // 读回容错与写入无关：写入本身没有失败。
  assert.equal(audit.stats().writeFailures, 0)
})

test('size-based rotation keeps at most rotateKeep history files', () => {
  const file = 'mem://rotate.jsonl'
  const io = memoryIo()
  const audit = createAuditLog({ file, io, maxBytes: 300, rotateKeep: 2 })

  for (let i = 0; i < 40; i += 1) {
    audit.record({ tool: 'Click', reason: 'x'.repeat(120) })
  }

  assert.ok(audit.stats().rotations >= 3, `rotations=${audit.stats().rotations}`)
  assert.equal(io.exists(`${file}.1`), true)
  assert.equal(io.exists(`${file}.2`), true)
  // 超出 rotateKeep 的最旧文件被删除。
  assert.equal(io.exists(`${file}.3`), false)

  // 未超阈值时 rotateIfNeeded() 是空操作。
  const small = createAuditLog({ file: 'mem://small.jsonl', io, maxBytes: 10_000 })
  small.record({ tool: 'A' })
  const before = small.stats().rotations
  assert.equal(small.rotateIfNeeded().rotated, false)
  assert.equal(small.stats().rotations, before)
})

test('rotateKeep: 0 drops the file instead of keeping history', () => {
  const file = 'mem://zero.jsonl'
  const io = memoryIo()
  const audit = createAuditLog({ file, io, maxBytes: 50, rotateKeep: 0 })
  audit.record({ tool: 'A' })
  audit.record({ tool: 'B' })
  assert.ok(audit.stats().rotations >= 1)
  assert.equal(io.exists(`${file}.1`), false)
})

test('redact masks secret keys, long blobs and circular refs', () => {
  const redacted = redact({
    apiKey: 'abcdef',
    Token: 'tok',
    password: 'p',
    secret: 's',
    credential: 'c',
    note: 'hello',
    image: 'short.png',
    nested: { accessKey: 'zzz', ok: true },
  })
  assert.equal(redacted.apiKey, '<redacted 6 chars>')
  assert.equal(redacted.Token, '<redacted 3 chars>')
  assert.equal(redacted.password, '<redacted 1 chars>')
  assert.equal(redacted.secret, '<redacted 1 chars>')
  assert.equal(redacted.credential, '<redacted 1 chars>')
  assert.equal(redacted.nested.accessKey, '<redacted 3 chars>')
  // 合法短值不受影响。
  assert.equal(redacted.note, 'hello')
  assert.equal(redacted.image, 'short.png')
  assert.equal(redacted.nested.ok, true)

  // 300 字符的假 base64 必须整体打码。
  const blob = 'A'.repeat(300)
  assert.equal(redact(blob), '<redacted 300 chars>')
  assert.equal(redact({ image: blob }).image, '<redacted 300 chars>')
  assert.equal(redact({ data: blob.replace(/A/g, 'f') }).data, '<redacted 300 chars>')

  // 自然语言长文本不能被打码。
  const prose = 'word '.repeat(90).trim()
  assert.equal(redact(prose), prose)

  // 循环引用不炸；同一对象被两个字段引用不算循环。
  const circular = {}
  circular.self = circular
  assert.equal(redact(circular).self, '[circular]')
  const shared = { pid: 1 }
  const both = redact({ before: shared, after: shared })
  assert.deepEqual(both.before, { pid: 1 })
  assert.deepEqual(both.after, { pid: 1 })

  // 不修改输入。
  const source = { apiKey: 'abcdef' }
  redact(source)
  assert.equal(source.apiKey, 'abcdef')

  // 打码是幂等的：read() 的防御性二次打码不会把长度改花。
  assert.equal(redact({ token: '<redacted 11 chars>' }).token, '<redacted 11 chars>')
})

test('record() redacts image payloads before they hit disk', () => {
  const file = 'mem://redact.jsonl'
  const audit = createAuditLog({ file, io: memoryIo() })
  const blob = 'iVBORw0KGgo'.repeat(40)
  audit.record({ action: 'screenshot', tool: 'Screenshot', image: blob, token: 'sk-live-123' })
  const [entry] = audit.read()
  assert.equal(entry.image, `<redacted ${blob.length} chars>`)
  assert.equal(entry.token, '<redacted 11 chars>')
  assert.equal(entry.tool, 'Screenshot')
})

test('read() re-redacts content that was written to the file out of band', () => {
  const file = 'mem://foreign.jsonl'
  const io = memoryIo()
  io.append(file, `${JSON.stringify({ tool: 'X', apiKey: 'abcdef' })}\n`)
  const audit = createAuditLog({ file, io })
  const [entry] = audit.read()
  assert.equal(entry.apiKey, '<redacted 6 chars>')
})

test('write failure never throws, is counted, and read() falls back to memory', () => {
  const file = 'mem://denied.jsonl'
  const io = memoryIo({ failAppend: true })
  const seen = []
  const audit = createAuditLog({
    file,
    io,
    onError: (error, entry) => seen.push({ message: error.message, entry }),
  })

  let status
  assert.doesNotThrow(() => {
    status = audit.record({ tool: 'Click', action: 'click' })
  })
  assert.equal(status.ok, false)
  assert.equal(typeof status.error, 'string')
  assert.equal(audit.stats().writeFailures, 1)
  assert.equal(seen.length, 1)
  assert.match(seen[0].message, /EACCES/)
  assert.equal(seen[0].entry.tool, 'Click')
  assert.equal(audit.stats().lastWriteAt, null)

  // 文件完全不可写时，read() 依然从内存环形缓冲返回数据。
  const entries = audit.read()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].tool, 'Click')
  assert.equal(entries[0].decision, null)

  assert.doesNotThrow(() => audit.record({ tool: 'Type' }))
  assert.equal(audit.stats().writeFailures, 2)
  assert.equal(audit.read().length, 2)
})

test('read failure is tolerated and falls back to the ring buffer', () => {
  const file = 'mem://broken.jsonl'
  const io = memoryIo()
  const audit = createAuditLog({ file, io })
  audit.record({ tool: 'A' })
  const broken = createAuditLog({ file, io: { ...io, read: memoryIo({ failRead: true }).read } })
  assert.doesNotThrow(() => broken.read())
  assert.deepEqual(broken.read(), [])
})

test('hostile input and dispose() are safe', () => {
  const file = 'mem://hostile.jsonl'
  const audit = createAuditLog({ file, io: memoryIo() })

  const circular = { tool: 'X' }
  circular.self = circular
  assert.doesNotThrow(() => audit.record(circular))
  assert.equal(audit.stats().entries, 1)

  const status = audit.record('plain string')
  assert.equal(status.ok, true)
  const entries = audit.read()
  assert.equal(entries.at(-1).value, 'plain string')
  assert.equal(entries.at(-1).tool, null)
  assert.equal(entries[0].self, '[circular]')
  // 已打码的标记在读回时不会被二次打码。
  assert.equal(entries[0].image, null)

  assert.equal(audit.dispose().ok, true)
  assert.equal(audit.dispose().reason, 'already-disposed')
  const after = audit.record({ tool: 'Y' })
  assert.equal(after.ok, false)
  assert.equal(after.reason, 'disposed')
  // 环形缓冲已清空，但磁盘上的历史仍然可读。
  assert.equal(audit.read().length, 2)
})

test('createAuditLog requires a file path', () => {
  assert.throws(() => createAuditLog(), /file/)
  assert.throws(() => createAuditLog({ file: '' }), /file/)
})
