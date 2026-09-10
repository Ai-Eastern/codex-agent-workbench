# 执行入口

以下 `<node>`、`<cli>`、`<project>` 均取自安装后的 runtime.json 与项目 AGENTS.md。PowerShell 使用 `& '<node>' '<cli>' ...`。不复制尖括号占位符直接运行。

1. 检索：`search --project <project> --query <需求关键词>`。只读相关正文；找不到就如实记录，不由聊天记忆编造事实。
2. 请求 JSON 包含 `id`（本次逻辑任务稳定名称）、`objective`、`mode`、`reason`、`constraints`、`tasks` 和 `checks`。tasks 每项为 `{id,objective,files,dependsOn}`；files 相对 workRoot；checks 每项为 `{id,command,args,timeoutMs}`，由 PM 在派单前确定。命令使用 argv，不嵌套拼接 shell。
3. `prepare --project <project> --request <request.json>`。返回 PREPARED 与 runId；到这里不会派工。原 id 不能换需求；禁止为绕过失败修改 id。
4. 明确执行后 `start --project <project> --run <runId>`。
5. direct：返回包在 PM 当前任务内完成。native：先对每个包调用 `claim --project <project> --run <runId> --task <taskId>`，成功领取后才直接调用 `collaboration.spawn_agent`，每包一次，使用工具实际支持的 `model=gpt-5.5`、`reasoning_effort=low`、`fork_turns=none`，message 为领取包内 prompt；先派齐独立任务，保存实际工具返回的子 Agent ID。随后 `bind --project <project> --run <runId> --task <taskId> --thread <真实子任务UUID>`。若工具只返回协调名称，让该子任务报告真实 CODEX_THREAD_ID，再绑定，不能猜 UUID。领取后缺少创建回执时保留未绑定状态，不再次创建。没有实际创建回执不能称已派工；不以桌面 create_thread 或 shell 代替原生子智能体。用户要求不同模型时先更新明确配置，不暗中回退。
6. langgraph：控制器向登记的现有工程师任务派工，PM 不重复发送。需要后续轮次时用一个有界 wait 等待变化，再调用原 runId 的 continue；不高频轮询无变化状态。App 控制器只接受真实 PM 任务身份和当前 app pipe。
7. 工程师写结果 receipt 后，PM 对 direct/native 调用 `continue`，对 LangGraph 等实际任务结束后调用 `continue`。控制器执行集成检查并给出 COMPLETE / FAILED / BLOCKED / COMPLETE_CAPTURE_PENDING。COMPLETE 后相同产物的重入不再执行验收。

`status --project <project> [--run <runId>]` 只查询。`pause --project <project> --run <runId>` 停止后续调度。continue 是用户已授权持续工作时的正常接续，不构成每轮人工审批。

本版本 native 创建身份以 Codex 工具实际返回记录为准，控制器验证文件结果、attempt 身份和集成命令；不把一个 receipt 文件当作工具创建子 Agent 的独立证明。
