# Observability 复用决定

决定为 **Borrow**：借鉴固定 Ruflo 版本的 span、时间轴和瓶颈解释方式，使用本地既有数据生成只读 trace-report。已核查一个外部候选：[observe-trace/SKILL.md](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/plugins/ruflo-observability/skills/observe-trace/SKILL.md)，commit `39e0b0540c9b018174955fc8a21f355bbac26c6a`，MIT 声明保留于 third_party。该入口依赖已有 spans；并非安装后就能采集 Codex 的实现。

本地已有 workflow 的时间戳事件、验收命令 elapsedMs，以及 cost-report 的明确 thread/turn 窗口。缺少完整父子 span、工程师开工时间、resume 事件和维护活动起止。先保留两层独立事实：按 run 读取控制器状态区间；按调用方给出的 cost-report 展示原始 turn 区间。不能仅凭 role/project 标签、时间重叠或最长 turn 推断它们属于某次 run、真实编码时间或关键路径。

新增一个 `trace-report --project ... --run ... [--cost-report ...]` 入口，不写运行库、不派工、不扫描日志、不调用模型。可选成本报告作为独立补充，必须声明其归属仍由原 manifest 提供。默认不会自动附着到每次状态查询。

控制器区间只算观测到的状态停留；重复 RUNNING 不切新阶段，失败/阻塞区间包含等待且不是维护工时。暂停仅记录请求点，恢复时间未知。未结束阶段不以当前时间补造结束；时间倒退拒绝计算。只有单任务线程的已报告区间可取并集；跨线程时钟未经核实，合并墙钟及并发数保持未知。参与者时长求和单独标记，绝不当作墙钟总耗时。成本快照只做结构/时序校验，不冒充已对原日志验真。实际验收命令时间只读取哈希绑定的验收回执，历史失败仅保留状态区间，不猜旧命令耗时。

验收范围：有界合成时序测试、现有完整测试、一份恋语历史运行与既有成本报告的只读应用。原始路径/任务身份及报告留在本地，仓库只提交实现和匿名结果。没有安装外部追踪服务，不推导固定效率收益。
