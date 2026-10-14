Feature: 观测存储与解析
  观测是闸门的唯一依据，因此它的 id 唯一性、会话隔离、历史有界与解析容错
  都是行为契约的一部分，而不只是实现细节。

  规格来源：spec/SYS_SPEC.md 第 3 章（S-OBS-01 … S-OBS-06）。

  Background:
    Given 一个新建的观测存储

  Scenario: 观测编号在进程内全局唯一
    Given 会话 A 记录一次观测，会话 B 也记录一次观测，会话 A 再记录一次
    When 我取出这三条观测的编号
    Then 三个编号应互不相同
    And 会话 A 的两条观测编号应为 obs-1 与 obs-3

  Scenario: 代次按会话各自单调递增
    Given 会话 A 与会话 B 各记录两次观测
    When 我读取它们的代次
    Then 会话 A 的代次应为 1 与 2
    And 会话 B 的代次也应为 1 与 2

  Scenario: 会话之间观测互相不可见
    Given 会话 A 记录一次观测
    When 我读取会话 B 的当前观测
    Then 结果应为空

  Scenario: 按编号查询只能查到本会话的观测
    Given 会话 A 记录一次观测
    When 我用会话 B 的身份按该编号查询
    Then 应查不到任何结果

  Scenario: 观测历史有界
    Given 同一个会话连续记录 30 次观测
    When 我读取该会话的观测历史
    Then 历史长度最多为 20
    And 最新一条应是最后一次记录

  Scenario: 历史查询遵守数量上限
    Given 同一个会话记录 10 次观测
    When 我请求最近 3 条历史
    Then 应恰好返回 3 条
    And 且返回的是最近的三条

  Scenario: 解析真实文本不虚构坐标
    Given 一段只有纯文字的结果
    When 我把它解析为观测
    Then 光标位置应为空
    And 截图区域应为空

  Scenario: 解析出窗口与元素信息
    Given 一段包含焦点窗口表格与 UI 树的观测文本
    When 我把它解析为观测
    Then 应解析出焦点窗口的名称与句柄
    And 应解析出带坐标的可交互元素

  Scenario: 解析对残缺区块容错
    Given 一段缺少 UI 树的观测文本
    When 我把它解析为观测
    Then 仍应解析出光标位置与截图区域
    And 可交互元素列表应为空
