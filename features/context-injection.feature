Feature: 持久上下文注入
  坐标换算系数如果只挂在一次工具结果之后，模型在后续步骤里只能靠记忆复用——
  一旦记错就是一次点偏。本 Feature 描述把它放进**每轮都重建**的运行时上下文
  所需的行为：注入了什么、按会话隔离、什么时候不注入、失败了怎么办。

  规格来源：spec/SYS_SPEC.md 第 10 章（S-CTX-01 … S-CTX-06）。
  技术接缝：`ctx.systemPrompt.context()`（宿主公开服务，注册的是全局层；
  组装时通过 `AssembleContext.scope` 区分是哪个 agent）。

  Background:
    Given 一个已挂载且开启了上下文注入的 dsh_Windows_MCP 插件

  Scenario: 有观测时注入编号与换算系数
    Given 本会话已完成一次观测
    When 宿主为该会话组装提示词上下文
    Then 注入文本应包含该观测的编号
    And 注入文本应包含坐标换算系数与原点

  Scenario: 注入文本只占一行
    Given 本会话已完成一次观测
    When 宿主为该会话组装提示词上下文
    Then 注入文本应只有一行

  Scenario: 无观测时不产生任何文本
    Given 本会话没有任何观测
    When 宿主为该会话组装提示词上下文
    Then 该贡献不应产生文本

  Scenario: 上下文按会话隔离
    Given 会话 A 与会话 B 各自完成了一次观测
    When 宿主分别为两个会话组装上下文
    Then 各自注入的应是自己那一次观测的编号

  Scenario: 系统提示服务缺失时不影响对话
    Given 宿主没有提供系统提示服务
    When 我挂载插件
    Then 挂载不应抛出异常

  Scenario: 组装时取值失败不得中断组装
    Given 观测存储的读取会抛出异常
    When 宿主为该会话组装提示词上下文
    Then 组装不应抛出异常
    And 该贡献应退化为不产生文本

  Scenario: 关闭注入后不再注册该贡献
    Given 配置中关闭了上下文注入
    When 我挂载插件
    Then 不应注册任何上下文贡献
