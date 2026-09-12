# 有界成本观察

用户要求成本评测时使用现有 CLI 的 `cost-report` 和 `cost-diff`。采集由维护者或已指定的统计负责人做一次；PM 和工程师沿正常交付保存回执，不重复写成本报告、读取其他任务历史或重跑验收。

派送身份与时间优先取明确任务/turn内的原生工具回执，输出中未提供的字段保持未知。不要要求总经理为了采样额外生成派工报告、复制完整委托或增加一个模型轮；统计方自己的报告和维护消耗单列。

使用派工回执和运行记录中的实际 task/turn 身份。显式 manifest 必须为 `schemaVersion: 1`，包含 `id` 和非空 `actors`；每个 actor 为：

```json
{
  "threadId": "actual-thread-id",
  "turnIds": ["actual-turn-id"],
  "rolloutPath": "/absolute/authorized/rollout.jsonl",
  "role": "PM",
  "project": "registered-project",
  "phase": "implementation-and-acceptance",
  "kind": "product"
}
```

`rolloutPath` 来自已核实的本地会话元数据，不能靠扫描 HOME、跨项目历史或修改 Codex 数据库获取。Windows 使用实际绝对路径。manifest 和原始报告保留在本地，不提交到 Git；对外报告只保留汇总数字和公开实现证据。

```text
node <runtime.cli> cost-report --manifest <absolute-manifest.json> --output <new-absolute-report.json>
node <runtime.cli> cost-diff --baseline <absolute-before.json> --current <absolute-after.json> --output <new-absolute-diff.json>
```

输出文件不可覆盖。统计优先使用 `token_usage_record`，按 response ID 去重并与 turn 总量核对；旧日志降级为 legacy 计数并保留诊断。未终止、缺失或不一致的数据只能报告部分观测。缓存是输入子集，推理是输出子集；不额外相加，不换算订阅美元或余额。

分别标记一次性框架建设、调查、总经理选题/交接、产品开发与返工。一个 turn 同时做实施、检索和验收时保留组合阶段；工具回执字符数不是 token，工具包装器计数不代表内部全部工具次数。不要凭阶段名字估算精确工具 token 或把它称为模型计算时间。当前报告者自身尚未结束，报告必须注明截点。

相同任务、基线、模型、知识条件和验收口径的成组实验才能讨论路线优势。单次真实任务可以定位观测成本与长上下文重复输入，不能从不同任务的快照差异推导 LangGraph 节省百分比。

需要定位阶段耗时时，由统计负责人按需读取指定 run 的既有记录：

```text
node <runtime.cli> trace-report --project <original-project-config> --run <run-id> --output <new-absolute-trace.json>
```

可选 `--cost-report <existing-absolute-cost-report.json>` 附加原 manifest 的 turn 区间，不自动绑定到该 run，也不重新核实原会话日志。跨任务时钟未经核实，合并墙钟与并发数保持未知。控制器的 RUNNING 包含执行和等待，不能称为纯编码耗时；验收命令时间只来自哈希绑定的最后回执。未结束区间、暂停时长、真实工程师开工时间和关键路径不猜测。此命令只读、不派工、不重跑验收、不调用模型；不加入每轮固定汇报流程。

新运行的 `taskTiming` 按 task/attempt 展示既有流程中的任务包下发、派送应答、首次观察到新 turn、有效结果接收等边界。Desktop 开工观察只复用正常 collect，不要求工程师另发开工消息；原轮询未观察到则保持未知。应答成功不等于开始编码，观察区间包含工具和等待；只有线程及 turn 一致才关联观察与结果。旧事件缺 attempt 不回填，返修分开显示，不把并行区间相加当作总耗时。
