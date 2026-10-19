# OpenCode 插件开发硬约束

本文档是 `oh-my-opencode-cohub` 包的**违反即出 bug** 的硬约束清单。不重复包级操作手册（已在 `packages/oh-my-opencode-cohub/AGENTS.md`），只列必须/禁止条款，每条附证据路径。

---

## 项目骨架

- **必须 ESM**：`package.json` 第 10 行 `"type": "module"`。
- **按惯例必须声明插件标记**：`package.json` 第 59-61 行 `"opencode": { "plugin": true }`（运行时惯例约定，非类型强制）。
- **依赖版本**：`@opencode-ai/plugin` ^1.17.0、`@opencode-ai/sdk` ^1.3.17（声明值，`package.json:44-47`）；截至本规范编写时实测安装版本均为 **1.17.15**（两者版本号已同步）。
- **入口**：`src/index.ts` 第 823-824 行同时导出具名 `server` 与 `default`。

## 插件签名与导出互斥

- **插件签名**：`(input: PluginInput, options?: PluginOptions) => Promise<Hooks>`，其中 `PluginOptions = Record<string, unknown>`。
- **`PluginInput` 共 7 个字段**：`client`（SDK client）、`project`、`directory`、`worktree`、`experimental_workspace`（`{ register(type, adapter): void }`）、`serverUrl`（URL）、`$`（BunShell）。
- **server / tui 类型层互斥**：`PluginModule` = `{ id?, server, tui?: never }`；`TuiPluginModule` = `{ id?, tui, server?: never }`。一个包不能同时导出两者。
- **TUI 侧走 `@opentui/solid`**，通过 `api.slots.register({ order, slots: {...} })` 注册（项目 `src/tui.ts:122-209` 注册 `sidebar_content`）。

## Hooks（v1 完整清单）

v1 Hooks 共计 **21 个属性**：18 个函数式 hook + 3 个对象槽。

### 函数式 hook（18 个，签名 `(input, output) => Promise<void>`）

| # | hook 名 |
|---|---------|
| 1 | `dispose` |
| 2 | `event` |
| 3 | `config` |
| 4 | `chat.message` |
| 5 | `chat.params` |
| 6 | `chat.headers` |
| 7 | `permission.ask` |
| 8 | `command.execute.before` |
| 9 | `tool.execute.before` |
| 10 | `tool.execute.after` |
| 11 | `shell.env` |
| 12 | `tool.definition` |
| 13 | `experimental.chat.messages.transform` |
| 14 | `experimental.chat.system.transform` |
| 15 | `experimental.session.compacting` |
| 16 | `experimental.compaction.autocontinue` |
| 17 | `experimental.text.complete` |
| 18 | `experimental.provider.small_model` |

### 对象槽（3 个）

- `tool` — 工具定义对象（`{ [name]: ToolDefinition }`）
- `auth` — 认证配置对象
- `provider` — 模型 provider 配置对象

**总计：18 个函数式 + 3 个对象槽 = 21 个属性。**

## AgentConfig（v1）字段

| 字段 | 类型 | 备注 |
|------|------|------|
| `model?` | `string` | 模型标识 |
| `temperature?` | `number` | 温度参数 |
| `top_p?` | `number` | **蛇形命名，不是 `topP`** |
| `prompt?` | `string` | 系统提示词 |
| `tools?` | `{[key]: boolean}` | 工具开关 |
| `disable?` | `boolean` | 禁用标记 |
| `description?` | `string` | 代理描述 |
| `mode?` | `"subagent"\|"primary"\|"all"` | 运行模式 |
| `color?` | `string`（hex） | 显示颜色 |
| `maxSteps?` | `number` | 最大步数 |
| `permission?` | 见下方 | 权限配置 |

### `permission` 子键

`edit?` / `bash?` / `webfetch?` / `doom_loop?` / `external_directory?`，取值均为 `"ask"|"allow"|"deny"`。`bash` 还可按命令名逐键设权限（如 `{ "git push *": "ask" }`）。

## 架构不变式

### 1. agent 双重注册

两种途径缺一不可：

- **途径一（官方）**：`config` hook 写入 `cfg.agent[name]`（Config 类型含 `agent` 字段）。
- **途径二（扩展）**：`return { agent: Record<string, AgentConfig> }`（Hooks 类型**不含** `agent` 字段，依赖运行时额外属性识别）。

证据：`src/index.ts:402`（途径二返回 `agent`）+ `:408-448`（途径一 `config` hook 写入），以保证 HTTP 服务器模式兼容。

### 2. config hook 幂等合并

`config` hook **可能被多次调用**，合并必须幂等。策略：existing 优先。
证据：`src/index.ts:421-426` — `existing ? { ...pc, ...existing } : { ...pc }`。

### 3. 中文指令推送方式

通过 `experimental.chat.system.transform` 推送，**必须用 `output.system.push(...)`**（`output.system` 是 `string[]`），赋值无效。
证据：`src/index.ts:807-809`。

### 4. 消息空 content 防御

`experimental.chat.messages.transform` 必须对 user 消息做**空 content 防御**：parts 为空或无 text part 时补齐至少一个 text part，否则 API 报 empty content。
证据：`src/index.ts:724-797`。

### 5. 权限策略：反向 deny + 少数 allow

- `co-council` → `council_session: 'allow'`，其余（含 `close_job`）deny。
- `co-orchestrator` / `co-orchestrator-gpt` → `close_job: 'allow'`，其余（含 `council_session`）deny。
- 其他代理两者都 deny。

证据：`src/index.ts:659-682`（运行时权限分支）+ `src/tools/job-control.ts:70-73`（工具层纵深防御），权限由显式白名单维护；新增同角色变体必须同步。

### 6. dispose 必须清理定时器

`dispose` hook 必须清理所有 `setInterval`/`setTimeout`。项目清理 `cleanupTimer` 与 `contextCleanupTimer`。
证据：`src/index.ts:816-819`。

## 构建流水线

4 步（`package.json:30` `build` script）：

1. `bun run scripts/generate-prompts.ts` — `src/prompts/*.md` → `src/prompts/*.ts`
2. `bun build src/index.ts src/tui.ts --outdir dist --target node --format esm`，external 清单：
   `@opencode-ai/plugin`、`@opencode-ai/plugin/*`、`@opencode-ai/sdk`、`@opencode-ai/sdk/*`、
   `@opentui/core`、`@opentui/solid`、`zod`
   **⚠️ `/*` 子路径通配不可漏**——否则子导出如 `@opencode-ai/plugin/tool` 会被错误打包。
3. `bun build src/cli/index.ts --outdir dist/cli`
4. `tsc --emitDeclarationOnly`

产物 `dist/` 被两处 `.gitignore` 排除：仓库根 `第 3 行` 与包级 `第 12 行`。

## 生成物禁忌

| 生成物 | 禁止原因 | 证据 |
|--------|---------|------|
| `src/prompts/*.ts` | 自动生成，源头是 `src/prompts/*.md` + `scripts/generate-prompts.ts` | 包级 `.gitignore:10`；生成器文件头含「自动生成，请勿手动编辑」 |
| `dist/` | `bun build` + `tsc` 编译产物 | 包级 `.gitignore:12` |

## 新增代理：必须同步 7 处

每处缺一不可，已核实行号：

1. **新建 `src/prompts/<name>.md`**（提示词源）
2. **`scripts/generate-prompts.ts:15-29`** 的 `AGENTS` 数组
3. **`src/index.ts` 四处**：`import`（`:3-15`）、`CHINESE_PROMPTS`（`:42-56`）、`agents` 数组（`:201-266`）、`loadFileOverrides` 的 `agentNames`（`:72-76`）
4. **`src/tui.ts:41-54`** 的 `DEFAULT_AGENTS()`
5. **运行构建**（`npm run build`）
6. **权限白名单**：`src/index.ts:659-682`（运行时权限分支）+ `src/tools/job-control.ts:70-73`（工具层纵深防御）
7. **CLI 模板**：`src/cli/config-io.ts:245-259`（`TEMPLATE_AGENTS`）+ `:394-408`（`agentSpecs`）

权限由显式白名单维护，**新增同角色变体（如 `co-orchestrator-gpt`）必须同步**上述第 6、7 处，不能依赖"按代理名自动处理"。

## 陷阱速查表

| 陷阱 | 后果 | 正确做法 |
|------|------|---------|
| `dispose` 漏清定时器 | 内存泄漏 | 清理所有 `setInterval`/`setTimeout` |
| `tool.execute.after` 返回值类型受限 | SDK 校验失败 | 只能返回 `string` 或 `{ title?, output, metadata?, attachments? }` |
| `tool.execute.before` 未删非法 arg | SDK 校验失败 | 删除非 `ses_` 前缀的 `task_id` 等非法字段 |
| TUI API 在 server 端使用 | 运行时崩溃 | `Slot`/`Prompt`/`theme` 等仅对 `tui` 导出有效 |
| `return { agent }` 当作官方字段 | 升级 SDK 时失效 | 非官方 Hooks 字段，升级后需重新验证 |

## 参考

- 包级详尽操作手册：`packages/oh-my-opencode-cohub/AGENTS.md`
- 本包自带应用规则目录（**4 个文件**）：`packages/oh-my-opencode-cohub/.opencode/rules/`——含 `Git工作流.md`、`上下文效率.md`、`方案可信性验证.md`、`发版规范.md`。注意 `opencode.json` 的 `instructions` 数组仅引用了其中 3 个（缺 `方案可信性验证.md`，实际文件存在但未被配置引用，可能是待补充项）。
- **版本敏感声明**：hooks 清单与类型签名基于 `@opencode-ai/plugin` 1.17.15 实测；官方 `opencode.ai` 文档本轮未能直连，部分结论来自类型声明推断。`experimental.*` 类 hook 属实验性，升级依赖后需重新校对全部 21 个 hook 属性。