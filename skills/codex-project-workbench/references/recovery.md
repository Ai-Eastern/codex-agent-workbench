# PM 与维护者：按状态恢复

仅在已有授权内处理原运行；不由工程师执行管理命令。FAILED/BLOCKED/RESERVED 不自动产生修复权限或新预算。先查询摘要确定原因，不改状态库、身份、合同或旧证据。

| 状态或原因 | 读取本页章节 |
|---|---|
| COMPLETE_CAPTURE_PENDING / REPAIR_KNOWLEDGE | 只修知识候选；冲突细节再读 [knowledge.md](knowledge.md) |
| RESERVED / 送达不明 / 首波预检失败 | 未送达派工恢复 |
| FAILED 且外部条件已解除、代码未变 | 有界验收恢复 |
| FAILED 需改代码，或独立桌面任务 blocked | 同一任务返修 |
| RECONCILE_EVIDENCE / 未知原因 | 只核对变化，不复用旧通过结论、不猜修复入口 |

## 只修知识候选

控制器在收集 receipt 时校验候选并记录 knowledgeIssues；格式错误不会抹掉工程交付。工程验收通过且状态为 COMPLETE_CAPTURE_PENDING 后，在已有修复授权内使用 `repair-knowledge --project <project> --run <runId> --task <taskId> --acceptance-hash <status.acceptance.hash> --candidate-hash <status.knowledgeCandidates中该任务hash> --candidate <单个候选JSON文件> --reason <纠正原因>`。候选仅含 id/title/body/kind 与可选 expectedHash，source 由控制器绑定。

入口核对原 receipt 字节哈希、已验收代码、候选版本和锁，另存修正记录，不覆盖原 receipt、验收或代码。返回 CONTINUE_CAPTURE 后沿原 runId continue，只保存知识。旧版本未记录 receipt 字节哈希的运行不能直接使用此入口，保留旧证据另行诊断；不得手改状态库或补造历史哈希。

## 未送达派工恢复

维护者确认原消息未送达后，在真实 PM 内调用 `reconcile-dispatch --project <project> --run <原runId> --task <taskId> --attempt <原attemptId> --baseline <原turnId> --confirm-not-delivered true --reason <证据与解除条件>`。仅适用于恰好一项 RESERVED、其他项 PENDING 的首批送达不明；全组须明确未归档且空闲，原基线、冻结包、合同一致，无新产物、回执或验收。入口保留原失败、包、runId 与 attempt，记录一次恢复事件，不发送消息；成功后同 runId continue 才派发。不能以“没有看到回复”代替未送达证据。

首波全员 PENDING 的预检失败记录为 PREPARED，命令报错且零派工，解除条件后可明确重新 start。已 RESERVED 的送达不明必须走上述恢复，不能直接反复 continue。Desktop 错误保留脱敏的 code/reason/message/delivery；NOT_SENT 仅表示本地发送前失败，已写入管道但没有确认仍属 UNCONFIRMED_DO_NOT_RETRY。

## 有界验收恢复

临时外部条件已解除、全部工程师交付结束且产物未变时，维护者可在已有修复授权内调用 `retry-acceptance --project <project> --run <runId> --acceptance-hash <原失败验收文件SHA256> --reason <诊断与解除条件>`。入口归档原失败、保留此前通过的检查，转回 ACCEPTING；随后沿原 runId continue，只接续失败及剩余检查。它不会自动派工、改产物、换模型或重置失败预算。

此入口不适用于代码已变、验收命令副作用未查清、执行结果未知、工程师仍运行或 BLOCKED。此前通过的检查仍适用须由诊断确认；不能把一次失败自动解释为临时故障后反复调用。

## 同一任务返修

完成同行的产物须与最初接收 DONE 回执时持久记录的哈希一致，不能只采信调用方现算的摘要。旧运行缺少这份接收基线时拒绝恢复，不追补历史证明。派送恢复后同样保留原基线，接续发送前若出现迟到轮次、产物或回执，必须停止并核对，不能再发一次。

独立桌面任务在自测后明确提交 blocked 回执、其他任务均 DONE、尚未集成时，可在已有修复授权下用 `repair-blocked-task --project <project> --run <原runId> --task <失败taskId> --attempt <原attemptId> --receipt-hash <原回执字节SHA256> --artifacts-hash <全部合同产物相对路径到SHA256映射的JSON摘要> --reason <诊断和精确修复范围>`。要求全组真实空闲，合同、原回执和产物未变，不支持依赖图、未知送达或正在执行的任务。入口归档失败和旧代码，保留原run、其他DONE任务和写集，只为失败项生成新attempt与新回执路径，沿原run continue。其他完成项哈希受保护。与下面的 repair-task 共享每run一次明确返修预算；再失败即停止，不重跑整组。

代码必须改变时，先在原产物仍与失败证据一致的状态调用 `repair-task --project <project> --run <runId> --task <taskId> --acceptance-hash <失败验收SHA256> --reason <明确缺陷与修复范围>`。控制器归档旧验收、任务包、工程师回执，保留原 run、合同和文件归属，生成新 attempt；随后原 PM start/continue 派发这次明确返修。不要先改代码再绕过哈希保护。

本入口仅支持单任务 direct/langgraph，且每个 run 只有一次明确返修预算；不适用于 native、多任务依赖、BLOCKED、未知或超时命令结果、已 COMPLETE 的工作。改变产物后此前验收不再适用，全部原定检查重新执行；这与临时条件解除时保留有效的已通过检查不同。再失败就保留事实，不自动循环，不换 ID 清空预算。
