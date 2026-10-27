# DSH 插件开发硬约束

违反即出 bug。只列必须/禁止类条款，每条带证据路径（仓库相对路径或 DSH 官方技能文档路径）。

## 一、插件两种形态

### npm 包形式（本项目）

- 源：`packages/dsh-cohub/src/*.ts`，产物：`packages/dsh-cohub/lib/`
- 通过 `cordis.patch.yml` 的 `insert` 挂到 host 组合，或写进 agent preset 的 `agent.cordis.yml`

### 动态插件

- 工具链：`co_define` → `co_run` → `co_stop` / `co_remove`
- 纯 JS 函数体，不编译，进程内生命周期，重启消失

## 二、npm 包导出契约

（`packages/dsh-cohub/src/index.ts:115-139`；L141-143 为测试用导出）

| 导出项 | 本项目取值 |
|--------|----------|
| `name` | `"cohub"` |
| `inject` | `["systemPrompt", "skills", "tools", "sessionProjections", "llm", "subagents"]`（6 个） |
| `Config` | `z.object({ councillors, skills, delegateEnvContract, delegateRetry, envSignatures, schedule, installPresets, councilTimeoutMs, councilProvider })`（**9 个**顶层字段；证据：`src/index.ts:118-139`） |
| `apply(ctx, config)` | 挂载入口 |

## 三、inject 约束与错误

`inject` 必须与实际使用的服务一致。不匹配时可能报**两条不同**错误之一：

- 用 `ctx.x` 形式访问未声明服务 → `service "x" is not declared`
- 直接属性访问（如 `ctx.timer`）未声明 → `cannot get property "timer" without inject`

出处：DSH 官方技能 `cordis-plugin-development` SKILL.md

## 四、双平面架构

- **Host 组合**：进程级单例（注册表 / 沙箱 / 审批 / 模型路由 / 会话持久化）。本机文件：`C:\Users\14023\.dsh\profiles\desktop\cordis.yml`
- **Agent Preset**：每会话挂载（工具 / persona / 提示词段 / compaction 策略）

## 五、preset 文件结构

### 目录组成

- `agent.cordis.yml`（行列表）+ `preset.yml`（`name` / `description`；**仅 shipped preset 额外有 `order`**）
- 可选 `skills/` 子目录

### 路径区分

- shipped preset 在**部署安装目录** `...\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-agent-presets\presets\`
- 用户自建 preset 在 `~/.dsh/.agent-presets/<id>/`

> 不要写成"preset 统一在 ~/.dsh/.agent-presets/"。

### agent.cordis.yml 行字段

每行含：`id` / `name` / `disabled` / `group` / `isolate` / `config`

- ⚠️ **无 `concurrency` 字段**（已证伪）
- ⚠️ `persona` **不是行字段**——它是独立插件行 `@deepseek-ai/dsh-persona`，其 `config` 含 `prefix` / `suffix`
- 组行 `cordis:group` 额外用 `config:` 数组存放子行

## 六、Host 级硬约束

### 6.1 禁止修改 shipped preset

实际存在的四个 shipped preset：`standard` / `cordis` / `minimal` / `ptc`（均已核实）。

- 文件在安装目录下，升级会被覆盖
- 编辑 `cordis` 会直接禁用创造模式本身
- 正确做法：`copy()` 后编辑副本

### 6.2 Service 隔离域

- preset 内发布 Service 的行**必须**包在 `cordis:group` 的 `isolate` realm 内
- 所有消费该 Service 的行也**必须**在同一 group 内
- 写法实例：`isolate: { planMode: true }`、`isolate: { compaction: true, toolResultPruner: true }`；`true` 表示 per-session 私有 realm
- 否则报：
  - `N row(s) did not activate: <id>: waiting for <service>`
  - `row(s) published process-global service(s) [<name>]`

### 6.3 tool-cordis 全进程唯一

`tool-cordis` 全进程只能挂一次。重复挂载会导致 inspect provider 撞名：

> `Host Cordis inspect provider "Service" is already registered`

出处：`packages/dsh-cohub/cordis.patch.yml:55-77` 注释（记录 v0.4.9 实际故障）

**禁止**在任何 bundle patch 或第二份 preset 里重复挂载。

### 6.4 persona 配置字段

必须用 `prefix`（required）/ `suffix`，**禁止**使用已废弃的 `text`。

旧字段导致整行挂载失败：

> `invalid config: - $.prefix missing required value`

出处：`packages/dsh-cohub/README.md:231-238`

### 6.5 standingKeyFor 挂载验证

改完 composition **必须**用 `standingKeyFor(id)` 做挂载验证。这是真正的验证，**不要**依赖 roster 的 `broken` 字段或已运行会话。

能检出四类失败：包不解析 / 配置无效 / 行未激活 / 服务泄漏到根 realm。

## 七、动态插件硬约束

- `code.host` / `code.client` 是**纯 JavaScript 函数体**：禁止 `import` / `require` / TypeScript 类型 / `as` / 装饰器 / JSX。Client 端 React 必须用 `React.createElement(...)`
- **Package 不可变**：修正必须新建 Package，不得覆盖失败的那个
- Client 端激活需用户审批：未授权时返回 `awaiting-approval`
- 所有副作用（事件监听 / Tool 注册 / Slot 注册 / 定时器 / 主题覆盖）必须在 stop/update/remove 时被清理：`ctx.on()` / `ctx.effect()` / disposer
- 可选 Service 用 `ctx.get(name)` + 判空；硬依赖才声明 `inject`
- Client→Host `host.call(method, args)` 参数与返回值**必须 JSON 无损**，禁止传函数 / React 元素 / 运行时对象
- **禁止**对内部实时数据对象（Service 实例 / Event 载荷 / Slot props / Conversation Snapshot）调 `JSON.stringify` 或 `structuredClone`，只提取所需叶子字段
- **动代码前先查真实签名**：`co_inspect_list` → `co_inspect_query`，不得凭 Service 名 / Event 载荷 / Slot props / 示例推断 API

### 七个运行时工具

（`packages/dsh-cohub/src/co-cordis-plugin.ts:20-205`）

| 工具 | 行号 | 作用 |
|------|------|------|
| `co_inspect_list` | L22 | 列出所有 Inspect Provider |
| `co_inspect_query` | L33 | 查询 Provider 的具体方法定义 |
| `co_inspect_self` | L51 | 查当前会话的自身动态插件 |
| `co_define` | L103 | 定义不可变 Package |
| `co_run` | L158 | 激活：`run`（首次/重启/回滚）或 `update`（切换同 Plugin 另一 Package） |
| `co_stop` | L184 | 停止运行，保留定义/授权/版本指针 |
| `co_remove` | L197 | 彻底删除，此后 pluginId / packageId 均失效 |

## 八、defineTool Schema DSL 规则

违反导致**启动时** `plugin tree failed to load`（可能伴随 `JsonSchemaError`），而 `bun build` **不报错**——最难查的一类坑。

完整参考：`packages/dsh-cohub/.opencode/rules/defineTool-schema.md`（105 行）

| # | 规则 | 说明 |
|---|------|------|
| 1 | 禁止 `required: false` | 默认可选 |
| 2 | `items` 内部禁止 `required` 数组 | 改在 `description` 说明 + 运行时检查 |
| 3 | `type: "object"` 必须显式声明 `additionalProperties` | 取值 `true` 或 `false` |
| 4 | 顶层参数**支持**逐属性 `required: true` | 合法，勿误判为禁止 |
| 5 | `type: "array"` 必须配套 `items` | |

## 九、陷阱速查表

| 陷阱 | 表现 |
|------|------|
| `inject` 不匹配 | `service "x" is not declared` 或 `cannot get property "x" without inject` |
| defineTool DSL 违规 | 启动时 `plugin tree failed to load`，`bun build` 不报错 |
| `subagents` 直接访问 | `ctx.subagents` 在 `cordis:include` 等 loader 下抛框架错误；必须用 `ctx.reflect.get('subagents', false)`（`src/index.ts:233-242`） |
| preset 中途切换 | 会话首次 turn 后即锁定，不能切换 preset（`README.md:295`），需新建会话 |
| 含 `skills/` 的 preset 复制 | `cp presets/<name>/*` 不包含子目录，必须用 `scripts/deploy-preset.ps1` |
| 用户改过的 preset 升级 | 被台账跳过、不自动更新（`README.md:271`） |
| `skills` 路由只配 `provider` 不配 `model` | 子代理回退到父代理模型名，若该模型不属于此 provider 则 `UNKNOWN_MODEL` 秒失败：`delegate` 返回 `subagent stopped with reason "error" after 0 retry(ies)`（`README.md:216`；v0.4.6 修复：改用 `ctx.llm.listModels(provider)` 取首个模型回退） |

## 十、构建与产物

### 构建五步

`bun run build` 等价于以下五步（`packages/dsh-cohub/package.json:40`），必须按此顺序：

1. `bun run scripts/generate-skills.ts` → 生成 `src/skills.ts`（源：`skills/*.md` + 脚本元数据）
2. `bun run scripts/guard-schema.ts` → 校验 Config schema 与 `cordis.patch.yml` 一致
3. `bun build src/index.ts --outdir lib ...` → 产物 `lib/index.js`
4. `bun build src/co-cordis-plugin.ts --outdir lib ...` → 产物 `lib/co-cordis-plugin.js`
5. `bun run scripts/build-client.js` → 产物 `lib/client.js`

### 生成物禁忌

`src/skills.ts` 与 `lib/` 均被 `.gitignore` 排除，**禁止手改**。修改技能内容必须编辑 `skills/*.md` 后重建。

## 十一、发版

详细步骤见 `docs/npm-release-setup.md`（日常发版流程）+ `packages/oh-my-opencode-cohub/.opencode/rules/发版规范.md`（权威）。硬要点：

- **禁止 `npm version`**：手改 `packages/dsh-cohub/package.json` 与 `package-lock.json` 的 `version`（lock 至少两处：顶层与 `packages[""].version`），否则 CI 的 `npm ci` 报 `EUSAGE`
- **CHANGELOG 是前置**：`packages/dsh-cohub/CHANGELOG.md` 自 0.6.0 起才建立，发版先补条目并用独立 `docs:` commit
- **README 与 CHANGELOG 同为前置**：发版前先改包内 README.md 首屏版本锚点（「本文对应 vX.Y.Z」）并同步受影响的正文说明；正文无需变更时在 commit message 里写明理由。详见发版规范「执行清单」
- **tag**：`dsh-vX.Y.Z`，annotated（`git tag -a ... <main-SHA>`），打前用 `git tag -l` + `git ls-remote --tags` 双重查重
- **发布只走 CI**：根 `.github/workflows/publish.yml` 用 OIDC `npm publish --provenance`，**不在本地 `npm publish`**
- **发布后必须重装验证**：CI 显示 `published` ≠ 用户装得上。走 `dsh plugin --profile web add dsh-cohub@X.Y.Z`（`dsh plugin` 是 pnpm 转发器；web profile 装 registry 版本，desktop 用 `link:` 验证不到 npm 产物），再查 `node_modules/dsh-cohub/package.json` 的 `version` + 重启后 `delegate` 工具是否在。不装 profile 的轻量替代：临时目录 `npm pack dsh-cohub@X.Y.Z --dry-run` 看 `lib/index.js` 非空。详见 `docs/npm-release-setup.md` →「发布后验证」

## 十二、参考

- 官方技能文档：
  - `C:\Users\14023\.dsh\.agent-presets\cohub-cordis\skills\cordis-plugin-development\SKILL.md`
  - `C:\Users\14023\.dsh\.agent-presets\cohub-cordis\skills\editing-cordis-compositions\SKILL.md`
- DSL 完整参考：`packages/dsh-cohub/.opencode/rules/defineTool-schema.md`
- 包源码与构建：`packages/dsh-cohub/src/`、`packages/dsh-cohub/README.md`
- **版本敏感**：本项目 `peerDependencies` 锁定 13 个 `@deepseek-ai/dsh-*` 为 `^0.1.0-rc.6`（外加 `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` / `react`）。DSH 处于 rc 阶段，SDK 接口可能变更。`rc.6` 是 **SDK 层独立版本线**，**不可**与 DSH Desktop 外壳版本号（2.0.11）直接对标。升级依赖后需重新校对本规范。

## 十三、常见故障与排查

以下四条均为 0.10.x 开发中真机实测踩到的坑，写法和 6.3 的 v0.4.9 复盘一致：现象 → 根因 → 修法，各带证据出处。

### 13.1 工具 / 命令注册成功 ≠ 能正常调用

**现象**：`/cohub-review` 注册后在 `/api/commands/list` 里能看到，但执行时永远返回

> `{"ok":false,"error":{"code":"gateway/internal","message":"command ... must return a CommandResult"}}`

用户看不到任何提示。

**根因**：`CommandDefinition.handler` 的返回值必须是 `CommandResult`（`{ kind: 'success' | 'error', text }`），只返回 `{ text }` 会在运行时被 `normalizeResult` 拒绝。`bun build` 与类型检查都不报错，因为返回类型写的是 `unknown` 或宽松对象。

**验证方法**：不要只看「命令出现在注册列表」，必须**真实执行一次**并检查返回的 `result.kind`。

### 13.2 fire-and-forget 里的异常必须落盘

**现象**：`/cohub-review` 返回「正在生成报告…」成功文案，但磁盘上只有采集统计、没有任何报告，日志里也查不到错误。

**根因**：报告生成是 fire-and-forget 异步任务，中间某步（`readSession` 的 live / replay 校验）抛错，被最外层 `catch` 吞成一条 `logger.warn`。而 warn 只走 stderr，**不落盘**——在 `~/.dsh/logs/` 里根本找不到，错误证据彻底丢失。

**修法**：异步任务的三层兜底——

1. 每步失败能降级就降级（如会话读不到就产出空报告并标记不完整）
2. 任何未捕获异常写 `error-<时间戳>.json` 落盘
3. 同时追加到 `_errors.log`

**判断标准**：如果一次失败不会在磁盘上留下任何痕迹，这个错误处理就是不合格的。

### 13.3 LLM 结构化输出的两处陷阱

**现象**：复盘分析的 findings 全部为空，但 `analysis.error` 里附带的模型原始输出开头是合法的 JSON 数组。

**根因有两个，且会叠加**：

1. **输出被 maxTokens 截断**——13 个会话的统计摘要要输出十几条结论，2000 token 远远不够
2. **解析用「最后一个 `]`」定位数组结尾**——输出被截断时根本没有 `]`，`lastIndexOf` 返回 -1，解析直接返回 null 并丢弃整份结果，且不报错

**修法**：

1. `maxTokens` 按输出规模设足（结构化输出建议 4000-6000）
2. 解析改为**括号配对扫描**（正确处理字符串内的转义），支持剥 Markdown 围栏、修尾随逗号
3. 截断时**逐个抢救完整对象**并标记 `interrupted`，而不是全丢
4. 失败时把 `rawOutput`（前 2000 字）与 `rawOutputLength` 落进报告，否则无法判断是截断还是格式问题

**判断标准**：解析失败时必须能回答「模型到底输出了什么、有没有被截断」。

### 13.4 发版前必须确认 tag 没被打过，且 tag 指向含改动的提交

**现象**：`0.10.0` 发布到 npm 后才发现内容残缺——缺了三个本应包含的功能。

**根因**：`dsh-v0.10.0` tag 在开发过程中就被打过并推送，指向的提交早于后续三项改动；`publish.yml` 的 `actions/checkout` 不带 ref 参数，取的是**tag 指向的 commit**，于是后续改动全部没进包。同版本号不可重发，只能发 `0.10.1` 补救并在 CHANGELOG 里说明。

**发版前必须逐条确认**：

1. `git status --porcelain` 为空
2. `git show HEAD:packages/<pkg>/package.json | grep '"version"'` 与预期版本一致
3. `git ls-remote --tags origin | grep <tag>` **无输出**（远程没打过）
4. `git tag -l "<tag>"` **无输出**（本地没打过）
5. README 锚点与 package.json 版本一致（CI 会校验）
6. **确认 tag 指向的 commit 含全部要发的改动**——用 `git log --oneline <上次tag>..HEAD` 核对

**发布后验证**：CI 显示 `success` 不等于能装。必须 `npm pack <pkg>@<version>` 解包，用 grep 逐个确认**本版新增的关键符号**确实在 `lib/index.js` 里。

注意 npm 有约 1-2 分钟传播延迟，`npm view` 首次查不到是正常的，别急着判定失败。

出处：0.10.0 → 0.10.1 实际事故（`packages/dsh-cohub/CHANGELOG.md`）；本章 13.4 是对第十一章「发版」tag 检查的双重查重条款的补充。