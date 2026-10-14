/**
 * commands.js —— 命令级策略：按**内容**判定危险操作。
 *
 * ## 它解决什么
 * 在只有工具分类的策略里，`Remove-Item -Recurse -Force C:\` 与 `Get-Date`
 * 是同一类动作（都叫 `PowerShell`）。本模块补上按内容判定的最小机制。
 *
 * ## ⚠️ 这不是安全边界
 * 采用**规范化子串**匹配，不是 shell 解析。绕过方式很多：字符串拼接、变量引用、
 * 编码（`-EncodedCommand`）、别名、`Invoke-Expression`。规格（SYS_SPEC S-CMD-04）
 * 明确声明这一点，**不得**把它宣传成"拦住了危险操作"。
 *
 * 它真正的价值是：把最常见的一批危险写法从**静默放行**变成**明确拒绝 + 可读理由**，
 * 并在审计里留下规则编号。
 *
 * ## 为什么用子串而不是正则
 * 正则里 `\` 与 `.` 的转义是配置错误的高发区（Windows 路径里全是反斜杠）。
 * 而这里的规则本质是"关键词黑名单"，子串足够，而且**不可能写坏**。
 * 代价是通配能力更弱——这个代价是自觉付出的。
 *
 * @module dsh_Windows_MCP/lib/commands
 */

/** 判定为"危险"的内置规则集。`pattern` 是**规范化后的子串**。 */
export const DEFAULT_COMMAND_RULES = Object.freeze([
  { id: 'recursive-delete', pattern: 'remove-item -recurse', risk: 'recursive-delete', reason: '递归删除会把整棵目录树连同其内容一起移除，且不可撤销。' },
  { id: 'recursive-delete-alias', pattern: 'rm -r', risk: 'recursive-delete', reason: '`rm -r` 等价于递归删除，同样不可撤销。' },
  { id: 'recursive-delete-cmd', pattern: 'rd /s', risk: 'recursive-delete', reason: '`rd /s` 是 cmd 的递归删除写法，同样不可撤销。' },
  { id: 'recursive-delete-del', pattern: 'del /s', risk: 'recursive-delete', reason: '`del /s` 会递归删除匹配到的所有文件。' },
  // FileSystem 工具自己的递归删除（不走 PowerShell）。实机 schema：
  // `{mode:'delete', path, recursive}`，因此拼装出的文本是 `delete <path> true`，
  // 上面那些 PowerShell 写法一条都命中不了。
  //
  // 只拦**驱动器根**的递归删除，不拦普通递归删除：
  // `delete ./build true` 是完全正常的开发操作，拦它属于严重假阳性，
  // 而假阳性会让人整体关掉这个功能（本模块最重要的设计约束）。
  // `delete c:/ true`（清空整个分区）没有正常用途。
  { id: 'filesystem-wipe-drive-root', pattern: '', requires: [/^delete /, /(?:^| )recursive(?: |$)/, /(?:^| )\/?[a-z]:\/?(?: |$)/], risk: 'recursive-delete', reason: '对驱动器根做递归删除会清空整个分区，且不可撤销。' },
  { id: 'format-volume', pattern: 'format-volume', risk: 'destructive-disk', reason: '格式化卷会清空该分区上的全部数据。' },
  { id: 'format-disk', pattern: 'format c:', risk: 'destructive-disk', reason: '格式化系统盘会直接破坏操作系统。' },
  { id: 'clear-disk', pattern: 'clear-disk', risk: 'destructive-disk', reason: 'Clear-Disk 会清除分区表与卷，数据不可恢复。' },
  { id: 'registry-delete-hklm', pattern: 'remove-item hklm:', risk: 'destructive-registry', reason: '删除 HKLM 根或整个配置单元会破坏系统级配置。' },
  { id: 'registry-delete-hkcr', pattern: 'remove-item hkcr:', risk: 'destructive-registry', reason: '删除 HKCR 会破坏文件关联与 COM 注册。' },
  { id: 'registry-remove-hklm', pattern: 'remove-item -path hklm:', risk: 'destructive-registry', reason: '同上：删除 HKLM 下的键是系统级破坏。' },
  // Registry 类目的操作文本是 `<action> <path> …`，`action` 是**注册表动作名**
  // （delete/remove/…），永远不会是 PowerShell 的 `remove-item`。
  // 因此上面三条在 Registry 类目下**不可达**——必须另有能命中拼装结果的规则，
  // 否则"删除 HKLM 键被拒绝"就是一句没兑现的承诺（对抗性验证 V2）。
  //
  // 注意不能简单用子串 `hklm:`：那会把**读取** HKLM 也拦掉（严重假阳性，
  // 而假阳性会让人整体关掉这个功能）。因此这两条用复合条件：动作 ∧ 配置单元。
  //
  // 动作词必须出现在**首位**（`^`）：操作文本是 `<mode> <path> <name> <value>`，
  // 若允许出现在任意位置，`Registry mode=get path=HKLM:\... name=Remove`
  // 这样的**读取值名为 Remove 的值**会被误判成破坏操作（对抗性复核发现的假阳性）。
  //
  // 配置单元要覆盖等价写法：PowerShell 接受 `HKEY_LOCAL_MACHINE:\...` 与
  // `Registry::HKEY_LOCAL_MACHINE\...`，只匹配 `hklm:` 等于留了绕过路径。
  { id: 'registry-hive-destructive-hklm', pattern: '', requires: [/^(?:delete|remove|del|rm|clear|rename|move)\b/, /hklm:|hkey_local_machine/], risk: 'destructive-registry', reason: '对 HKLM 执行删除/改名/移动是系统级破坏；只读查询不受本规则影响。' },
  { id: 'registry-hive-destructive-hkcr', pattern: '', requires: [/^(?:delete|remove|del|rm|clear|rename|move)\b/, /hkcr:|hkey_classes_root/], risk: 'destructive-registry', reason: 'HKCR 承载文件关联与 COM 注册；删除/改名会破坏整个系统的关联行为。只读查询不受本规则影响。' },
  { id: 'force-kill-process', pattern: 'stop-process -force', risk: 'force-kill', reason: '强制结束进程会丢失未保存数据，且可能命中系统关键进程。' },
  // `Process` 类目的强杀：`mode=kill` ∧ `force`（上游 `force` 决定 `p.kill()` 而非 `p.terminate()`）。
  // 对抗性验证 V3：`force` 是可区分字段却没人读，于是这条规则在 Process 类目下不可达——
  // `Process {mode:kill, force:true}` 与普通 terminate 在规则眼里一模一样。
  { id: 'process-force-kill', pattern: '', requires: [/^kill(?: |$)/, /(?:^| )force(?: |$)/], risk: 'force-kill', reason: '无条件强杀进程会丢失未保存数据，且可能命中系统关键进程。' },
  // `App` 启动解释器 = 一条**绕过命令级策略的执行路径**。
  // `App` 能带 `executable` + `args` 启动任意程序，而 PowerShell 的命令文本规则看不到它，
  // 于是 `App(mode=launch_executable, executable="powershell.exe", args=["-enc", ...])`
  // 可以做到与直接调用 PowerShell 等价的事，却完全不受命令级判定约束。
  // 这是 `winmcp_doctor` 第一次真机运行发现 `App` 少登记 5 个参数时顺带暴露的。
  //
  // 与 S-CMD-04 同样的话要说在前面：**这是关键词黑名单，不是安全边界**。
  // 绕过方式存在（改名、复制解释器、自解压、脚本宿主变体）；
  // 它的价值是把最常见的几种写法从"静默放行"变成"明确拒绝 + 可读理由"。
  // 正常应用（notepad 等）必须放行——假阳性会让人整体关掉这个功能。
  { id: 'app-launch-interpreter', pattern: '', requires: [/^launch(?:_executable)?(?: |$)/, /(?:^|[\s\\/])(?:powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32|msiexec|certutil|bitsadmin|installutil|wmic)(?:\.exe)?(?=[\s"']|$)/], risk: 'execution-bypass', reason: '通过 App 启动解释器/脚本宿主等同于执行任意命令，会绕过命令级策略；请改用受策略约束的方式，或在确有需要时把它加进 allowRules。' },
  { id: 'shutdown-machine', pattern: 'stop-computer', risk: 'power-state', reason: '关机操作会中断所有正在运行的工作。' },
  { id: 'restart-machine', pattern: 'restart-computer', risk: 'power-state', reason: '重启操作会中断所有正在运行的工作。' },
  { id: 'disable-execution-policy', pattern: 'set-executionpolicy unrestricted', risk: 'weaken-security', reason: '放开脚本执行策略会让后续任意脚本可直接运行。' },
  { id: 'disable-firewall', pattern: 'set-netfirewallprofile -enabled false', risk: 'weaken-security', reason: '关闭防火墙会移除主机层面的网络防护。' },
  { id: 'disable-defender-realtime', pattern: 'set-mppreference -disablerealtimemonitoring', risk: 'weaken-security', reason: '关闭实时防护会让恶意程序得以执行。' },
])

/** 各类目用于拼装"操作文本"的字段顺序。
 *
 * **字段名必须来自上游真实 schema**（见下面的 `WINDOWS_MCP_ARGUMENTS`）。
 * 顺序固定，便于规则撰写与审计比对。
 */
const FIELD_LAYOUT = Object.freeze({
  PowerShell: [['command']],
  Registry: [['mode'], ['path'], ['name'], ['value']],
  FileSystem: [['mode'], ['path'], ['destination']],
  Process: [['mode'], ['name'], ['pid']],
  // 读 `executable`/`args`/`cwd` 的理由：它们是**执行向量**的载体。
  // 不读它们，`App(mode=launch_executable, executable="powershell.exe", args=[...])`
  // 在规则眼里与"切换窗口"没有区别（真机自检发现的缺口）。
  App: [['mode'], ['name'], ['executable'], ['args'], ['cwd']],
})

/** 供测试校验字段名是否与上游 schema 一致（S-CMD-12）。 */
export const ARGUMENT_LAYOUT = FIELD_LAYOUT

/**
 * 各类目里**布尔修饰符**的参数名。
 *
 * 为什么必须单独处理：`recursive:true` 是决定"删除一个文件"还是"删除整棵树"的关键，
 * 但它不是位置字段，拼装 `<mode> <path>` 时会被漏掉——于是
 * `FileSystem mode=delete path=C:\ recursive=true` 与不递归的删除在规则眼里一模一样。
 *
 * 只有值为**上游认的真值**时才把参数名加入操作文本（`... recursive`），
 * 这样规则可以直接匹配 `recursive`，而假值不会误命中。
 *
 * ## 真值判断必须逐字照抄上游，不能"合理推断"
 * 上游 `tools/filesystem.py` 与 `tools/process.py` 用的都是同一个写法：
 *
 * ```python
 * recursive = recursive is True or (isinstance(recursive, str) and recursive.lower() == 'true')
 * ```
 *
 * 即：**只有**布尔 `True`，或（字符串且 `lower()` 后恰好等于 `'true'`）。
 * 由此可推出几个反直觉但必须遵守的结论：
 *
 * | 输入 | 上游真值 | 说明 |
 * |---|---|---|
 * | `true` / `'true'` / `'TRUE'` / `'True'` | **真** | `lower()` 后相等 |
 * | `' true '`（带空白） | **假** | 上游**不 trim** |
 * | `'1'` / `'yes'` / `1` / 非零数 | **假** | 不是 `is True`，也不是 `'true'` |
 *
 * 我第一版"为了让规则更安全"放宽成也认 `'1'`/`'yes'`/非零数，并把这条写进了规格。
 * 结果是**假阳性**：`recursive:'yes'` 被拒，而上游根本不会递归删除——
 * 正是本模块自己声明最怕的那类缺陷。安全方向不等于"宁可多认"，
 * 方向只能是**照抄上游**：上游不递归，就没有东西要拦。
 */
function isTruthyFlag(value) {
  if (value === true) return true
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  return false
}

const BOOLEAN_FLAGS = Object.freeze({
  FileSystem: [['recursive'], ['overwrite'], ['append'], ['show_hidden']],
  PowerShell: [],
  Registry: [],
  // `Process mode=kill` 的 `force` 决定 `p.kill()`（无条件强杀）还是 `p.terminate()`，
  // 是可区分字段，必须读进来——否则 `force-kill-process` 在该类目下不可达。
  Process: [['force']],
})

/**
 * 上游工具的真实参数名（**完整清单**，不是"策略会读的那部分"）。
 *
 * ## 为什么必须是完整清单（对抗性验证 N15）
 * 第一版把自己定义成"只记录策略会读的键"，于是**漏登记永远查不出**：
 * 某个可区分字段没被登记，测试会认为"布局没用到它"而通过，
 * 规则却因此永远命中不了——`Process` 的 `force` 正是这样漏掉的。
 * 现在这里是**该工具的完整参数集**，来源是实机 introspection 与上游源码：
 * - `_recon_tools/REPORT-mcp-contract.md`（FileSystem / Registry 等）
 * - live 工具 schema（实测抓取）
 * - 上游源码 `tools/filesystem.py` / `tools/process.py` / `tools/registry.py`
 *
 * 测试会断言：这个清单与"工具真实参数集"一致（登记不得遗漏），
 * 且布局用到的键都在清单里（不得凭空猜测）。
 */
export const WINDOWS_MCP_ARGUMENTS = Object.freeze({
  PowerShell: Object.freeze(['command', 'timeout']),
  Registry: Object.freeze(['mode', 'path', 'name', 'value', 'type']),
  FileSystem: Object.freeze([
    'mode', 'path', 'destination', 'content', 'pattern',
    'recursive', 'append', 'overwrite', 'offset', 'limit', 'encoding', 'show_hidden',
  ]),
  // `force` 决定 `p.kill()`（无条件强杀）还是 `p.terminate()`；`sort_by`/`limit` 只在 list 用。
  Process: Object.freeze(['mode', 'name', 'pid', 'sort_by', 'limit', 'force']),
  // 真机 schema 实测（`winmcp_doctor` 第一次运行就发现旧登记少了 5 个）：
  // `executable` + `args` + `cwd` 让 `App` 成为一条**启动任意程序**的执行路径。
  App: Object.freeze(['mode', 'name', 'window_loc', 'window_size', 'executable', 'args', 'cwd']),
  Clipboard: Object.freeze(['mode', 'text']),
})

/**
 * 上游里**布尔型**参数（值语义由 `isTruthyFlag` 决定）。
 * 用于测试双向核对：登记为布尔的键必须是布尔型，`force` 这类不得遗漏。
 */
export const WINDOWS_MCP_BOOLEAN_ARGUMENTS = Object.freeze({
  FileSystem: Object.freeze(['recursive', 'append', 'overwrite', 'show_hidden']),
  Process: Object.freeze(['force']),
  PowerShell: Object.freeze([]),
  Registry: Object.freeze([]),
  App: Object.freeze([]),
  Clipboard: Object.freeze([]),
})

/**
 * 规范化操作文本。
 *
 * 恰好做四件事，顺序固定（S-CMD-02）：
 * 1. 转小写；
 * 2. 连续空白折叠成一个空格并去首尾；
 * 3. `\` 与 `/` 统一为 `/`；
 * 4. 去掉 Windows 命名空间前缀 `\\?\` 与 `\\.\`（在词首或空格之后）。
 *
 * 第 4 步是对抗性验证 V1 的直接产物：`\\?\C:\` 与 `\\.\C:\` 表示**同一个路径**，
 * 只是要求不做路径规范化。不做这一步，它们会变成 `/?/c:/` 与 `/./c:/`，
 * 与规则的 `c:/` 不匹配，于是"递归删除驱动器根"**整条绕过**——
 * 而上游 `Path('\\\\?\\C:\\').is_dir()` 为真，会真的走 `shutil.rmtree` 清空分区。
 *
 * **不做**去引号、变量展开、转义还原——那需要真正的解析器，超出本模块的立场。
 */
export function normalizeOperation(value) {
  if (value === null || value === undefined) return ''
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\/]+/g, '/')
    // `\\?\` / `\\.\` 经上一步变成 `/?/` / `/./`；在词首或空格之后去掉
    .replace(/(^| )\/{1,2}[.?]\//g, '$1')
}

/**
 * 按类目从参数里取字段值（字符串化）。
 * @returns {string[]} 原始字段值（未规范化）
 */
function collectFieldValues(category, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return []
  const layout = FIELD_LAYOUT[category]
  if (!layout) return []
  const values = []
  // layout 是按"候选字段名"分组：每个内层数组是同一逻辑位的别名候选，取第一个存在者。
  for (const aliases of layout) {
    for (const key of aliases) {
      if (!Object.prototype.hasOwnProperty.call(args, key)) continue
      const value = args[key]
      if (value === null || value === undefined) break
      if (Array.isArray(value)) {
        values.push(...value.filter((item) => item !== null && item !== undefined).map(String))
      } else if (typeof value === 'object') {
        values.push(JSON.stringify(value))
      } else {
        values.push(String(value))
      }
      break
    }
  }
  // 布尔修饰符：值为 true 时把**参数名**加入文本，让规则能区分
  // "删除一个文件" 与 "递归删除整棵树"。false 不加入（避免误命中）。
  for (const aliases of BOOLEAN_FLAGS[category] ?? []) {
    for (const key of aliases) {
      if (!Object.prototype.hasOwnProperty.call(args, key)) continue
      const value = args[key]
      if (isTruthyFlag(value)) values.push(key)
      break
    }
  }
  return values
}

/**
 * 类目是否需要操作文本。
 * 只有需要的类目才适用 S-CMD-06（取不到 → 拒绝）。
 */
export function categoryNeedsText(category) {
  return Object.prototype.hasOwnProperty.call(FIELD_LAYOUT, category)
}

/**
 * 提取并规范化操作文本。
 *
 * @returns {{category: string, normalized: string, raw: string, fields: number}}
 */
export function extractOperation(toolName, args) {
  const category = toolName
  const values = collectFieldValues(category, args)
  const raw = values.join(' ')
  return {
    category,
    raw,
    normalized: normalizeOperation(raw),
    fields: values.length,
  }
}

/**
 * 评估一次调用的命令级风险。纯函数：不读时钟、不写日志。
 *
 * @param {object} input
 * @param {string} input.tool 已去前缀的工具名
 * @param {unknown} input.args 该次调用的参数。**省略**（`undefined`）表示这次判定没有
 *   内容依据，跳过命令级判定；传入了取不到字段的值（`{}`、字符串等）才算"不可评估"
 * @param {object} [input.config] 策略配置
 * @returns {{kind: 'allow', operation: object}
 *   | {kind: 'deny', code: string, ruleId?: string, ruleIds?: string[], reason: string, operation: object}
 *   | {kind: 'exempt', ruleId: string, operation: object}}
 */
export function evaluateCommand({ tool, args, config = {} }) {
  // S-CMD-10 的开关必须在**纯函数层**也生效：同一个开关两套行为是不可接受的
  // （曾经的实机差异：策略层跳过、直接调用却仍拒绝）。
  if (config?.commandRulesEnabled === false) {
    return { kind: 'allow', operation: { category: tool, raw: '', normalized: '', fields: 0 } }
  }

  // 调用方**根本没有提供 args** 与**提供了一个取不到字段的 args**是两回事：
  // - 前者：这次判定没有内容依据可言（例如内部构造的请求），跳过命令级判定；
  // - 后者：调用方声称这是该工具的真实参数（如 `PowerShell {}`、`"not-an-object"`），
  //   却取不到命令文本 → 判定不了 → 必须拒绝（S-CMD-06）。
  //
  // 这个区分是必要的：命令级策略只在**有内容可判**时发言。把"没传 args"也判成
  // 不可评估，会让所有不关心内容的调用方（以及大量既有测试）无辜被拒。
  if (args === undefined) {
    return { kind: 'allow', operation: { category: tool, raw: '', normalized: '', fields: 0 } }
  }

  const operation = extractOperation(tool, args)

  // S-CMD-06：类目需要文本却拿不到**有效**文本 → 判定不了 → 拒绝。
  //
  // "拿不到"的判据是**规范化后是否为空**，不是"有没有这个键"：
  // `{command:''}` / `{command:'   '}` 拼装出来是空串，所有规则都不命中，
  // 于是会**静默放行**——而"命令文本为空"恰恰是判定不了（对抗性 N1 实测可达）。
  if (categoryNeedsText(operation.category) && operation.normalized === '') {
    return {
      kind: 'deny',
      code: 'CMD_UNEVALUABLE',
      reason:
        `${operation.category} 调用没有携带可判定的命令字段（参数不是对象，或 command/action/path ` +
        `这类字段缺失、为空、或规范化后为空）。无法确认它是否安全，因此拒绝。`,
      operation,
    }
  }

  const rules = mergeRules(config.commandRules)
  const exempt = new Set(
    Array.isArray(config.allowRules) ? config.allowRules.map((id) => String(id)) : [],
  )

  const hits = []
  const exempted = []
  for (const rule of rules) {
    if (!ruleMatches(rule, operation.normalized)) continue
    if (exempt.has(rule.id)) {
      exempted.push(rule.id)
      continue
    }
    hits.push(rule)
  }

  if (hits.length === 0) {
    // S-CMD-07：命中了但被显式豁免 → 不算拒绝，但要能让审计看到。
    if (exempted.length > 0) {
      return { kind: 'exempt', ruleId: exempted[0], operation }
    }
    // S-CMD-08：未命中 → 放行（不得因"没看懂"拒绝）。
    return { kind: 'allow', operation }
  }

  const primary = hits[0]
  return {
    kind: 'deny',
    code: 'COMMAND_RULE',
    ruleId: primary.id,
    ruleIds: hits.map((rule) => rule.id),
    reason:
      `命中危险操作规则「${primary.id}」：${primary.reason}` +
      `如果你确实需要执行它，请让用户把 ${primary.id} 加进 allowRules 显式豁免。`,
    operation,
  }
}

/**
 * 规则是否命中。
 *
 * 两种规则形态：
 * - **子串规则**（`pattern` 非空）：规范化后 `includes` 判命中。简单、不可能写坏。
 * - **复合规则**（`requires` 是数组）：**所有**条件都满足才算命中。
 *   字符串条件同样是规范化子串；RegExp 条件对规范化文本测试。
 *   用于"必须同时出现动作词与目标"这种不能单靠子串表达的判断——
 *   例如 `hklm:` 单独出现太宽（会把只读查询也拦掉），必须与删除动作同时出现。
 */
function ruleMatches(rule, normalized) {
  const normalizedPattern = normalizeOperation(rule.pattern)
  if (normalizedPattern !== '') {
    if (!normalized.includes(normalizedPattern)) return false
  }
  if (Array.isArray(rule.requires)) {
    for (const condition of rule.requires) {
      if (condition instanceof RegExp) {
        if (!condition.test(normalized)) return false
      } else {
        const needle = normalizeOperation(condition)
        if (needle === '' || !normalized.includes(needle)) return false
      }
    }
  }
  // 既没有 pattern 也没有 requires 的规则永远不命中（而不是命中一切）
  return normalizedPattern !== '' || Array.isArray(rule.requires)
}

/** 内置规则 + 配置追加规则（配置不能移除内置规则，只能通过 allowRules 豁免）。 */
function mergeRules(configured) {
  if (!Array.isArray(configured) || configured.length === 0) return DEFAULT_COMMAND_RULES
  const extra = []
  for (const rule of configured) {
    if (!rule || typeof rule !== 'object') continue
    const id = typeof rule.id === 'string' && rule.id.trim() !== '' ? rule.id.trim() : null
    if (id === null) continue
    const pattern = typeof rule.pattern === 'string' ? rule.pattern : ''
    const requires = Array.isArray(rule.requires) ? rule.requires : null
    // 追加规则必须有 pattern 或 requires 之一，否则它永远不命中（等于没写）
    if (pattern.trim() === '' && requires === null) continue
    extra.push({
      id,
      pattern,
      ...(requires === null ? {} : { requires }),
      risk: typeof rule.risk === 'string' ? rule.risk : 'custom',
      reason: typeof rule.reason === 'string' && rule.reason.trim() !== ''
        ? rule.reason
        : `自定义规则 ${id} 判定该操作危险。`,
    })
  }
  return [...DEFAULT_COMMAND_RULES, ...extra]
}
