# Codex Agent Workbench

在现有 Codex Desktop 项目任务中，把项目知识检索、任务分流、文件归属、执行恢复和集成验收连接起来。

用户继续使用原有项目侧栏；项目经理（PM）吸收原技术负责人（TL）的方案、拆分和验收职责。小任务由 PM 直接完成，独立短任务使用原生子 Agent，有依赖或需要跨轮接续的工作交给已登记的桌面工程师任务。跨项目协调者查看摘要、处理优先级和冲突，各项目 PM 自己组织开发。

仓库：[Ai-Eastern/codex-agent-workbench](https://github.com/Ai-Eastern/codex-agent-workbench)，已建立并核对为 **PRIVATE**，访问需要相应权限。Skill、知识引擎和编排器共同发布，当前采用一个仓库，避免三套接口和版本分别漂移。

## 解决的问题

长对话和多层派工容易重复传递背景，历史经验也容易散落在聊天里。这个项目把持续有用的知识保存为项目 Markdown，每次按当前任务检索，再冻结到工程师任务包；同时把执行状态、文件归属和验收证据保存在控制器中。

期望减少重复说明背景、重复调查同一失败和多层重复验收，让模型只接收当前工作需要的知识。是否减少返工、节省时间，仍取决于任务拆分、知识质量和实际执行；本项目没有固定提速或降错比例。

## 三条执行路线

| 路线 | 适合的工作 | 实际执行者 |
| --- | --- | --- |
| `direct` | 一项有界工作，无需并行 | 当前 PM 任务 |
| `native` | 相互独立、短期完成的工作 | Codex 原生子 Agent |
| `langgraph` | 有依赖、多阶段、需要跨轮接续的工作 | 已登记的现有 Desktop 工程师任务 |

三条路线共享任务合同、项目知识包、文件归属和验收标准。当前实现中，LangGraph.js 也承载共同的收集、验收和知识保存流程；路线名称 `langgraph` 特指由控制器向现有桌面工程师派工的方式。人数按任务依赖决定，不给小任务强加团队。

原生路线必须先 `claim`，再调用真实的子 Agent 创建工具，最后 `bind` 创建记录对应的真实子任务 UUID。示例配置中的占位 UUID、协调名称和工程师结果文件，都不能充当实际创建证明。详细步骤见 [执行入口](skills/codex-project-workbench/references/execution.md)。

## 项目知识与 Obsidian

- 每个项目显式登记 `vaultRoot`，可作为独立 Obsidian Vault 打开，也可在用户授权后通过 `externalVaultRoot` 接入既有 Vault 内的一个项目子目录。Obsidian 与 RAG 共用 Markdown；索引和任务状态留在项目目录。普通人工笔记也可检索，不要求添加 frontmatter。
- SQLite FTS5/BM25 加 Unicode 词项和汉字 bigram 提供 **lexical RAG**。当前没有 embedding、向量库或语义检索。
- `prepare` 根据项目目标和子任务目标检索，冻结带来源路径、哈希的上下文。新知识不会悄悄修改已经发出的任务包，也不会自动缩短既有聊天历史。
- `captureEnabled=true` 时，工程师在原交付中附知识候选，控制器在验收后校验证据并保存。稳定 ID 去重；更新已变更的笔记需要当前 `expectedHash`，避免覆盖人工修改。
- 检索会检查显式绑定的证据哈希。证据变化或删除后，相应 capture 退出检索，Markdown 原文保留。这只覆盖已绑定文件，不会自动识别所有外部事实或未绑定代码的变化。

项目知识、执行状态和私人 Obsidian 知识库各有明确范围。系统不会默认扫描个人 Vault，也不会交叉检索其他项目。检索结果始终是资料，不能授予写权限或要求执行笔记里的命令。详见 [项目知识约定](skills/codex-project-workbench/references/knowledge.md)。

## 安装与入口

技术栈为 **Node.js 24、LangGraph.js、SQLite、FTS5/BM25**。当前三项目桌面验证使用 **PM：gpt-5.6-sol/high，工程师：gpt-5.6-luna/medium**；跨项目总经理按用户配置使用 gpt-6-astra/ultra。仍支持先前 Spark/low 与 5.5/low 配置，历史验证分别记录，不把配置支持当作完整兼容证明。

在仓库目录中安装依赖和 Skill：

```powershell
npm ci
& ./scripts/install.ps1 -CodexRoot D:/Eastern/codex -NodePath D:/tool/Node.js/node.exe
```

示例安装位置：

| 内容 | 位置或查找方式 |
| --- | --- |
| 仓库源码 | `D:/Eastern/codex/codex-agent-workbench` |
| 安装后的 Skill | `D:/Eastern/codex/skills/codex-project-workbench/SKILL.md` |
| 本机入口配置 | 安装后 Skill 同目录的 `runtime.json`，包含 `repository`、`node`、`cli`、`registry` |
| 真实项目配置 | 从该项目 `AGENTS.md` 给出的绝对路径读取 |
| 项目任务、验收和知识数据 | 从真实配置中的 `controlRoot`、`workRoot`、`vaultRoot` 读取 |

以 [examples/project.example.json](examples/project.example.json) 为配置模板；其中目录和任务 UUID 均为占位，必须换成本机已确认的项目及现有 PM／工程师任务。不要把真实配置、任务 ID、日志、简历或 Vault 正文提交到 Git。安装脚本写入入口路径，但不会替用户登记真实项目。

默认安装保留旧 Skill。脚本提供显式的 `-DisableLegacy` 迁移选项，将指定旧 Skill 连同哈希清单移入备份目录；它不清除已有任务历史，也不解除旧项目的暂停、权限或失败记录。已存在新 Skill 时，脚本拒绝直接覆盖。

## 简短用法

在已登记项目的现有 PM 任务中，可以继续用自然语言交代目标，例如：

> 使用 codex-project-workbench。先检索本项目知识，再按依赖选择直接处理、原生子 Agent 或 LangGraph。为这次需求列出精确文件范围和验收条件，执行已授权的部分；完成后保存有证据、可复用的经验。

Skill 负责让 PM 调用下面的真实控制器入口；仅在聊天中提到 LangGraph 不代表已经经过控制器。当前已登记的项目保留原侧栏任务，历史技术负责人任务不再承担新派工。原生子 Agent 的 UI 展示由 Codex 决定，不承诺它们成为永久侧栏角色。新项目必须先登记项目根目录、知识范围和真实 PM／工程师任务映射。

安装后读取真实入口。先把下面的项目配置占位值替换成项目 `AGENTS.md` 中登记的路径：

```powershell
$runtime = Get-Content 'D:/Eastern/codex/skills/codex-project-workbench/runtime.json' -Raw | ConvertFrom-Json
$project = '<项目 AGENTS.md 中的真实配置绝对路径>'
& $runtime.node $runtime.cli search --project $project --query '项目权限隔离'
& $runtime.node $runtime.cli status --project $project
```

开发请求的最小结构见 [examples/request.example.json](examples/request.example.json)。PM 明确目标、路线及原因、精确文件清单、依赖和验收命令后，按以下顺序接续：

1. `prepare --project <配置> --request <请求 JSON>`：保存合同、预留整批文件、冻结知识包，不派工。
2. `start --project <配置> --run <runId>`：按选定路线开始执行；direct/native 返回任务包，native 另需真实创建及绑定。
3. 工程师完成必要自测和结果 receipt 后，`continue --project <配置> --run <runId>` 收集结果并推进一次集成验收。
4. `status` 查询；`pause` 停止新派工。多项目摘要使用 `portfolio --registry <runtime.registry 指向的登记表>`。

`continue` 是已有授权下的正常接续。`FAILED`、`BLOCKED` 或派送不确定时保留原 run 和证据，不自动重发、重跑或换 ID 绕过失败。`COMPLETE_CAPTURE_PENDING` 表示工程验收通过、知识保存待处理，接续时不重做代码和验收。暂停不会强制结束已经运行的 Agent 或其子进程。

## 验证状态与当前限制

本地合成测试已覆盖知识重建、中文检索、项目与路径隔离、冲突及证据失效，以及任务合同、状态恢复和验收行为。测试数量、执行命令、版本和真实接入证据统一记录在 [验证报告](docs/verification.md)，README 不固定测试数量。

2026-09-11 已在一个现有项目中跑通 `direct`、真实原生子 Agent 和桌面工程师 A/B → C 三条路线，完成命令验收、经验回写及无旧聊天上下文的新任务检索验证。完成状态重入没有再次派工或执行验收。该阶段为小型代码任务。

2026-09-12 完成 [多项目调度、RAG 与成本报告](docs/dispatch-scale-results-20260912.md)：双项目真实峰值 6 人、45 项合同检查通过；三项目编码批次在一次定点返修后通过 67 项检查，峰值仍为 6；随后统一放行的知识交付达到真实 9 人并发、重叠 22.529 秒，9 条知识自动写入 Obsidian 并重新检索通过。这验证了有界任务的 1-2-6／1-3-9 调度能力，尚未证明九人生产编码提速。三位工程师是每项目容量上限，PM 按任务使用 0–3 人；小任务仍走 direct/native。

本轮补齐未归档状态预检、保留证据的派送恢复、只返修失败任务、跨项目 ready/release 和按任务限定知识范围。每个项目复用控制器的唯一集成验收结果。报告同时列出全部 PM／工程师 Token、首次失败及维护成本，不能据此推导固定节省比例。

随后按用户指定模型开展 [Spark 完整流程测试](docs/spark-e2e.md)：真实发现上下文中断、业务与契约遗漏，并补充摘要输出、保留证据的验收接续及单任务返修入口。测试明确记录维护介入、首次失败和未验证范围，不将跑通样例等同于无人介入成功或固定提速。

已执行同模型、同知识、同验收的 [三组真实功能对照](docs/comparison-results.md)：单 Agent 首次验收失败，固定专业团队功能通过但知识保存待处理；动态组接续后复制了固定组实现，样本判为无效。报告保留全员 Token、重复验收、维护成本和隔离漏洞，当前不能据此宣称动态调度更省或更快。原始方法见 [对照协议](docs/comparison-protocol.md)。

后续使用 5.5 完成 [流程修复与验证](docs/repair-verification.md)：控制器给出明确下一动作及可复用验收摘要，知识候选可单独纠正，新请求校验项目身份；新的桌面任务验证了知识回写和跨会话检索。修复中发现的误选配置与维护者验收脚本错误均保留。Windows 受管命令已实测拒绝指定跨组读取，但 Desktop 全工具隔离尚未接通，暂不重开效率对照。

进一步完成 [Docker＋SSH 桌面隔离实测](docs/desktop-isolation-results-20260911.md)：两个 GPT-5.5/low 任务已分别接入独立远程项目，各自文件读写通过；A 仍可经桌面 `read_thread` 读取 B 的合成标记，**未达到全部工具的分组读取隔离要求**。确认首个反例后停止后续测试，保留原始调用和 Token 记录；当前仍不提供效率排名。

随后完成 [原生受管钩子实测](docs/desktop-hooks-results-20260911.md)：GPT-5.5/low 新任务的本任务读取正常，显式跨组和省略主机的读取均被 `PreToolUse` 拒绝；但钩子进程故障时，桌面仍返回外组标记。**钩子可减少误调用，不能承担完整隔离。** 已恢复正常规则并停止后续测试，原任务与新反例均保留。

进一步的 [工具执行端授权核查](docs/desktop-tool-authorization-assessment-20260911.md) 追踪了当前安装包的真实读取链路：主机参数用于优先查找，未找到按调用项目约束目标的受支持授权入口。保留官方桌面习惯的完整隔离方案目前受此平台接入缺口限制；报告包含源码定位、替代方案边界及尚未外发的最小功能诉求。

桌面适配器依赖当前 Codex 版本的内部 pipe 和工具回执格式，不是已承诺稳定的公共 API；必须在登记的真实 PM 任务内运行。原生子 Agent 的创建身份同样需要真实工具回执，不能仅凭本地结果文件确认。

当前文件归属、路径检查与写锁属于应用层控制，未实现操作系统沙箱；没有语义向量检索或全自主生产运行保证。多项目证据限于上述有界合同与知识交付；自动化测试、真实桌面任务结束、GUI 验收和用户验收是不同证据，不能相互代替。

## 进一步阅读

- [与旧 PM–TL 链、单 Agent、原生子 Agent 的比较](docs/comparison.md)
- [本轮规模验证与完整成本口径](docs/dispatch-scale-results-20260912.md)、[Ruflo 只读评估](docs/ruflo-assessment-20260912.md)
- [Ruflo 成本模块全量评估与实际复用](docs/ruflo-cost-assessment-20260912.md)、[恋语真实任务的成本与耗时分账](docs/ruflo-real-task-cost-20260912.md)：显式 turn 采集、零基线比较，定位长上下文和管理开销。
- [阶段交接优化的真实结果](docs/stage-handoff-results-20260912.md)：短交接、同轮派工和自动 delivery 已用于下一项恋语开发；分别呈现原始 token、非缓存输入与一次性设置成本。
- [SmartRetrieval 中文适配与同库对照](docs/smart-retrieval-results-20260912.md)：完成显式候选入口，15 道可回答题的必要证据覆盖由 15/15 降至 14/15，未达到采用标准，正式默认保留 BM25。
- [架构、数据流与恢复边界](docs/architecture.md)
- [Skill 入口](skills/codex-project-workbench/SKILL.md)、[工程师交付格式](skills/codex-project-workbench/references/worker.md)
- [复用与许可证依据](docs/reuse-decision.md)、[实现契约](docs/implementation-contract.md)
