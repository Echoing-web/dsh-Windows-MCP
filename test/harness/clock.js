/**
 * clock.js —— 可注入的虚拟时钟。
 *
 * 为什么要虚拟时钟：本插件的行为大量依赖时间（观测年龄、审批有效期、
 * 审计时间戳、重试间隔）。用 `Date.now()` 直接实现会让测试要么依赖 `sleep`
 * （慢且偶发失败），要么只能测"大范围"而测不到边界。
 *
 * 虚拟时钟让「年龄恰好等于上限」这类边界变成**确定性的**断言：
 * 拨动 ms 即可，无真实等待。这也是 S-GATE-03 那条边界规格能被可靠测试的前提。
 *
 * @module dsh_Windows_MCP/test/harness/clock
 */

/**
 * @param {number} [start] 起始毫秒时间戳
 * @returns {{now: () => number, advance: (ms: number) => number, set: (ms: number) => number, iso: () => string, calls: () => number}}
 */
export function createVirtualClock(start = 1_700_000_000_000) {
  let current = start
  let calls = 0
  return {
    /** Date.now() 兼容签名。 */
    now() {
      calls += 1
      return current
    },
    /** 前进 ms 毫秒，返回新的当前值。 */
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error(`advance 需要非负有限数，收到 ${ms}`)
      current += ms
      return current
    },
    /** 直接设定。 */
    set(ms) {
      if (!Number.isFinite(ms)) throw new Error(`set 需要有限数，收到 ${ms}`)
      current = ms
      return current
    },
    /** 当前值的 ISO 字符串。 */
    iso() {
      return new Date(current).toISOString()
    },
    /** 读取次数（诊断用，可用来断言"没有多余取时"）。 */
    calls() {
      return calls
    },
  }
}
