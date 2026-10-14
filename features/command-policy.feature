Feature: 命令级策略
  「递归删除整个分区」与「读一下当前时间」在只做工具分类的策略里长得一模一样。
  本 Feature 描述按**命令内容**判定的最小机制：能确定性判定的部分明确拒绝，
  其余一律放行——因为把正常操作误拦会让人整体关掉这个功能。

  规格来源：spec/SYS_SPEC.md 第 11 章（S-CMD-01 … S-CMD-10）。

  **这不是安全边界**：子串匹配可以被绕过（拼接、变量、编码、别名）。
  它只是把最常见的一批危险写法从"静默放行"变成"明确拒绝"。

  Background:
    Given 一个已挂载且开启了命令级策略的 dsh_Windows_MCP 插件

  Scenario: 递归删除被拒绝
    Given 一个 PowerShell 命令 "Remove-Item -Recurse -Force C:\"
    When 策略评估该调用
    Then 决策应为拒绝并给出规则编号 recursive-delete
    And 拒绝理由应说明为什么危险

  Scenario: 格式化卷被拒绝
    Given 一个 PowerShell 命令 "Format-Volume -DriveLetter D"
    When 策略评估该调用
    Then 决策应为拒绝并给出规则编号 format-volume

  Scenario: 删除注册表根被拒绝
    Given 一个 Registry 操作用 mode=delete 删除 HKLM 下的键
    When 策略评估该调用
    Then 决策应为拒绝并给出规则编号 registry-hive-destructive-hklm

  Scenario: 只读查询注册表不被拒绝
    Given 一个 Registry 操作用 mode=get 读取 HKLM 下的键
    When 策略评估该调用
    Then 决策应为放行

  Scenario: 正常只读命令放行
    Given 一个 PowerShell 命令 "Get-Date"
    When 策略评估该调用
    Then 决策应为放行

  Scenario: 大小写与路径分隔符不影响判定
    Given 一个 PowerShell 命令 "remove-item   -RECURSE  -force"
    When 策略评估该调用
    Then 决策应为拒绝
    And 该命令不得因为大小写或多余空白而漏判

  Scenario: 反斜杠与正斜杠写法都命中同一条规则
    Given 两个等价的注册表删除命令，一个用反斜杠一个用正斜杠
    When 策略分别评估它们
    Then 两者都应被拒绝

  Scenario: 取不到操作文本时拒绝而不是放行
    Given 一次 PowerShell 调用没有携带任何命令字段
    When 策略评估该调用
    Then 决策应为拒绝并给出代码 CMD_UNEVALUABLE
    And 拒绝理由应说明缺少哪个字段

  Scenario: 参数不是对象时拒绝
    Given 一次 PowerShell 调用的参数是字符串而不是对象
    When 策略评估该调用
    Then 决策应为拒绝并给出代码 CMD_UNEVALUABLE

  Scenario: 未命中任何规则时放行
    Given 一个 PowerShell 命令 "Get-Process explorer"
    When 策略评估该调用
    Then 决策应为放行
    And 放行理由不得是"没看懂所以拒绝"

  Scenario: 显式豁免可以让内置规则不拒绝
    Given 配置里把 recursive-delete 放进了豁免列表
    And 一个会被该规则命中的命令
    When 策略评估该调用
    Then 决策不应因该规则而拒绝
    And 审计应记录该规则被豁免

  Scenario: 命令级拒绝优先于审批
    Given 配置要求系统级工具走审批
    And 一个会被内置危险规则命中的命令
    When 策略评估该调用
    Then 决策应为直接拒绝而不是询问审批

  Scenario: 关闭命令级策略后不再判定内容
    Given 配置里关闭了命令级策略
    And 一个会被内置危险规则命中的命令
    When 策略评估该调用
    Then 决策不应是命令级拒绝

  Scenario: 规格里的规则表与代码逐字一致
    Given 规格文档里的内置规则表
    And 实现里的内置规则集
    When 我逐条比对两者
    Then 代码里的每条规则都应在表里出现
    And 表里的每个规则编号都应在代码里存在
    And 两者的命中子串应逐字相同
