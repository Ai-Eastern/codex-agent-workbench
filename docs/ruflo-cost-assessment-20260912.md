# Ruflo 成本模块全量评估与 Codex 适配

结论：采用 **Borrow**，实际改造纯快照比较算法，并借鉴按模型、角色和 token 类别呈现的方式。Codex 原始计数采集继续使用本地实现。本轮没有安装 Ruflo、AgentDB、Booster 或新增 npm 依赖。

## 范围与证据

固定上游提交 [`39e0b0540c9b018174955fc8a21f355bbac26c6a`](https://github.com/ruvnet/ruflo/tree/39e0b0540c9b018174955fc8a21f355bbac26c6a)：成本插件全部 66 个文件，加根 LICENSE、package.json 和成本 CI，共 **69 文件、509,933 字节、12,940 行**。Git tree 未截断；下载内容逐个核对 Git blob SHA-1，并记录 SHA-256。三个有界评估组完整读取各自文件，合并后没有遗漏、额外条目或哈希不一致。逐文件结论见 [覆盖清单](ruflo-cost-coverage-20260912.json)。这是成本插件的全量评估，不是整个 Ruflo 仓库的全量运行认证。

MIT 通知保留在 [third_party](../third_party/README.md)。初始 [复用决策](ruflo-cost-reuse-decision-20260912.md) 在实现前记录；最终适配位于 [cost-report.mjs](../src/cost-report.mjs) 与 [usage.mjs](../src/usage.mjs)。

## 按模块作出的决定

| 模块 | 判断 | 本次处理 |
|---|---|---|
| `diff.mjs` 的 `diffNumber` / `diffMap` | 复用价值最高，纯本地快照运算 | 已改造并实际用于本轮前后快照；保留 MIT 来源，补未知值、零基线语义 |
| `summary` / `conversation` / `session` 的分组展示 | 可借鉴输出，不适合直接接入数据层 | 已按角色、模型、阶段、输入/缓存/输出/推理呈现 |
| `_prices` / `counterfactual` / `projection` | Claude 价格与假设成本，不代表 Codex 订阅账单 | 不复用价格、节省美元或订阅余额推导 |
| `_npx` / `_sessions` | 外部 CLI 和 AgentDB 依赖；list 后逐条 retrieve 存在 N+1 进程调用 | 不复用；使用明确授权的本地 rollout 文件，每份文件每次报告只读一次 |
| `track` / `session` 的 HOME 扫描 | Claude 日志格式和目录选择；坏行跳过、未知模型成本归零不适合审计 | 不复用；按真实 session 身份和显式 turn 列表验证 |
| `budget` | 告警档位可参考，但依赖美元与外部状态 | 本轮不引入硬停、自动换模型或新的审核环节 |
| `burn` / `anomaly` / `trend` | 时间桶、MAD、趋势可独立改造 | 作为后续候选；单次不同任务不足以拟合稳定异常阈值，本次不增加代码 |
| `compact` | 动态依赖外部 token optimizer；缺依赖时可返回成功退出但无优化 | 不引入上下文压缩，不宣称减少历史窗口或 token |
| `health` | 四项检查并行组合可参考；底层 CLI 无统一总超时 | 不复用运行链，保留当前 Workbench 生命周期判断 |
| `outcome` / `federation` | 外部 memory 写入和事件命名空间；联邦事件存在预留接口 | 不接入，不把预留接口当已经发生的事件 |
| `export` | Prometheus 字段设计可参考，但支持任意 webhook 外发 | 本次只落本地 JSON，没有 webhook 或新服务 |
| `ruflo-hook` / hooks / plugin manifest | Claude 插件契约，Stop shim 总是退出 0 | 不作为 Codex Desktop 采集成功证明；不安装 Stop hook |
| `bench` / corpus / CI / smoke / integration tests | 可借鉴对照方法；依赖安装、付费 LLM 或静态结构检查 | 只运行已审阅的无外部副作用子集；不重复运行历史模型基准 |
| README / REFERENCE / commands / skills / agents / ADR | 能力导航及限制说明 | 全量读取，用源码和实际结果核对，不把文档数字当本项目效果 |

`_npx` 在 Windows 使用 `shell:false` 的 Node/npm 入口；问题是动态外部依赖与调用成本，不能误报为已证实的 shell 注入。`track` 对显式会话路径仍存在先检查 Claude 项目目录的耦合；完整移植远超本次实际需要。

## 实际复现与测试边界

- 10 个指定 JS/CJS 文件通过 `node --check`；YAML、JSON 和 Bash 没有冒充 Node 语法测试。
- `test-hooks.mjs` 使用临时目录及 dry-run，3/3 通过，仅证明输入管道接线。
- `compact.mjs` 缺少集成依赖时返回 `bridgeUnavailable=true`、退出 0，证明的是回退路径。
- `trend.mjs` 读取仓库内 8 个 legacy runs，正常输出，不代表本轮重新跑了 8 次模型实验。
- 对上游 `diff.mjs` 输入合成的基线 0、当前 10，并设置 1% 阈值，观察到退出 0、`alert.triggered=false`。原因是零基线变为 Infinity，告警又只接受有限百分比。适配后将此类增长明确标为 `new`，百分比为 null，绝不当作零增长。

没有执行带有 npx 安装、AgentDB 写入、gcloud Secret Manager、付费 LLM 或 webhook 的路径。没有执行完整 Bash smoke，也没有把已有 JSON、文档、静态 grep 或局部测试升级为 Codex 全链路兼容证明。

历史 runs 是 **11 个物理 JSON、9 个独立哈希版本**：含别名共 179 条 `results`，去除两个重复别名后为 **142 条**。另有 25-case corpus JSON。不同数据规模、模型和测试阶段不能合并为收益比例；上游宣称的节省率或加速倍数没有在本项目复现。

## 已落地的成本口径

`cost-report` 从显式 manifest 读取本地文件，校验 session 身份、turn 范围及重复范围。`token_usage_record` 按 response ID 去重，核对每轮累计；旧 `token_count` 仅作兼容回退。缓存属于输入，推理属于输出，不重复相加。未结束或不一致的轮次只保留部分观测，不冒充完整账单。

报告包括角色/模型/阶段计数、每次响应平均输入、缓存占比和顶层工具输出字符数。后两项帮助定位长上下文和大段工具输出；字符数不是 token，工具包装器也不等于内部全部工具调用。单轮包含检索、实施和验收时按组合阶段报告，不能凭时间戳猜每个工具消耗了多少模型 token。

适配器使用现有 Node 和原生库，不启动另一个 agent 服务。普通开发不新增汇报轮次；成本需求按 [Skill 入口](../skills/codex-project-workbench/references/cost.md) 由一位统计负责人采集。真实恋语交付与本次调查、适配、管理成本分账，具体测量见同日实操报告。
