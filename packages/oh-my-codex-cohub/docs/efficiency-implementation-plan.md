# CoHub Codex 效率优化实施记录

日期：2026-10-14  
状态：1.4.0 已实现并安装。V1 通过：build、包测试 27/27、技能校验 13/13、16 个 Markdown 文件的 25 个本地链接及 diff 检查均通过。V2 复核通过，包含 Maven 类级 `Time elapsed` 行、`surefire:`/`failsafe:` 简写头和中断模块统计。真实宿主验收报告：[efficiency-forward-1.4.0](../../../.tmp/efficiency-forward-1.4.0/report.json)，验证了 A/B 同文件串行、C 依赖 A、D 独立、E 失败仅阻断 F；观察到 2 个并发子任务（含协调者共 4 个线程槽），不证明可超过 3 并发或性能提升。`oh-my-codex-cohub@cohub` 已安装并启用，版本 1.4.0，来源为本仓库；缓存位于 `C:\Users\14023\.codex\plugins\cache\cohub\oh-my-codex-cohub\1.4.0`。

成果：[共享效率规范](../skills/cohub/references/efficiency.md)、[上下文与检查证据](../skills/cohub/references/context-guard.md)、[批量执行规范](../skills/cohub/references/batch-execution.md)、[日志摘要 helper](../scripts/summarize-log.mjs)、[检查证据 helper](../scripts/check-evidence.mjs)。

## 1. 目标与边界

围绕用户确认的两项目标实施：减少模型往返、冗余输出和过长历史；让可复用的检查结果避免无意义重跑。普通任务按需完成理解、必要收集/规范分析、执行与验证，避免把完整六阶段变成六次独立委派；复杂任务仍可走完整工作流。一次整理好任务包和验收，再把当前所有就绪任务完整委派；仅遇到新需求、真实阻断或审查发现才追加委派，并一次说明新增完整范围。

主代理继续作为纯调度者：可读任务输入和必要状态，不亲自读原始业务文件、改业务代码或扮演执行者。通过会话原生 spawn/wait 调度。不能消除上游模型响应延迟、裁剪主会话历史或强制降低主会话 `ultra` 推理设置；技能只能建议适中推理、短上下文和短输出。普通任务建议 low/medium 推理，复杂冲突或审查建议 high；仅在原生委派工具支持、候选模型共同支持且用户没有固定选择时设置。当前完整上下文 `fork_turns=all` 沿用既有模型和推理设置，不接受覆盖；只有工具允许 `fork_turns=none` 时才可传入精简上下文及允许的模型/推理参数。不得擅改主会话设置。仓库当前是 skills + Council MCP 插件，没有宿主调度实现；不得宣称插件能管理并发、切换模型或自主监听任务事件。

## 2. 约束与数据契约

规则来源与方案映射：仓库 [AGENTS.md](../../../AGENTS.md) 规定包边界、Codex 包源码目录和验证命令；[.rules/04-file-operation.md](../../../.rules/04-file-operation.md) 要求同文件写入串行、独立读取并行；[.rules/07-codex-plugin-dev.md](../../../.rules/07-codex-plugin-dev.md) 限定原生插件结构及构建、测试和安装；当前 [cohub/SKILL.md](../skills/cohub/SKILL.md)、[co-orchestrator/SKILL.md](../skills/co-orchestrator/SKILL.md) 与 [batch-execution.md](../skills/cohub/references/batch-execution.md) 定义纯调度、批次和事件等待；[context-guard.md](../skills/cohub/references/context-guard.md) 定义委派上下文策略。下文据此设计单一共享规则源、资源冲突排队、整批验证和安装边界。

先定义轻量 `task-state.json` 契约，示例：

```json
{
  "schemaVersion": 1,
  "taskId": "<stable-id>",
  "revision": 1,
  "goal": "<goal and acceptance summary>",
  "decisions": [{"text": "<decision>", "source": "<user or artifact path>"}],
  "contracts": [{"name": "<interface>", "value": "<agreed contract>"}],
  "writeOwners": [{"owner": "<alias>", "paths": ["<exclusive path>"]}],
  "tasks": [{"id": "<alias>", "dependsOn": [], "status": "pending"}],
  "checks": [{"id": "<check-id>", "status": "pending", "evidence": null}],
  "blockers": []
}
```

按 `tasks/<taskId>/` 隔离状态与证据；证据目录必须位于被检查的 scope 之外，避免证据文件改变自身指纹。仅指定上下文负责人写该任务的 `task-state.json`。代理回传结构化结果，协调者在内存对账；状态只在初始化、批次完成、阻断/解除、验证完成等里程碑更新，不为每个小步骤额外委派一次写状态。每个代理仍收到任务、目标、约束、输入、验收；`none` 仅表示不附原始文件片段，不表示没有任务上下文。移除默认附带最近 20 条消息及现有 2000 token 摘要硬限，统一改用参考摘要默认不超过 6000 Unicode 字符、交付摘要不超过 3000 字符、失败片段不超过 4000 字符的软预算，可说明理由后例外。预算不能机械截掉接口契约、验收与阻断信息；不承诺精确 token 计数。

## 3. 文件改动设计

入口及角色技能只保留路由、角色职责、关键约束，并引用共享真源 [efficiency.md](../skills/cohub/references/efficiency.md)、[context-guard.md](../skills/cohub/references/context-guard.md)、[batch-execution.md](../skills/cohub/references/batch-execution.md)。`efficiency.md` 定义精简阶段选择、上下文与输出预算、任务状态和结果格式、追加委派触发条件、原生 spawn/wait 等规则；避免每个角色复制整套流程。

`cohub/SKILL.md` 定义普通/复杂任务路由与入口；`co-orchestrator/SKILL.md` 定义一次完整派发、状态负责人、事件等待和滚动补位；`co-planner/SKILL.md` 定义依赖 DAG、专属写入范围、单一真源/接口契约和批次；`co-fixer`、`co-designer` 定义实现者的结构化短交付；`co-explorer`、规则分析技能定义必要信息摘要；`co-oracle` 定义读取最终 diff、结果摘要和证据的审查边界。上述技能均引用共享文档，不再各自重复批量细则。

新增零依赖 `scripts/check-evidence.mjs`，只创建/校验检查证据，不负责启动命令。每项检查先声明受限输入根、相对路径匹配规则和覆盖范围；每次运行重新枚举 scope，再把本次路径集与上次证据路径集取并集，排序生成 `(relativePath, existence, contentHash)` 清单。文件缺失时记录 `existence=false`，覆盖新增、删除、修改及 untracked 文件；运行前后比较同一清单，任何变化都不复用该次结果。fingerprint 同时涵盖命令、cwd、匹配规则、依赖锁文件及完整输入清单，不能只依赖 HEAD。环境仅允许记录完整定义的非秘密环境变量与工具标识；秘密变量不记录也不哈希。若不能完整定义环境影响、scope 不明、后台命令未结束或依赖数据库/网络/时间等外部可变状态，则禁止复用。只有运行前后清单稳定、退出码为成功、状态为 `passed` 的明确只读检查可复用；副作用命令（如 commit/push）不缓存，`force` 可强制重验。新增的检查证据写到 scope 外的独立文件，避免自我失效和共享写锁；输入变化只使覆盖该输入集的证据失效。

新增零依赖 `scripts/summarize-log.mjs`，消费已结束任务日志和调用方提供的真实退出码，不执行命令、不等待或轮询任务。成功输出总计、耗时与原始日志路径；失败抽取相关错误片段并限制摘要长度。做最小密钥遮蔽，但说明自动脱敏无法保证完整。build/test 包装命令必须立即保存 `$LASTEXITCODE`/对应 shell 退出码并原样传入；摘要标签不是通过证明，完整日志保留在工作区供定向检查。

## 4. 执行 DAG 与资源分配

插件和技能规则不额外设置数字并发上限，也不预设配置默认上限。每次把所有前置已满足、写入资源互不冲突的任务交给原生运行时；实际同时运行数只受宿主当前可用容量和用户明确给出的临时限制约束。宿主容量暂时不足时，其余就绪任务排队；每当运行时容量可用，立即从队列滚动补位。绝不绕过宿主硬限制。直接调用 `collaboration` 原生 spawn/wait 工具，不把代理调用包装进 `functions.exec`。优先一次派满所有当前可派发的独立任务；支持完成事件时用事件等待。若环境没有事件等待，用有上限、间隔渐退的原生等待并报告用户进度；不得反复 tail 日志作为任务状态来源。DAG 中某任务一旦就绪即进入派发队列，不为凑固定批次等待其他任务；V1/V2 则都等全部写入结束后并行启动。

| ID | 前置 | 角色 | 独占写入范围 | 产出与验收 |
|---|---|---|---|---|
| D0 | 无 | co-planner 单一负责人 | 方案期任务契约 | 固定状态/结果字段、接口与预算；列全任务和资源清单后才进入执行 |
| W1-A | D0 | co-fixer | `cohub/SKILL.md`、`co-orchestrator/SKILL.md`、`co-planner/SKILL.md`、共享 `batch-execution.md`、新增 `efficiency.md` | 一次委派、阶段选择、资源依赖、事件等待/补位及失败处理规则一致；明确无插件数字并发上限；同步移除上述四份现有“每批最多 3 个”及默认/配置 3 上限规则，改为原生容量和用户临时限制；入口技能移除默认最近 20 条消息和 co-oracle/co-council 2000 token 摘要旧值，改引共享字符软预算；仅 `implementation-only` 交付 |
| W1-B | D0 | co-fixer | `context-guard.md`、`scripts/check-evidence.mjs`、对应独立测试文件 | 上下文预算及证据格式落实；context-guard 移除旧的 2000 token/最近消息默认，统一字符软预算；缓存指纹纯函数测试覆盖限定 scope 的新增/删除/untracked、dirty、环境和复用边界；不改共享文档以外文件 |
| W1-C | D0 | co-fixer | `scripts/summarize-log.mjs`、对应独立测试文件 | 不执行/轮询，真实退出码保真、摘要限长和脱敏测试；独占脚本/测试 |
| W2-D | A 的核心契约完成 | co-fixer | `co-fixer`、`co-designer`、`co-explorer`、`co-oracle`、必要规则技能 | 完成短上下文、结构化结果和共享引用接入；不得更改 A/B/C 的独占文件。A 完成后任务立即就绪并派发；如原生容量暂满则排队，容量释放即补位，可与仍在运行且无资源冲突的 W1-B/W1-C 并行 |
| W2-E | W1-A/B/C、W2-D 均 `implemented` | 单一集成者 co-fixer | 包 `package.json`、插件 manifest、仓库根 `README.md`、Codex `README.md`、`CHANGELOG.md`、`scripts/validate.mjs` | 集中统一 1.4.0 元数据、用户文档与结构校验；ABC/D 不碰这些汇总共享文件 |
| V1 | W1-A/B/C、W2-D、W2-E 所有写入结束 | 单一验证代理 | 测试专属临时目录/独立证据文件 | 运行统一 build/test/skills 引用及 frontmatter 校验；检查 diff、任务结果和证据 |
| V2 | 与 V1 相同：W1-A/B/C、W2-D、W2-E 所有写入结束 | co-oracle，只读 | 无 | 与 V1 并发审查已完成的 diff、契约、缓存边界和失败限制；只能报告审查结论，不能宣称 V1 验证通过 |
| R1 | V1、V2 均通过 | 安装负责人 | 安装目标配置 | 执行 `npm run install:codex`，再开新会话验证加载；安装不是方案编写阶段操作 |

任务冲突以完整写集合判断：同文件一律单所有者；关联接口/实现合并给同一代理；同一 `dist`、manifest、锁文件、测试状态、数据库、端口或证据文件均视为共享资源并串行或隔离。资源冲突只约束相关任务，不形成全局并发上限。失败仅阻断下游；修复后重跑受影响检查，不重复无关构建。V1 由一人统一验证，避免多个代理同时写 `node_modules`、构建输出或报告。

## 5. 验证方案

分层验证，模拟不能替代真实 Codex 宿主能力：

1. 对缓存指纹纯函数做单测：输入修改、新增、删除，dirty tree、环境和命令变化都会影响指纹；scope 未知、任务未结束、证据失败不得复用；`force` 强制检查。
2. 对日志摘要做单测：真实退出码成功/失败保真、摘要截断、错误摘取和基础密钥遮蔽；确认脚本本身不启动进程、不轮询。
3. 运行现有 6 项隔离 MCP 测试；运行 `npm run build:codex`、skills 引用/frontmatter 静态校验。避免用脆弱的文案匹配测试技能全文。
4. 用临时文件和真实独立任务运行调度验收：根据原生运行时动态容量派发、超过当前容量的任务排队并在释放时补位、同资源冲突排队、依赖失败只阻断下游、等待阶段不 tail 日志、输入不变时只读检查复用、输入变更必须重验；确认插件没有额外数字截断，宿主支持时可派发超过 3 个并行任务。此类模拟只检验方案/脚本逻辑，不能证明生产 host 一定按规则调度；仍须用真实 Codex 子代理 spawn/wait 做一次端到端验收。
5. 在同一类任务前后分别记录委派/追加次数、模型响应往返、重复检查次数、输出字符数、传入上下文字符数与首次 token 时间；报告原始样本和口径。后两项不承诺固定百分比改善，也不将主模型上游延迟归因为插件。

## 6. 风险、回退与完成条件

主要风险是技能之间规则漂移、证据遗漏新增/删除文件、环境证据暴露秘密、伪造退出码导致误复用，以及测试模拟被误当作宿主保证。以共享 `efficiency.md` 为唯一规则源；每次枚举受限文件 scope 并生成前后指纹，秘密环境值不存储也不哈希，shell 立即捕获退出码，并单独报告模拟测试和宿主实测结果。无法确定完整 scope 或环境状态时宁可不复用检查。

实施前记录当前 Git 状态并为本任务保留可恢复补丁或快照，不要求创建 Git tag；仅回退本任务补丁或明确归属文件，保留用户现有未提交改动，禁止 `reset --hard`。若上下文/调度规则造成回归，先撤销对应技能引用和文档变更；脚本证据格式变更则保持旧证据不兼容并强制重跑，不误读旧缓存。完成条件为静态引用、单测、MCP 测试、build、真实 host 调度验收、只读审查全部通过；随后安装本仓库版本并在新会话确认加载。统一验证与安装仍按后续步骤执行。
