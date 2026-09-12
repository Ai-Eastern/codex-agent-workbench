# 任务时间关联的复用决定

Decision: Borrow。延续既有 Observability 的固定来源与本地实现，仅补运行中缺失的关联字段和观察事件。

本地已读取 `workflow.mjs` 的 dispatch/collect、native claim/bind、验收状态与事件表，`desktop.mjs` 的 read/send，以及 `trace-report.mjs`。本轮重新核查 [Ruflo observe-trace](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/plugins/ruflo-observability/skills/observe-trace/SKILL.md) 固定提交 `39e0b0540c9b018174955fc8a21f355bbac26c6a` 的全部 25 行；它依赖已存在 spans，未提供当前 Codex 的实际开工采集。MIT 通知沿用 `third_party/ruflo-cost-LICENSE.txt`。没有新依赖或外部服务，没有复制上游可执行代码；兼容边界沿用本机既有 Desktop 适配器，未认证其它版本。

使用现有控制器的 `events.at` 作为同一 run 的观察时钟：direct/native 下发记录 task_assigned；native_claim/native_bound 补 attemptId；Desktop 发送前保留 dispatch_intent，成功应答后记录 dispatch_ack；正常 collect 发现新 active/inProgress turn 时每 attempt 最多记录一次 turn_started_observed；有效 task_result 补 attemptId/threadId 和可用的 turnId。验收使用原 ACCEPTING/status 与 acceptance 回执，不新增检查轮。

开工观察不增加单独 RPC、轮询、开工聊天或工具调用。dispatch_ack 不是实际开工；没有被原轮询观察到的开工时间保持未知。报告按 task/attempt 分组，匹配线程与 turn 才计算观察区间，历史缺 attempt 的结果不以当前任务表回填。并行任务时长不相加作为总墙钟。

验证计划为覆盖三条路线、重复观察、送达不明、返修和报告关联的有界测试，再执行一次全套集成检查；正式队列只跑一项有实际用途的离线开发，使用同一集成验收回执与成本采集，不生成框架效率排名。
