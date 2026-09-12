# 有界成本观察

用户要求成本评测时使用现有 CLI 的 `cost-report` 和 `cost-diff`。采集由维护者或已指定的统计负责人做一次；PM 和工程师沿正常交付保存回执，不重复写成本报告、读取其他任务历史或重跑验收。

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
