# 能力与证据对照

主入口是 npm start 的实际任务工作台，CLI 入口是 npm run agent。下表区分源码机制、自动检查和真实调用；最新运行结果见 [验证记录](verification-20260921.md)。

## 新增本地执行路径

| 能力 | 源码与测试 | 支持的结论及边界 |
|---|---|---|
| 真实 Codex CLI | [执行器](../src/codex-executor.mjs)、[执行器测试](../test/codex-executor.test.mjs) | 采用 exec / JSONL / workspace-write / ephemeral，提示词经 stdin；显式指定才覆盖模型。退出码、完成事件与日志完整性共同决定执行结果。假进程测试之外，已有一次真实小任务链路记录。 |
| 执行记录与预算 | 同上 | 保留原始事件与 stderr；处理坏日志、输出上限、超时、Abort、启动失败与本次进程树终止。日志可能包含源码，不自动等于可公开资料。 |
| Git 工作区与补丁 | [工作区](../src/git-workspace.mjs)、[测试](../test/git-workspace.test.mjs) | 确定提交创建 detached worktree；使用临时 index 检查和导出二进制补丁；测试覆盖脏源码工作区与真实 index 保留。未提交内容不复制到新 worktree。 |
| 写集与 HEAD | 同上；[本地任务测试](../test/local-runner.test.mjs) | 检查精确写集、候选 HEAD 与原仓库 HEAD。忽略的非白名单缓存排除在补丁检查外；任务期间原工作区未提交内容尚未全量监测。 |
| 固定验收文件 | [本地控制器](../src/local-runner.mjs)、[测试](../test/local-runner.test.mjs) | 取得指定验收文件哈希，验收边界再次检查；变化阻止交付。这是变化检测，不是隐藏测试不可读或不可改保证。 |
| 独立命令验收 | [验收进程](../src/local-check.mjs)、[工作进程](../src/acceptance-worker.mjs)、[测试](../test/local-check.test.mjs) | 控制器在编码后运行预定 argv，记录退出码、输出与耗时，支持取消和时限。它仍使用本机环境，不是容器或 OS 沙箱；本地通过不等于人工验收。 |
| 交付绑定 | [本地控制器](../src/local-runner.mjs)、[交付测试](../test/delivery.test.mjs) | 验收通过才导出 candidate.patch，记录 SHA-256；读取就绪任务复核产物、patch 和 HEAD。EVIDENCE_CHANGED 表示旧结论需重新检查，不自动覆盖历史。 |
| 重复调用与接续 | [本地控制器](../src/local-runner.mjs)、[测试](../test/local-runner.test.mjs) | 同一 ID 绑定同一合同与仓库，重复调用复用状态；continue 仅接续已完成编码后的验收阶段。中断编码不自动重启，残留锁不自动删除。 |
| 明确修复一次 | [工作流](../src/workflow.mjs)、[本地任务测试](../test/local-runner.test.mjs)、[恢复测试](../test/recovery.test.mjs) | 验收失败后记录原因，核对失败证据，为新 attempt 使用独立回执并保留原失败；预算受控制器约束。 |
| 浏览器工作台 | [服务](../src/app-server.mjs)、[前端](../app/)、[API 测试](../test/app-server.test.mjs) | 可提交、查询、停止、按原因修复以及查看/下载 diff；哈希核验后提供验收命令完整 stdout / stderr。API 与浏览器回归采用注入执行器，实际运行 Git 和命令验收，不能冒充真实模型 UI 样本。 |
| 本机请求边界 | [服务](../src/app-server.mjs)、[API 测试](../test/app-server.test.mjs) | 监听 127.0.0.1，检查 Host，POST 检查 token 与 Origin；不是多用户账户体系。事件 API 展示近期记录，完整保留日志在状态目录。 |
| 指定项目知识 | [本地控制器](../src/local-runner.mjs)、[知识实现](../src/knowledge.mjs)、[范围测试](../test/knowledge-scope.test.mjs) | 复制明确选中的 Markdown，按任务目标检索并冻结内容/哈希。新本地路径关闭自动 capture；检索命中不保证内容正确。 |

## 一次真实调用与自动检查分别证明什么

真实小任务把 normalizeLabels 从直接返回输入改为 trim、过滤空串、稳定去重；两条固定 Node 测试通过，得到补丁，原仓库实现与 Git 状态保持不变。它覆盖了 **真实 CLI → 实际改码 → 独立命令验收 → patch**，不代表 60 项任务、180 次运行或固定收益。

自动检查覆盖更多故障和边界，编码步骤主要使用独立假进程或注入执行器。两类证据互补，不能把自动检查数量计入真实模型样本数。真实调用沿用本机配置，未观测服务端实际模型标识。

## 保留的既有能力

| 既有模块 | 证据入口 | 与新入口的关系 |
|---|---|---|
| direct / native / LangGraph Desktop 分流 | [合同](../src/contracts.mjs)、[工作流](../src/workflow.mjs)、[Desktop 指南](desktop-guide.md) | 新本地任务固定采用单执行者 direct；网页未开放 Desktop 多角色调度。 |
| 中文知识检索、来源失效与验收后 capture | [知识实现](../src/knowledge.mjs)、[知识测试](../test/knowledge.test.mjs)、[交付测试](../test/delivery.test.mjs) | 复用检索与来源机制；本地路径目前不自动回写。没有 embedding 语义检索承诺。 |
| Desktop 送达对账与恢复 | [送达恢复测试](../test/dispatch-recovery.test.mjs)、[定点修复测试](../test/blocked-task-repair.test.mjs) | 具有身份与内部接口边界，不证明新 CLI 对所有外部副作用提供 exactly-once。 |
| 时间线与用量统计 | [链路](../src/trace-report.mjs)、[成本](../src/cost-report.mjs)、[用量](../src/usage.mjs) | 保留未知值与采集边界；Token 不等于账单，日志不自动证明提速。 |

## 尚未证明的主张

- 隐藏测试答案保密、对恶意 Agent 的完整隔离、额外 OS 安全沙箱。
- 端口租约、依赖环境自动配置、新网页的多 Agent 并行调度。
- 任务期间原工作区全部未提交内容漂移检测。
- 可供第三方重算的真实模型任务集、多轮成功率与耗时收益。简历中的样本、通过率与试用描述未与本仓库完整原始记录绑定，不能直接作为当前产品指标。
- 正式开源发布；目前原创代码仍保留所有权利。

历史 [功能对照](comparison-results.md)、[隔离调查](desktop-isolation-results-20260911.md) 与 [钩子实验](desktop-hooks-results-20260911.md) 保留各自失败与边界，不重写为当前版本通过证据。后续模型评测按 [协议](evaluation-protocol.md) 记录。

## Evidence Lab 与截图

[确定性机制入口](../scripts/evidence-lab.mjs) 使用公开固定补丁、零模型调用，运行真实控制器和命令验收。它适合检查失败、修复、复用与证据失效，不替代真实任务。

[工作台表单截图](assets/workbench.png) 来自实际 app 页面；[任务流程截图](assets/workbench-test-run.png) 来自真实 API、Git 和验收流程，**编码者为测试执行器，未调用模型**。旧 evidence-lab.png 只代表次级只读演示，不作为实际任务界面的证据。

返回 [README](../README.md)。
