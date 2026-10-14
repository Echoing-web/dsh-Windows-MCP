# 规格覆盖报告

> **本文件由 `npm test` 自动校验一致性**，但内容建议手工刷新：
> `node scripts/render-coverage.mjs`。手改内容不会影响门禁（门禁直接读源码）。

- 生成时间：2026-10-10T21:12:31.193Z
- 需求条目：69，其中**未被任何测试引用**：0
- 行为场景：101，其中**未被任何测试引用**：0

## 需求覆盖

| 需求 | 摘要 | 状态 |
|---|---|---|
| `S-MAP-01` | 映射公式 | ✅ |
| `S-MAP-02` | 缩放系数只来自 coord_scale | ✅ |
| `S-MAP-03` | 无偏移 `[真机测量项]` | ✅ |
| `S-MAP-04` | 实测锚点（回归基准） | ✅ |
| `S-MAP-05` | 映射不可用时必须显式失败 | ✅ |
| `S-MAP-06` | 数值友好化与误差界 | ✅ |
| `S-MAP-07` | 映射摘要必须单行 | ✅ |
| `S-GATE-01` | 失败关闭 | ✅ |
| `S-GATE-02` | 无观测 | ✅ |
| `S-GATE-03` | 过期 | ✅ |
| `S-GATE-04` | 代次落后 | ✅ |
| `S-GATE-05` | 窗口漂移 | ✅ |
| `S-GATE-06` | 引用的观测必须存在 | ✅ |
| `S-GATE-07` | 只读工具不因闸门原因被拦 | ✅ |
| `S-GATE-08` | 非本插件的工具不受影响 | ✅ |
| `S-GATE-09` | 映射不完整不阻断 | ✅ |
| `S-GATE-11` | 配置开关的边界（裁决 A-10） | ✅ |
| `S-CFG-02` | 除这三个显式开关外，**任何配置都不得使 S-GATE-\* 失效**（与 一致）。 | ✅ |
| `S-GATE-10` | 依据的观测必须属于本会话 | ✅ |
| `S-FAIL-01` | 只接受明确定义的决策 | ✅ |
| `S-FAIL-02` | 异常与畸形输入不得让闸门崩溃 | ✅ |
| `S-HOST-04` | 而**不得**把异常抛给调用方，也不得让插件挂载失败（与 一致）。 | ✅ |
| `S-FAIL-03` | 放行必经完整新鲜度检查 | ✅ |
| `S-OBS-01` | id 全局唯一 | ✅ |
| `S-OBS-02` | 代次按 agent 单调 | ✅ |
| `S-OBS-03` | 会话隔离 | ✅ |
| `S-OBS-04` | 有界历史 | ✅ |
| `S-OBS-05` | 解析必须容错 | ✅ |
| `S-OBS-06` | 属性按行界定 | ✅ |
| `S-SAFE-01` | 急停语义 | ✅ |
| `S-SAFE-02` | 急停的同步兜底 | ✅ |
| `S-SAFE-03` | 审批不可用时失败关闭 | ✅ |
| `S-SAFE-04` | 审批授权一次性且会过期 | ✅ |
| `S-AUDIT-01` | 只追加 | ✅ |
| `S-AUDIT-02` | 审计失败绝不影响动作 | ✅ |
| `S-AUDIT-03` | 时间戳形状统一 | ✅ |
| `S-AUDIT-04` | 脱敏 | ✅ |
| `S-AUDIT-05` | 撕裂行容错 | ✅ |
| `S-AUDIT-06` | 有界 | ✅ |
| `S-AUDIT-07` | 记录放行与拒绝 | ✅ |
| `S-HOST-01` | 挂载点 | ✅ |
| `S-HOST-02` | 富化只追加 | ✅ |
| `S-HOST-03` | 生命周期 | ✅ |
| `S-HOST-05` | 桥接行的所有权 | ✅ |
| `S-CFG-01` | 三处一致 | ✅ |
| `S-CTX-01` | 观测状态进入运行时上下文 | ✅ |
| `S-CTX-02` | 会话隔离 | ✅ |
| `S-CTX-03` | 无观测时不注入 | ✅ |
| `S-CTX-04` | 单行且有界 | ✅ |
| `S-CTX-05` | 注入失败不得影响对话 | ✅ |
| `S-CTX-06` | 可关闭 | ✅ |
| `S-CMD-01` | 操作文本的来源 | ✅ |
| `S-CMD-02` | 拼装后做**规范化**（）。若类目需要文本但一个字段都取不到 → 见 。 | ✅ |
| `S-CMD-06` | 拼装后做**规范化**（）。若类目需要文本但一个字段都取不到 → 见 。 | ✅ |
| `S-CMD-03` | 规则格式：规范化子串 | ✅ |
| `S-CMD-04` | 内置危险规则必须始终生效 | ✅ |
| `S-CMD-07` | 只能通过显式的 `allowRules` 豁免（）： | ✅ |
| `S-CMD-05` | 拒绝理由必须可执行 | ✅ |
| `S-CMD-08` | 判定不了 ≠ 没命中规则。前者必须拒绝；后者按 放行。 | ✅ |
| `S-CMD-09` | 命令级拒绝优先于审批 | ✅ |
| `S-CMD-10` | 可关闭 | ✅ |
| `S-BRIDGE-01` | 上游内容只追加不丢失 | ✅ |
| `S-BRIDGE-02` | 可交互元素与窗口事实必须解析出来 | ✅ |
| `S-BRIDGE-03` | 畸形响应不得抛出，也不得被当成观测 | ✅ |
| `S-BRIDGE-04` | 上游报错如实入库且不产生观测 | ✅ |
| `S-BRIDGE-05` | 图片无法被桥接纳时不得谎报 | ✅ |
| `S-BRIDGE-06` | UI 树的两种合法形状 | ✅ |
| `S-BRIDGE-07` | 并发写入的一致性与隔离 | ✅ |
| `S-BRIDGE-08` | 传输失败不得产生半条观测 | ✅ |

## 行为场景覆盖

| Feature | 场景 | 步骤数 | 来源 | 状态 |
|---|---|---|---|---|
| 动作闸门 | 没有观测就想点击会被拒绝 | 4 | `features/action-gate.feature:10` | ✅ |
| 动作闸门 | 先观测再点击可以通过 | 3 | `features/action-gate.feature:16` | ✅ |
| 动作闸门 | 观测超过年龄上限会被拒绝 | 3 | `features/action-gate.feature:21` | ✅ |
| 动作闸门 | 观测年龄恰好等于上限时不算过期 | 3 | `features/action-gate.feature:26` | ✅ |
| 动作闸门 | 存在更新的观测时旧观测被判定为过期 | 3 | `features/action-gate.feature:31` | ✅ |
| 动作闸门 | 目标窗口发生变化会被拒绝 | 4 | `features/action-gate.feature:36` | ✅ |
| 动作闸门 | 目标窗口未变化时不报漂移 | 4 | `features/action-gate.feature:42` | ✅ |
| 动作闸门 | 引用了不存在的观测会被拒绝 | 4 | `features/action-gate.feature:48` | ✅ |
| 动作闸门 | 引用别的会话的观测会被拒绝 | 3 | `features/action-gate.feature:54` | ✅ |
| 动作闸门 | 引用真实存在的观测会被放行 | 3 | `features/action-gate.feature:59` | ✅ |
| 动作闸门 | 不带依据声明的点击不做该校验 | 3 | `features/action-gate.feature:64` | ✅ |
| 动作闸门 | 策略评估抛异常时必须失败关闭 | 3 | `features/action-gate.feature:69` | ✅ |
| 动作闸门 | 只读工具在任何情况下都不被闸门拦截 | 3 | `features/action-gate.feature:74` | ✅ |
| 动作闸门 | 只读工具在观测过期时同样不被拦截 | 3 | `features/action-gate.feature:79` | ✅ |
| 动作闸门 | 别的服务器的工具不经本闸门 | 3 | `features/action-gate.feature:84` | ✅ |
| 动作闸门 | 非 MCP 工具完全不受影响 | 3 | `features/action-gate.feature:89` | ✅ |
| 动作闸门 | 缺少坐标映射只提示不阻断 | 4 | `features/action-gate.feature:94` | ✅ |
| 动作闸门 | 拒绝会被写入审计 | 4 | `features/action-gate.feature:100` | ✅ |
| 动作闸门 | 放行的输入类动作同样会被写入审计 | 4 | `features/action-gate.feature:106` | ✅ |
| 审计与宿主集成 | 审计记录只追加不改写 | 4 | `features/audit-and-host.feature:10` | ✅ |
| 审计与宿主集成 | 时间戳形状统一为 ISO 字符串 | 3 | `features/audit-and-host.feature:16` | ✅ |
| 审计与宿主集成 | 审计写入失败不影响动作结果 | 4 | `features/audit-and-host.feature:21` | ✅ |
| 审计与宿主集成 | 读取时跳过撕裂的最后一行 | 4 | `features/audit-and-host.feature:27` | ✅ |
| 审计与宿主集成 | 超长敏感内容被脱敏 | 4 | `features/audit-and-host.feature:33` | ✅ |
| 审计与宿主集成 | 文件不可读时回退到内存缓冲 | 3 | `features/audit-and-host.feature:39` | ✅ |
| 审计与宿主集成 | 超过大小上限时轮转并保留有限历史 | 4 | `features/audit-and-host.feature:44` | ✅ |
| 审计与宿主集成 | 观测与拒绝都会留下记录 | 4 | `features/audit-and-host.feature:50` | ✅ |
| 审计与宿主集成 | 插件接在官方契约的三个接入点上 | 4 | `features/audit-and-host.feature:56` | ✅ |
| 审计与宿主集成 | 富化只追加不替换上游内容 | 4 | `features/audit-and-host.feature:62` | ✅ |
| 审计与宿主集成 | 卸载后不留残留 | 3 | `features/audit-and-host.feature:68` | ✅ |
| 审计与宿主集成 | 插件自身的失败不会阻断宿主启动 | 3 | `features/audit-and-host.feature:73` | ✅ |
| 审计与宿主集成 | 测试模式使用真实文件后端时仍可往返 | 3 | `features/audit-and-host.feature:78` | ✅ |
| 桥接边界 | 带图片的截图走完整条链路 | 5 | `features/bridge-boundary.feature:12` | ✅ |
| 桥接边界 | 纯文本快照也能立即可点击 | 5 | `features/bridge-boundary.feature:19` | ✅ |
| 桥接边界 | 焦点窗口已打开窗口与界面元素都被解析出来 | 5 | `features/bridge-boundary.feature:26` | ✅ |
| 桥接边界 | 结果文本逐字节保真 | 4 | `features/bridge-boundary.feature:33` | ✅ |
| 桥接边界 | 畸形响应既不能抛也不能被当成观测 | 5 | `features/bridge-boundary.feature:39` | ✅ |
| 桥接边界 | 上游报错如实入库且不产生观测 | 5 | `features/bridge-boundary.feature:46` | ✅ |
| 桥接边界 | 图片无法被桥接纳时不谎报 | 5 | `features/bridge-boundary.feature:53` | ✅ |
| 桥接边界 | UI 树占位空树不产生任何元素 | 5 | `features/bridge-boundary.feature:60` | ✅ |
| 桥接边界 | UI 树完整时元素照常解析 | 5 | `features/bridge-boundary.feature:67` | ✅ |
| 桥接边界 | UI 树占位行混入属性也不该被当成元素 | 4 | `features/bridge-boundary.feature:74` | ✅ |
| 桥接边界 | 服务器不响应时不得产生半条观测 | 5 | `features/bridge-boundary.feature:80` | ✅ |
| 桥接边界 | 响应中途断线不得产生半条观测 | 5 | `features/bridge-boundary.feature:87` | ✅ |
| 命令级策略 | 递归删除被拒绝 | 4 | `features/command-policy.feature:14` | ✅ |
| 命令级策略 | 格式化卷被拒绝 | 3 | `features/command-policy.feature:20` | ✅ |
| 命令级策略 | 删除注册表根被拒绝 | 3 | `features/command-policy.feature:25` | ✅ |
| 命令级策略 | 正常只读命令放行 | 3 | `features/command-policy.feature:30` | ✅ |
| 命令级策略 | 大小写与路径分隔符不影响判定 | 4 | `features/command-policy.feature:35` | ✅ |
| 命令级策略 | 反斜杠与正斜杠写法都命中同一条规则 | 3 | `features/command-policy.feature:41` | ✅ |
| 命令级策略 | 取不到操作文本时拒绝而不是放行 | 4 | `features/command-policy.feature:46` | ✅ |
| 命令级策略 | 参数不是对象时拒绝 | 3 | `features/command-policy.feature:52` | ✅ |
| 命令级策略 | 未命中任何规则时放行 | 4 | `features/command-policy.feature:57` | ✅ |
| 命令级策略 | 显式豁免可以让内置规则不拒绝 | 5 | `features/command-policy.feature:63` | ✅ |
| 命令级策略 | 命令级拒绝优先于审批 | 4 | `features/command-policy.feature:70` | ✅ |
| 命令级策略 | 关闭命令级策略后不再判定内容 | 4 | `features/command-policy.feature:76` | ✅ |
| 并发一致性 | 两个 agent 交错观测与点击不互相污染 | 6 | `features/concurrency.feature:12` | ✅ |
| 并发一致性 | 引用别的 agent 的观测会被拒绝 | 4 | `features/concurrency.feature:20` | ✅ |
| 并发一致性 | 多路并发写入观测不丢不重 | 5 | `features/concurrency.feature:26` | ✅ |
| 并发一致性 | 并发写入的审计每一行都是合法 JSON | 4 | `features/concurrency.feature:33` | ✅ |
| 持久上下文注入 | 有观测时注入编号与换算系数 | 4 | `features/context-injection.feature:13` | ✅ |
| 持久上下文注入 | 注入文本只占一行 | 3 | `features/context-injection.feature:19` | ✅ |
| 持久上下文注入 | 无观测时不产生任何文本 | 3 | `features/context-injection.feature:24` | ✅ |
| 持久上下文注入 | 上下文按会话隔离 | 3 | `features/context-injection.feature:29` | ✅ |
| 持久上下文注入 | 系统提示服务缺失时不影响对话 | 3 | `features/context-injection.feature:34` | ✅ |
| 持久上下文注入 | 组装时取值失败不得中断组装 | 4 | `features/context-injection.feature:39` | ✅ |
| 持久上下文注入 | 关闭注入后不再注册该贡献 | 3 | `features/context-injection.feature:45` | ✅ |
| 坐标映射 | 图片像素换算为屏幕坐标 | 3 | `features/coordinate-mapping.feature:11` | ✅ |
| 坐标映射 | 屏幕坐标换算回图片像素 | 3 | `features/coordinate-mapping.feature:16` | ✅ |
| 坐标映射 | 换算结果与整数相差极小时吸附到整数 | 3 | `features/coordinate-mapping.feature:21` | ✅ |
| 坐标映射 | 附件尺寸不参与换算 | 3 | `features/coordinate-mapping.feature:26` | ✅ |
| 坐标映射 | 缺少缩放系数行时按 1.0 处理 | 3 | `features/coordinate-mapping.feature:31` | ✅ |
| 坐标映射 | 缺少区域行时原点退化为零 | 4 | `features/coordinate-mapping.feature:36` | ✅ |
| 坐标映射 | 坐标系原点非零时仍然正确 | 3 | `features/coordinate-mapping.feature:42` | ✅ |
| 坐标映射 | 映射信息不足时必须明确失败 | 4 | `features/coordinate-mapping.feature:47` | ✅ |
| 坐标映射 | 映射摘要必须是一行 | 4 | `features/coordinate-mapping.feature:53` | ✅ |
| 坐标映射 | 解析容错——CRLF 与中文控件名 | 4 | `features/coordinate-mapping.feature:59` | ✅ |
| 坐标映射 | 多个元素的焦点与取值只属于各自所在行 | 4 | `features/coordinate-mapping.feature:65` | ✅ |
| 失败关闭 | 策略返回无法识别的决策形状时一律拒绝 | 3 | `features/fail-closed.feature:13` | ✅ |
| 失败关闭 | 无法识别的决策形状不得绕过新鲜度检查 | 4 | `features/fail-closed.feature:18` | ✅ |
| 失败关闭 | 策略抛异常或返回畸形值时不得让闸门崩掉 | 4 | `features/fail-closed.feature:24` | ✅ |
| 失败关闭 | 策略对象本身是畸形值时挂载不得抛异常 | 4 | `features/fail-closed.feature:30` | ✅ |
| 失败关闭 | 配置对象带抛错 getter 时挂载不得抛异常 | 3 | `features/fail-closed.feature:36` | ✅ |
| 失败关闭 | 已放行的输入动作必须已经过完整的新鲜度检查 | 3 | `features/fail-closed.feature:41` | ✅ |
| 观测存储与解析 | 观测编号在进程内全局唯一 | 4 | `features/observation-store.feature:10` | ✅ |
| 观测存储与解析 | 代次按会话各自单调递增 | 4 | `features/observation-store.feature:16` | ✅ |
| 观测存储与解析 | 会话之间观测互相不可见 | 3 | `features/observation-store.feature:22` | ✅ |
| 观测存储与解析 | 按编号查询只能查到本会话的观测 | 3 | `features/observation-store.feature:27` | ✅ |
| 观测存储与解析 | 观测历史有界 | 4 | `features/observation-store.feature:32` | ✅ |
| 观测存储与解析 | 历史查询遵守数量上限 | 4 | `features/observation-store.feature:38` | ✅ |
| 观测存储与解析 | 解析真实文本不虚构坐标 | 4 | `features/observation-store.feature:44` | ✅ |
| 观测存储与解析 | 解析出窗口与元素信息 | 4 | `features/observation-store.feature:50` | ✅ |
| 观测存储与解析 | 解析对残缺区块容错 | 4 | `features/observation-store.feature:56` | ✅ |
| 安全开关 | 启用急停后输入类动作被拒绝 | 4 | `features/safety-switch.feature:10` | ✅ |
| 安全开关 | 急停期间只读观测工具仍可用 | 3 | `features/safety-switch.feature:16` | ✅ |
| 安全开关 | 急停期间其他服务器的工具不受影响 | 3 | `features/safety-switch.feature:21` | ✅ |
| 安全开关 | 解除急停后恢复正常 | 3 | `features/safety-switch.feature:26` | ✅ |
| 安全开关 | 重复启用急停是幂等的 | 4 | `features/safety-switch.feature:31` | ✅ |
| 安全开关 | 急停状态可查询并带出原因与时间 | 4 | `features/safety-switch.feature:37` | ✅ |
| 安全开关 | 守卫自身异常时不得阻断调用 | 3 | `features/safety-switch.feature:43` | ✅ |
| 安全开关 | 审批通道不可用时失败关闭 | 4 | `features/safety-switch.feature:48` | ✅ |
