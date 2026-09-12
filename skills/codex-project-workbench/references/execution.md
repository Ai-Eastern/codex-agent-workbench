# PM 正常执行

`<node>`、`<cli>` 取自 runtime.json；`<project>` 取本次明确配置，否则取项目 AGENTS.md 的登记路径。PowerShell 使用 `& '<node>' '<cli>' ...`；不直接运行占位符。指定配置缺失报 CONFIG_PENDING，不猜上层入口。

## 选定一种路线

| mode | 适用工作与执行者 | 开始前补读 |
|---|---|---|
| direct | 一项有界工作，由当前 PM 完成 | [worker.md](worker.md)，PM 此时也承担实现和交付 |
| native | 独立、短期的子任务，由真实 Codex 子智能体完成 | [native.md](native.md) |
| langgraph | 需要桌面接续、依赖或多阶段恢复，使用登记工程师任务 | [desktop.md](desktop.md) |

三种路线共用知识包、文件归属和验收标准。工程师登记数量是容量上限，按独立写集与依赖选 0–3 人。模型与档位取明确配置；当前工程师支持 Spark/low、5.5/low、Luna low/medium，已验证范围见仓库记录。若用户仅授权额度不足才换模型，上下文溢出、工具不支持或代码失败均不构成切换理由。原生工具能力在冻结合同前核对。

## 同一轮推进

1. 开发前 `search --project <project> --query <需求关键词>`，核对当前项目经验及适用条件；无命中就如实记录，不从聊天记忆编造事实。新任务用 `task.knowledge:{query,ids,limit,maxChars}` 限定相关来源与正文预算；空 ids 明确不检索，默认 BM25，详细策略才读 [knowledge.md](knowledge.md)。知识在 prepare 冻结，不回写旧包。
   前置检索确认相关知识后，把 IDs 写入该任务合同，避免 prepare 再泛搜。必要规则和关键证据不能为了减少字数而丢弃。
2. PM 一次明确目标、接口、独占文件、依赖与 checks。请求含 `projectId`、稳定 `id`、`objective`、`mode`、`reason`、`constraints`、`tasks`、`checks`。tasks 为 `{id,objective,files,dependsOn,constraints?}`，局部 constraints 写清提供/引用的接口及不属于本模块的实现；固定文案/枚举使用引号或 JSON 常量。files 相对 workRoot；checks 为 `{id,command,args,timeoutMs}`，使用 argv，不嵌套 shell。新请求 projectId 与明确配置精确匹配；旧合同无此字段则不追写改哈希。
3. `prepare --project <project> --request <request.json>` 保存计划、预留写集，返回 PREPARED，不派工。目标明确且已获执行授权时同轮 `start --project <project> --run <runId>`；LangGraph 先完成 desktop 预检。原 id 不换需求，不为绕过失败建新合同。
4. 依据 nextAction 执行。EXECUTE_DIRECT 由 actorThreadId 指向的当前 PM 在本轮实现、必要自测、写 receipt 并 continue；ASSIGNED 不代表后台有人开发。CLAIM_NATIVE/BIND_NATIVE 按 native 入口。只有 WAIT_FOR_WORKERS 才有界等待已派任务。
   新任务包提供 resultTool 时，使用 `submit --project <project> --run <runId> --task <taskId> --attempt <本次 attemptId> --summary <实际完成内容>` 自动生成回执；不要另跑哈希命令再抄写长 JSON。可选 `--status blocked` 与 `--candidate <知识候选.json>`。attempt 来自当前包，用于拒绝过期提交；身份、独占写集和文件哈希由工具核对。SUBMITTED 只代表回执写入，继续沿原 run 正式验收。
5. direct/native 交付完成、或 LangGraph 实际任务结束后，沿原 runId `continue`。控制器执行一次集成验收；REPORT_ACCEPTANCE 引用已核验的 acceptance 和 delivery，不另跑相同 checks。保存事实包附 `--output <新的绝对路径.json>`；历史完成运行可 `delivery --project <project> --run <runId>` 复用证据。无需为汇报再读 handoff 全文。

`status --project <project> [--run <runId>]` 只查询。`pause --project <project> --run <runId>` 停止后续派工；授权持续工作下的 continue 不增加逐轮人工审批。FAILED/BLOCKED/RESERVED、证据变化或知识保存待处理按 [recovery.md](recovery.md)，不在正常入口猜修复方法。

返回 `continueGate` 时，按 signals 核对既有事件、失败检查和条件变化；重复次数是诊断提醒，不证明根因相同。`advisoryOnly` 不改变 nextAction、暂停或恢复授权，不重置返修预算。已有解除条件与授权满足时按原入口接续，不为提示另开审核、汇报或模型判断轮。未返回该字段也不证明工作高效；内部步骤、Token 剩余额度及无效返工比例未采集，不能猜测。

知识候选随既有工程交付提交，captureEnabled 授予本项目捕获时统一验收后保存；没有该权限只留候选，不重复问保存同一记录。知识保存失败不重做工程验收。新阶段、实际需求变化或 COMPLETE 后已授权的产物变更才新建合同；未完成的失败仍沿原 run 恢复，不能以改文件为由清空失败预算。已变产物不能继续使用旧通过结论。

保存证据直接保存 CLI JSON 文本，不经 PowerShell 多层重新序列化。派工已调用而包装器保存失败时，只读 status/事件并保留保存错误，不能为得到整齐输出重跑 start/continue。

search/start/packet/claim 等较长结果优先加 `--view compact`，默认总展示预算 12,000 字符，可用 `--max-output-chars` 调整。CLI 自动将完整结果保存在 controlRoot/views，并返回路径与哈希；展示预算包含元数据。执行提示保留完整合同，RAG 保留选中的正文和来源引用，完整 source 链在详情中。`needsRead:true` 表示预算内无法完整展示，先读取已保存详情再行动；不要重跑 start/continue 取全文。较短的 status/continue/delivery 通常保留默认输出，避免仅为详情引用增加字数；它们同样支持 compact。`--output` 仍用于保存正式 delivery。摘要保存异常返回 doNotRetry，保留原动作与证据，按原状态处理。

新验收脚本可在写出前调用 `src/check-context.mjs` 的 `requireCheckContext({expectedWorkRoot,expectedOutputRoot})` 核对 cwd 与输出目录，使用返回的 outputRoot。此为误调用保护，不能代替 OS 读取隔离。
