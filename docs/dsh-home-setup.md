# DSH 本机配置（重装迁移清单）

> 这些改动在 `~/.dsh/` 下，**不进 git**。重装 DSH / 换机器后需要照本文重建。
> 每项包含：为什么这么配 / 改哪个文件 / 目标片段（逐字）/ 如何验证 / 如何回滚 / 收益与代价。
>
> 盘点时间：2026-10-26（对应 `dsh-cohub` v0.8.0、DSH Desktop 运行时 0.2.1-rc.2）
> 本文只描述**目标态**；同目录下的 `*.bak-cohub-*` 是**回滚用**的历史版本，不是重建依据。

**通用铁律**

1. `~/.dsh/profiles/*/cordis.patch.yml` 是 YAML **数组**，条目之间靠 `- ` 对齐；新增条目直接追加，不写逗号。
2. `package.json` 是 JSON，**不能写注释**；删条目时必须同时处理前一行的逗号。
3. 任何 `cordis.patch.yml` 改动后，`patchReload: live` 通常热生效；涉及 preset 结构（章节 1）建议重启 DSH 再验证。
4. 本机 `~/.dsh/profiles/node_modules/@deepseek-ai/*` 指向 DSH Desktop 的 0.1.5-rc.2，**不是**运行时版本；字段名一律以 `DeepSeek Harness\resources\app.asar` 内 0.2.1-rc.2 源码为准。

---

## 0. 迁移前对齐基线

重建前先确认这几件事，否则片段贴进去也不会生效：

| 项目 | 目标值 | 本机实际 |
|---|---|---|
| `dsh-cohub` 版本 | `0.8.0` | `0.8.0`（`packages/dsh-cohub/package.json`） |
| desktop profile 的 `dsh-cohub` 依赖 | 本地源码 link | `link:C:/Users/14023/myproject/cohub/packages/dsh-cohub` |
| `node_modules/dsh-cohub` | 指向该 link | `..\..\..\..\myproject\cohub\packages\dsh-cohub` |
| 编排 preset | 4 个均已安装 | `co-orchestrator` / `cohub-cordis` / `cohub-subagent-readonly` / `cohub-subagent-write` |
| 使用的 profile | desktop（主）+ web | 两套都在；本文以 **desktop** 为主，web 单列章节 4 |

> 注意：desktop profile 里**同时存在**两份 co-orchestrator 定义 —— 一份是 `cordis.patch.yml` 里用 `insert:` 声明的**声明式 preset**（`id: preset-co-orchestrator`），另一份是 `~/.dsh/.agent-presets/co-orchestrator/` 下的**文件式 preset**（由插件自动装）。`agent-preset-registry.selectedDefault: co-orchestrator` 指向后者，声明式那份是历史并存项，两者 id 不同、互不覆盖。重建时**两份都要有**才与本机一致（见 `docs/dsh-home-setup.md` 附录 C 的说明）。

---

## 1. 关闭 github MCP（每请求省 ≈6,487 tokens）

### 为什么

`mcp__github__*` 共 **23 个工具**，schema 每请求全量重发，约 **6,487 tokens**（占当时工具税的 36.6%）。`compaction` 与 `tool-result-pruner` 都削不掉它（它们只管结果和上下文，不管工具声明）；`subagent` 子代理继承父 preset 工具表，于是**每一个子代理**都重复付这笔钱。实测近 7 天该 MCP **0 次调用**。

### 改哪个文件

只有一处：`~/.dsh/profiles/desktop/cordis.patch.yml`，位置在 `insert:` → `id: preset-co-orchestrator` → `plugins:` 数组内，紧跟 `compaction` group 之后、`agent-instructions` 之前（当前文件 415–430 行）。

> ⚠️ 注意层级：原条目是**挂在 preset 内**的，不在文件顶层。如果贴到顶层，它会变成 host 级工具行 —— 那样所有 profile、所有 preset 的会话都会看到 github 工具，和本机现状不一致。顶格缩进不能改。

### 目标片段（节选，逐字来自当前文件，缩进 10 空格）

```yaml
          # ── cohub tokenfix 2026-10-23：github MCP 停用 ──────────────────────────
          # 原因：mcp__github__* 23 个工具 schema 每请求全量重发（≈6,487 tokens，占工具税
          #       36.6%），compaction 削不掉，子代理还继承 → 每轮净省 6,487 tokens。
          # 恢复：删掉下列各行开头的注释符即可（原件备份 cordis.patch.yml.bak-cohub-tokenfix）。
          # - id: mcp-github
          #   name: '@deepseek-ai/dsh-mcp-client'
          #   config:
          #     transport: stdio
          #     serverName: github
          #     command: 'C:\Users\14023\.dsh\bin\github-mcp-server.exe'
          #     args:
          #       - stdio
          #       - --read-only
          #       - --toolsets=context,repos,issues,pull_requests
          #     env:
          #       GITHUB_PERSONAL_ACCESS_TOKEN: !!js process.getBuiltinModule('fs').readFileSync('C:/Users/14023/.dsh/github.token','utf8').trim()
```

**恢复**（要重新启用 github MCP 时）：删掉上面 12 行里每行开头的 `# `（注释符 + 一个空格），缩进保持不变 —— 即 `          # - id: mcp-github` 变成 `          - id: mcp-github`，`          #   name:` 变成 `          -   name:` 需还原成 `            name:`。**逐行还原最容易出错**，直接用备份更稳：

```powershell
# 更安全的恢复方式：从原件备份里把这一段取回来（备份含未注释的原始条目）
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-cohub-tokenfix" `
  -Pattern 'id: mcp-github' -Context 0,12
```

### 前提文件（恢复前必须还在）

| 文件 | 本机状态 |
|---|---|
| `C:\Users\14023\.dsh\bin\github-mcp-server.exe` | 存在，26,080,768 字节 |
| `C:\Users\14023\.dsh\github.token` | 存在，40 字节（PAT） |

这两个文件也**不在 git 里**。换机器重建时如果还需要 github MCP，得重新下载 `github-mcp-server.exe` 并写入新 PAT；不需要的话，保持停用即可，这两项可以不管。

### 如何验证

重启 DSH 后看工具列表：`mcp__github__*` 应该**完全不存在**，工具总数比开启时少 23 个。或跑附录 A 的自检脚本，`github MCP 已停用` 一项应显示 `[ OK ]`。

### 如何回滚

- 手工：按上面「恢复」把注释符删掉。
- 或直接还原备份：`cordis.patch.yml.bak-cohub-tokenfix`（35,929 字节，tokenfix 之前的状态）。注意该备份**早于** spill 阈值改动，整文件覆盖会丢掉章节 2。

### 收益 / 代价

- **收益**：每请求净省 ≈6,487 tokens（主代理与每个子代理各一份）。
- **代价**：失去 GitHub MCP 的 read-only 检索能力。替代方案：`co-librarian` 走 `web_search`/`domain_search` 的 `github` 引擎，或在本仓库内直接用 `grep`/`glob`（本地 checkout 已足够）。`platform_search(github)` 也是轻量替代。

---

## 2. spill 节流阈值（`maxInlineTokens: 4096`）

### 为什么

`@deepseek-ai/dsh-spill-policy` 决定**单次工具结果有多少 token 能内联进上下文**，超出部分落盘并在上下文里留 locator。默认 `12500`，一次 `grep` / `web_fetch` / `job_output` 的大输出就会吃掉上万 token。收紧到 `4096`（≈16KB 文本）后，典型大输出只内联 1/3，其余可再取。

**字段名必须写 `maxInlineTokens`**：schemer 对未知键静默丢弃，写成 `maxInlineBytes` 不报错、不告警、与不配完全等价。运行时源码（app.asar 内 0.2.1-rc.2）的 Config 只有 `{ maxInlineTokens: z.number() }`，且 `apply()` 首行 `if (cap === void 0) return;` —— 省略即彻底 no-op。

### 改哪个文件

`~/.dsh/profiles/desktop/cordis.patch.yml`，**顶层数组条目**（当前 794–797 行，前面 770–793 是解释性注释块）。这条不是新增实例：`applyEntryPatches` 会按 id 命中 `dsh-base` 里那份 `spill-policy` 并**整值覆盖**其 config，全进程仍是单实例。

### 目标片段（逐字）

```yaml
- id: spill-policy
  name: '@deepseek-ai/dsh-spill-policy'
  config:
    maxInlineTokens: 4096
```

### 已知边界（别指望它管住 `read`）

运行时在结果决策处对 `read` 显式跳过（`if (... || exec.name === "read") return decision;`）。所以本项只收 `grep` / `glob` / `pwsh` / `web_search` / `web_fetch` / `job_output` / `delegate` 的巨大结果；读文件本身不受控。`PTC run_code` 子调用另由日志裁剪负责（不进模型上下文）。

### 如何验证

`grep` 一个大目录后，结果被截断且带 locator 提示即生效；或跑自检脚本看 `spill-policy maxInlineTokens = 4096` 为 `[ OK ]`。

### 如何回滚

删掉这 4 行（回到 dsh-base 默认 12500）。备份：`cordis.patch.yml.bak-cohub-spillfix`（36,323）/ `-spillfix2`（37,218）/ `-spillfix3`（37,902），是调这个阈值过程中的三个中间态。

### 收益 / 代价

- **收益**：单次超长结果的内联量降到原来的 ≈33%（4096 / 12500），按推算可省 2/3 的峰值工具输出 token。
- **代价**：被落盘的部分模型当场看不到，需要 `read` 那个 spill 文件才能看全文 —— 多一次往返。阈值越小越省 token、越多往返，4096 是本机实测的平衡点。

---

## 3. 移除 dsh-taskboard bundle（每请求省 ≈2,540 tokens）

### 为什么

`dsh-taskboard` 在 bundle 层注册了整套工具与 UI 投影，实测约占 **2,540 tokens**/请求，而本机不使用它的看板工作流。

### 改哪个文件

`~/.dsh/profiles/desktop/package.json`，两处都要改：

1. `dsh.profile.bundles` 数组里删掉 `"dsh-taskboard"` 这一整行；
2. `dependencies` 里删掉 `"dsh-taskboard": "<版本>"` 这一整行。

**JSON 不能注释，只能删行**。删数组中间元素要连带删掉它那一行的逗号；删最后一个元素要删掉**前一行**末尾的逗号。

### 目标片段（节选，逐字来自当前文件）

`dependencies` 中 cohub 相关的两行（`dsh-taskboard` 已不在其中）：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh-typert-protocol": "0.1.5-rc.2",
    "@dsh-external/dsh-clawd-bridge": "link:C:/Users/14023/.clawd/integrations/deepseek-harness/homes/d0232706eb982c76ad57de59fc8f86719874186754759c95e53876ff074ec2ac/generations/596f1f37cfc23031fa06f1ed8c3d28a10fa6c69d434ea42e18fb31396844a5cf",
    "@laoyuehanni/dsh-git-worktree": "0.4.12",
    "@liustack/modsearch": "5.10.10",
    "dsh-better-sidebar": "0.28.0",
    "dsh-codearts-auth": "2.6.261026",
    "dsh-cohub": "link:C:/Users/14023/myproject/cohub/packages/dsh-cohub",
    "dsh-context": "0.77.0",
    "dsh-free-search": "0.9.16",
    "dsh-rewind-plugin": "0.19.0",
    "dsh-share": "0.5.0",
    "dshmarket": "1.66.42",
    "upstream-radar": "0.45.0"
  },
```

`dsh.profile.bundles` 完整现状（16 项，无 `dsh-taskboard`）：

```json
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-share",
        "dsh-better-sidebar",
        "upstream-radar",
        "@liustack/modsearch",
        "dsh-cohub",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@deepseek-ai/dsh-experimental-inspector-profile",
        "dshmarket",
        "@laoyuehanni/dsh-git-worktree",
        "@dsh-external/dsh-clawd-bridge",
        "dsh-codearts-auth",
        "dsh-context",
        "dsh-free-search",
        "dsh-rewind-plugin"
      ],
      "patchReload": "live"
    },
```

### 连带清理（可选）

- `pnpm-workspace.yaml` 里还留着 `dsh-taskboard@0.4.3 || 0.9.6` 白名单行（当前 11 行）。它无害（包已不装），想干净可以删。
- `~/.dsh/dsh-taskboard.json`（86 字节，`{"schemaVersion":1,"revision":1,"tasks":[],"settings":{"defaultIsolation":"worktree"}}`）与 `~/.dsh/dsh-taskboard-templates.json`（2,564 字节）是残留数据文件。**本机保留未删**；重建时不需要它们。
- `node_modules/dsh-taskboard` 已不存在（确认过）。

### 如何验证

重启后 GUI 里**看板页消失**；`package.json` 能被 `JSON.parse` 解析（逗号处理对了没）。自检脚本 `dsh-taskboard 已从 bundles 移除` 应为 `[ OK ]`。

### 如何回滚

`package.json.bak-cohub-notaskboard`（1,692 字节）—— 移除 taskboard 之前的完整文件（注意它同时还带着 `dsh-extension-hub`、更早的 `dsh-codearts-auth`/`dsh-context`/`dsh-free-search`/`dsh-rewind-plugin` 版本，**不是**只回滚 taskboard 一项）。只想单独装回来，就在 `bundles` 与 `dependencies` 各加一行 `"dsh-taskboard": "0.9.6"`。

### 收益 / 代价

- **收益**：每请求 ≈2,540 tokens。
- **代价**：**GUI 看板页一起消失**，任务看板功能不可用（`todo_write` 仍在，那是另一个插件，不受影响）。若将来要用看板，装回 bundle 即可恢复。

---

## 4. pnpm 白名单（`minimumReleaseAgeExclude`）

### 为什么

pnpm 的 `minimumReleaseAge` 策略会把「刚发布不久」的版本从解析候选里排除。cohub 发版后立刻在本机安装时，新版本会被拦下、装到旧版本。`minimumReleaseAgeExclude` 是白名单：按 `<包名>@<版本> || <版本> || ...` 语法逐个放行。

### 文件 A：`~/.dsh/profiles/desktop/pnpm-workspace.yaml`（全文，18 行，逐字）

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
minimumReleaseAgeExclude:
  - dsh-context@0.23.0 || 0.29.0 || 0.52.1 || 0.73.3 || 0.77.0
  - dsh-better-sidebar@0.15.0
  - upstream-radar@0.40.0
  - dsh-rewind-plugin@0.3.1 || 0.17.0
  - dsh-taskboard@0.4.3 || 0.9.6
  - '@liustack/modsearch@5.10.10'
  - dsh-free-search@0.9.6 || 0.9.11 || 0.9.16
  - dshmarket@1.66.42
  - dsh-codearts-auth@1.10.261021 || 2.6.261026
  - '@laoyuehanni/dsh-git-worktree@0.4.12'
allowBuilds:
  node-pty: false
```

> desktop 侧**没有** `dsh-cohub` 白名单行 —— 因为它是 `link:` 本地源码，不走 registry，不需要放行。

### 文件 B：`~/.dsh/profiles/web/pnpm-workspace.yaml`（全文，10 行，逐字）

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
# dsh-cohub 已切到本地源码（file:../..），其中已包含 0.4.4 那个 patch 的内容
# （fix(delegate): 移除非法 required:false），故 patchedDependencies 条目停用。
# 备份见 pnpm-workspace.yaml.bak.20260915-cohub046
minimumReleaseAgeExclude:
  - dsh-cohub@0.4.11 || 0.5.0 || 0.5.1 || 0.6.0 || 0.7.0
```

> ⚠️ **已知缺口：web 白名单只放行到 `0.7.0`，没有 `0.8.0`。**
> 若将来在 web profile 里从 registry 安装 `dsh-cohub@0.8.0`，会因 `minimumReleaseAge` 被拦（提示找不到匹配版本或回落到旧版）。
> **届时**把该行改成：
>
> ```yaml
>   - dsh-cohub@0.4.11 || 0.5.0 || 0.5.1 || 0.6.0 || 0.7.0 || 0.8.0
> ```
>
> 目前 web profile 的 `package.json` 里 `dsh-cohub` 仍是 registry 版本 `0.7.0`（不是 link），所以**现在不改也不会出错** —— 本节只是提前登记。

### 如何验证

```powershell
# desktop：确认白名单结构可解析（无引号漏写）
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\pnpm-workspace.yaml" | Select-String 'minimumReleaseAgeExclude' -Context 0,11
```

要验证「新版本是否真能装」，在该 profile 目录跑 `pnpm up dsh-cohub@<版本>`（会改 lock，属真操作，别在只做自检时跑）。

### 如何回滚

- desktop：`pnpm-workspace.yaml.bak-cohub-npmswitch`（501 字节）
- web：`pnpm-workspace.yaml.bak-cohub-0.7.0`（379 字节，加 0.7.0 之前）/ `.bak-cohub-0.6.0`（370 字节，加 0.6.0 之前）

### 收益 / 代价

- **收益**：本机能立刻装上刚发布的版本，不必等 `minimumReleaseAge` 窗口过去。
- **代价**：白名单里的版本**跳过了「发布多久算稳定」的保护**。放行刚发布的 0.8.0 意味着承担它第一天就带 bug 的风险（本项目 0.8.0 是本地 link 自测过的，风险可控；换其它包时要想清楚）。白名单只增不减会越来越长，本机 desktop 侧已积了 `dsh-taskboard` 这条无用项。

---

## 5. 子代理 preset（自动安装，**无需手工**）

### 为什么不需要手工做

`cohub-subagent-readonly` 与 `cohub-subagent-write` 由 `packages/dsh-cohub/src/preset-install.ts` 在插件加载时**自动复制**到 `~/.dsh/.agent-presets/`，并写安装台账 `~/.dsh/.cohub-preset-install.json`（故意放在 preset root 的**上一级**，避免被 roster 当成一个 preset 目录）。

升级逻辑（决定了「什么时候该手工介入」）：

| 情况 | 行为 |
|---|---|
| 台账无此 id、目录也不存在 | 全量复制，视为首次安装 |
| 台账无此 id、目录已存在 | 只把与包内**语义相同**的文件纳入台账（`adopt`），不覆盖 |
| 台账版本 = 当前包版本 | 什么都不做 |
| 台账版本 ≠ 当前包版本 | 逐文件比对：**当前哈希 ≠ 台账哈希 → 用户改过 → 跳过并告警**；相等或不存在的用包内新版覆盖 |
| 台账有、包内已无该 preset | 递归删除该 preset 目录（孤儿清理） |

所以：**一般情况下什么都不用做**；只有当你手改过 preset 文件、又想跟随上游时，才需要 `rm -r ~/.dsh/.agent-presets/<id>` 让它重装。

### 台账现状（`~/.dsh/.cohub-preset-install.json`，逐字节选）

```json
{
  "version": 1,
  "presets": {
    "co-orchestrator": {
      "version": "0.8.0",
      "files": {
        "agent.cordis.yml": "77dd3ce8f858113388f518f01638f9f46c61f5e9b9b00a13287229a57bf78a66",
        "preset.yml": "b9a014a0fee9ee68c43a905e6372385972ef57f0c27b2c25c57cb078d9d65abc"
      }
    },
    "cohub-cordis": {
      "version": "0.8.0",
      "files": {
        "agent.cordis.yml": "43bc4d9461271f9707b851ce9eb211b5558b927b3f6274c3fb4fbcbe4dae4935",
        "preset.yml": "d1d28a74aa5825247ee99a215bd025e62266165f274092822acfe1497a2b548e",
        "skills/cordis-plugin-development/SKILL.md": "01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa",
        "skills/editing-cordis-compositions/SKILL.md": "861b3b8b798344ce22890da844b464f492a57c11941eb119d96f2e2dce88dce4"
      }
    },
    "cohub-subagent-readonly": {
      "version": "0.8.0",
      "files": {
        "agent.cordis.yml": "5bc1ddabd181c294d82b9f1242f67f5155be94615e8dabd400c7462008022a98",
        "preset.yml": "993e10a2f9e1a3d9759c9bbe4d4db011208fdf8b163257e71710515d7d2e9449"
      }
    },
    "cohub-subagent-write": {
      "version": "0.8.0",
      "files": {
        "agent.cordis.yml": "8d27624898d0436a1dca2faf544d80c58eae45c3aacd27d20b6b53b9f92f79ed",
        "preset.yml": "844e81c2ddff0a69b7f01bb4bd52acab6fb2eae72f213c7cada6f729862c1123"
      }
    }
  }
}
```

**DIFFER 检查结果（本次盘点实测）：4 个 preset 的全部登记文件，磁盘哈希 = 台账哈希 = 仓库源哈希，三方完全一致，零 DIFFER。** 也就是说本机 preset 目录没有被手工改过，升级时不会有任何文件被跳过。

> 补充：`~/.dsh/.agent-presets/co-orchestrator/` 里还有 8 个历史 `.bak-*` 文件（`agent.cordis.yml.bak-20260915`、`-tokenfix`、`-personafix2` 等）。**它们不在台账里**（台账只登记 `agent.cordis.yml` 与 `preset.yml`），互不影响；重建时不需要复制它们。清单见附录 B。

### 如何验证

```powershell
node -e "const r=require(process.env.USERPROFILE+'/.dsh/.cohub-preset-install.json');console.log(Object.keys(r.presets).map(k=>k+' v'+r.presets[k].version).join('\n'))"
```

应输出 4 行、全部 `v0.8.0`。自检脚本会额外逐文件比哈希，报 `[WARN] <id> 无本地改动 (DIFFER)` 说明被手改过。

### 如何回滚

删 `~/.dsh/.agent-presets/<id>` 目录后重启，插件按「首次安装」重新复制。台账不想留就删 `~/.dsh/.cohub-preset-install.json`（退化为「仅新增」语义，不再清孤儿、不再跟踪用户改动）。备份：`.cohub-preset-install.json.bak-cohub-personafix`（814）/ `-personafix2`（815）/ `-presetfix`（814）/ `-bak-20260921-113857-before-hash-sync`（816）。

### 收益 / 代价

- **收益**：零手工 —— 换机器只要装上 `dsh-cohub` bundle，四个 preset 自动出现在宿主器的 preset 选择器里。
- **代价**：你手改过的 preset 文件**不会**跟随上游更新（这是刻意的保护）。想改又不想被跳过，就把定制写进 `cordis.patch.yml` 覆盖层，别改 preset 源文件。

---

## 6. 编排相关的手工配置（`cordis.patch.yml` 其余部分）

以下不是「省 token」而是「让 13 个 co-* 技能按本机模型路由跑起来」的配置，重装后同样会丢。都在 `~/.dsh/profiles/desktop/cordis.patch.yml`。

### 6.1 `cohub` 条目：技能 → 模型路由（当前 145–218 行，逐字节选）

```yaml
- id: cohub
  name: dsh-cohub
  config:
    councillors: []
    councilTimeoutMs: 180000
    skills:
      - name: co-orchestrator
        provider: guiyi1
        model: deepseek-v4.1-flash
        reasoningEffort: max
      - name: co-planner
        provider: guiyi
        model: gpt-6.1-sol
        reasoningEffort: max
      - name: co-oracle
        provider: guiyi
        model: gpt-6.1-sol
        reasoningEffort: high
      - name: co-explorer
        provider: guiyi1
        model: deepseek-v4.1-flash
        reasoningEffort: max
      - name: co-librarian
        provider: guiyi1
        model: deepseek-v4.1-flash
        reasoningEffort: max
      - name: co-observer
        provider: guiyi
        model: gpt-6-luna
        reasoningEffort: max
      - name: co-fixer
        provider: guiyi1
        model: deepseek-v4.1-flash
        reasoningEffort: max
      - name: co-designer
        provider: guiyi
        model: gpt-6-luna
        reasoningEffort: max
      - name: co-council
        provider: guiyi
        model: gpt-6.1-sol
        reasoningEffort: max
      - name: co-rule-user
        provider: guiyi1
        model: deepseek-v4.1-flash
        reasoningEffort: max
      - name: co-rule-project
        provider: guiyi1
        model: deepseek-v4.1-flash
        reasoningEffort: max
      - name: co-rule-app
        provider: guiyi1
        model: deepseek-v4.1-flash
        reasoningEffort: max
      - name: co-cordis
        provider: guiyi1
        model: deepseek-v4.1-flash
        reasoningEffort: max
    delegateRetry:
      maxRetries: 0
      retryDelayMs: 1000
      retryableReasons:
        - aborted
      stall:
        enabled: true
        consecutiveErrors: 3
        idleMs: 180000
        reasoningWithoutAction: 50
        loopCount: 3
        graceMs: 30000
        recoverable: true
    schedule:
      wallClockBudgetMs: 600000
```

> `provider` / `model` 引用的是前面 `llm-pi-ai` 里定义的 provider（`guiyi` / `guiyi1` / `tokenproto` / `minimax-cn`）。**换机器重建时这些 provider 及其 apiKeyEnv 也得一起搬**，否则技能路由全部解析失败、回落到父模型。`schedule` 里也可以显式写 `maxParallelBatch`（本机未写，用插件缺省 3）。

### 6.2 其余关键条目（逐字；以下三条各自独立，原文件中互不相邻）

新会话默认落到哪个 preset：

```yaml
- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: standard
    selectedDefault: co-orchestrator
```

子代理并发上限（`delegate_batch` 批量派发需要）：

```yaml
- id: subagent
  name: "@deepseek-ai/dsh-subagent"
  config:
    maxActiveSubagents: 888
```

沙箱 / 审批预设（本机默认全权限）：

```yaml
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
    defaultPreset: danger-full-access
```

- `selectedDefault: co-orchestrator` —— 新会话默认用编排 preset；不设会回落到 `standard`，cohub 就不在默认路径上了。
- `maxActiveSubagents: 888` —— 放开并发子代理上限（`delegate_batch` 批量派发需要）。
- `defaultPreset: danger-full-access` —— 默认全权限。⚠️ 这是本机有意的选择，重建到别人机器上请自己权衡。

---

## 附 A：一键自检

存成任意 `.mjs` 文件后运行 `node check-dsh-home.mjs`。**只读，不修改任何文件**。退出码 `0` = 无硬性失败。

```js
// dsh-home-setup 自检脚本（只读，不修改任何文件）
// 用法：node check-dsh-home.mjs
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';
const DSH = join(HOME, '.dsh');
const results = [];
const push = (level, name, detail = '') => results.push({ level, name, detail });

const readText = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** 递归算目录内所有文件的 sha256（相对路径用 / 分隔） */
function hashTree(dir) {
  const out = {};
  const walk = (cur) => {
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out[relative(dir, full).split('\\').join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ── 1. desktop package.json：taskboard 已移除 / dsh-cohub 走本地 link ──
const pkgPath = join(DSH, 'profiles', 'desktop', 'package.json');
const pkgRaw = readText(pkgPath);
if (pkgRaw === null) {
  push('FAIL', 'desktop/package.json 可读', pkgPath);
} else {
  let pkg;
  try {
    pkg = JSON.parse(pkgRaw);
  } catch (e) {
    push('FAIL', 'desktop/package.json 是合法 JSON', String(e));
  }
  if (pkg) {
    const bundles = pkg?.dsh?.profile?.bundles ?? [];
    if (bundles.includes('dsh-taskboard')) push('FAIL', 'dsh-taskboard 已从 bundles 移除', '仍在 bundles 里');
    else push('OK', 'dsh-taskboard 已从 bundles 移除', `bundles 共 ${bundles.length} 项`);

    const dep = pkg?.dependencies?.['dsh-cohub'];
    if (typeof dep === 'string' && dep.startsWith('link:')) push('OK', 'dsh-cohub 依赖指向本地源码', dep);
    else if (typeof dep === 'string') push('WARN', 'dsh-cohub 依赖不是 link:', `当前为 ${dep}`);
    else push('FAIL', 'dsh-cohub 依赖存在', 'dependencies 缺 dsh-cohub');
  }
}

// ── 2. desktop cordis.patch.yml：github MCP 已注释 / spill-policy = 4096 ──
const patchPath = join(DSH, 'profiles', 'desktop', 'cordis.patch.yml');
const patch = readText(patchPath);
if (patch === null) {
  push('FAIL', 'desktop/cordis.patch.yml 可读', patchPath);
} else {
  if (/^[ \t]*-[ \t]+id:[ \t]*mcp-github/m.test(patch)) {
    push('FAIL', 'github MCP 已停用', '存在未注释的 "- id: mcp-github"');
  } else {
    push('OK', 'github MCP 已停用', '无未注释的 github MCP 行');
  }
  if (!patch.includes('# - id: mcp-github')) {
    push('WARN', 'github MCP 注释块仍在（可一键恢复）', '找不到 "# - id: mcp-github"，恢复时要照文档重贴');
  }

  const idx = patch.indexOf('- id: spill-policy');
  if (idx < 0) {
    push('FAIL', 'spill-policy 覆盖条目存在', '未找到 "- id: spill-policy"');
  } else {
    const near = patch.slice(idx, idx + 300);
    const km = near.match(/maxInlineTokens:\s*(\d+)/);
    if (km && km[1] === '4096') push('OK', 'spill-policy maxInlineTokens = 4096');
    else if (km) push('FAIL', 'spill-policy maxInlineTokens = 4096', `实际为 ${km[1]}`);
    else push('FAIL', 'spill-policy maxInlineTokens = 4096', '未找到 maxInlineTokens 键');
  }

  if (/^[ \t]*-[ \t]+id:[ \t]*dsh-taskboard/m.test(patch)) push('WARN', 'cordis.patch.yml 无 taskboard 残留', '仍有 taskboard 条目');
  else push('OK', 'cordis.patch.yml 无 taskboard 残留');
}

// ── 3. co-orchestrator preset：thresholdRatio / 身份判据 ──
const presetPath = join(DSH, '.agent-presets', 'co-orchestrator', 'agent.cordis.yml');
const preset = readText(presetPath);
if (preset === null) {
  push('FAIL', 'co-orchestrator preset 已安装', presetPath);
} else {
  const tm = preset.match(/thresholdRatio:\s*([0-9.]+)/);
  if (tm && tm[1] === '0.5') push('OK', 'compaction thresholdRatio = 0.5');
  else if (tm) push('FAIL', 'compaction thresholdRatio = 0.5', `实际为 ${tm[1]}`);
  else push('WARN', 'compaction thresholdRatio = 0.5', '未显式配置（用默认 0.8）');

  if (preset.includes('--- 你的具体任务 ---')) push('OK', 'persona 含子代理身份判据');
  else push('FAIL', 'persona 含子代理身份判据', 'prefix 里找不到 "--- 你的具体任务 ---"');
}

// ── 4. web profile 的 pnpm 白名单是否已含 0.8.0 ──
const webWs = readText(join(DSH, 'profiles', 'web', 'pnpm-workspace.yaml'));
if (webWs === null) {
  push('INFO', 'web/pnpm-workspace.yaml 不存在', '（未使用 web profile 可忽略）');
} else {
  const line = webWs.split(/\r?\n/).find((l) => l.includes('dsh-cohub@'));
  if (!line) push('WARN', 'web 白名单含 dsh-cohub 条目', '找不到 dsh-cohub@ 行');
  else if (line.includes('0.8.0')) push('OK', 'web 白名单已放行 0.8.0', line.trim());
  else push('WARN', 'web 白名单未放行 0.8.0', `${line.trim()} —— 在 web 装 0.8.0 前需补`);
}

// ── 5. 安装台账：四个 preset 已登记且文件未被本地改动 ──
const recPath = join(DSH, '.cohub-preset-install.json');
const recRaw = readText(recPath);
if (recRaw === null) {
  push('FAIL', 'preset 安装台账存在', recPath);
} else {
  let rec;
  try {
    rec = JSON.parse(recRaw);
  } catch (e) {
    push('FAIL', '台账是合法 JSON', String(e));
  }
  if (rec) {
    for (const id of ['co-orchestrator', 'cohub-cordis', 'cohub-subagent-readonly', 'cohub-subagent-write']) {
      const entry = rec?.presets?.[id];
      if (!entry) {
        push('FAIL', `台账已登记 ${id}`, '缺该条目（插件未安装过该 preset）');
        continue;
      }
      const dir = join(DSH, '.agent-presets', id);
      if (!existsSync(dir)) {
        push('FAIL', `${id} 目录存在`, dir);
        continue;
      }
      const disk = hashTree(dir);
      const differ = Object.entries(entry.files ?? {})
        .filter(([rel, h]) => disk[rel] !== undefined && disk[rel] !== h)
        .map(([rel]) => rel);
      if (differ.length > 0) push('WARN', `${id} 无本地改动 (DIFFER)`, `被改过：${differ.join(', ')} —— 升级时会被跳过`);
      else push('OK', `${id} v${entry.version} 与台账一致`);
    }
  }
}

// ── 6. 市场 state（市场自管，仅报告） ──
const mktPath = join(DSH, 'profiles', 'desktop', '.dsh-market', 'state.json');
const mktRaw = readText(mktPath);
if (mktRaw === null) {
  push('INFO', '市场 state.json', `${mktPath} 不存在（市场未启用过）`);
} else {
  try {
    const st = JSON.parse(mktRaw);
    push('INFO', `市场 disabled = [${(st.disabled ?? []).join(', ')}]`, '市场自管，不要手工改');
  } catch {
    push('INFO', '市场 state.json 不可解析', '忽略（市场自管）');
  }
}

// ── 7. 恢复 github MCP 的前提文件 ──
const tokenPath = join(DSH, 'github.token');
const exePath = join(DSH, 'bin', 'github-mcp-server.exe');
push(existsSync(tokenPath) ? 'OK' : 'WARN', 'github.token 存在（恢复 github MCP 的前提）', tokenPath);
push(existsSync(exePath) ? 'OK' : 'WARN', 'github-mcp-server.exe 存在', exePath);

// ── 汇总 ──
const label = { OK: '[ OK ]', WARN: '[WARN]', FAIL: '[FAIL]', INFO: '[INFO]' };
let fails = 0;
let warns = 0;
console.log(`\nDSH 本机配置自检 —— ${DSH}\n`);
for (const r of results) {
  if (r.level === 'FAIL') fails += 1;
  if (r.level === 'WARN') warns += 1;
  console.log(`${label[r.level]} ${r.name}${r.detail ? `\n         ${r.detail}` : ''}`);
}
console.log(`\n合计：OK ${results.filter((r) => r.level === 'OK').length} / WARN ${warns} / FAIL ${fails}`);
console.log(fails === 0 ? (warns === 0 ? '全部就位。' : '无硬性失败，WARN 项见上（多为已知缺口或可选前提）。') : '存在硬性失败，按 docs/dsh-home-setup.md 对应章节补齐。\n');
process.exitCode = fails === 0 ? 0 : 1;
```

### 本机实测输出（2026-10-23，退出码 0）

```text
DSH 本机配置自检 —— C:\Users\14023\.dsh

[ OK ] dsh-taskboard 已从 bundles 移除
         bundles 共 16 项
[ OK ] dsh-cohub 依赖指向本地源码
         link:C:/Users/14023/myproject/cohub/packages/dsh-cohub
[ OK ] github MCP 已停用
         无未注释的 github MCP 行
[ OK ] spill-policy maxInlineTokens = 4096
[ OK ] cordis.patch.yml 无 taskboard 残留
[ OK ] compaction thresholdRatio = 0.5
[ OK ] persona 含子代理身份判据
[WARN] web 白名单未放行 0.8.0
         - dsh-cohub@0.4.11 || 0.5.0 || 0.5.1 || 0.6.0 || 0.7.0 —— 在 web 装 0.8.0 前需补
[ OK ] co-orchestrator v0.8.0 与台账一致
[ OK ] cohub-cordis v0.8.0 与台账一致
[ OK ] cohub-subagent-readonly v0.8.0 与台账一致
[ OK ] cohub-subagent-write v0.8.0 与台账一致
[INFO] 市场 disabled = [dsh-cache-optimizer]
         市场自管，不要手工改
[ OK ] github.token 存在（恢复 github MCP 的前提）
         C:\Users\14023\.dsh\github.token
[ OK ] github-mcp-server.exe 存在
         C:\Users\14023\.dsh\bin\github-mcp-server.exe

合计：OK 13 / WARN 1 / FAIL 0
```

---

## 附 B：本机备份文件清单（回滚用，**不是**重建依据）

这些是历次手工改动的 `.bak`，留着回滚，重建时**不要**复制它们。

`~/.dsh/profiles/desktop/`：

| 文件 | 字节 | 内容 |
|---|---|---|
| `cordis.patch.yml.bak-cohub-tokenfix` | 35,929 | 关闭 github MCP 之前（含未注释的 mcp-github 原件） |
| `cordis.patch.yml.bak-cohub-spillfix` | 36,323 | spill 阈值调整中间态 1 |
| `cordis.patch.yml.bak-cohub-spillfix2` | 37,218 | spill 阈值调整中间态 2 |
| `cordis.patch.yml.bak-cohub-spillfix3` | 37,902 | spill 阈值调整中间态 3 |
| `cordis.patch.yml.bak-20261021-101401` | 34,606 | 更早的整文件快照 |
| `package.json.bak-cohub-notaskboard` | 1,692 | 移除 taskboard 之前 |
| `package.json.bak-cohub-npmswitch` | 1,572 | 切 link/registry 之前 |
| `pnpm-workspace.yaml.bak-cohub-npmswitch` | 501 | 同上（工作区） |
| `pnpm-lock.yaml.bak-cohub-npmswitch` | 55,590 | 同上（锁） |

`~/.dsh/profiles/web/`：`pnpm-workspace.yaml.bak-cohub-0.7.0`（379）、`.bak-cohub-0.6.0`（370）、`.bak.20260915-cohub046`（131）等。

`~/.dsh/.agent-presets/`：

| 文件 | 字节 |
|---|---|
| `co-orchestrator/agent.cordis.yml.bak-cohub-tokenfix` | 7,742 |
| `co-orchestrator/agent.cordis.yml.bak-cohub-presetfix` | 7,994 |
| `co-orchestrator/agent.cordis.yml.bak-cohub-personafix` | 9,281 |
| `co-orchestrator/agent.cordis.yml.bak-cohub-personafix2` | 9,578 |
| `co-orchestrator/agent.cordis.yml.bak-20260921-113529-before-persona-sync` | — |
| `cohub-cordis/agent.cordis.yml.bak-cohub-presetfix` | 15,363 |

`~/.dsh/`：`.cohub-preset-install.json.bak-cohub-*`（3 个，814–819 字节）。

---

## 附 C：已知缺口与需人工核对项

1. **web 白名单缺 `0.8.0`**（章节 4）。当前不影响（web 仍是 registry `0.7.0`），在 web 装 0.8.0 前必须补。
2. **github MCP 只在 `co-orchestrator` preset 内被注释**，`~/.dsh/.agent-presets/co-orchestrator/agent.cordis.yml` 里**本来就没有** mcp-github 条目（连注释块都没有）。所以「恢复 github MCP」只有一个动作点：desktop profile 的 `cordis.patch.yml`。别在 preset 文件里找它。
3. **`.agent-presets/co-orchestrator/agent.cordis.yml` 与仓库源零差异**（sha256 `77dd3ce8…`），persona 的**身份判据那几句在仓库源里就是有的**，不是本机手工加的。重建时由插件自动装，不要手改。
4. **市场状态不在 `~/.dsh/.dsh-market/`**，而在 **profile 目录内**：`~/.dsh/profiles/desktop/.dsh-market/state.json`（99 字节）。当前内容：`disabled: ["dsh-cache-optimizer"]`、`region: china`、`regionAuto: true`、`groups: {}`、`groupOrder: []`。**这是市场自管的状态，不要手工改** —— 它是 GUI 里「禁用某插件」的选择，手工编辑会与市场 UI 打架。换机器不需要迁移（按需在 GUI 里重新禁用即可）。
5. **desktop profile 同时存在声明式 preset（`cordis.patch.yml` 的 `preset-co-orchestrator` / `preset-cohub-cordis`）与文件式 preset（`.agent-presets/`）**，两套 id 不同。`agent-preset-registry.selectedDefault` 指向文件式那个 `co-orchestrator`。若只搬 `cordis.patch.yml` 不装插件，选择器里会少 preset；只装插件不搬 patch，模型路由与 spill 阈值都不生效。**两样都要。**
6. **章节 6.1 的 `provider` 名字（`guiyi` / `guiyi1` / `tokenproto` / `minimax-cn`）依赖同文件里 `llm-pi-ai` 的 provider 定义**（`apiKeyEnv: GUIYI_API_KEY` 等）与对应环境变量。换机器时必须一起搬，否则 13 个技能路由全部解析失败。
7. **`compaction-basic.thresholdRatio: 0.5`** 目前在**文件式 preset** 里（`~/.dsh/.agent-presets/co-orchestrator/agent.cordis.yml` 第 167 行），而声明式 preset（`cordis.patch.yml` 内那份 `compaction-basic`）**没有**这个 config 行（用默认 0.8）。也就是说两套 co-orchestrator 的压缩激进度不同 —— 这是并存遗留，**需人工确认**是否有意为之。
8. **`dsh-taskboard.json` / `dsh-taskboard-templates.json` 数据文件仍在 `~/.dsh/` 下**（86 + 2,564 字节），属卸载残留。本机保留未动；重建时不需要。
