# PM：原生子智能体路线

准备请求前核对原生工具支持配置模型，能力不支持时不能暗换模型或伪装已派工；重新选择可用路线必须发生在冻结合同前。模型与推理档位都取领取包的真实值。

对每包先 `claim --project <project> --run <runId> --task <taskId>`，成功后直接调用 `collaboration.spawn_agent` 一次：model=包内 model，reasoning_effort=包内 thinking（旧包缺少时 low），fork_turns=none，message=领取包内 prompt。先派齐独立任务，保存工具实际返回的子 Agent ID。

随后 `bind --project <project> --run <runId> --task <taskId> --thread <真实子任务UUID>`。若工具只返回协调名称，让该子任务报告实际 CODEX_THREAD_ID 后再绑定，不能猜 UUID。领取后缺少创建回执时保留未绑定状态，不再次创建。用户要求换模型先更新明确配置；不暗中回退。

没有实际创建回执不能称已派工，不以桌面 create_thread 或 shell 代替原生子智能体。控制器验证文件结果、attempt 和集成命令；一个 receipt 文件不是创建子 Agent 的独立证明。完成后按 execution 沿原 runId continue。
