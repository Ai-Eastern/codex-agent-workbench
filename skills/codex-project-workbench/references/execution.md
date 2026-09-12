# PM 执行与 CLI 生命周期

`<node>`、`<cli>` 从安装目录 `runtime.json` 取得；PowerShell 使用 `& '<node>' '<cli>' ...`，不运行占位符。配置缺失报 `CONFIG_PENDING`。

## 路线

`direct` 是当前 PM 完成的一项有界工作；`native` 是真实 Codex 子 Agent 执行的独立短任务；`langgraph` 用于需要桌面接续、依赖或多阶段恢复的登记工程师任务。direct 读 [worker.md](worker.md)，native 读 [native.md](native.md)，LangGraph 读 [desktop.md](desktop.md)。无依赖项目独立开工，不强制 portfolio barrier；显式同步批次仍按 [handoff.md](handoff.md)。

## 新入口

- `begin --project <cfg> --request <req.json> [--view compact]` 用于全新的 direct/native 请求，内部完成 `prepare` + `start`。请求包含 `projectId,id,objective,mode,reason,constraints,tasks,checks`；tasks 为 `{id,objective,files,dependsOn?,constraints?,knowledge?}`，files 是相对 workRoot 的完整独占写集，局部 constraints 明确接口与模块边界；checks 为 `{id,command,args,timeoutMs?}`，使用 argv。重复 begin 只返回已有状态并标 `reused:true`，不返回 packets，也不自动创建或恢复。
- native 整批 claim 成功时返回 `nextAction: CREATE_NATIVE` 及所有完整 prompt；PM 对每包真实调用 `collaboration.spawn_agent` 一次，禁止重建送达不明的派工。
- `bind --project <cfg> --run <id> --task <task> --thread <真实UUID>` 保留单条兼容形式；也支持仅使用 `--bindings '{"A":"真实UUID","B":"真实UUID"}'` 一次原子绑定。批量形式不能再带 `--task`/`--thread`；控制器校验 PM 身份、RUNNING 且未暂停，失败不得部分绑定。
- `finish --project <cfg> --run <id> --task <task> --attempt <attempt> --summary <text> [--candidate <path>] [--output <新delivery.json>]` 仅 direct PM 使用，自动 submit + advance；不能用于 native 叶子或 desktop，不能恢复暂停/失败，也不能覆盖既有回执。错误保留 run；已 submit 后查询状态并沿既有 continue。native 叶子仍 submit，PM 等实际完成后只 continue 一次。

低级 `prepare`、`start`、`claim`、`submit`、`continue`、`status`、`delivery` 继续作为恢复兼容入口；原 run 不因失败、超时或需求未变而更换。`pause` 停止后续派工。已完成运行用 `delivery` 复用证据，不重跑验收。

## 正常证据链

开发前用 `search --project <project> --query <关键词>`；知识策略写在 `task.knowledge:{query,ids,limit,maxChars}`，命中后限定 IDs 避免重复泛搜，空 ids 明确不检索，默认 BM25，知识在 prepare 冻结。PM 明确目标、接口、依赖、完整写集和 checks 后，direct/native 用 begin，桌面路线按 desktop 入口。direct 沿用 PM 当前模型并使用 finish；工程师遵循包内模型和 attempt 使用 submit，不伪造身份或把启动命令写成完成。

direct 的 finish 已包含一次集成验收，成功后直接引用返回的 delivery；native/desktop 由 PM 沿原 run continue 完成验收。输出正式 delivery 使用新的绝对 `--output`。同一产物版本与合同的有效自测和引用直接复用，不为汇报再跑；产物、条件、新失败或证据变化时做必要检查。正式集成命令仍由控制器执行，不能把自测当成已正式验收。候选知识随交付提交；无 capture 权限只留候选，知识保存失败不重跑工程验收。

较长的 search/begin/start/packet/claim 结果用 `--view compact`；完整内容由 CLI 保存到 `controlRoot/views` 并返回路径/哈希。`needsRead:true` 时先读详情，不重跑原命令取全文；短状态和完成回执保持默认。直接保存 CLI JSON，不经多层 PowerShell 重序列化；保存失败按 `doNotRetry` 保留原动作和证据。
