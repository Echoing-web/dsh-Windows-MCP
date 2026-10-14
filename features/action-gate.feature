Feature: 动作闸门
  模型可以自由地"看"屏幕，但"动手"必须满足安全条件。本 Feature 描述闸门对外
  的可观测行为：什么情况下拒绝、拒绝时给出什么信息、什么情况下永不拒绝。

  规格来源：spec/SYS_SPEC.md 第 2 章（S-GATE-01 … S-GATE-10）。

  Background:
    Given 一个已挂载的 dsh_Windows_MCP 插件，观测年龄上限为 60000 毫秒

  Scenario: 没有观测就想点击会被拒绝
    Given 本会话没有任何观测
    When 我请求创建鼠标点击
    Then 闸门应拒绝并给出代码 NO_OBSERVATION
    And 拒绝原因应提示先执行 Snapshot

  Scenario: 先观测再点击可以通过
    Given 本会话刚完成一次观测
    When 我请求创建鼠标点击
    Then 闸门应放行

  Scenario: 观测超过年龄上限会被拒绝
    Given 本会话在 61000 毫秒前完成过一次观测
    When 我请求创建鼠标点击
    Then 闸门应拒绝并给出代码 STALE_OBSERVATION

  Scenario: 观测年龄恰好等于上限时不算过期
    Given 本会话在恰好 60000 毫秒前完成过一次观测
    When 我请求创建鼠标点击
    Then 闸门应放行

  Scenario: 存在更新的观测时旧观测被判定为过期
    Given 本会话先后完成两次观测，且我依据的是较早那一次
    When 我请求创建鼠标点击
    Then 闸门应拒绝并给出代码 STALE_OBSERVATION

  Scenario: 目标窗口发生变化会被拒绝
    Given 本会话完成过一次观测，焦点窗口是 Notepad
    And 执行时焦点窗口已变成另一个程序
    When 我请求创建鼠标点击
    Then 闸门应拒绝并给出代码 PROCESS_CHANGED

  Scenario: 目标窗口未变化时不报漂移
    Given 本会话完成过一次观测，焦点窗口是 Notepad
    And 执行时焦点窗口仍是 Notepad
    When 我请求创建鼠标点击
    Then 闸门应放行

  Scenario: 引用了不存在的观测会被拒绝
    Given 本会话只有编号为 obs-1 的观测
    When 我请求创建鼠标点击并声明依据 obs-99
    Then 闸门应拒绝并给出代码 UNKNOWN_OBSERVATION
    And 拒绝原因应同时提到 obs-99 与当前可用的 obs-1

  Scenario: 引用别的会话的观测会被拒绝
    Given 另一个会话拥有一次观测，而本会话有自己的观测
    When 我请求创建鼠标点击并声明依据另一个会话的观测编号
    Then 闸门应拒绝并给出代码 UNKNOWN_OBSERVATION

  Scenario: 引用真实存在的观测会被放行
    Given 本会话只有编号为 obs-1 的观测
    When 我请求创建鼠标点击并声明依据 obs-1
    Then 闸门应放行

  Scenario: 不带依据声明的点击不做该校验
    Given 本会话刚完成一次观测
    When 我请求创建鼠标点击且不带任何依据声明
    Then 闸门应放行

  Scenario: 策略评估抛异常时必须失败关闭
    Given 策略评估会抛出异常
    When 我请求创建鼠标点击
    Then 闸门应拒绝并给出代码 POLICY_ERROR

  Scenario: 只读工具在任何情况下都不被闸门拦截
    Given 本会话没有任何观测
    When 我依次请求快照 截图 显示器清单 等待
    Then 这些请求都应放行

  Scenario: 只读工具在观测过期时同样不被拦截
    Given 本会话在 120000 毫秒前完成过一次观测
    When 我请求快照
    Then 该请求应放行

  Scenario: 别的服务器的工具不经本闸门
    Given 一个属于其他 MCP 服务器的点击类工具
    When 我请求执行它
    Then 闸门不应介入并应放行

  Scenario: 非 MCP 工具完全不受影响
    Given 一个宿主的普通工具
    When 我请求执行它
    Then 闸门不应介入

  Scenario: 缺少坐标映射只提示不阻断
    Given 本会话的观测缺少坐标映射信息
    When 我请求创建鼠标点击
    Then 闸门应放行
    And 应产生一条映射不完整的提示

  Scenario: 拒绝会被写入审计
    Given 本会话没有任何观测
    When 我请求创建鼠标点击并被拒绝
    Then 审计中应出现一条拒绝记录
    And 该记录应带有拒绝代码与原因

  Scenario: 放行的输入类动作同样会被写入审计
    Given 本会话刚完成一次观测
    When 我请求创建鼠标点击并被放行
    Then 审计中应出现一条放行记录
    And 该记录应带上所依据的观测编号
