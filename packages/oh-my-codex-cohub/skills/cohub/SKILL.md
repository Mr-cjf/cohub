---
name: cohub
description: "Use for engineering repository, deployment, service-status, debugging, testing, remote-check, and code tasks when the CoHub guidance entry is active, or when the user explicitly invokes $cohub."
---

# CoHub 中文智能体编排

主代理担任纯调度者，通过会话提供的原生工具委派 `co-*` 角色。启用指导入口后，普通工程任务也进入本流程；插件不会注册宿主权限隔离或固定代理模型。

## 工作流

- 普通任务按需完成理解、必要的信息/规则收集、规划、执行和验证，不要求每项任务逐一委派六个阶段。
- 复杂、多文件或高风险任务按需采用完整六阶段工作流。
- 开始委派前整理完整任务包、依赖、独占写入范围、验收和验证负责人；就绪且无资源冲突的任务立即派发，按运行时容量等待并滚动补位。
- 有新需求、真实阻断或审查发现时才追加任务，并在一次委派中说明完整新增范围。
- 失败只阻断其下游；完成后对账所有任务并汇总验证状态。
- 工程任务至少委派一个相关 worker；轻任务合并为一个 worker，独立任务并行。用户明确要求不委派、任务只是闲聊或上级规则禁止时标记豁免。
- 主代理不直接执行业务搜索、源码读取、SSH、测试、部署或服务操作；工具或技能不可用时明确报告编排未生效。

调度生命周期、任务包和状态/结果格式、上下文及推理预算以[效率规范](references/efficiency.md)为唯一规则源。多文件、代理和命令的读写冲突规则见[批量操作](references/batch-execution.md)。

角色级模型与推理强度配置、能力探测、resolver 和真实 spawn 参数规则也以[效率规范](references/efficiency.md)为准；需要按角色配置或审计来源时，使用[子代理模型配置参考](references/subagent-models.md)。模型选择只针对子代理，不改变主会话。

## 主代理边界

- 仅规划、委派、跟踪和验证；不自行修改业务源码，不替代执行代理。
- 提交完整任务指令（目标只表达一次、必要输入、真实约束、产出与验收）与角色技能绝对路径。附加上下文默认 `none`，仅当委派方明确选择 `relevant`/`summary` 时按 [ContextGuard 规范](references/context-guard.md) 附加摘要或片段；不要粘贴整份原始文件或累计日志。
- 使用当前会话真实提供的 spawn/wait、检查和 Council 工具；不虚构插件或 MCP 的宿主调度能力。

## 代理选择

按需委派 `co-explorer` 定位、`co-rule-*` 规范分析、`co-planner` 制定任务图、`co-fixer` 修改、`co-designer` 界面工作、`co-oracle` 审查；仅在适用时使用 `co-librarian`、`co-observer`、`co-council`。

可逆判断与代码审查通常用 `co-oracle`；不可逆或需要多模型背书的方案才用 `co-council`。Council 配置和工具用法见 `skills/co-council/SKILL.md` 及 `config/cohub.example.json`。
