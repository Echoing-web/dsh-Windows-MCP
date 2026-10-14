Feature: 桥接边界
  第 1–7 章的承诺都假定「结果已经到达插件」。真实故障多数发生在更早一步：
  桥没有投影出结果、结果形状不对、上游报错、图片进不来。本 feature 只描述
  这条链路**对外可观测**的行为：模型看到的内容、观测里有什么、审计里记了什么。

  规格来源：spec/SYS_SPEC.md 第 8 章（S-BRIDGE-01 … S-BRIDGE-08）。

  Background:
    Given 一个可编程的假 MCP 服务器
    And 一个已挂载的插件宿主

  Scenario: 带图片的截图走完整条链路
    Given 假服务器返回一次带图片的 Screenshot
    When 结果经过后置富化与前置闸门
    Then 返回的内容应以上游原始块开头并在其后追加映射块
    And 观测应携带图片标记与 1.333333 的映射
    And 审计里应有那条观测记录且闸门不应拒绝

  Scenario: 纯文本快照也能立即可点击
    Given 假服务器返回一次不含图片块的 Snapshot
    When 结果经过后置富化与前置闸门
    Then 观测应携带光标 区域与缩放系数
    And 观测的图片标记应为假
    And 紧接着的点击应被放行

  Scenario: 焦点窗口已打开窗口与界面元素都被解析出来
    Given 假服务器返回包含焦点窗口 已打开窗口与界面树的 Snapshot
    When 结果经过后置富化
    Then 应解析出焦点窗口的名称与句柄
    And 应解析出已打开窗口列表
    And 应解析出全部带坐标的界面元素

  Scenario: 结果文本逐字节保真
    Given 假服务器返回一段含中文 em dash CRLF 与回车残留的文本
    When 结果经过后置富化
    Then 模型看到的那段文本应与上游文本逐字符相同
    And 追加的映射块应接在原始块之后

  Scenario: 畸形响应既不能抛也不能被当成观测
    Given 假服务器返回一批形状畸形的结果
    When 结果经过后置富化
    Then 富化不应抛出异常
    And 不应产生任何观测
    And 原始决定应保持不变

  Scenario: 上游报错如实入库且不产生观测
    Given 假服务器对一次 Click 返回错误
    When 结果经过后置富化
    Then 审计应记录一条带原因的 error 条目
    And 不应产生观测
    And 结果内容不应被改写

  Scenario: 图片无法被桥接纳时不谎报
    Given 假服务器返回一次媒体类型不被接纳的 Screenshot
    When 结果经过桥投影
    Then 投影后的内容应只含文本块
    And 上游原始值里应仍保留图片块
    And 观测的图片标记应为假但观测本身仍然成立

  Scenario: UI 树占位空树不产生任何元素
    Given 假服务器返回一次 UI 树为占位空树的 Snapshot
    When 结果经过后置富化
    Then 可交互元素列表应为空
    And 光标 区域与缩放系数仍应解析出来
    And 观测仍应被记录

  Scenario: UI 树完整时元素照常解析
    Given 假服务器返回一次 UI 树完整的 Snapshot
    When 结果经过后置富化
    Then 应解析出全部带坐标的界面元素
    And 应解析出带焦点的那个元素
    And 追加块里应给出元素数量提示

  Scenario: UI 树占位行混入属性也不该被当成元素
    Given 假服务器返回一次占位行带坐标与 action 属性的空树
    When 结果经过后置富化
    Then 可交互元素列表必须为空
    And 观测仍应携带光标与区域

  Scenario: 服务器不响应时不得产生半条观测
    Given 假服务器永不返回结果
    When 调用被放弃
    Then 该调用不应自行完成
    And 插件不应收到任何结果
    And 不应产生观测

  Scenario: 响应中途断线不得产生半条观测
    Given 假服务器只送出文本块后就断线
    When 宿主把传输错误交给插件
    Then 传输错误应如实抛出
    And 不应产生观测
    And 后续一次完整响应应从第一条观测编号开始
