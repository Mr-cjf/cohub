# 调度效率与交付契约

本文件是 CoHub Codex 工作流、委派上下文和任务状态的唯一规则源。入口技能与角色技能只引用本规范，不复制其细则。仅在本任务涉及委派或共享状态时加载。

## 工作流与任务包

普通任务按需执行理解、必要收集/规则分析、规划、执行和验证，不把六阶段变成固定的六次委派；复杂任务可采用完整流程。主代理在委派前一次准备当前范围的完整任务包与验收。仅新需求、真实阻断或审查发现触发追加委派，且一次交付完整新增范围。

指导入口激活时，普通工程、仓库定位、部署状态、故障排查、测试和远程检查都先进入委派流程；轻任务至少一个相关 worker，独立任务进入同一发送队列。闲聊、改写已有材料、用户明确豁免或更高规则禁止时不派发。指导模式只改变行为约束，不提供权限隔离；严格模式必须另有宿主能力证据。

每个任务包含：稳定 `taskId`、目标、约束、输入路径/摘要、已确认决策及来源、接口契约、`dependsOn`、独占 `writeScope`、验收标准、验证负责人、`effort`。代理仍需收到任务、目标、约束、输入与验收；ContextGuard 的 `none` 只表示不附原始文件片段。

## 并发与等待

不设置插件级或技能级数字并发上限，也不设默认并发配置。就绪条件是依赖已满足且写资源无冲突；宿主容量和用户明确提出的临时限制只影响发送时机，不限制插件准备任务的数量。

### dispatch_prepare：准备完整派发队列

每次准备一批时，收集当前全部就绪且无冲突的任务，不按预计可用槽位截断，也不等待其他尚未就绪的任务。为每项准备完整 prompt，包含目标、约束、输入路径与必要摘要、已确认决策及来源、接口契约、依赖、独占 `writeScope`、验收标准和验证负责人。保留稳定 `taskId`，并核对 prompt、写入范围与验收互相一致。

同一批角色的模型参数在发送前一次解析。按下文角色模型配置规则，从当前原生工具能力和配置得到每个任务实际支持的参数；配置无效或工具不支持显式选择时，停止该项并报告。将全部当前就绪任务及其最终 prompt、`writeScope`、验收和精确原生工具参数组成 `dispatchQueue`。每个队列项至少包含 `taskId` 和完整的 `nativeToolArgs`；槽位不足时，未发送项及已解析参数留在队列中。任务新就绪或配置改变后，再准备新增或受影响的队列项。

### dispatch_send：连续发送原生调用

如果宿主允许在同一 assistant 响应中发出多个原生委派调用，就在该响应中提交队列内所有可启动项。如果接口只能逐个 spawn，就连续提交当前容量允许的队列项，直到队列发完或宿主容量用尽。两种情况下都不设置插件侧任务数量上限。

同一 send pass 的 spawn 调用之间不得插入搜索、文件读取、进度消息、成功代理结果分析、重新规划或等待。spawn 返回的代理 ID 只用于记录 `taskId` 与原生代理 ID 的对应关系；当前工具协议必需的工具结果中转不代表已经完成任务，也不触发逐项分析。发送完成后再解释结果或统一等待事件。用户插入的新需求、安全或权限要求、必要的许可请求和工具拒绝等情况可以中断发送并暂停队列。

若原生工具明确表示容量不足，保留未发送项，待活动任务释放槽位后立即继续；不为了凑批次或制造重叠而 sleep。真实启动错误要记录为失败，不能记成已启动或成功，并只阻断依赖该任务的下游；无关任务仍可继续。

优先使用原生事件等待接收完成。运行时没有事件等待时，使用有上限、间隔渐退的可用等待方式并向用户报告进度。不要将代理调用塞进 `functions.exec`，也不要声称技能或 MCP 实现了宿主调度。

### 实际派发验收

测量真实派发时，记录首末原生 spawn 提交时刻，以及每项任务可观察到的 start/end 时刻；不可观察的字段记为未知。由实际 task start 计算启动 spread（最晚 start 减最早 start），并记录任务区间的重叠时长或并行数。准备队列后不加入人工等待。单次原生接口、模型轮次或服务调度仍可能形成启动间隔；规范不承诺毫秒级同时启动或固定提速。短任务之间没有重叠本身不表示派发能力失败。

## 上下文与推理

保持上下文短而完整：摘要默认最多 6000 Unicode 字符、交付结果最多 3000 字符、失败片段最多 4000 字符，均为可说明理由后超出的软预算，不是精确 token 限额。不得默认附加最近 20 条消息或使用 2000 token 摘要硬限；不得机械截断目标、接口契约、验收、阻断或写入归属。向执行者传路径和必要片段，原始文件及完整日志按路径读取。

普通任务建议 `low`/`medium`，复杂冲突分析或审查建议 `high`。只有原生委派工具和所选模型能力支持时才设置；用户或有效配置明确选择的值优先于效率建议。未配置时保留原生默认，不强制设置模型或强度。`fork_turns=all` 继承原模型与推理设置，不能附加覆盖；只有原生工具支持 `fork_turns=none` 时，才可同时提交它允许的模型与推理参数。绝不修改主会话模型或 `ultra` 设置。

Council 共识回传遵循 [`co-council`](../../co-council/SKILL.md) 的 `result_mode` 约定：普通请求显式 `summary`（仅当 chair 成功且有非空白可用综合时省略成员正文、完整保留 chair 综合与错误，成员保留状态/原始长度/省略标记），chair 未配置/配置不完整/空或空白响应/调用失败时自动回退 `full` 并说明原因、完整回传所有成员观点与主席错误/skip 信息，用户要求全文时 `full`，省略参数保持旧 full 行为兼容。`summary` 是选定视图而非整结果硬上限，不静默截断 prompt/context、不设置任意硬长度；chair 始终基于完整成员结果综合，`result_mode` 只改变最终回传。

### 角色模型配置

角色模型配置只影响子代理，不改变主会话。配置仅允许 `subagents.defaults` 与 `subagents.roles.<role>` 中的 `model`、`reasoning_effort` 两个字段；不为配置新增并发上限或其他调度字段。逐字段按以下优先级合并：本次委派明确选择、workspace `.codex/cohub.json`、`COHUB_CONFIG`（或 CLI `--config` 指定文件）、`~/.codex/oh-my-codex-cohub/config.json`、旧版 `~/.config/oh-my-codex-cohub/config.json`、原生继承。Resolver 依次读取 legacy、user、config/env、project，再应用本次任务覆写，故后读取来源优先级更高。字段未出现时继续采用较低优先级值；`null` 明确清除此字段的 CoHub 覆盖并回到原生继承。先合并 `defaults`，再用同一层的角色字段覆盖；逐字段执行上述层级规则。

dispatch_prepare 为同一批收集宿主实际支持的模型、各模型可用推理强度、当前继承值和覆盖能力，并只调用一次 resolver：

```powershell
node scripts/resolve-agents.mjs --roles co-explorer,co-oracle --cwd . --capabilities runtime-caps.json
```

有本次明确的模型/强度选择时，可用 `--overrides explicit.json` 提供按角色映射，或直接提供 `{ "model": "…", "reasoning_effort": "…" }` 以覆写所选整批角色。需要指定配置文件时传 `--config <path>`。能力输入应来自当前会话工具，形如 `{ "models": [{ "id": "…", "reasoning_efforts": ["…"] }], "inherited": { "model": "…", "reasoning_effort": "…" }, "supports": { "model": true, "reasoning_effort": true, "fork_turns_none": true } }`；不得根据静态推荐、猜测或 benchmark 编造能力。resolver 输出 `results`（每个角色的解析值、来源和 `spawnArgs`）与 `warnings`。若显式配置的模型或强度无效、不可用或工具不支持，停止并报告错误，不能静默降级。配置没有指定的值保持原生默认。

按 resolver 为每个角色调用真实原生 spawn，并只将实际支持的 `model`、`reasoning_effort`、`fork_turns` 参数传入工具。原生工具仅当 `fork_turns=none` 时允许模型/强度覆盖；`all` 必须沿用宿主继承设置。Resolver 只解析，不执行 spawn；不得把配置文件内容贴进 prompt 并声称已切换模型。记录角色、所用配置来源和 resolver 值；若 spawn 返回中可观察到实际 model/effort，再记录该值。宿主未返回实际值时标记为未知，不得把请求值写成已验证的实际值。角色配置变化后重新解析；同一批就绪角色一次批量解析。旧版配置中的旧 `agents` 字段仅作为历史数据提示，不执行或映射。

## 状态与回传

简单任务在内存任务看板跟踪，不为状态更新额外派写文档任务。需要跨阶段持久化时，以 `taskId` 隔离状态；仅指定的上下文负责人写状态，并只在初始化、批次完成、阻断变化、检查完成等里程碑更新。主代理可写独立任务状态元数据，但不改业务源码。建议结构：

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

任务状态使用 `pending / running / implemented / completed / failed / blocked / cancelled`；统一验证通过前，`implementation-only` 结果保持 `implemented`。每个执行者只回传紧凑结构化结果：

```json
{
  "status": "implemented",
  "changedFiles": ["<path>"],
  "decisions": ["<decision>"],
  "checkEvidence": ["<check id, result and evidence path>"],
  "blockers": [],
  "artifactPaths": ["<output path>"]
}
```

协调者对账结果并维护依赖；不要要求执行者返回完整源码、整份文档或累计日志。日志摘要与检查证据由实现中的 helper 负责，位置为 [`scripts/summarize-log.mjs`](../../../scripts/summarize-log.mjs) 和 [`scripts/check-evidence.mjs`](../../../scripts/check-evidence.mjs)；在这些工具存在并适用前，不宣称日志摘要或证据缓存已经执行。

## 复核

所有相关写入结束后，由指定负责人统一验证，避免重复构建和共享输出冲突。结果记录状态、文件、决定、检查证据路径、阻断和产物路径。审查者读取最终 diff、短结果和证据，不重新传递全量历史；最终对账所有已派任务，并区分已实现、已验证、失败和阻断。
