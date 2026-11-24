# awesome-dsh-plugin 收录条目

本仓库的 DSH 插件（`packages/dsh-cohub`）已被 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 收录。本文件记录**外部仓库里的条目真值**与**同步时机**，避免描述与代码漂移后被维护者打回。

## 收录现状

| 项 | 值 |
|---|---|
| 条目文件 | `data/plugins/Mr-cjf__cohub--packages-dsh-cohub.yml` |
| 条目名 | `Mr-cjf/cohub#dsh-cohub` |
| 分类 | `workflow`（工作流与自动化） |
| 收录日期 | 2026-11-18 |
| 市场入口 | https://awesome-dsh-plugin.com/ |

市场弹窗里的插件描述**不读 npm `package.json` 的 description**，只读榜单数据（`awesome-dsh-plugin.com/plugins.json`，由 `data/plugins/*.yml` 生成）。改文案无需发 npm 新版本，但需要向 awesome 仓库提 PR。

## 当前条目真值

`data/plugins/Mr-cjf__cohub--packages-dsh-cohub.yml` 全文：

```yaml
url: https://github.com/Mr-cjf/cohub/tree/main/packages/dsh-cohub
name: Mr-cjf/cohub#dsh-cohub
category: workflow
description:
  en: 'Orchestrate coding tasks in DeepSeek Harness: the main agent delegates instead of editing files, 13 skills route to models, and subagents are read/write-isolated; plans and replies stay in Chinese.'
  zh: '在 DeepSeek Harness 中编排编码任务：主代理只做调度、不亲自改文件，13 个技能按名路由模型，子代理读写权限隔离，规划与回复用中文。'
```

对应 README 条目（**生成产物，勿手改**）：

```markdown
- [Mr-cjf/cohub#dsh-cohub](https://github.com/Mr-cjf/cohub/tree/main/packages/dsh-cohub) - Orchestrate coding tasks in DeepSeek Harness: the main agent delegates instead of editing files, 13 skills route to models, and subagents are read/write-isolated; plans and replies stay in Chinese.
```

历史上曾用描述 "Agent-orchestration plugin for DeepSeek Harness: a dispatch-only orchestrator preset, …"：`dispatch-only orchestrator preset` 属内部行话，且 `only` 是易被证伪的绝对化断言，已替换为动作句。

## 同步 checklist

技能、preset 或默认行为变化时逐项确认：

- [ ] `packages/dsh-cohub/skills/*.md` 个数 ≠ 13 → 条目 en 的 `13 skills` 与 zh 的 `13 个技能` 必须同步改（描述里的数字会被维护者逐项核对）
- [ ] 主代理仍「只调度、不亲自改文件」才保留 `delegates instead of editing files`（约束见 `packages/dsh-cohub/presets/co-orchestrator/agent.cordis.yml`）
- [ ] 子代理读写隔离仍成立才保留 `read/write-isolated`（对应 `cohub-subagent-readonly` / `cohub-subagent-write` 两个 preset）
- [ ] 中文默认行为变化时，同步 `plans and replies stay in Chinese` / `规划与回复用中文`
- [ ] 格式：一句话 + 句号结尾；无营销词与最高级；不写安装命令与 URL；含半角 `: ` 的 YAML 值整体加引号
- [ ] 长度：en 120–330 字符（该分类实测中位 231）；zh 控制在百余字内
- [ ] README 是生成物：只改 `data/plugins/*.yml`，若 CI 报 README 与 data 不一致，跑仓库生成步骤而非手改那一行

## 提交流程

1. 在 GitHub 网页编辑 `data/plugins/Mr-cjf__cohub--packages-dsh-cohub.yml`，提交 PR 并一句话说明改动理由；
2. 等待 CI 校验（含 README 生成一致性、描述与源码核对）；
3. 合并后目录每日重建，`plugins.json` 更新后刷新插件市场即可看到新描述。

## 已知缺口

市场弹窗「它会做什么」区块目前显示「还没有扫描结果」：本条目在 `plugins.json` 中缺少 `capabilities` / `capabilityRedLines`（全库 12960 条里有 11836 条带这两个字段）。该字段由榜单扫描器产出，作者不能手填；成因（是否读 `package.json` 的能力声明）待查，未处理。
