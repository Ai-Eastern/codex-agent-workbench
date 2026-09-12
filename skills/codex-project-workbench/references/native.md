# PM：原生子 Agent 路线

native 只用于独立、短期且写集可分离的子任务。冻结合同前核对配置模型和工具能力；不因工具不支持、上下文或代码失败暗换模型，改路线必须在冻结前完成。

`begin` 返回 `CREATE_NATIVE` 后，PM 对每个已 claim 包直接调用 `collaboration.spawn_agent` 一次：`model=包内model`、`reasoning_effort=包内thinking`（旧包缺省 low）、`fork_turns=none`、`message=完整prompt`，保存工具真实返回的子 Agent ID。已有 PREPARED 状态用 start，再逐任务 claim 的旧流程仍保留；仅成功的新 claim 才允许创建一次。没有创建回执不能称已派工，也不能用桌面 create_thread 或 shell 代替。

随后用 `bind` 绑定真实子任务 UUID；短任务可创建后立即逐条绑定，全部身份齐备时也可用 execution.md 的 `--bindings` 原子批量绑定，不为凑批次拖延绑定。若只得到协调名称，让该子任务报告实际 `CODEX_THREAD_ID`，不猜 UUID；创建回执缺失时保留未绑定状态，不再次创建。PM 等待实际完成后核对文件、attempt、必要自测和集成证据，再沿原 run `continue` 一次。native 叶子用自己的 attempt `submit`，不能调用 PM 专用 `finish`。
