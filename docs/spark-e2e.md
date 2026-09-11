# Spark 完整流程测试

状态：`BLOCKED_CONTEXT_WINDOW`。这是前置检查记录，完整业务测试尚未开始。

## 本轮模型约定

用户指定 `gpt-5.3-codex-spark` 优先；仅在确认额度不足时切换 `gpt-5.5`。上下文溢出、工具能力不足和业务失败不属于模型降级条件。模型切换需要保留原因、原始失败与已完成步骤，不直接改写已有 run 的模型身份。

## 已观察到的事实

- 账户工具返回 Spark 短周期额度使用为 0%，周额度使用为 56%，没有额度耗尽标记。
- 向现有项目 PM 发送了一次 `gpt-5.3-codex-spark/low` 的只读准备请求，要求阅读入口并讨论候选需求，禁止写文件和派工。
- 该轮在 25,942 毫秒后失败，错误为：`Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.`
- 该轮没有返回就绪标记，完整业务链没有启动；没有改用 5.5，也没有自动重发同一请求。
- 官方文档提供 `thread/compact/start`，但本次已提供的 Desktop 工具没有压缩入口；本机 CLI 的共享 app-server daemon 命令返回仅支持 Unix。没有启动第二个 app-server 来替代桌面连接，没有删除或手工改写会话历史。

这个失败暴露出一个接入前提：检索片段更短，并不能让已经超长的旧会话适配较小模型窗口。业务测试应在上下文能够容纳的任务中执行，并验证新 Skill 能独立恢复必要项目知识。

## 已完成的窄范围修正

- 控制器模型校验允许上述两个显式配置，保持现有默认值及模型身份冻结行为。
- 原生子智能体模型改为读取任务包，准备前核对工具实际支持，避免 Skill 固定写死 5.5。
- Skill 明确额度不足与其他失败的区别，不允许用后者触发降级。
- 新增模型传递回归先复现原有 5.5 限制，修正后编排相关 **13 个测试通过**；命令为 `node --test test/workflow.test.mjs`。这些是本地控制逻辑测试，不算 Spark 执行业务任务的成功证据。

## 待补验证

上下文条件解决后，继续使用真实小需求覆盖自然语言入口与路线选择、项目知识应用、执行与验收、关键异常恢复和下一次开发的经验复用。优先新建一个归属原项目的干净测试 PM，保留原任务及记录；新建侧栏任务须有用户明确授权。

参考：[官方模型入口](https://learn.chatgpt.com/docs/models)、[官方历史压缩接口](https://learn.chatgpt.com/docs/app-server#trigger-thread-compaction)。实际连接结果以本轮工具回执为准。
