# ContinueGate 最小适配决定

决定：**Borrow**。沿用 Ruflo 按证据优先判断长任务是否值得继续的思路，在现有 Workbench 状态摘要中提供异常提醒。默认不新增模型调用、独立管理轮、状态机、计时器或强制暂停入口。

已核查一个外部候选：固定 commit `39e0b0540c9b018174955fc8a21f355bbac26c6a` 的 [continue-gate.ts](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/v3/@claude-flow/guidance/src/continue-gate.ts)。该实现接收 StepContext，按预算、步骤、返工及其他评分决定继续与否。上游是 MIT；声明保留在 [许可证文件](../third_party/ruflo-cost-LICENSE.txt)。不复制其类、历史缓冲、默认阈值或预算斜率算法。

本地检索发现 `src/workflow.mjs` 已有 nextAction、整批预检、一次代码返修预算、一次送达恢复预算，以及 acceptance_recovery、task_repair、blocked_task_repair、batch_preflight_failed 事件；`src/cost-report.mjs` 只报告明确 turn 的观测成本，不提供运行合同的剩余 Token 预算。没有可靠的 Agent 内部步骤、返工比例、连贯性或不确定性评分。不能把原始事件数、等待时间或缓存 Token 计数当作无效工作。

适配只在有异常事实时追加 `continueGate`，通过 nextAction 和原有事件计数给出可核对的提醒：未知送达、已用代码返修预算、同一当前失败检查的重复验收恢复、首批多次预检失败，以及工程已验收后的知识处理。正常、暂停、完成及等待不追加冗余提示。未知指标保持未采集，不填零、不据此放行。事件历史不改变，不自动停止、派单、重试或扩大授权。

重复次数提示仅用于诊断，不证明根因相同；代码返修后，验收恢复统计从新 attempt 对应的返修事件起计算。正常推进后旧告警不继续附着。对比仅测附加字段、状态不变和边界行为，不重新开产品任务做合成提速比较。

验证采用现有状态机的有界集成测试与独立只读审查：确认提醒可追溯、已通过验收不重跑、暂停/等待不误报、未配置预算不被猜测、状态查询不新增事件，最后运行现有全套测试一次。新摘要字段是兼容性扩展，任务包、知识、模型和 run 身份保持不变。
