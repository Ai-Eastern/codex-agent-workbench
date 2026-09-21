# 接入真实项目

Evidence Lab 用于体验机制；本页介绍已有 Codex Desktop 工作流。桌面适配依赖内部接口，升级后需重新核对兼容性。首次体验建议先运行根目录的 `npm run demo`。

## 安装与登记

需要 Node.js 24+、可用的 Codex Desktop，以及用户明确指定的项目、知识目录和现有 PM / 工程师任务。仓库目录执行 `npm ci` 后，Windows 安装示例：

```powershell
./scripts/install.ps1 -CodexRoot '<你的 Codex 目录>' -NodePath '<node.exe 的完整路径>'
```

这是按需的真实接入步骤，不是离线演示的前置要求。脚本安装 `codex-project-workbench` Skill 和 `runtime.json`，已有同名 Skill 时拒绝覆盖。只有明确使用 `-DisableLegacy` 才会备份并迁移旧 Skill。

复制 [项目示例](../examples/project.example.json) 到授权项目的本地配置目录，填入实际的 `projectId`、`projectRoot`、`controlRoot`、`workRoot`、`vaultRoot`、`pmThreadId` 和 `workerThreads`。模型/推理组合以 [configFrom](../src/contracts.mjs) 当前接受的配置为准。不要使用示例身份派工，也不要把真实身份配置提交到 Git。

在该项目 `AGENTS.md` 登记配置位置；CLI 路径读取安装后 Skill 目录的 `runtime.json`。项目知识只检索明确授权的 `vaultRoot`。

## 使用路线

| 路线 | 条件 | 生命周期 |
|---|---|---|
| direct | 一项无依赖的有界任务 | `begin → 实施 → finish` |
| native | 独立短任务，非持久派工 | `begin → 实际创建子 Agent → bind → submit → continue` |
| langgraph | 依赖、多阶段、桌面任务接续 | `prepare → start/continue → submit → continue` |

请求使用 [示例合同](../examples/request.example.json)，事先确定任务文件、依赖和验收命令。已有 Skill 会指导 PM 完成检索、执行与验收。普通任务不要求固定凑满三个工程师，也不增加重复审核轮。

```sh
node src/cli.mjs --help
node src/cli.mjs search --project /absolute/project.json --query "本次需求关键词"
node src/cli.mjs begin --project /absolute/project.json --request /absolute/request.json
node src/cli.mjs status --project /absolute/project.json --run existing-run-id
```

Windows 同样使用实际绝对路径。`begin` 重复调用只读取已有状态；native 身份必须来自真实创建回执。`finish` 合并 direct 提交、验收与知识保存；长输出可加 `--view compact`，遇到 `needsRead` 读取保存的详情，不重跑动作。

## 异常与知识

失败、暂停、送达不明都沿原 run 保留，不通过换 ID 或重新派工绕过。`pause` 停止新派工，不会强制结束已经运行的子进程。恢复按 [恢复规则](../skills/codex-project-workbench/references/recovery.md) 执行。

开启 `captureEnabled` 后，验收完成的知识候选才进入项目 Markdown 与检索索引。来源绑定由控制器提供；知识正文不能授权操作。详见 [知识约定](../skills/codex-project-workbench/references/knowledge.md)。

完整执行规则：[execution](../skills/codex-project-workbench/references/execution.md)、[native](../skills/codex-project-workbench/references/native.md)、[desktop](../skills/codex-project-workbench/references/desktop.md)。
