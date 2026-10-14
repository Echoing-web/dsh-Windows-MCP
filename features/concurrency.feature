Feature: 并发一致性
  插件是宿主里的**全局**监听器：`tools/post-execute` 会收到所有 agent 的调用。
  因此「谁观测的」「谁在写审计」这两件事必须在交错与并发下依然分得清。

  规格来源：spec/SYS_SPEC.md 第 8 章 S-BRIDGE-07（并发写入的一致性与隔离），
  并沿用第 2 章 S-GATE-10 与第 3 章 S-OBS-03 的会话隔离承诺。

  Background:
    Given 一个可编程的假 MCP 服务器
    And 一个已挂载的插件宿主

  Scenario: 两个 agent 交错观测与点击不互相污染
    Given agent A 与 agent B 先后各自观测一次
    And 两次观测的光标位置不同
    When 两个 agent 各自交错执行一次点击
    Then 两次点击都应被放行
    And 审计里两条拒绝记录都不应存在
    And 每条观测都应留在自己的会话桶里

  Scenario: 引用别的 agent 的观测会被拒绝
    Given agent A 与 agent B 各自观测一次
    When agent B 用 agent A 的观测编号作为依据点击
    Then 该点击应被拒绝
    And 拒绝代码应为 UNKNOWN_OBSERVATION

  Scenario: 多路并发写入观测不丢不重
    Given 四个 agent 各并发提交十次观测
    When 全部观测完成后读取存储
    Then 观测编号应全部唯一
    And 每个会话桶都应恰好有十条观测
    And 四个会话的当前观测应互不相同

  Scenario: 并发写入的审计每一行都是合法 JSON
    Given 一个使用真实文件的审计日志
    When 二十次并发调用同时写入审计
    Then 文件行数应恰好等于写入次数
    And 每一行都应能独立解析为 JSON 对象
