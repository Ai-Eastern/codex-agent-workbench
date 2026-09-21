# 安装、项目绑定与验证范围

本仓库当前交付开发中的源码、控制器和确定性测试。安装成功或 CI 通过均不代表新版功能已经完成；功能发布仍要求 [三项目真实验收](three-project-demo.md) 及 [DEVELOPMENT.md](../DEVELOPMENT.md) 第 20 节的发布检查。当前宿主实测、工具能力和缺口见 [host-capabilities.md](host-capabilities.md)。

## 检查源码与依赖

需要 Git、Node.js 24 和 npm。Windows 安装脚本使用 PowerShell。控制器使用 Node 内置 SQLite；不要为消除其版本提示擅自降级运行时。

在独立工作目录中取得源码并记录所验证的提交：

```powershell
git clone https://github.com/Ai-Eastern/codex-agent-workbench.git
Set-Location codex-agent-workbench
git rev-parse HEAD
node --version
npm --version
npm ci
npm test
node src/cli.mjs --help
```

`npm ci` 使用锁文件安装本地依赖；`npm test` 使用 `node:test`，不调用付费模型、不登记真实项目、不创建 Desktop 任务。CI 在 Windows 和 Linux 的 Node.js 24 上运行相同安装/测试入口；未运行的 CI 不能预先标为通过。公开依赖和源码许可见 [LICENSE](../LICENSE)、[第三方说明](../third_party/README.md)。

## 先验证隔离安装

现有 [install.ps1](../scripts/install.ps1) 接受 `-CodexRoot`、`-NodePath`，另有显式的 `-DisableLegacy` 开关。先用临时配置目录验证复制和路径绑定，无须修改个人 Codex 配置：

```powershell
$testCodexRoot = Join-Path ([IO.Path]::GetTempPath()) ('workbench-install-' + [guid]::NewGuid().ToString('N'))
$nodeExecutable = (Get-Command node).Source
& ./scripts/install.ps1 -CodexRoot $testCodexRoot -NodePath $nodeExecutable
$runtimeFile = Join-Path $testCodexRoot 'skills/codex-project-workbench/runtime.json'
$runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
& $runtime.node $runtime.cli --help
```

隔离目录只用于检查安装文件，Codex 不会因此自动加载该目录中的 Skill。正式安装时，把 `-CodexRoot` 改为用户明确授权的真实 Codex 配置目录。脚本写入该目录的 `skills/codex-project-workbench/`；若已存在则拒绝覆盖，先核对版本与差异再决定更新。本文不会自动运行正式安装。

安装后的 `runtime.json` 位于 **Skill 安装目录**，保存仓库、Node、CLI 和 `.local/projects.json` 登记表的位置。保留安装所引用的仓库目录；移动或删除仓库会使这些路径失效。安装不修改全局 Git 配置，不创建项目配置或 Desktop 任务，也不清理旧聊天。

默认不处理旧 Skill。只有显式使用 `-DisableLegacy` 才备份并移动脚本中列出的旧条目，备份包含文件哈希；这属于单独的迁移操作，不是普通安装必需步骤。升级前保留原 `runtime.json` 和私有项目配置，不用删除状态库代替恢复。

## 绑定实际项目

复制 [project.example.json](../examples/project.example.json) 到私有配置位置，再替换示例身份和路径。示例仅展示语法，里面的身份、模型值和目录不是当前宿主的已验证配置。

| 字段 | 当前源码要求 |
| --- | --- |
| `projectId` | 稳定的项目代号；请求和配置必须对应同一项目。 |
| `projectRoot` | 项目根的绝对路径。 |
| `workRoot` / `controlRoot` | 均在 `projectRoot` 内，分别用于任务产物与控制器状态，不能相等。仓库开发时明确把 `workRoot` 绑定到实际允许修改的工作区。 |
| `vaultRoot` | 显式授权的知识目录；默认在项目根内，与工作/控制目录不同。外部知识目录只有 `externalVaultRoot` 与它精确一致时才被允许。 |
| `pmThreadId` | 来自当前真实 PM 任务的宿主身份。不要复制示例 UUID 或来源任务身份。 |
| `workerThreads` | 已登记 Desktop 工程师的真实、互不重复身份，不能与 PM 相同；不使用这条执行路线时可为空对象。原生执行者由真实创建回执后绑定。 |
| `model` / `thinking` | 用户明确选定的配置，始终显式填写；新计划入口要求这两个字段存在。 |
| `maxWorkers` | 现有配置校验接受 1–12，不代表当前宿主保证有这些执行槽。单主原生执行者仍按项目策略最多 3 个，实际分配服从已验证容量与授权预算。 |
| `captureEnabled` | 是否保存验收后的知识候选；知识来源和授权范围仍独立校验。 |

模型配置通过语法校验，只表示控制器保留了请求值。它**不证明账户可用、宿主接受或服务实际使用了该模型/推理档位**。实际宿主回执缺少运行时信息时记录“未知”，不能用模型自述或配置回显补齐，也不自动换成其他模型。历史测试配置只是历史证据。

`projectRoot` 的包含关系与路径检查会拒绝链接或 Junction 等不明确路径。遇到拒绝时确认绑定目录并使用真实规范路径，不移除保护来迁就路径别名。知识索引和写集控制是应用层约束，不是操作系统级的跨项目保密沙箱。

在项目的 `AGENTS.md` 记录私有配置的位置，或每次明确传入 `--project`；不要让代理扫描个人目录猜配置。旧摘要命令 `portfolio --registry` 读取的登记格式是 `{"projects":[{"config":"<配置绝对路径>"}]}`。它与新总览计划 JSON 的职责不同；只为查询摘要时不要把计划文件当成这个旧登记表。

## 使用已存在的 CLI 合同

由 Skill 读取其安装目录下的 `runtime.json`。以下查询使用真实配置替换占位值，不触发派工：

```powershell
$projectConfig = '<私有项目配置的绝对路径>'
& $runtime.node $runtime.cli status --project $projectConfig
& $runtime.node $runtime.cli search --project $projectConfig --query '本次需求关键词'
```

开发前确认项目、授权写集、实际身份、明确模型配置和验收，再按 [execution.md](../skills/codex-project-workbench/references/execution.md) 与 [native.md](../skills/codex-project-workbench/references/native.md) 执行。已实现的旧生命周期仍包括 `begin → finish`（direct），以及 `begin → 真实原生创建 → bind → submit → continue`（native）；独立 Desktop 路线只使用真实已登记任务。`CREATE_NATIVE` 是待执行动作，不是已创建的身份。

新版计划、资源与交接命令见 [执行协议](../skills/codex-project-workbench/references/execution.md)、[交接协议](../skills/codex-project-workbench/references/handoff.md) 和当前 `--help`；任务及验证状态见 [开发进度](development-status.md)。普通已授权接续不需要逐步询问；如果宿主创建额外用户可见任务需要明确请求，先取得对应授权或绑定手动创建的任务。`pause` 阻止后续派工，运行中执行者是否停止必须有宿主证据。失败、送达不明和旧版本结果保留原记录，恢复步骤见 [recovery.md](../skills/codex-project-workbench/references/recovery.md)。

## 安装与真实能力分别验收

确定性安装检查可以证明依赖可加载、CLI 可运行、Skill 文件和路径写入正确。三项目夹具可以证明固定业务验收和证据拒绝逻辑。两者都不能证明已完成真实 Desktop 派工、新上下文接续、暂停终止或 A/B/C 联动。

真实运行前还需绑定项目、取得所需创建权限，并保存宿主来源、请求/可观测模型、全部角色用量、提交和验收证据。具体缺口使用 [宿主支持矩阵](host-capabilities.md) 与 [三项目流程](three-project-demo.md) 记录。只有这些功能义务完成后才能标为功能版本；源码公开和 PR/CI 可以先按开发状态交付。
