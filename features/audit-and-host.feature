Feature: 审计与宿主集成
  审计是事后复盘的唯一依据，因此"记了什么、形状是否统一、失败是否影响动作"
  都属于对外契约。宿主集成则决定插件是否真的接在官方契约上、卸载是否干净。

  规格来源：spec/SYS_SPEC.md 第 5、6 章（S-AUDIT-01 … S-AUDIT-07、S-HOST-01 … S-HOST-05）。

  Background:
    Given 一个使用临时文件的审计日志

  Scenario: 审计记录只追加不改写
    Given 我已经写入三条记录
    When 我读取文件内容
    Then 文件应有且仅有三行
    And 每行都是独立的 JSON 对象

  Scenario: 时间戳形状统一为 ISO 字符串
    Given 我分别写入毫秒时间戳与 ISO 字符串形状的记录
    When 我读回这些记录
    Then 所有记录的 at 字段都应是 ISO 8601 字符串

  Scenario: 审计写入失败不影响动作结果
    Given 审计的写入路径不可写
    When 我写入一条记录
    Then 写入不应抛出异常
    And 失败次数应被计数

  Scenario: 读取时跳过撕裂的最后一行
    Given 文件最后一行是被截断的半个 JSON
    When 我读取审计
    Then 应成功返回之前完整的记录
    And 不应抛出异常

  Scenario: 超长敏感内容被脱敏
    Given 我写入一条包含超长 base64 图像的记录
    When 我读取磁盘上的原始内容
    Then 原始图像数据不应出现在文件中
    And 应出现脱敏占位标记

  Scenario: 文件不可读时回退到内存缓冲
    Given 审计文件在写入后被删除
    When 我读取审计
    Then 应返回内存中的记录而不是抛错

  Scenario: 超过大小上限时轮转并保留有限历史
    Given 审计的大小上限设得很小
    When 我写入足够多的记录触发多次轮转
    Then 应产生历史文件
    And 历史文件数量不超过设定上限

  Scenario: 观测与拒绝都会留下记录
    Given 本会话没有任何观测
    When 我请求创建鼠标点击并被拒绝
    Then 审计中应同时存在拒绝记录
    And 拒绝记录应带代码与原因

  Scenario: 插件接在官方契约的三个接入点上
    Given 一个已挂载的插件
    When 我检查它注册了什么
    Then 应各注册一个前置闸门与一个后置富化监听器
    And 应注册一个同步守卫

  Scenario: 富化只追加不替换上游内容
    Given 一次携带图片的截图观测
    When 后置富化处理该结果
    Then 返回的内容应以上游原始块开头
    And 追加的块应位于其后

  Scenario: 卸载后不留残留
    Given 一个已挂载的插件
    When 我执行卸载
    Then 监听器 守卫与已注册工具都应被清理干净

  Scenario: 插件自身的失败不会阻断宿主启动
    Given 一个配置畸形的插件实例
    When 我挂载它
    Then 挂载不应抛出异常

  Scenario: 测试模式使用真实文件后端时仍可往返
    Given 一个使用真实文件后端的审计日志
    When 我写入并读回一条记录
    Then 内容应保持一致
