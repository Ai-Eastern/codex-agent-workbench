# Guidance 规则按需加载：复用决定

本轮优化 Codex 编排框架的规则装载，不启动恋语新功能。决定为 **Borrow**：借鉴 Ruflo 的常驻核心规则与按任务选择规则片段，使用 Workbench 已知的角色、执行路线和控制器状态确定入口。

## 依据

- 上游固定版本：[`retriever.ts`](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/v3/@claude-flow/guidance/src/retriever.ts)，commit `39e0b0540c9b018174955fc8a21f355bbac26c6a`。保留 constitution，再选择与任务有关的 shards。
- 该版本默认 HashEmbeddingProvider 为测试用途，英文意图分类不能直接承担中文权限与流程路由；包仍有 hooks、memory、shared 的 alpha 依赖。不引入整包、向量服务或新的调度层。
- 上游 MIT 声明已保存在 [third_party/ruflo-cost-LICENSE.txt](../third_party/ruflo-cost-LICENSE.txt)。本轮借鉴设计方式，不移植 TypeScript 实现。
- 现有 Skill 已有五个 reference，但常驻入口仍包含大量 PM 恢复细节，execution 又把三种路线和所有异常恢复放在一起。沿用 Markdown 入口足以减少不相关读取。

## 适配边界

公共层保留用户授权、暂停、项目/身份/写集、检索不可信、失败与未知送达不得绕过、证据等级。工程师只追加 worker；PM 正常开发追加 execution 及所选路线；恢复状态才追加 recovery。跨项目统一放行归入已有 handoff。知识和成本专题按明确需要读取。

选路采用显式角色、mode、nextAction/status，不用中文关键词猜测，不用 RAG 命中决定权限。更高层用户与项目明确要求继续有效。未知状态只查询摘要，不猜恢复操作。

不改控制器、任务包、模型配置、现有 run、失败预算或 RAG 排名。原有工程师提示词保持不变。新的 Skill 只影响随后读取的规则，不会移除已进入聊天的历史。

## 验证与采用标准

保存修改前规则快照；逐角色比较去重后的实际文件字符数，明确计入工程师未改变的派工提示词，不把字符数叫作模型 token。检查链接、安装副本与关键约束归属；以 Luna/medium 新子任务进行工程师和 PM 规则选择场景验证，记录实际读取路径和回答。

只有正常角色读取减少且约束审查、场景验证无缺口，才更新安装副本。结果只证明规则材料和一次行为样本；不据此宣称整体开发提速、token 固定下降或约束已成为工具硬隔离。后续真实开发复用原有成本采集，不为每次开发新增规则汇报轮。
