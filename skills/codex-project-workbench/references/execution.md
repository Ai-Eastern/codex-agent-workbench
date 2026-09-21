# PM 执行与 CLI 生命周期

## 版本计划与多项目入口

新目标可以先用 `plan-publish --project <cfg> --source <DEVELOPMENT.md> --expected-revision <当前版本，初次为0> --reason <原因>` 发布计划。Markdown 只解析 `<!-- workbench-plan -->` 与 `<!-- /workbench-plan -->` 之间的一个 `json` 代码块；也可传独立 JSON。普通正文不是授权。配置必须明确 `model`、`thinking`，语法通过不证明宿主支持或实际服务模型一致。

总调度使用私有登记 `{controlRoot,coordinatorThreadId,manifest,bindings}`；`manifest` 采用仓库 portfolio 示例，`bindings` 将每个 projectId 指向自己的绝对配置路径。总调度执行 `portfolio-register --registry <登记文件>`，再以 `portfolio-observe --registry <登记文件> --project-id <项目>` 更新摘要；`portfolio-status --registry <登记文件> --after <上次序号>` 只取增量。总调度不能伪造项目 PM 身份执行其任务。

各项目 PM 在自己的真实上下文推进：

1. `plan-status --project <cfg>` 核对当前版本、依赖和既有 run。
2. 形成一个组 JSON：`expectedRevision,phaseId,groupId,taskIds,decision:{topology,carrier,context,reason},checks`。checks 必须逐一解析计划中的 acceptanceRefs。`phase-prepare --project <cfg> --group <组JSON>` 冻结合同和原 run；只准备，不派工。
3. 若返回 `RESERVE_WORKERS`，调用 `portfolio-reserve --registry <登记文件> --project-id <项目> --run <原run> --epoch <当前代次>`。`WAITING` 不授予执行权，不重复新建 run；按候选顺序等待别的组释放。
4. `plan-advance --project <cfg> --run <原run>` 进入原来的 direct/native/Desktop 路线。native 沿用 claim → 真实创建 → bind → submit；Desktop 仍只操作已登记身份。协议记录不能代替宿主创建授权或实际身份回执。
5. 实际等待完成后继续同一 `plan-advance`。direct 的 `finish` 自动进入计划接续。完成后核验回执、归还已登记额度，返回 `plan.nextAction` 的下一批就绪任务；主 Agent 在原授权内继续选择有界组，不要求用户重复说继续。

同一组重试只返回 `READ_RUN`；`RECONCILE_PREPARE` 必须核对保存意图，再用 `phase-reconcile --project <cfg> --run <原run>` 恢复准备。送达不明不能改 groupId 逃避对账。没有独立控制额度的旧请求保留旧入口和语义，不将历史 run 自动迁入新计划。

`portfolio-pause --registry <登记文件> --epoch <当前代次> --paused true` 暂停全部新派工；加 `--project-id` 只暂停本项目。`--paused false` 是明确恢复动作；原 run 自身暂停还需 `plan-advance --resume true`。暂停不证明在途宿主已停止，仍可收集与验收原结果。`portfolio-revise --registry <旧登记> --next-registry <另存的新登记> --expected-revision <旧版本> --epoch <旧代次> --reason <原因>` 更新优先级、已观察计划版本或缩减预算；预算不可自行扩张。

新计划继续复用旧 run 的失败、返修及写集约束。完成并核验的组会自动释放额度。需求变化使尚未派出的旧组失效时，由项目 PM 执行 `phase-supersede --project <cfg> --run <旧run> --expected-revision <当前计划版本> --reason <原因>`；只有完整证据证明所有任务从未分配、派送或提交才会退出并解除写集。若已预留 portfolio 额度，再执行 `portfolio-release-undispatched --registry <登记文件> --project-id <项目> --run <旧run> --epoch <当前代次>` 核验该记录并归还额度，原 attempt 计数不退还。失败、未知派送、未证实取消保留额度，不能用超时释放。

跨项目依赖必须引用源任务声明的 `artifacts:[{id,version,path}]`，path 位于该任务写集；总览同时冻结源/目标计划、任务、产物版本及产物哈希。只有源任务完成、原始验收和结果回执有效且当前文件仍匹配，目标才可获得派工额度。额外扩组和真实新 Desktop 上下文仍按宿主支持矩阵及明确授权处理。参见仓库 `docs/host-capabilities.md` 与 `docs/three-project-demo.md`。

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
