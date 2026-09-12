# Ruflo 与当前 Codex 工作流的适配评估

日期：2026-09-12。用户指定项目的独立子 Agent 只读调研，随后核对关键源码。基线 commit：`9576a1032b0749ac12d08fd9d05b86d4bee893b5`。未安装、运行、连接 MCP 或引入 Ruflo 代码。

结论：值得借鉴任务状态、知识归属和成本追踪的设计；当前继续使用已接通桌面的 Workbench。Ruflo 的 Codex 配置与 MCP 支持，不能直接证明它会把我们的 PM／工程师任务按原样接入 Codex Desktop 项目侧栏。

| 核对点 | 实际证据 | 对当前项目的意义 |
|---|---|---|
| Codex 适配 | 有配置/Skill/agent 生成、迁移、初始化、worktree 和 loop 等真实导出 | 可参考适配层组织方式；未验证桌面可见任务生命周期 |
| 层级并行 | swarm 文档描述多种拓扑和 specialized agents | 角色拓扑可配置，但人数本身不证明效率 |
| 重复注册 | 加入 swarm 列表前检查 agentId 是否已有 | 成员去重有实现，不等于整个任务 exactly-once |
| 停止与收束 | execute 前资格检查；terminate 时合并或丢弃记忆分支 | 可借鉴明确停止条件和结果提交边界 |
| RAG | 文档描述 AgentDB、向量检索及重排 | 需要在现有 BM25 召回确有不足时再比较，不急于替换 Obsidian Markdown |
| 成本与观测 | 插件文档描述 agent/task/model 归因及追踪 | 设计有参考价值；本次未核实完整 token 落库调用链 |

Codex 导出与初始化代码见 [Codex index](https://github.com/ruvnet/ruflo/blob/9576a1032b0749ac12d08fd9d05b86d4bee893b5/v3/@claude-flow/codex/src/index.ts)。成员去重见 [agent_spawn](https://github.com/ruvnet/ruflo/blob/9576a1032b0749ac12d08fd9d05b86d4bee893b5/v3/@claude-flow/cli/src/mcp-tools/agent-tools.ts#L390-L399)，资格检查与记忆收束见 [execute/terminate](https://github.com/ruvnet/ruflo/blob/9576a1032b0749ac12d08fd9d05b86d4bee893b5/v3/@claude-flow/cli/src/mcp-tools/agent-tools.ts#L492-L563)。

模型路由类型包含 anthropic/openrouter/ollama，显式非别名模型名会保留，不能概括成只支持 Claude；本次没有运行 Astra/Sol/Luna 兼容测试。[模型路由](https://github.com/ruvnet/ruflo/blob/9576a1032b0749ac12d08fd9d05b86d4bee893b5/v3/@claude-flow/cli/src/mcp-tools/agent-tools.ts#L173-L205)

拓扑、RAG 与成本表述的证据级别为项目文档：[swarm](https://github.com/ruvnet/ruflo/blob/9576a1032b0749ac12d08fd9d05b86d4bee893b5/plugins/ruflo-swarm/README.md)、[RAG memory](https://github.com/ruvnet/ruflo/blob/9576a1032b0749ac12d08fd9d05b86d4bee893b5/plugins/ruflo-rag-memory/README.md)、[cost tracker](https://github.com/ruvnet/ruflo/blob/9576a1032b0749ac12d08fd9d05b86d4bee893b5/plugins/ruflo-cost-tracker/README.md)。上游性能或节省数字未当作我们的实测结果。

根项目采用 [MIT License](https://github.com/ruvnet/ruflo/blob/9576a1032b0749ac12d08fd9d05b86d4bee893b5/LICENSE)，后续如摘取代码仍须保留许可声明，并核对实际依赖。建议先复用有明确缺口的小组件；只有具体组件能在同任务下减少交接、返工或消耗时，再考虑接入。
