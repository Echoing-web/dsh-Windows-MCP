Feature: 失败关闭
  闸门是安全组件，它的默认行为必须是「拒绝」。本 Feature 用**对抗性验证者
  构造出的反例**写成场景：当上游（策略、配置、结果形状）返回任何无法识别的东西时，
  系统不能"因为没人说不"就放行。

  规格来源：spec/SYS_SPEC.md 第 2 章 S-GATE-01（失败关闭）与第 6 章 S-HOST-04
  （插件自身的失败不得阻断宿主）。本 Feature 的引入直接来自验证者发现的
  失败开放缺陷（策略返回 `{}` 时整个新鲜度检查被跳过）。

  Background:
    Given 一个已挂载的 dsh_Windows_MCP 插件，观测年龄上限为 60000 毫秒

  Scenario: 策略返回无法识别的决策形状时一律拒绝
    Given 策略会返回一个无法识别的决策形状
    When 我请求创建没有观测依据的鼠标点击
    Then 闸门应拒绝并给出代码 POLICY_ERROR

  Scenario: 无法识别的决策形状不得绕过新鲜度检查
    Given 策略返回空对象而不是明确的放行
    When 我在没有任何观测的情况下请求创建鼠标点击
    Then 闸门绝不应放行
    And 闸门应拒绝

  Scenario: 策略抛异常或返回畸形值时不得让闸门崩掉
    Given 策略在评估时抛出异常
    When 我请求创建鼠标点击
    Then 闸门不应抛出异常
    And 闸门应拒绝并给出代码 POLICY_ERROR

  Scenario: 策略对象本身是畸形值时挂载不得抛异常
    Given 一个缺少 evaluate 方法的策略对象
    When 我请求创建鼠标点击
    Then 闸门应拒绝
    And 挂载过程不应抛出异常

  Scenario: 配置对象带抛错 getter 时挂载不得抛异常
    Given 一个属性读取会抛异常的配置对象
    When 我挂载插件
    Then 挂载过程不应抛出异常

  Scenario: 已放行的输入动作必须已经过完整的新鲜度检查
    Given 策略明确返回放行
    When 我在没有观测的情况下请求创建鼠标点击
    Then 闸门仍应拒绝并给出代码 NO_OBSERVATION
