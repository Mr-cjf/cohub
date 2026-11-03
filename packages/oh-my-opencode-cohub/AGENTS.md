# oh-my-opencode-cohub

OpenCode 中文智能体编排插件。TypeScript ESM，通过 `@opencode-ai/plugin` SDK 注册 13 个 agent（12 专职 + co-orchestrator-gpt 变体）+ 中文注入 + TUI 面板。

## 代理清单

| Agent | 角色 |
|-------|------|
| `co-orchestrator` | 纯调度——分析需求→委派→审核 |
| `co-orchestrator-gpt` | GPT 专用纯调度变体（mode: primary，DS 用户继续用 co-orchestrator） |
| `co-oracle` | 架构审查 / 代码审查 / YAGNI 简化 / 复杂调试 |
| `co-librarian` | 官方文档 / API / GitHub 研究（只读+Web） |
| `co-explorer` | 代码库搜索定位——grep / glob / AST（只读） |
| `co-designer` | UI/UX 设计实现 / 视觉润色 / 响应式布局（读写） |
| `co-fixer` | 代码修改 / 构建 / 测试执行（读写+Bash） |
| `co-observer` | 图片 / PDF / 截图视觉分析（只读） |
| `co-council` | 多模型并行共识（不可逆决策用） |
| `co-rule-user` | 用户级 `~/.config/opencode/AGENTS.md` 分析 |
| `co-rule-project` | 项目 `AGENTS.md` + 仓库根 `.rules/*.md` 规范分析 |
| `co-rule-app` | `.opencode/rules/*.md` 分析 |
| `co-planner` | 方案制定——综合需求+信息+规范输出任务分解 |

## dsh-cohub（DeepSeek Harness 版插件，同仓库兄弟包）

DSH 移植版现在是本 monorepo 内的兄弟包 `packages/dsh-cohub`（remote 只有 `git@github.com:Mr-cjf/cohub.git`，三个原独立仓库已归档）。13 个 co-* skill（12 专职代理 + `co-cordis`）以 runtime skills 注册 + 中文指令 section + council 共识工具 + co-orchestrator preset。

- 构建：`cd packages/dsh-cohub && npm run build`（prepublishOnly 自动构建）
- 单测（无需 LLM）：`node test/unit.ts`
- ⚠️ `lib/` 与生成的 `src/skills.ts` 都在 `.gitignore` 中，干净 clone 后必须先 build 才能跑测试
- 本机 DSH Desktop 已安装（junction `%APPDATA%\dsh-desktop\harness\profiles\node_modules\dsh-cohub` → 本仓库 `packages/dsh-cohub`）
- 分发：npm publish 后用户 `dsh plugin --profile web add dsh-cohub`

## 构建

**前提**：bun 必须系统安装（非项目 devDependency）。

```bash
npm run build
```

完整 4 步（`package.json` `build` script）：
1. `bun run scripts/generate-prompts.ts` — 将 `src/prompts/*.md` → `src/prompts/*.ts`
2. `bun build src/index.ts src/tui.ts src/v2/index.ts --outdir dist --target node --format esm`（external 依赖见下方列表）
3. `bun build src/cli/index.ts --outdir dist/cli --target node --format esm`
4. `tsc --emitDeclarationOnly`

外部依赖不打包：`@opencode-ai/plugin`、`@opencode-ai/sdk`、`@opentui/core`、`@opentui/solid`、`zod`。
⚠️ `dist/v2/index.js` **不得**包含 `@opencode-ai/plugin` 的静态 import（2.x 宿主没装该包），构建后请确认：

```bash
grep -c '@opencode-ai/plugin' dist/v2/index.js   # 应为 0
```

`dist/` 在 `.gitignore` 中。

## 源码地图

| 找什么 | 去哪里 |
|--------|--------|
| 插件入口（agent 注册、hook、消息转换） | `src/index.ts` |
| **OpenCode 2.x 入口**（`./server` 子路径） | `src/v2/index.ts` |
| **2.x 兼容层**（v2 ctx → v1 PluginInput） | `src/v2/compat.ts` |
| **2.x 事件桥接**（v2 事件 → v1 语义） | `src/v2/events.ts` |
| **2.x 定义转换**（prompt/model/permission 词汇） | `src/v2/adapt.ts` |
| **跨代工具形状**（不依赖宿主包） | `src/tools/portable.ts` |
| TUI 侧边栏面板 | `src/tui.ts` |
| 13 个 agent 提示词源文件（人工编辑） | `src/prompts/*.md` |
| 提示词自动生成文件（勿手动编辑） | `src/prompts/*.ts` |
| 提示词生成脚本 | `scripts/generate-prompts.ts` |
| 上下文共享系统 | `src/context/`（types / strategy / extractor / formatter / engine / diag-log） |
| 编排引擎（契约 / 调度 / 重试） | `src/orchestration/`（index.ts / contract.ts / engine.ts / retry.ts / scheduler.ts / types.ts） |
| 跨包共享层（⚠️ 生成物，勿直接编辑） | `src/shared/`（由 `bun cohub-shared/sync.ts` 从 `cohub-shared/src/` 同步，见 `cohub-shared/README.md`） |
| 多模型共识工具 | `src/tools/`（council.ts / model-stats.ts / adaptive-params.ts / job-control.ts） |
| CLI 安装/卸载 | `src/cli/`（index.ts / config-io.ts） |
| Background Job Board 追踪器 | `src/task-manager/`（types.ts / tracker.ts / quality.ts / stats.ts） |
| 用户配置文件加载 | `src/config/loader.ts` |
| 中文指令文本 | `src/instructions/chinese.ts` |

## 关键架构约定

- **双入口共包**：`exports["."]`（1.x，默认导出是 `(input, options) => Hooks` 函数）与 `exports["./server"]`（2.x，默认导出是 `{ id, setup }`）并存。2.x 优先解析 `./server`，1.x 只读根导出。**改任何一侧都要确认另一侧仍可加载**
- **2.x 不重写编排逻辑**：`src/v2/` 只负责把 v2 的 `ctx` 翻译成 v1 形状，然后复用 `src/index.ts` 的工厂。业务模块（context / orchestration / task-manager / tools）保持单一实现
- **工具必须产出中立形状**：`src/tools/*` 只导出 `PortableToolDefinition`（`{ description, args, execute }`），由入口层分别包装。**禁止在工具模块里直接 import 宿主包**——2.x 不装 `@opencode-ai/plugin`，静态导入会让整个模块图解析失败
- **双重注册（仅 1.x）**：代理通过 `return { agent }` + `config` hook 写入。2.x **没有 config hook**，改由 `AgentEditor.default()` 表达默认代理
- **中文注入**：1.x 走 `experimental.chat.system.transform`；2.x 走 `session.hook('context')`。两者都在适配层统一
- **Background Job Board**：1.x 走 `experimental.chat.messages.transform`；2.x 同样走 `session.hook('context')`，由 `toV1Messages` / `applyV1Messages` 做消息形状双向适配
- **TaskTracker**：`tool.execute.before` 注册任务 → `tool.execute.after` 更新状态（两代同名）
- **TUI state**：写入 `~/.local/share/opencode/storage/oh-my-opencode-cohub/`，TUI 面板每 250ms 轮询。**2.x 目前不带 TUI**

## 2.x 迁移备忘（实测 OpenCode Desktop 2.2.5）

| 项 | 1.x | 2.x |
|---|---|---|
| 插件形态 | 文件或目录 | **必须是目录**（含 `package.json`），单文件被拒：`configured plugin path must be a directory` |
| 导出契约 | `async (input, options) => Hooks` | `{ id, setup(ctx) }` |
| 包名 | `@opencode-ai/plugin` | `@opencode/plugin` / `@opencode/schema` / `@opencode/client` |
| 配置字段 | `agent` / `provider` / `plugin` / `mcp` | `agents` / `providers` / `plugins` / `mcp.servers` |
| 代理新增 | `agent` 配置直接声明 | `ctx.agent.transform` + `update(id, fn)`（**对未知 id 会创建**，无 `add`） |
| `config` hook | 有 | **不存在** |
| `session.idle` 事件 | 有 | **没有**，改用 `session.hook('experimental.idle')` |
| agent prompt 字段 | `prompt` | `system` |
| 权限 | `permission: { tool: 'deny' }` | `permissions: [{ action, resource, effect }]` |
| 消息形状 | `{ info: { role }, parts: [] }` | `{ role, content: [] }` |
| session 入参 | `{ path, body, query }` | 扁平 `{ sessionID, ... }` |


## 操作手册

### 修改提示词

⚠️ **编辑 `src/prompts/*.md`（Markdown 源文件）**，不要编辑 `src/prompts/*.ts`（自动生成，会被覆盖）。

运行时覆盖优先级（高→低）：
1. `.opencode/oh-my-opencode-cohub/{agent}.md`（项目级文件替换）
2. `~/.config/opencode/oh-my-opencode-cohub/{agent}.md`（用户级文件替换）
3. 内置提示词（`src/prompts/*.md`）

### 添加新代理（以 `co-foo` 为例）

必须修改 **5 个位置**，缺一不可：

| # | 操作 | 文件 |
|---|------|------|
| 1 | 创建提示词源文件 | `src/prompts/foo.md` |
| 2 | 注册到生成脚本 | `scripts/generate-prompts.ts` → `AGENTS` 数组 |
| 3 | 注册到插件入口（**4 处**）：import、`CHINESE_PROMPTS`、`agents` 数组、`loadFileOverrides` 的 `agentNames` | `src/index.ts` |
| 4 | 注册到 TUI 兜底列表 | `src/tui.ts` → `DEFAULT_AGENTS()` |
| 5 | 构建 | `npm run build`（自动执行 generate-prompts） |

> **同角色变体（如 `co-orchestrator-gpt`）额外必须同步**：权限白名单（`src/index.ts` 权限分支与 config hook 权限键级合并**两处** + `src/tools/job-control.ts` 工具层纵深防御）与 CLI 模板（`src/cli/config-io.ts` 的 `TEMPLATE_AGENTS` / `agentSpecs`），缺一不可。

### 运行测试

```bash
bun test
# 等效命令：npm run test
```

测试覆盖 `src/**/*.test.ts`，共 **13 个**测试文件：

| 目录 | 测试文件 |
|------|----------|
| `src/context/` | `engine` / `extractor` / `truncate` |
| `src/orchestration/` | `contract` / `engine` / `retry` / `scheduler` |
| `src/task-manager/` | `quality` / `stats` / `tracker` |
| `src/tools/` | `adaptive-params` / `council` / `model-stats` |

（`package.json` 的 `test` 脚本等价于 `bun test ./src`。）

### 发版

权威流程见 `.opencode/rules/发版规范.md`。关键步骤：
1. 更新各包 `README.md`（首屏版本锚点 + 受影响正文），详见 `.opencode/rules/发版规范.md`
2. 更新 `CHANGELOG.md`（独立 docs commit）
3. **准备版本不提前打 tag**：直接编辑 `package.json` 与 `package-lock.json` 的 `version` 并独立 chore commit；**不使用 `npm version`**（避免其自动 commit / 打 tag / 触发 lifecycle）
4. 合并到 main 后，对已核实的 main SHA 打 **annotated** 标签 `opencode-vX.Y.Z`（`git tag -a "opencode-vX.Y.Z" -m "release X.Y.Z" <main-SHA>`），确保使用 SSH remote 后 `git push --follow-tags`
5. 发布由根仓库 Publish to npm workflow（OIDC 身份）执行，**不在本地运行 `npm publish`**

## 常见陷阱

| 陷阱 | 后果 | 正确做法 |
|------|------|---------|
| 直接编辑 `src/prompts/*.ts` | 下次 `npm run build` 覆盖修改 | 编辑 `src/prompts/*.md` 后 `npm run build` |
| 添加代理忘记更新 `scripts/generate-prompts.ts` | `.md` 不会生成 `.ts`，构建报错 | 步骤 2 不可跳过 |
| 添加代理只改 1 处 `src/index.ts` 位置 | 代理不生效或 `loadFileOverrides` 漏掉 | `src/index.ts` 中需改 **4 处** |
| 系统未安装 bun | `npm run build` 失败 | `npm install -g bun` 或使用系统的 bun |
| 忘记 `git push --follow-tags` | tag 未推送，CI 不触发 npm 发布 | 发版步骤 4 不可遗漏 |
| 在 `master`/`test`/`dev` 分支执行 git 提交技能 | 违反分支保护约定 | 仅在功能分支使用提交和发版技能 |

## 外部依赖与配置

- **运行依赖**：`@opencode-ai/plugin`、`@opencode-ai/sdk`
- **可选依赖**：`@opentui/solid`、`@opentui/core`（仅 TUI 需要）
- **devDependencies**：`typescript`、`@types/node`
- **插件标记**：`package.json` 中 `"opencode": { "plugin": true }`
- **用户配置**：运行时从 `~/.config/opencode/oh-my-opencode-cohub.json` 加载
