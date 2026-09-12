## Reuse Decision

Decision: Borrow

### Evidence
- Project search (tool-backed anchors): `src/workflow.mjs` 的 requireRun、taskArtifacts、getPacket、readReceipt、delivery 与 advance；`src/cli.mjs` 已支持一次 continue 保存 delivery；`src/knowledge.mjs` 的 search 只限制正文长度，source 元数据另行返回。基线 `9b17bbf22d1d827c063979a10f61449038c8eb63`。
- GitHub / official search (tool-backed anchors): 核对 1 个现有运行时候选 Node.js，不引入包；[Node 24 文件操作](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-system-flags) 的 wx 保证目标已存在时拒绝创建。
- License: 用户授权修改本私有项目；未复制第三方源码。[Node v24.0.0 LICENSE](https://github.com/nodejs/node/blob/v24.0.0/LICENSE) 核对了 Node 原生代码的 MIT 授权及第三方许可证说明。
- Maintenance: 沿用项目已用 Node 24、SQLite 和 LangGraph 依赖，依赖清单不变。
- Compatibility (contract comparison): 保留原 CLI 默认返回与旧手写回执；新增 submit 填充既有结果字段，继续由原收集/验收路径处理。compact 为显式展示选项，原完整记录和知识 hash 不改变。
- Verification (commands/tests and observed result): 实施前已读现有 delivery、project-binding 与 workflow 测试；新增定点测试及全套结果在实施报告记录，未提前声明通过。

### Rationale
复用既有身份、路径、产物哈希、检索和验收机制，避免新增状态机。派工明确性通过现有 handoff 规则落实，不增加报告表、角色或批准轮。机器生成的是完成申报与文件事实，不替代真实自测记录或正式验收。

### Next step
增加有身份和 attempt 约束的结果提交入口；增加保存完整结果后的受预算限制展示；更新派工与使用规则并验证现有失败边界。
