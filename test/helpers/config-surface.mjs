/**
 * 配置面的单一真源：README、cordis.patch.yml 与代码三处必须一致。
 * 测试会拿这个名字集合去比对 index.js 实际注册的工具。
 *
 * 放在 test/ 下是因为它只服务于测试与文档校验，不属于运行时。
 */

/** 本插件向模型暴露的辅助工具名（全部只读或控制自身状态，不直接操作桌面）。 */
export const OFFERED_TOOLS = Object.freeze([
  'winmcp_doctor',
  'winmcp_state',
  'winmcp_to_screen',
  'winmcp_screen_to_image',
  'winmcp_kill',
  'winmcp_audit',
])

/**
 * 配置键与默认值的文档真源。index.js 的 DEFAULTS 必须与之保持一致；
 * 若两边不一致，测试会失败，避免 README 写着一套、代码跑另一套。
 */
export const DOCUMENTED_DEFAULTS = Object.freeze({
  serverName: 'winmcp',
  maxObservationAgeMs: 60000,
  requireObservation: true,
  requireCoordinateMapping: true,
  requireProcessMatch: true,
  requireApproval: false,
  requireApprovalForInput: false,
  approvalTtlMs: 120000,
  auditFile: '',
  auditMaxBytes: 8 * 1024 * 1024,
  autoAudit: true,
  annotateResults: true,
  registerTools: true,
  injectContext: true,
  commandRulesEnabled: true,
  commandRules: [],
  allowRules: [],
})
