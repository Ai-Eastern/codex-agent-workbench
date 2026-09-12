# PM：LangGraph 桌面路线

真实 PM 先 `preflight --project <project>`，整组 READY 后才 start。核对登记工程师的项目目录、明确未归档、空闲状态和已完成基线；notLoaded 或旧 completed 不能证明当前可派工。预检不派工、不改运行状态，控制器发送前会再次检查。App 控制器只接受真实 PM 身份与当前 app pipe。

LangGraph 向登记的现有工程师任务发送包，PM 不重复发送。后续轮次使用一个有界 wait 等待变化，再沿原 runId continue，不高频轮询无变化状态。只有实际任务结束后才能收集并推进集成验收。

本次明确要求跨项目同步放行时，先按 [handoff.md](handoff.md) 的统一放行一节汇总全部 PM 预检；不能先释放一个项目再收集其他项目的 READY。

首波预检失败、送达不明、RESERVED 或迟到回执均按 [recovery.md](recovery.md) 核对，不根据超时自动重发。
