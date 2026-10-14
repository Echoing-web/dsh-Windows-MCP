Feature: 运行时自检
  本项目最大的一个缺陷（把猜出来的 `action` 当成上游字段名，而真实工具用 `mode`）
  只有对着**真实注册表**才能发现：规则表在每份文档里都对，真机上永远不命中，
  而单元测试用的是同样猜错的键，所以全绿。
  本 Feature 描述把这类"假设漂移"变成模型随时可调的自检所需的行为。

  规格来源：spec/SYS_SPEC.md 第 13 章（S-HOST-06 … S-HOST-08）。

  Background:
    Given 一个已挂载的 dsh_Windows_MCP 插件

  Scenario: 上游参数与登记一致时报告通过
    Given 注册表里的 winmcp 工具参数与本插件登记完全一致
    When 我运行自检
    Then 总体结论应为健康
    And 应说明参数名与登记全等

  Scenario: 上游缺少本插件要读的字段时判为严重
    Given 注册表里 PowerShell 工具没有 command 参数
    When 我运行自检
    Then 总体结论应为不健康
    And 应把该差异标为严重
    And 应指出规则会因此静默失效

  Scenario: 上游多出未登记的字段时给出警告
    Given 注册表里 Process 工具多出一个本插件未登记的布尔参数
    When 我运行自检
    Then 应把该差异标为警告
    And 不应因此判为不健康

  Scenario: 自检必须只读
    Given 一个已挂载的插件
    When 我运行自检
    Then 不得改变急停状态
    And 不得改变观测桶内容

  Scenario: 注册表不可读时必须报未知而不是正常
    Given 工具服务不可用
    When 我运行自检
    Then 总体结论不应为健康
    And 应明确说明哪一项查不到

  Scenario: 自检报告包含观测与策略状态
    Given 一个已挂载的插件且已有一次观测
    When 我运行自检
    Then 报告应包含观测编号与年龄
    And 报告应包含命令级策略是否启用
