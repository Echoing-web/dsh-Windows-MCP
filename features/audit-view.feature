Feature: 审计可视化
  审计日志是机器可读的 JSONL；但"最近做了什么、被拦了什么"需要人一眼看懂。
  本 Feature 描述把同一份日志渲染成人可读视图所需的确定性行为——
  同一份输入在任何时候渲染出同样的文本。

  规格来源：spec/SYS_SPEC.md 第 12 章（S-VIEW-01 … S-VIEW-06）。
  实现被**两个入口共用**：工具 `winmcp_audit`（view=summary）与
  脚本 `scripts/audit-report.mjs`。

  Background:
    Given 一份包含若干审计条目的日志

  Scenario: 摘要统计给出固定口径
    Given 一份包含放行与拒绝两类条目的日志
    When 我请求审计摘要
    Then 应给出总数 按判定 按动作 按工具 四类计数
    And 放行条数与拒绝条数之和应等于总数

  Scenario: 分类计数的合计等于总数
    Given 一份条目判定残缺不一的日志
    When 我请求审计摘要
    Then 按判定分组的合计应等于总数
    And 按工具分组的合计也应等于总数

  Scenario: 渲染结果包含标题与分区
    Given 一份包含若干审计条目的日志
    When 我渲染审计报告
    Then 首行应是包含条目数的标题
    And 应包含概览 分类 最近条目三个分区

  Scenario: 最近条目按时间倒序
    Given 一份时间递增的日志
    When 我渲染审计报告
    Then 最近条目区里最新的应排在最前

  Scenario: 空日志给出明确说明而不是空白
    Given 没有任何审计条目
    When 我渲染审计报告
    Then 输出应明确说明暂无记录

  Scenario: 时间不可解析的条目不被丢弃
    Given 一条时间不可解析的审计条目
    When 我渲染审计报告
    Then 该条目仍应计入统计
    And 它的时间位置应显示占位符
    And 它应排在时间可用的条目之后

  Scenario: 畸形输入不得让渲染抛异常
    Given 渲染函数收到非数组或含畸形条目的输入
    When 我调用渲染与统计
    Then 不应抛出异常
    And 应返回可用的结果

  Scenario: 两个入口共用同一实现
    Given 审计可视化模块
    When 我检查工具与脚本的渲染来源
    Then 两者都应调用同一批纯函数

  Scenario: 原因过长时截断并标注
    Given 一条拒绝原因非常长的审计条目
    When 我渲染审计报告
    Then 该原因应被截断
    And 应带省略标记

  Scenario: 同一工具的两种写法归一到一行
    Given 两条审计条目分别用带前缀与去前缀的形式记录同一个工具
    When 我请求审计摘要
    Then 该工具在按工具分区里应只占一行
    And 计数应合并为两条

