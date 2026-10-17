# ContextGuard 上下文卫士

ContextGuard 为委派提供有限、可追溯的上下文，并用文件证据判断验证结果能否复用。`scripts/check-evidence.mjs` 仅读取文件、计算指纹和写证据；它不启动或执行项目命令。

## 委派上下文

任务指令与附加上下文分开。任务指令包含：目标（只表达一次）、代理技能绝对路径、必要输入或自行收集指引、真实约束/风险、前置依赖、独占写入范围/共享资源、产出、验收标准、验证方式与负责人。附加上下文（历史文件片段、已做决定、报错、依赖摘要）默认不附加。简单任务不生成仅重复目标的空壳契约，也不填无实质内容的字段；决策与验收必须来自真实输入或前序产出，不得编造。

ContextGuard 默认策略对**所有角色均为 `none`**：不按角色默认附加历史文件、决策、错误或依赖摘要。`none` 只表示不注入附加上下文，不是零任务信息——任务指令与基本契约始终完整，代理自行收集一手信息。仅当委派方在任务包中**明确选择 `relevant` 或 `summary`** 时才附加相应材料：

| 角色 | 默认策略 | 默认附加材料 |
|------|---------|--------------|
| 全部代理角色 | `none` | 任务指令 + 基本契约；不附历史文件/决策/错误/依赖摘要 |

| 策略（默认均为 `none`，仅在委派方明确选择时启用） | 附加材料 |
|---|---|
| `relevant` | 相关文件片段 ≤5、已做决定 ≤10、报错 ≤5、依赖结论 ≤8；只摘必要的最近对话，不复制固定消息窗口 |
| `summary` | 摘要含来源标识和当前结论；预算遵循[CoHub 效率规范](efficiency.md)的字符软预算 |

摘要参考[CoHub 效率规范](efficiency.md)：默认最多 6000 Unicode 字符，属于可说明理由后超出的软预算；交付摘要和失败片段预算也按该规范执行。不得使用固定消息窗口或 token 硬限。摘要仅保留目标、已确认决定、风险、依赖、状态和验收条件；接近预算时先删重复背景与原文，保留来源路径/任务别名。来源文件、规范结论、决策或任务状态改变时，相关摘要即失效，重读来源后更新。不得把摘要当作原始材料；执行者可按路径补读。决策和验收条件必须来自真实输入或前序产出。`dependsOn` 只表达调度依赖，不自动传播摘要；确实消费前序结果时，把关键结论及来源写入任务指令的"必要输入"或"真实约束"，`none` 下同样完成关键事实交接，不因此自动切换策略；`relevant`/`summary` 仅补充材料，不取代必要输入。上下文包完整时直接执行；只有缺少会阻断执行或验收的关键信息时才追问。

```text
### 📋 任务指令 (CoHub 自动注入)
- 目标（只表达一次）：
- 技能文件绝对路径：
- 必要输入 / 自行收集范围（确实消费前序结果时，承载关键依赖结论及来源）：
- 真实约束 / 风险：
- 依赖（仅调度依赖 `dependsOn`）：
- 独占写入范围 / 共享资源：
- 产出与验收标准：
- 验证方式 / 验证负责人：

### 附加上下文（仅当任务明确选择 `relevant`/`summary` 时注入）
- 相关文件片段 / 已做决定 / 报错 / 依赖结论（`relevant`）：
- 摘要（`summary`，含来源标识）：
```

## 验证证据

只在验证命令明确只读、输入范围完整且外部状态不影响结果时启用缓存。命令是证据中的 argv 数组或字符串，helper 永远不执行命令。scope 必须列出相对 `cwd` 的完整目录 roots；`files` 中的显式文件也必须位于这些 roots 内，`patterns` 只用于筛选 roots 范围内的文件。helper 每次重新递归枚举 roots 并对活动文件内容做 SHA-256，因此新增、删除、修改文件都会改变指纹。范围不完整、未知环境、写入命令或依赖外部状态时，结果不可复用。scope 根或其内部的符号链接会被拒绝；evidence 和 before 快照必须存放在 scope 外。

spec 示例（路径按项目调整）：

```json
{
  "command": ["node", "--test", "test/unit.test.mjs"],
  "cwd": "C:/work/project",
  "scope": { "roots": ["src", "test"], "files": [], "patterns": [] },
  "completeScope": true,
  "environment": { "complete": true, "names": ["NODE_ENV"], "unknown": false },
  "tools": [{ "name": "node", "version": "20.0.0" }],
  "readOnly": true,
  "externalState": false
}
```

CLI 示例；`--evidence`、`--out` 和 `--before` 路径会由 helper 检查不在 scope 内且祖先路径没有符号链接。由调用者真实运行命令并传入它的退出码：

```sh
node scripts/check-evidence.mjs snapshot --spec check.json --evidence .evidence/unit.json --out .evidence/before.json
# 此处由调用者执行 check.json 中记录的命令，并记录实际退出码
node scripts/check-evidence.mjs record --spec check.json --before .evidence/before.json --evidence .evidence/unit.json --completed --exit-code 0 --status passed
node scripts/check-evidence.mjs check --spec check.json --evidence .evidence/unit.json
node scripts/check-evidence.mjs check --spec check.json --evidence .evidence/unit.json --force
```

`record` 会重新快照并写入前后指纹及新增/删除/修改清单。仅 `completed=true`、实际 `exitCode=0`、`status=passed` 且运行期间输入稳定时标记为可复用；失败、pending、输入变化都会保存为不可复用证据。`check` 只有 spec、scope 文件、声明环境和工具标识完全匹配才报告 `reusable: true`，`--force` 总是 miss。必须显式声明 `environment.complete=true`；值只参与摘要指纹，不写入证据，疑似密钥名会拒绝。环境范围未知或声明不完整时禁用复用。

证据是本地决策辅助，不是命令审计、执行器或对外部状态的证明。调用者必须正确声明完整 scope、只读性、环境和工具，并提供真实退出码；未建模的外部变化可能令结果过期。
