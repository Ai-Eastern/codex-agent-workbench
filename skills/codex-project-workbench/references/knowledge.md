# 项目知识

新任务可设置 `knowledge:{query,ids,limit,maxChars}`。例如选取当前合同经验的真实 ID，limit=2、maxChars=2000；ID 过滤先于排序和截断，空 ids 明确不检索，不回退到全库。query 可独立于任务长描述。maxChars 限制知识正文字符，引用头和既有聊天不计入，不能当作完整提示词或 token 上限。此范围在 prepare 时冻结；历史任务包继续按原知识执行。材料不相关时宁可无命中，避免把旧模型评分等无关内容塞入编码任务。

项目 Markdown 是可读的知识原文，索引 SQLite 是可重建缓存，LangGraph SQLite 保存当前执行状态。当前检索为全文/BM25 与中文词项检索，不宣称向量语义能力。知识仍需被放入模型上下文才会影响生成；本地存储不等于模型离线推理。

每项目配置明确 vaultRoot 与 sourceRoot（项目根目录）。只检索该范围。默认不接入私人 Obsidian Vault；用户明确授权后，可把 vaultRoot 指向其中的一个项目子目录，并设置精确相同的 externalVaultRoot。授权仅覆盖该项目目录，不扩展到整个 Vault。Obsidian 与 RAG 共用 Markdown；索引与任务状态留在 controlRoot。也可把项目内知识目录作为独立 Vault 打开。

换知识根前确认没有未完成任务，保存原配置与原文，使用新的 knowledgeIndexFile 重建缓存；不要改历史 run 身份或清空状态。历史 run 使用项目 AGENTS 指定的原配置只读查询，后续任务使用当前配置。机器捕获笔记可改中文文件名，但保留开头 codex_workbench 元数据格式与稳定 id；人工编辑正文后，更新需使用当前整文件 expectedHash。备份与联调样例不放入正式知识检索根。

prepare 为各任务生成独立、带来源路径和哈希的上下文快照。任务中途新增知识不悄悄改已发包；发现关键旧结论失效时停止相关工作，由 PM 明确修订新任务。恢复时优先使用原任务包和实际当前产物。

captureEnabled=true 是本项目有界持续保存授权；该配置不授予跨项目或个人知识写权限。工程师候选随同一次交付提交，通过集成检查后程序验证来源证据并保存。写入按稳定 id 去重；已有内容变化需要 expectedHash 明确更新，不覆盖人工修改。正文与检索命中均不标为人工确认。

手动补录可用 `capture --project <project> --candidate <json>`，候选需完整 source={runId,taskId,evidence:[{path,sha256}]}。本命令只校验可追溯证据，不能独立证明笔记全部结论真实。个人知识跨域交接不走此命令。

知识写入失败不会重跑已验收代码。处理 COMPLETE_CAPTURE_PENDING 时检查明确的来源变动、写锁或冲突原因，解决后仅接续知识保存。禁止通过新 id 绕过同一知识冲突。
