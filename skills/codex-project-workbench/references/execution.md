# 执行入口

以下 `<node>`、`<cli>`、`<project>` 均取自安装后的 runtime.json 与项目 AGENTS.md。PowerShell 使用 `& '<node>' '<cli>' ...`。不复制尖括号占位符直接运行。

1. 检索：`search --project <project> --query <需求关键词>`。只读相关正文；找不到就如实记录，不由聊天记忆编造事实。
2. 请求 JSON 包含 `id`（本次逻辑任务稳定名称）、`objective`、`mode`、`reason`、`constraints`、`tasks` 和 `checks`。tasks 每项为 `{id,objective,files,dependsOn}`；files 相对 workRoot；checks 每项为 `{id,command,args,timeoutMs}`，由 PM 在派单前确定。命令使用 argv，不嵌套拼接 shell。
3. `prepare --project <project> --request <request.json>`。返回 PREPARED 与 runId；到这里不会派工。原 id 不能换需求；禁止为绕过失败修改 id。
4. 明确执行后 `start --project <project> --run <runId>`。
5. direct：返回包在 PM 当前任务内完成。native：准备请求前核对原生工具是否支持配置模型，能力不支持时不能暗换模型或伪装已派工；重新选择可用路线必须发生在冻结合同前。先对每个包调用 `claim --project <project> --run <runId> --task <taskId>`，成功领取后才直接调用 `collaboration.spawn_agent`，每包一次，`model` 取任务包的真实模型、`reasoning_effort=low`、`fork_turns=none`，message 为领取包内 prompt；先派齐独立任务，保存实际工具返回的子 Agent ID。随后 `bind --project <project> --run <runId> --task <taskId> --thread <真实子任务UUID>`。若工具只返回协调名称，让该子任务报告真实 CODEX_THREAD_ID，再绑定，不能猜 UUID。领取后缺少创建回执时保留未绑定状态，不再次创建。没有实际创建回执不能称已派工；不以桌面 create_thread 或 shell 代替原生子智能体。用户要求不同模型时先更新明确配置，不暗中回退。
6. langgraph：控制器向登记的现有工程师任务派工，PM 不重复发送。需要后续轮次时用一个有界 wait 等待变化，再调用原 runId 的 continue；不高频轮询无变化状态。App 控制器只接受真实 PM 任务身份和当前 app pipe。
7. 工程师写结果 receipt 后，PM 对 direct/native 调用 `continue`，对 LangGraph 等实际任务结束后调用 `continue`。控制器执行集成检查并给出 COMPLETE / FAILED / BLOCKED / COMPLETE_CAPTURE_PENDING。COMPLETE 后相同产物的重入不再执行验收。

`status --project <project> [--run <runId>]` 只查询。`pause --project <project> --run <runId>` 停止后续调度。continue 是用户已授权持续工作时的正常接续，不构成每轮人工审批。

本版本 native 创建身份以 Codex 工具实际返回记录为准，控制器验证文件结果、attempt 身份和集成命令；不把一个 receipt 文件当作工具创建子 Agent 的独立证明。

## 有界验收恢复

临时外部条件已解除、全部工程师交付结束且产物未变时，维护者可在已有修复授权内调用 `retry-acceptance --project <project> --run <runId> --acceptance-hash <原失败验收文件SHA256> --reason <诊断与解除条件>`。入口归档原失败、保留此前通过的检查，转回 ACCEPTING；随后沿原 runId continue，只接续失败及剩余检查。它不会自动派工、改产物、换模型或重置失败预算。

此入口不适用于代码已变、验收命令副作用未查清、执行结果未知、工程师仍运行或 BLOCKED。此前通过的检查仍适用须由诊断确认；不能把一次失败自动解释为临时故障后反复调用。

## 同一任务返修

代码必须改变时，先在原产物仍与失败证据一致的状态调用 `repair-task --project <project> --run <runId> --task <taskId> --acceptance-hash <失败验收SHA256> --reason <明确缺陷与修复范围>`。控制器归档旧验收、任务包、工程师回执，保留原 run、合同和文件归属，生成新 attempt；随后原 PM start/continue 派发这次明确返修。不要先改代码再绕过哈希保护。

本入口仅支持单任务 direct/langgraph，且每个 run 只有一次明确返修预算；不适用于 native、多任务依赖、BLOCKED、未知或超时命令结果、已 COMPLETE 的工作。改变产物后此前验收不再适用，全部原定检查重新执行；这与临时条件解除时保留有效的已通过检查不同。再失败就保留事实，不自动循环，不换 ID 清空预算。
