---
name: co-git-commit-release
description: 完成 git 提交并执行发版流程：核实目标包/渠道/版本/tag/remote 与真实可用脚本，更新 CHANGELOG 与版本号、打 tag、精确推送、真实验证，文件修改/提交/tag/push/发布/安装逐项核对授权。当用户说"发版""发布""release""提交并发版"时使用；工作区干净也可单独发版。
---

# co-git-commit-release：提交与发版

你是 CoHub 的发版工作流，分两阶段执行：阶段 A 提交（如需要）+ 阶段 B 发版。

## 定位与触发

- 触发：用户明确要求"发版""发布""release""提交并发版"。
- 仅"提交"而无发版意图 → 使用 [co-git-commit](../co-git-commit/SKILL.md)。
- 工作区干净也可单独发版（跳过阶段 A）。
- 工作目录是**用户目标仓库**，不是插件安装缓存或开发源仓库；不读写 `~/.codex/plugins/cache`。

## 阶段 A：提交（如需要）

- 提交流程遵循 [co-git-commit](../co-git-commit/SKILL.md) 的**提交保护**：审查状态、**按内容（hunk）而非文件核对授权**、保留用户索引状态（不 `git reset`/撤销暂存，索引含无关暂存时不直接 commit）、扫描秘密、生成真实 diff 中文表格、预览确认后提交。
- **提交授权与发版授权是两次独立授权**，分别确认。

## 阶段 B：发版

### 1. 核实发版要素

不预设任何发布机制，先只读核实：

- **目标包**：`package.json` 的 `name` / `version` / `private` 字段；`private: true` 的包**不预设 npm 发布**。
- **发布渠道与真实可用脚本**：检查 `package.json` scripts 与仓库文档中真实存在的构建/发布/CI 脚本；CI 发布方式以仓库真实配置为准。
- **版本**：当前版本号与本次推荐版本号。
- **目标 tag**：由目标包的版本号与真实 CI 的 tag 约定共同确定**唯一完整 `<目标tag>`**（如某仓库 CI 监听 `opencode-v*` / `dsh-v*` 前缀，tag 即 `opencode-v<版本>` / `dsh-v<版本>`）；**不自动套用本仓库或其他仓库的 tag 前缀到所有仓库**。
- **remote**：用 `git remote` 与 `git remote get-url <remote>` 核实真实 remote 名与地址，不假设 `origin`。
- **基准分支与 CI 触发**：以核实到的远程默认分支和真实 CI 配置为准。

### 2. 逐项核对授权

以下动作**各自独立授权**，逐一与用户确认，不可用一个笼统授权覆盖：

- 文件修改（CHANGELOG、package.json 等）
- 暂存与 commit
- 创建 tag
- push（代码与 tag）
- 发布（存在真实发布脚本/CI 触发时）
- 安装或重启验证（独立授权）

### 3. 版本号与 CHANGELOG

推荐 SemVer 级别：

| 提交类型 | 推荐级别 | 说明 |
|---------|:---:|------|
| `fix` | patch | Bug 修复，向后兼容 |
| `feat` | minor | 新功能，向后兼容 |
| 包含 `BREAKING CHANGE` | major | 破坏性变更 |
| `refactor`/`perf` | patch | 内部改进 |
| `docs`/`test`/`chore`/`ci` | 询问 | 可能不需要发版 |

- 向用户展示推荐级别并请其确认（可手动选择不同级别）。
- CHANGELOG 按 Keep a Changelog 结构更新，分类「新增/修复/变更/移除」，日期格式 `YYYY-MM-DD`；填充规则：`feat`→新增、`fix`→修复、`refactor`/`perf`→变更、删除功能→移除、`docs`/`test`/`chore`/`ci` 通常不写入。
- 版本号更新：**手动编辑** `package.json` 的 `version` 字段；**禁用 `npm version`**（它隐含自动 commit 与 tag）。
- 提交数量与范围**以目标仓库现行规则为准**，不强制制造"CHANGELOG 与版本号分开两个提交"（那是旧子包专属约定，不是通用要求）；若目标仓库规则或用户要求确需多个提交，**预先告知提交数量与范围并获授权后再执行**。

### 4. tag 冲突检查

打 tag 前双重确认 `<目标tag>` 未被占用：

- `git tag -l "<目标tag>"`（本地）
- `git ls-remote --tags <remote> "refs/tags/<目标tag>"`（远端）

两者都必须为空才可打 tag。**远端查询失败（网络/认证错误）不视为空闲**，停止发版并报告原因。`<目标tag>` 已被占用 → **停止发版**并报告冲突，可向用户建议候选版本号；用户**明确确认新版本号**后，按新版本重新定义 `<目标tag>` 并**重新走全部检查**，**不自动换版本继续**。**严禁删除/移动/覆盖已有 tag**。

### 5. 执行与精确推送

- 修改 CHANGELOG/package.json（已授权）→ 按目标仓库现行规则提交（提交数量与范围已预先告知并获授权）→ 用已核实并获授权的 `<目标tag>` 打 tag：

```bash
git tag <目标tag>
```

- 推送**精确范围**，分别推送分支与 tag：

```bash
git push <remote> <branch>
git push <remote> <目标tag>
```

- **禁用 `push --follow-tags`**。
- 不改 remote、不做 amend/强推/绕 hooks（如 `--no-verify`）、不回退用户文件。

### 6. 真实验证

- 验证推送真实结果：`git ls-remote <remote> "refs/tags/<目标tag>"` 能返回该 tag、`git log --oneline <remote>/<branch>` 包含本次提交。
- 存在真实发布脚本时按脚本执行并记录真实退出码。
- 任一验证失败 → **停止发版**并报告真实错误，不宣称成功。
- 安装/重启验证需**独立授权**后执行，不在本流程自动进行。

## 常见错误

| 错误 | 正确做法 |
|------|---------|
| `npm version` 隐式 commit+tag | 手动编辑版本号，分步授权 |
| 强制制造 CHANGELOG/版本号两个提交 | 以目标仓库规则为准；确需多个提交时先告知数量/范围并获授权 |
| `push --follow-tags` | 分别精确推送 branch 与 tag |
| 远端查询失败仍视为 tag 空闲 | 查询失败即停止，报告原因 |
| 一个笼统授权覆盖全部动作 | 文件/commit/tag/push/发布/安装逐项确认 |
| private 包仍走 npm 发布 | 以真实发布脚本为准，不预设 npm 发布 |
| tag 写死 `vX.Y.Z` 或套用其他仓库前缀 | 由目标包版本与真实 CI 定义唯一 `<目标tag>`，检查/创建/推送/验证统一复用 |
| tag 占用后自动换更高版本继续 | 停止报告冲突，用户明确确认新版本后重新定义 `<目标tag>` 并重走检查 |

## 硬性规则

- private 包不预设 npm 发布；一切以核实到的真实脚本为准。
- `<目标tag>` 由目标包版本与真实 CI 约定确定，不写死前缀、不套用其他仓库前缀；tag 占用即停止，不自动换版本继续。
- 禁用：`npm version` 隐式提交/tag、`push --follow-tags`、改 remote、amend/强推/绕 hooks、删除/移动 tag、回退用户文件。
- 失败停止，不静默吞掉错误。
- 始终中文输出。
