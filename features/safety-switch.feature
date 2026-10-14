Feature: 安全开关
  当 AI 正在错误地操作桌面时，用户需要一个"立刻停手"的手段，并且这个手段
  不能依赖可能已经出问题的那条链路。

  规格来源：spec/SYS_SPEC.md 第 4 章（S-SAFE-01 … S-SAFE-04）。

  Background:
    Given 一个已挂载的 dsh_Windows_MCP 插件

  Scenario: 启用急停后输入类动作被拒绝
    Given 我启用急停
    When 我请求创建鼠标点击
    Then 同步守卫应给出拒绝原因
    And 原因中应提到急停

  Scenario: 急停期间只读观测工具仍可用
    Given 我启用急停
    When 我请求快照
    Then 同步守卫应放行

  Scenario: 急停期间其他服务器的工具不受影响
    Given 我启用急停
    When 我请求执行一个宿主的普通工具
    Then 同步守卫应放行

  Scenario: 解除急停后恢复正常
    Given 我启用急停再解除
    When 我请求创建鼠标点击
    Then 同步守卫应放行

  Scenario: 重复启用急停是幂等的
    Given 我连续三次启用急停
    When 我读取急停状态
    Then 状态应为已启用
    And 启用计数应为 3 而状态不变

  Scenario: 急停状态可查询并带出原因与时间
    Given 我启用急停并附上原因
    When 我读取急停状态
    Then 状态中应包含该原因
    And 状态中应包含启用时间

  Scenario: 守卫自身异常时不得阻断调用
    Given 我启用急停
    When 我用一个畸形的执行对象调用守卫
    Then 守卫应放行而不是抛异常

  Scenario: 审批通道不可用时失败关闭
    Given 策略要求高影响工具走审批
    And 审批通道不可用
    When 我请求执行一个高影响工具
    Then 闸门应拒绝并给出代码 APPROVAL_UNAVAILABLE
