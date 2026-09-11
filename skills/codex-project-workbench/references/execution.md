# 执行入口

以下 `<node>`、`<cli>` 取自安装后的 runtime.json；`<project>` 优先取本次明确委托的配置，否则使用项目 AGENTS.md 的登记路径。指定文件缺失时报 CONFIG_PENDING，不猜测上层入口。PowerShell 使用 `& '<node>' '<cli>' ...`。不复制尖括号占位符直接运行。

1. 检索：`search --project <project> --query <需求关键词>`。只读相关正文；找不到就如实记录，不由聊天记忆编造事实。
2. 新请求 JSON 包含 `projectId`（与明确配置精确一致）、`id`（本次逻辑任务稳定名称）、`objective`、`mode`、`reason`、`constraints`、`tasks` 和 `checks`。tasks 每项为 `{id,objective,files,dependsOn,constraints?}`，局部 constraints 明确模块与接口；files 相对 workRoot；checks 每项为 `{id,command,args,timeoutMs}`，由 PM 在派单前确定。命令使用 argv，不嵌套拼接 shell。旧合同没有 projectId 时保持原样，不追写字段改变其哈希；硬匹配保护只对带该字段的请求生效。
3. `prepare --project <project> --request <request.json>`。返回 PREPARED 与 runId；到这里不会派工。原 id 不能换需求；禁止为绕过失败修改 id。
4. 明确执行后 `start --project <project> --run <runId>`。
5. direct：返回包在 PM 当前任务内完成。native：准备请求前核对原生工具是否支持配置模型，能力不支持时不能暗换模型或伪装已派工；重新选择可用路线必须发生在冻结合同前。先对每个包调用 `claim --project <project> --run <runId> --task <taskId>`，成功领取后才直接调用 `collaboration.spawn_agent`，每包一次，`model` 取任务包的真实模型、`reasoning_effort=low`、`fork_turns=none`，message 为领取包内 prompt；先派齐独立任务，保存实际工具返回的子 Agent ID。随后 `bind --project <project> --run <runId> --task <taskId> --thread <真实子任务UUID>`。若工具只返回协调名称，让该子任务报告真实 CODEX_THREAD_ID，再绑定，不能猜 UUID。领取后缺少创建回执时保留未绑定状态，不再次创建。没有实际创建回执不能称已派工；不以桌面 create_thread 或 shell 代替原生子智能体。用户要求不同模型时先更新明确配置，不暗中回退。
6. langgraph：控制器向登记的现有工程师任务派工，PM 不重复发送。需要后续轮次时用一个有界 wait 等待变化，再调用原 runId 的 continue；不高频轮询无变化状态。App 控制器只接受真实 PM 任务身份和当前 app pipe。
7. 工程师写结果 receipt 后，PM 对 direct/native 调用 `continue`，对 LangGraph 等实际任务结束后调用 `continue`。控制器执行集成检查并给出 COMPLETE / FAILED / BLOCKED / COMPLETE_CAPTURE_PENDING。COMPLETE 后相同产物的重入不再执行验收。

`status --project <project> [--run <runId>]` 只查询。`pause --project <project> --run <runId>` 停止后续调度。continue 是用户已授权持续工作时的正常接续，不构成每轮人工审批。

本版本 native 创建身份以 Codex 工具实际返回记录为准，控制器验证文件结果、attempt 身份和集成命令；不把一个 receipt 文件当作工具创建子 Agent 的独立证明。

## 状态与验收汇报

start、continue、status 均返回 `nextAction:{type,actorThreadId,taskIds}`。EXECUTE_DIRECT 表示当前 PM 立即完成包内工作，不等待另一执行者；CLAIM_NATIVE/BIND_NATIVE 按上述原生步骤处理；WAIT_FOR_WORKERS 才使用有界等待。REPORT_ACCEPTANCE 读取返回的 `acceptance:{verified,passed,checks,path,hash}` 汇报，不再手工运行 checks。RECONCILE_EVIDENCE 表示已验收文件或证据发生变化，不能继续使用旧通过结论。

新编写的验收脚本可调用仓库 `src/check-context.mjs` 的 `requireCheckContext({expectedWorkRoot,expectedOutputRoot})`，在任何输出写入之前核对控制器上下文和 cwd，并把输出写入返回的 outputRoot。控制器为每项检查提供唯一运行目录下的输出路径。此为误调用保护，不能限制任意 shell 命令，也不能代替 OS 读取隔离。

## 只修知识候选

控制器在收集 receipt 时校验候选并记录 knowledgeIssues；格式错误不会抹掉工程交付。工程验收通过且状态为 COMPLETE_CAPTURE_PENDING 后，在已有修复授权内使用 `repair-knowledge --project <project> --run <runId> --task <taskId> --acceptance-hash <status.acceptance.hash> --candidate-hash <status.knowledgeCandidates中该任务hash> --candidate <单个候选JSON文件> --reason <纠正原因>`。候选仅含 id/title/body/kind 与可选 expectedHash，source 由控制器绑定。

入口核对原 receipt 字节哈希、已验收代码、候选版本和锁，另存修正记录，不覆盖原 receipt、验收或代码。返回 CONTINUE_CAPTURE 后沿原 runId continue，只保存知识。旧版本未记录 receipt 字节哈希的运行不能直接使用此入口，保留旧证据另行诊断；不得手改状态库或补造历史哈希。

## 有界验收恢复

临时外部条件已解除、全部工程师交付结束且产物未变时，维护者可在已有修复授权内调用 `retry-acceptance --project <project> --run <runId> --acceptance-hash <原失败验收文件SHA256> --reason <诊断与解除条件>`。入口归档原失败、保留此前通过的检查，转回 ACCEPTING；随后沿原 runId continue，只接续失败及剩余检查。它不会自动派工、改产物、换模型或重置失败预算。

此入口不适用于代码已变、验收命令副作用未查清、执行结果未知、工程师仍运行或 BLOCKED。此前通过的检查仍适用须由诊断确认；不能把一次失败自动解释为临时故障后反复调用。

## 同一任务返修

代码必须改变时，先在原产物仍与失败证据一致的状态调用 `repair-task --project <project> --run <runId> --task <taskId> --acceptance-hash <失败验收SHA256> --reason <明确缺陷与修复范围>`。控制器归档旧验收、任务包、工程师回执，保留原 run、合同和文件归属，生成新 attempt；随后原 PM start/continue 派发这次明确返修。不要先改代码再绕过哈希保护。

本入口仅支持单任务 direct/langgraph，且每个 run 只有一次明确返修预算；不适用于 native、多任务依赖、BLOCKED、未知或超时命令结果、已 COMPLETE 的工作。改变产物后此前验收不再适用，全部原定检查重新执行；这与临时条件解除时保留有效的已通过检查不同。再失败就保留事实，不自动循环，不换 ID 清空预算。
