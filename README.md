# dsh_Windows_MCP

基于 [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)开发的 DeepSeek Harness 插件。

Windows-MCP 本身由 DSH 内置的 `@deepseek-ai/dsh-mcp-client` 桥接入，工具以 `mcp__winmcp__<Tool>` 出现。
桥只做协议搬运：它把 MCP 的工具注册进来、把图片落成 DSH 附件，**不做任何语义加工**。
本插件补上桥缺的那一层。

```
                     ┌────────────────────────────────────────────────────────────┐
   模型工具表 ◄───────│ mcp__winmcp__Snapshot / Click / Type / …（20 个，桥提供）    │
                     └────────────────────────────────────────────────────────────┘
                                        ▲
        tools/post-execute ─────────────┤  ① 观测：把散文元数据解析成结构化状态
        （追加，不替换原文）              │  ② 映射：追加单行 screen/image 换算关系
                                        ▼
                     ┌────────────────────────────────────────────────────────────┐
   dsh_Windows_MCP   │ lib/observe.js  解析 Cursor Position / Region / Scale / 窗口 │
                     │ lib/coords.js   图片像素 ⇄ 屏幕坐标（实测校准）              │
                     │ lib/gate.js     动作分类 + 观测存储 + 新鲜度判定             │
                     │ lib/policy.js   急停 / 黑白名单 / 审批（失败关闭）            │
                     │ lib/audit.js    append-only JSONL 审计（脱敏）               │
                     └────────────────────────────────────────────────────────────┘
                                        ▲
        tools/pre-execute + tools.guard │  ③ 闸门：无观测/过期/代次落后/窗口漂移 → 拒绝
                                        │
   模型工具表 ◄────────────────────────┘  winmcp_state / winmcp_to_screen /
                                          winmcp_screen_to_image / winmcp_kill / winmcp_audit
```

## 1. 它解决的四类真实事故

### ① 坐标换算靠「读散文 + 心算」，容易漏乘或重复乘

Windows-MCP 的截图元数据是一句人类可读的长句：

```
Screenshot Coordinate Scale: 1.333333 — image pixels are downscaled; multiply every
image pixel coordinate by 1.333333 before passing to Click, Move, Scroll, or any loc= …
```

模型要读懂它、并且**恰好**换算一次。实测确认的关系是：

```
screen_x = region_left + img_x * coord_scale
screen_y = region_top  + img_y * coord_scale
```

`img_*` 是模型实际看到的那张图的像素，`coord_scale` 就是上面那个公开的数，缺该行按 1.0。

**怎么校准的（可复跑）**：唯一可靠的探针是**光标往返**——用 `Move` 把光标放到已知屏幕坐标，
再由服务端回报 `Cursor Position`（服务端回报的是它自己的真值，不依赖任何图像解读）：

```
Move(200, 100)    → Cursor Position: (200, 100)
Move(2000, 1200)  → Cursor Position: (2000, 1200)
```

两点精确吻合 → slope = 1.333333、**intercept = 0.0000**（纯乘无偏移），125% DPI **不需要任何补偿**。
且 `coord_scale = 1.333333 = 2560/1920`，与上游 Snapshot 自己文档里那句
"multiply image coordinates by the ratio of original size to displayed size" 完全一致——
两份文档描述的是同一个换算。

> **更正**：早期笔记说这个式子是用「CURSOR 红十字」探针校准的，**这是错的**。
> `use_annotation=true` 画的是**带序号的彩色矩形**（每个 UI 元素一个方框），
> 不是光标十字；而且方框位置来自元素的 `bounding_box`，与换算公式并非独立来源，
> 用它自证会循环论证。

> ⚠️ **一个被实测否掉的错误做法**：曾经把「附件宽 / 上游图片宽」也乘进系数
> （`coord_scale / attachmentRatio` = 1.333333 / 0.75 = 1.777778）。**这是错的。**
> 本机 `1920 = 2560 / 1.333333`，`coord_scale` 本身就已经是「模型所见图 → 屏幕」的完整因子；
> 双重缩放会把「关闭」按钮预测到图片 x≈1417.5，而实测在 x≈1890。
> 本插件因此**只用 coord_scale**，附件尺寸仅作诊断信息。

**本插件的做法**：每次 `Snapshot`/`Screenshot` 结果后追加一行机器可读的映射，并提供双向换算工具：

```
[mcp] scale=1.333 origin=0,0 region=0,0,2560,1440 coord_scale=1.333333
      source=2560x1440 attachment=1920x1080 based_on=obs-3
      | screen = (0,0) + image_px * 1.333
```

### ② `Click` 不看新鲜度，会静默点到别的窗口

`dsh-mcp-client` 永远是「有工具就调」，它不知道模型依据的是哪一次截图。
于是「看了 Snapshot → 用户切走了窗口 → 模型按旧坐标点击」就会点在**别的程序**上。

**本插件的做法**：`tools/pre-execute` 前置闸门，输入类动作（Click/Type/Scroll/Move/Shortcut/MultiSelect/MultiEdit）
在下列任一情况下被**拒绝**，并把修复动作写进拒绝原因让模型自己纠正：

| 判定 | code | 触发条件 |
|---|---|---|
| 没有观测 | `NO_OBSERVATION` | 没先 Snapshot 就想点 |
| 观测太旧 | `STALE_OBSERVATION` | 超过 `maxObservationAgeMs`（默认 60000） |
| 代次落后 | `STALE_OBSERVATION` | 引用的观测已被更新的一次取代 |
| 目标窗口漂移 | `PROCESS_CHANGED` | 焦点窗口的 title/handle 与观测时不符 |
| 引用了不存在的观测 | `UNKNOWN_OBSERVATION` | `based_on` 不存在、或值类型非法 |
| 策略失败/形状异常 | `POLICY_ERROR` | 策略抛异常、或返回无法识别的决策形状 |
| 映射不完整 | `MAPPING_INCOMPLETE` | 只**提示**，不阻断（UI 树坐标仍可用） |

只读工具（Snapshot/Screenshot/DisplayInventory/Wait/WaitFor）**永不被拦**，否则就没法自救了。

#### 决策形状契约（失败关闭）

闸门只接受**明确定义**的三种策略返回：`{kind:'allow'}`、`{kind:'deny', reason}`、`{kind:'ask'}`。
其它任何形状（`{}`、`null`、字符串、未知 kind…）一律按 `POLICY_ERROR` 拒绝。

这条契约来自**对抗性验证**：验证者构造出「策略返回 `{}`」，发现旧实现既不认它、
也不拒绝它，于是**整个新鲜度检查被跳过**——没有观测也能点击。属于失败开放缺陷，
已修复并由 `features/fail-closed.feature` 的 6 个场景守护。

#### 主动声明依据：`based_on`

输入类动作可以在参数里带一个观测 id，声明「我这次点击依据的是哪一次观测」：

```json
{ "loc": [2520, 35], "based_on": "obs-3" }
```

闸门会校验这个 id **真实存在**。这是唯一能拦住「模型凭空编一个观测 id、
然后在错误坐标上点击」的检查——它自己以为有依据，实际上没有。

id 是**进程内全局唯一**的（不是每个会话各自从 1 开始），所以审计日志里
`obs-3` 永远只指一次观测，事后复盘不会串。`winmcp_state` 会告诉你当前可用的最新 id
以及最近若干次的 id 序列。

### ③ 没有任何审计记录，出问题无法复盘

**本插件的做法**：`lib/audit.js` 写 append-only JSONL（默认 `$DSH_HOME/logs/windows-mcp-audit.jsonl`），
记录每一次观测、放行、拒绝、失败，含时间、动作分类、目标窗口、坐标、判定原因。
写入前脱敏（密钥样式字段、超长 base64/hex）。**审计写入失败绝不影响动作结果**，只计入 `writeFailures`。

### ④ 无法一键停下

**本插件的做法**：常驻急停开关。`winmcp_kill action=engage` 之后，同步 guard 会拦下所有会改动桌面/系统的
`winmcp` 调用，只放行只读观测工具——这样模型既能被立刻按住，又还能截图向你汇报现场。

## 2. 安装与启用

### 2.1 前置：Windows-MCP 已在 profile 里挂好

本插件**不负责**插入 MCP 桥接行——本机 desktop profile 的 `cordis.patch.yml` 已经有一段
`- insert: mcp-winmcp` 的桥接行（serverName `winmcp`），本 bundle 插入的是**另一个** id
`dsh-windows-mcp`，两者互不冲突，可以同时存在（本机当前就是这个状态）。

一个 loader id 只能被一个层 insert，这条规则是实测出来的：

- 若某个 id 被两个层 insert → Loader 报 `duplicate loader entry id: <id>`，**启动失败**；
- 若只写顶层 `- id:` 覆盖行、而没有任何层 insert 过它 → Loader 报
  `patch: entry "<id>" not found`。

所以桥接行只在 profile 里 insert 一次；本 bundle 的 `cordis.patch.yml` 里把它作为注释保留，
供「换一台机器、由本 bundle 负责桥接」时启用（届时需删掉 profile 里那一份）。

### 2.2 启用本插件

```powershell
# 目录已在 workspace 里，直接作为本地 bundle 安装
dsh plugin --profile desktop add "C:\path\to\dsh_Windows_MCP"
```

或手工（不走 bundle）：把目录放到 `$DSH_HOME/profiles/desktop/node_modules/dsh-windows-mcp`，
再把 `cordis.patch.yml` 里的 `- insert:` 块合并进 profile 的 `cordis.patch.yml`，
并把 `dsh-windows-mcp` 加进 profile `package.json` 的 `dsh.profile.bundles`。

重启 DSH 后，工具表里会出现 5 个 `winmcp_*` 辅助工具。

## 3. 配置

插件行 id 为 `dsh-windows-mcp`。所有键与默认值如下（`README` / `cordis.patch.yml` / `index.js`
三处由 `test/config-surface.test.mjs` 强制一致，改一处漏另一处会直接测试失败）。

| 键 | 默认 | 说明 |
|---|---|---|
| `serverName` | winmcp | 必须与桥接行的 serverName 一致；工具名 = `mcp__<serverName>__<Tool>` |
| `maxObservationAgeMs` | 60000 | 输入类动作可依赖的最旧观测（毫秒） |
| `requireObservation` | true | 输入类动作是否必须有前置观测 |
| `requireCoordinateMapping` | true | 观测缺坐标信息时是否提示（不影响放行） |
| `requireProcessMatch` | true | 是否复核目标窗口在观测之后是否漂移 |
| `requireApproval` | false | 高影响（系统级）工具是否走审批 |
| `requireApprovalForInput` | false | 输入类动作是否走审批。**与上一项各自独立生效**（只开这一项也会拦输入动作） |
| `approvalTtlMs` | 120000 | 审批授权有效期 |
| `auditFile` | 空（**派生**） | 审计文件路径；空 = 用默认路径 `$DSH_HOME/logs/windows-mcp-audit.jsonl`。**派生键**：取值由环境在运行期决定，因此不要求在 `cordis.patch.yml` 中出现（见 `S-CFG-01` / 裁决 A-13） |
| `auditMaxBytes` | 8388608 | 审计文件大小上限（8388608 字节 = 8 MiB），超出后轮转保留 3 份 |
| `autoAudit` | true | 是否自动启用审计；设为 false 则完全不写文件 |
| `annotateResults` | true | 是否在 Snapshot/Screenshot 结果后追加映射行 |
| `registerTools` | true | 是否注册 `winmcp_*` 辅助工具 |
| `injectContext` | true | 是否把当前观测注入运行时上下文（每轮重建，含编号/换算系数/年龄） |
| `commandRulesEnabled` | true | 是否按**命令内容**判定危险操作（Batch 3） |
| `commandRules` | 空 | 追加的自定义危险规则数组（只能追加，不能移除内置规则） |
| `allowRules` | 空 | 内置规则的显式豁免（规则 id 数组）；豁免会记入审计 |

### 3.1 命令级策略（Batch 3）

在只有工具分类的策略里，`Remove-Item -Recurse -Force C:\` 与 `Get-Date` 是同一类动作。
开启后，命中内置危险规则的调用**直接拒绝**（优先于审批），并给出可执行的拒绝理由。

> ⚠️ **这不是安全边界。** 采用规范化**子串**匹配，不是 shell 解析。绕过方式很多：
> 字符串拼接、变量引用、`-EncodedCommand`、别名、`Invoke-Expression`。
> 它的价值是把**最常见的一批危险写法**从静默放行变成明确拒绝 + 可审计。
> 需要真正的隔离时，请用虚拟机 / Windows Sandbox（见第 8 节）。

内置规则（`pattern` 为规范化后的子串）：

| 规则 id | 命中 | 风险 |
|---|---|---|
| `recursive-delete` | `remove-item -recurse` | 递归删除 |
| `recursive-delete-alias` | `rm -r` | 递归删除 |
| `recursive-delete-cmd` | `rd /s` | 递归删除 |
| `recursive-delete-del` | `del /s` | 递归删除 |
| `format-volume` / `format-disk` / `clear-disk` | 格式化 / 清盘 | 磁盘破坏 |
| `registry-delete-hklm` / `registry-delete-hkcr` / `registry-remove-hklm` | 删注册表根 | 注册表破坏 |
| `force-kill-process` | `stop-process -force` | 强杀进程 |
| `shutdown-machine` / `restart-machine` | 关机 / 重启 | 电源状态 |
| `disable-execution-policy` / `disable-firewall` / `disable-defender-realtime` | 削弱安全配置 | 安全降级 |

自定义规则通过 `commandRules: [{id, pattern, risk, reason}]` 追加。
`pattern` 也必须是**规范化形态**（小写、空白折叠、`\`→`/`），否则永远匹配不上——
这条由测试强制。

配置类目与字段映射：

| 类目 | 取值字段 |
|---|---|
| `PowerShell` | `command` 或 `script` |
| `Registry` | `action`、`path`、`name`、`value` |
| `FileSystem` | `operation`/`action`、`path`/`paths` |
| `Process` | `action`、`name`/`pid` |

> **关于审批**：`requireApproval: true` 需要 DSH 侧真的有审批通道。当前会话的审批策略是 `never`，
> 打开此项会让高影响工具按**失败关闭**（fail closed）直接被拒绝，而不是静默放行——这是刻意的设计。

## 4. 工具

### 桥提供的 20 个（`mcp__winmcp__*`）

App、Click、Clipboard、DisplayInventory、FileSystem、Move、MultiEdit、MultiSelect、Notification、
PowerShell、Process、Registry、Scrape、Screenshot、Scroll、Shortcut、Snapshot、Type、Wait、WaitFor。

其中唯一**不需要换算**的坐标是 UI 树里给出的坐标——那就是屏幕坐标本身：

```
├── (2520,35) 按钮 "关闭"  [action: click]
```

### 本插件新增的 6 个（都以 `winmcp_` 开头，只读或只控制自身状态）

| 工具 | 作用 |
|---|---|
| `winmcp_doctor` | **只读自检**：把本插件对上游的假设（工具参数名、坐标映射、策略与审计状态）与**实际注册情况**逐项比对，给出总体结论。刚装好环境、或"点击似乎偏了／规则好像没生效"时先跑它——它能发现只有对着真实注册表才能发现的**参数漂移**（本项目历史上最贵的一个缺陷就是这类） |
| `winmcp_state` | 当前急停状态、最近观测及其坐标映射、审计统计。点不动或点错了先看它 |
| `winmcp_to_screen` | 图片像素 → 屏幕坐标（正算），并附反查确认，直接给出可用的 `loc=[x, y]` |
| `winmcp_screen_to_image` | 屏幕坐标 → 图片像素（反算），用于在截图上核对位置 |
| `winmcp_kill` | 急停：`action=engage` / `release` / `status` |
| `winmcp_audit` | 读取最近的审计记录。`view=summary` 给出人可读的统计与最近条目（被拦了什么、为什么），`view=raw`（默认）返回原始 JSON |

## 5. 验证

```powershell
# 多轮功能测试（发布前验收的执行点）：6 轮，逐轮报告，不伪造通过
node scripts/functional-suite.mjs
node scripts/functional-suite.mjs --fast         # 跳过慢轮（变异测试）
node scripts/functional-suite.mjs --json         # 机读输出

# 全套：单元 + 行为 + 规格覆盖门（必须带 isolation=none，见下）
node --test --experimental-test-isolation=none

# 只跑行为层（BDD）
node --test "test/behaviors/*.test.mjs"

# 只跑规格覆盖门
node --test --experimental-test-isolation=none test/spec/*.test.mjs

# 渲染可读的覆盖报告（只是视图；门禁直接读源码，不读这份报告）
node scripts/render-coverage.mjs

# 变异测试：31 个变异体，证明测试套件真的能杀死缺陷（见 5.3）
node scripts/mutants.mjs

# 发布面脱敏检查（个人路径/主机名/邮箱/凭据/本机附件路径）
node scripts/sanitize-check.mjs

# 真机只读探测（与 live Windows-MCP 握手并把参数名与登记全等比对）
node scripts/live-probe.mjs

# 重启 DeepSeek Harness（插件代码改动只有重启才生效）
# 以**脱离**的辅助进程执行，因此本会话被结束后重启仍会完成；结果见 %TEMP%\dsh-restart.log
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-dsh.ps1

# 审计报告：人可读地看「最近做了什么、被拦了什么」
node scripts/audit-report.mjs                 # 默认读 $DSH_HOME/logs/windows-mcp-audit.jsonl
node scripts/audit-report.mjs --recent 20     # 最近条目条数
node scripts/audit-report.mjs --json          # 输出统计 JSON
node scripts/audit-report.mjs --check         # 有拒绝记录时退出码 1（可用于巡检）

# 桥接行与解释器的端到端自检（读 profile → 真实 MCP 握手 → 真实工具调用）
node scripts/verify-windows-mcp.mjs
```

> **除 `test/*.test.mjs` 之外的脚本不要用 `-test` 结尾**：Node 的测试发现 glob 含
> `**/*-test.mjs`，会把它们当成测试文件跑。本项目的功能套件原名
> `functional-test.mjs`，就被 `node --test` 递归调用导致稳定超时，已改名
> `functional-suite.mjs`。

> **为什么必须 `--experimental-test-isolation=none`**：规格覆盖门除了静态扫描源码，
> 还要求每个声明在**运行时**真的被执行过（防止"声明还在但测试被删/skip"）。
> 逐文件独立进程会把运行时登记表隔离掉，于是门禁会（正确地）失败。
> `package.json` 的 `scripts.test` 已经带这个参数；手工跑时别忘了加。

### 5.1 三驱动开发方式

本项目按 SDD + BDD + TDD 叠加推进，三者的产物都在仓库里：

| 驱动 | 真源 | 作用 |
|---|---|---|
| **SDD** 规格驱动 | [spec/SYS_SPEC.md](spec/SYS_SPEC.md) | 41 条带稳定编号的**可判定**行为承诺。代码与规格冲突时以规格为准 |
| **BDD** 行为驱动 | [features/](features) | 59 个 Gherkin 场景，只描述对外可观测行为 |
| **TDD** 测试驱动 | [test/](test) | 每个场景一个同名 `test()`；先写失败测试再实现 |

覆盖门**强制**下列关系成立（任一不成立则测试失败），并且是**双向**的：

1. 规格文档里每一条 `S-XXX-NN` 都有测试通过 `coverage({ spec: [...] })` 声明；
2. 每个 Gherkin 场景都有同名测试通过 `coverage({ covers: [...] })` 声明；
3. 每个被声明为"已覆盖"的场景都**真的有一个同名 `test()`**（防只声明不实现）；
4. 行为测试里的每个 `Feature :: Scenario` 名都**被声明过**（防写了测试忘声明导致覆盖率虚高）；
5. 行为测试名必须要么是场景名、要么带 `补强｜` 前缀（让"验收"与"额外保险"可机器区分）；
6. 这些声明在**运行时**都真的被登记过（静态声明 + 运行时登记双层校验）；
7. 测试不得声明规格/feature 里不存在的编号或场景（防改名后忘记同步）。

当前的批次进度、每批的证据与已知未验证项见 [spec/GOAL.md](spec/GOAL.md)；
对抗性验证发现的**规格缺陷裁决**见 [spec/ADJUDICATION.md](spec/ADJUDICATION.md)；
自动生成的覆盖明细见 [spec/COVERAGE.md](spec/COVERAGE.md)。

### 5.2 关键回归

`node --test` 覆盖的关键回归（都是真实抓过的数据，不是编造的样例）：
- `parseUiElements` **按行**界定属性：早期版本用固定长度字符窗口向后看，把后面元素的
  `[focused]` 误挂到前面的元素上，导致「哪个元素有焦点」全错；
- `parseUiElements` 只在 `UI Tree:` 区段内解析：早期版本会在区段外匹配坐标，
  把 `Screenshot Region: (0,0,2560,1440)` 当成一个名为 `Screenshot` 的可点元素；
- UI 树的空占位行（`No elements`）即使混入坐标与属性也不得被解析成元素；
- CRLF 行尾与 `\r` 残留；
- 映射公式只用 `coord_scale`（防回归到已被否掉的双重缩放）；
- 实测锚点对账：屏幕 (2520,35) ⇄ 图片 (1890,26.25)、光标 (2000,720) ⇄ 图片 (1500,540)；
- 闸门的每一条拒绝路径，以及「`policy` 抛异常必须失败关闭」；
- `based_on` 引用校验：存在的 id 放行、不存在的 id 报 `UNKNOWN_OBSERVATION`、
  跨会话引用别的 agent 的 id 同样被拒；
- 观测 id 全局唯一（跨 agent 不重复）；
- 审计写入失败不得改变动作结果；审计时间戳形状统一（毫秒 `at` 与 ISO 混写是实机撞到的）；
- **放行的改动类动作也要留审计**（只记拒绝会让"真正改动了桌面"的动作查不到）；
- 桥接边界：畸形响应与上游报错不得产生观测、图片不可接纳时不得谎报、传输失败不得留半条记录；
- 并发一致性：跨 agent 观测隔离、并发 post-execute 不串桶、并发审计仍是逐行合法 JSONL；
- **失败关闭**：策略返回无法识别的形状（`{}`/`null`/未知 kind）必须拒绝而不是放行；
  策略抛异常、配置带抛错 getter 都不得让闸门崩溃或让挂载失败；
- 常见凭据键名（`authorization`/`cookie`/`session_id`/`accessKey`/`jwt`…）必须脱敏；
  非字符串的 `based_on` 必须被拒绝而不是静默忽略；
- `history(limit<=0)` 返回空而不是全部；非法 `coord_scale` 的诊断不得谎称"缺行"；
- 配置面一致性：`index.js` 的 `DEFAULTS` / `cordis.patch.yml` / 本 README 三处必须对齐；
- 只有 `requireObservation` / `requireCoordinateMapping` / `requireProcessMatch` 三个显式开关
  能削弱闸门，**未知配置项不得让闸门失效**（反向断言）；
- 配置值被强转或回退默认时必须留下含"键名/收到值/采用值"的警告；
- 持久上下文注入：单行有界、按会话隔离、无观测时不产生文本、
  取值失败退化为不注入、服务缺失不影响挂载。

当前共 **354 项**测试，**87 条需求 / 120 个行为场景全部有测试覆盖**（由覆盖门双向强制，非人工声明）。

### 5.5 运行时自检：`winmcp_doctor`（本项目最贵的缺陷催生的功能）

本项目最贵的一个缺陷是：把**猜出来的** `action` 当成上游字段名，而真实工具用 `mode`。
后果是规则表在每份文档里都对、**真机上永远不命中**，而单元测试用的是同样猜错的键，
所以全绿——**只有对着真实注册表才能发现**。

`winmcp_doctor` 就是把这件事做成随时可调的自检：它把本插件对上游的假设与
实际注册的工具参数逐项比对，并区分三种结论：

| 结论 | 含义 |
|---|---|
| 一致 | 参数名与登记全等 |
| **严重** | 上游少了本插件要读的键 → 规则会**静默失效** |
| **警告** | 上游多出未登记的键 → 可能有可区分字段没被利用 |

它**只读**，且查不到结果时报"未知"而**不报"正常"**——自检工具最常见的危害是
给出虚假的健康结论，那比没有自检更糟。

**它已经抓到过一个真缺陷**：第一次真机运行就报出 `App` 少登记 5 个参数
（`executable`/`args`/`cwd`/`window_loc`/`window_size`），顺着查下去发现
`App` 能带 `executable` + `args` 启动**任意程序**——一条绕过 PowerShell 命令级策略的
**执行路径**。现已由规则 `app-launch-interpreter` 覆盖（`S-CMD-17`），
并同时加了正向与反向用例（`notepad` 等普通应用必须放行）。

### 5.3 变异测试：证明测试真的能杀死缺陷

覆盖率门证明的是"每条需求都有一条**声明**"，不是"真的在验证"。实测：78 条需求里有 60 条
只在 `coverage({ spec: [...] })` 里出现过一次，任何测试都没有引用它。

`node scripts/mutants.mjs` 用 15 个变异体回答真正的问题：**故意把代码改坏，套件必须变红。**

首次运行只杀死 **10/15**，存活的 5 个全部是我自己测试的弱点（不是实现的问题）：

| 存活的变异体 | 我的测试为什么没抓住 |
|---|---|
| 越界时间戳显示 NaN | 只测了 `1e20`/`Infinity`/`NaN`，它们在前置的 `Number.isFinite` 就被挡住，**根本没走到** `new Date()` 那行检查 |
| 注入文本不再单行 | 只在**超长**窗口名上断言单行，而 `truncate(name, 60)` 会先把换行截掉，折叠逻辑从未执行 |
| 富化不回退到 `value.content` | 既有用例都提供了 `result.content`，在回退之前就返回了 |
| 斜杠归一化改坏 | 等价性用例用了 `hklm:\` vs `hklm:/`，而规则 pattern 是 `hklm:`（分隔符在**后面**），那次断言与归一化无关 |
| 排序丢失 tiebreaker | 该变异体其实是**等价变异体** —— V8 的 `Array.sort` 本就稳定 |

修完测试后 **15/15 全部杀死**。诚实说明：等价变异体无论如何都无法被测试杀死，
那是变异体自身的性质；发现后我把它换成了真正可观察的缺陷（不转小写）。

> **一个真实的坑**：这个脚本原先叫 `mutation-test.mjs`，而 Node 的测试发现 glob
> 会匹配 `*-test.mjs` —— 于是 `node --test` 跑的是变异测试脚本本身，而不是测试套件。
> 已改名为 `mutants.mjs`。

### 5.4 重启 DeepSeek Harness

插件代码改动**只有重启才生效**，而重启会结束正在进行的会话。因此
`scripts/restart-dsh.ps1` 把重启交给一个**脱离的**辅助进程（`dsh-restart-helper.ps1`），
它能在会话结束后继续完成重启；每一步都写进 `%TEMP%\dsh-restart.log`。

> **为什么两个 .ps1 都是纯 ASCII**：Windows PowerShell 5.1 会把**没有 BOM** 的 `.ps1`
> 按系统 ANSI 代码页（这里是 GBK）读取，中文注释会被破坏成语法错误。
> 保持纯 ASCII 就消除了这一整类故障。

## 6. 故障排查

| 现象 | 原因与处理 |
|---|---|
| Loader 报 `duplicate loader entry id: mcp-winmcp` | 两个层都 insert 了桥接行。保留 profile 里那段，删掉插件层或反之——**只能留一个** |
| Loader 报 `patch: entry "mcp-winmcp" not found` | 只写了顶层 `- id:` 覆盖行，但没有任何层 insert 过它。改用 `- insert:` |
| 点击被拒 `NO_OBSERVATION` | 正常保护。先 `mcp__winmcp__Snapshot` 再点 |
| 点击被拒 `STALE_OBSERVATION` | 观测过期或已有更新观测。重新 Snapshot |
| 点击被拒 `PROCESS_CHANGED` | 目标窗口变了。重新 Snapshot 确认焦点窗口再点 |
| 模型抱怨坐标算不对 | 让它用 `winmcp_to_screen`，不要手算；或直接用 UI 树坐标（无需换算） |
| 想立刻停手 | `winmcp_kill action=engage`；随后只读工具仍可用，可让它截图汇报 |
| 工具表里没有 `winmcp_*` | bundle 没被组合：确认 profile `package.json` 的 `dsh.profile.bundles` 里有 `dsh-windows-mcp` |
| 审计文件没生成 | 检查 `autoAudit` / `auditFile`；`winmcp_state` 会显示实际路径与写入失败次数 |

## 7. 已知限制

- **多显示器未实测**：本机只有 1 个 active display。`Screenshot Region` 的负原点与多屏合并规则
  只有代码依据（`service.py` 的 `cx - left_offset`），没有实测。按 Region 原点换算在设计上正确，但请自行验证。
- **上游 `Snapshot` 不打印 Region 的路径**：缺行时原点按 (0,0)，单屏全桌面情形下这是对的。
- **`Screenshot Coordinate Scale` 不恒有**：上游 `scale == 1.0` 时只打印 `Screenshot Size:`，此时按 1.0 处理。
- **UI 树不稳定**：同一分钟内可能一次返回完整树、另几次返回 `No elements`。插件不假定树存在
  （`Cursor Position` 与截图元数据则始终稳定）。
- **不解析 PowerShell / FileSystem / Registry 的语义**：这些工具只做分类、审计与（可选的）审批，
  不解析命令内容。它们的能力边界仍由 Windows-MCP 与本机的审批策略决定。

## 8. 安全边界

Windows-MCP 拥有完整的本机权限：`PowerShell`、`FileSystem`、`Registry`、`Process`、`App`
都能做不可逆操作，且这些调用走 MCP 自己的进程派生，**不经过 DSH 的文件沙箱与审批策略**。
本插件能提高的是「误点/误操作」的可见性与可阻止性（新鲜度闸门、急停、审计），
**不能**替代操作系统层面的隔离。需要真正的隔离时，把 Windows-MCP 部署到虚拟机或 Windows Sandbox，
或用上游的 `--tools` / `--exclude-tools` 裁掉不需要的工具（在
`$DSH_HOME/runtimes/windows-mcp/` 下建 `config.toml` 写 `exclude_tools = [...]`，比改 profile 更不容易被界面重写覆盖）。

## 9. English summary

`dsh_Windows_MCP` deepens DSH's integration with [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP).
The in-box `@deepseek-ai/dsh-mcp-client` bridge moves protocol only; this plugin adds the semantics:

- **Structured coordinate mapping.** Windows-MCP reports `Screenshot Coordinate Scale` as prose. This plugin
  parses the snapshot metadata into real fields and appends one machine-readable line per observation, plus
  `winmcp_to_screen` / `winmcp_screen_to_image`. The verified relation is `screen = region_origin + image_px * coord_scale`
  (two-point fit: slope 1.333333, intercept 0.0000; 125% DPI needs no compensation). A double-scaling variant that
  also applied the attachment ratio was measured and **falsified**, and a regression test guards against it.
- **Action freshness gate.** `tools/pre-execute` denies desktop input when there is no observation, the observation is
  too old or superseded, or the focused window drifted — each with a `code` and a concrete remediation. Read-only tools
  are never blocked.
- **Kill switch, process-identity checks, and an append-only redacted JSONL audit trail** that can never change an
  action's outcome.

126 tests (`node --test`) cover parsing, the mapping math against measured anchors, every denial path, fail-closed
policy errors, `based_on` reference validation, global observation-id uniqueness, audit-shape normalisation, and
config-surface consistency across `index.js`, `cordis.patch.yml` and this README.

## License

MIT。
