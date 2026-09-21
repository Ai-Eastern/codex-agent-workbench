# 阶段交接与跨项目协调

总经理一次明确项目目标、里程碑、优先级与允许范围，由已有 PM 在范围内自主推进。用户直接交给 PM 的单项目任务不再经过总经理；总经理收到明确需求时同轮转派，不逐项重审工程步骤。只在里程碑完成、阻塞、资源冲突或需要用户决定时汇总；没有授权的后台监听不宣称自动监控。每项目 PM 按依赖选择 direct/native/LangGraph 和 0–3 位工程师；无依赖项目独立开工，不强制同步等待。

交接只带本阶段目标、明确配置、上一 delivery 路径、必要入口、未决限制和允许动作，优先约 2,000 中文字符；不复制聊天记录、完整源码或全部知识笔记。用户说“继续”时接续已明确的项目计划，不制造测试业务或要求 PM 自行寻找一个任务证明流程。PM 负责分流和合同，无需另做“已读/准备开始”轮。新需求才建立新 run，未完成的失败仍沿原 run 恢复。

阶段窗口切换只在已授权新任务时进行，保留旧任务、配置、失败记录、同一 controlRoot 和工作目录。projectIdentity 包含 PM ID，新 PM 用新的配置文件并核对实际身份，旧配置留作历史验证；不得改 Codex 状态库、伪造 compact 或新建控制库绕过锁。短交接和 RAG 不清除聊天历史，阶段设置成本单独记账。

## 有版本的上下文交接

`handoff-create --project <原配置> --request <交接请求.json>` 由原 PM 的真实 `CODEX_THREAD_ID` 执行。请求明确给出 `id`、已有阶段 `runId`、`expectedPlanRevision`、Git `expectedHead`、`budget: {maxActiveWorkers, maxAttemptsPerTask}`、`nextStep` 和 `allowedActions`。允许动作仅使用 `READ_STATE`、`RECONCILE`、`RESUME`、`REPAIR`、`CONTINUE_PLAN`；这些字段描述已有授权范围，不增加用户权限。

程序从已生效计划和原运行生成私有不可变包，包含用户约束、任务版本、attempt、Git HEAD 与工作区差异、当前产物哈希、任务包和结果引用、全部运行事件、失败验收、文件归属和必要知识 ID。返回的 `packetPath` 和 `packetHash` 是后续接收依据。不要手写这些事实或以摘要覆盖它们，也不要上传控制目录的交接包与真实身份。

新配置只允许 `pmThreadId` 和配置文件路径变化。接收前普通未完成 run 必须已暂停；FAILED 和 BLOCKED 原样保留。仍在外部派工、等待回执、原生执行者未完成或送达不明时返回 `HANDOFF_RECONCILE_REQUIRED`，先在原运行对账。不得通过交接重派、重置失败、释放旧文件锁或扩大预算。

`handoff-accept --project <新配置> --request <接收请求.json>` 必须在真实新 PM 中执行，字段为 `handoffId`、`expectedHash`、`expectedHead` 和 `sessionEvidence`。证据对象含 `kind`（`created` 或 `registered`）、`threadId`、`cwd`、`sourceThreadId`、`receiptPath`、`receiptHash`。证据文件位于同一私有控制目录，记录实际宿主创建回执或用户明确登记的独立新会话，不能由模型根据摘要猜测身份或补造。

证据记录的版本为 `schemaVersion: 1`，并包含同样的 `kind/threadId/cwd/sourceThreadId`、`context: "fresh"`、`forkedFrom: null`、毫秒时间 `createdAt` 和 `receiptId`。创建时间不得早于交接包。`created` 记录另保留真实创建工具的 `hostReceipt`（含 `threadId`、`hostId`）；`registered` 记录另有 `registeredBy: "user"` 和明确的 `registrationReason`。这些是本机证据封装字段，不是宿主提供了这些原生字段的声明。只发送短摘要、fork 全部历史或复用原 PM ID 都不满足要求。

接收器还要通过 Desktop adapter 的实时 `read` 核验两端身份与项目目录；源 PM 必须 idle 且最后一轮 completed。接收成功仅向 SQLite 的 `identity_transfers` 追加身份链，保留原 run、计划、配置和失败证据。旧负责人不能再以旧配置读取可执行状态或推进，新负责人继续原 run，不自行创建替代 run。重复接收返回已登记结果，不再次转移身份。

`test/context-handoff.test.mjs` 使用注入宿主的协议夹具，只证明校验、保留与拒绝行为。真实新会话创建、真实上下文独立及宿主可用性仍须单列现场证据；未授权创建新用户任务时明确报告该支持缺口，不调用创建工具补做演示。

总经理以实际原生 `send_message_to_thread` 回执确认派送；回执不明保留送达不明，不重复派送。指定统计方直接读取原生回执，不要求 GM 手写重复派工 JSON 或新增成本报告轮。交付由 PM 正式验收，汇报复用 finish/continue 返回的 delivery，证据未变不重复查询、验收或清单。

## 显式同步批次

需要统一窗口时，总协调者冻结 manifest（项目、run、PM、配置身份）；各 PM 预检后执行带 barrier 的 `start`，全部 ready 后总协调者一次 `release-portfolio`。等待中的进程只接续读取，不能再次 start；过期、身份变化或部分未就绪不派工。该 barrier 只同步派工窗口，不改变实际并发上限。

隔离对照须先实测执行工具的跨组读取与可绕过入口；证据不足只报告功能诊断，不报告效率排名，保留失败和污染记录。
