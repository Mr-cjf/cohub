# npm 发布配置文档

> 发布流水线：`.github/workflows/publish.yml`，用 Git tag 触发（`opencode-v*` / `dsh-v*`）或手动 `workflow_dispatch`；认证靠 npm Trusted Publisher（OIDC），无需 NPM_TOKEN 或个人 access token。

## 架构说明

### 唯一生效的发布流水线

GitHub Actions **只加载仓库根目录** `.github/workflows/` 下的 workflow 文件。因此 `packages/oh-my-opencode-cohub/.github/workflows/publish.yml` 与 `packages/dsh-cohub/.github/workflows/publish.yml` 这两个子包工作流**不会被执行**——它们已在提交 `62e12b2` 中改写为说明性注释，提醒后来者去根级 workflow 找发布配置。

根级 `publish.yml` 包含 2 个 job，按 tag 前缀分流：

| Job | Tag 前缀 | 包名 | 构建工具 |
|-----|----------|------|----------|
| `publish-opencode` | `opencode-v*` | `packages/oh-my-opencode-cohub` | bun |
| `publish-dsh` | `dsh-v*` | `packages/dsh-cohub` | bun |

### workflow 关键细节

- **`actions/setup-node@v7`**：v4–v6 会导出假 token `XXXXX-XXXXX-XXXXX-XXXXX` 污染 `.npmrc`，干扰 OIDC 认证。v7.0.0（2026-07-14，PR #1558）已修复该问题，因此 **不要** 再手写清空 `NODE_AUTH_TOKEN` 的 workaround。
- **OIDC 权限**：`id-token: write` + `contents: read`。
- **并发控制**：每个 job 的 `concurrency.group` 保证同包的发布串行，避免竞态覆盖。
- **版本校验**：tag 触发时，脚本自动比对 `GITHUB_REF_NAME` 与 `package.json#version`，不一致则失败退出。
- **构建必须显式执行**：`dist/`、`lib/` 均在 `.gitignore` 中，CI 必须 `npm run build`。

## 认证方式：npm Trusted Publisher（OIDC）

### 已配置的包

| 包名 | Trust ID | 状态 |
|------|----------|------|
| `oh-my-opencode-cohub` | `5145ea91-4860-4ccb-9a9f-58d0a3d79a76` | ✅ 已配置 |
| `dsh-cohub` | `62f22721-8593-490f-b111-462c2b420083` | ✅ 已配置 |


### 每个包必须单独配一条 TP

npm 没有「组织级」Trusted Publisher 功能。每个包需要各自执行一次 `npm trust` 命令，不能期望一条配置覆盖多个包。

### 2FA 要求

`npm trust` 属于「账号变更」类操作，需要 2FA。CLI 执行后会输出一个 `npmjs.com/auth/cli/<uuid>` 链接，需在浏览器中打开并确认。

### workflow 文件名只填文件名

npm 侧 Trusted Publisher 配置中的 workflow filename 参数只填 `publish.yml`（不含路径），因为 GitHub Actions 只加载根 `.github/workflows/` 下的文件。这与我们根级 workflow 的文件名一致。

## 日常发版流程

权威流程见 `packages/oh-my-opencode-cohub/.opencode/rules/发版规范.md`（`AGENTS.md` 引为权威）；本节是面向本仓库两个 npm 包的落地摘要，**冲突时以发版规范为准**。

1. **更新 `CHANGELOG.md`（发版前置，不可跳过）** — 在对应包目录下按 Keep a Changelog 格式新增版本条目，区分「新增 / 修复 / 变更 / 移除」，用独立 `docs:` commit 提交。`packages/oh-my-opencode-cohub/CHANGELOG.md` 一直存在；`packages/dsh-cohub/CHANGELOG.md` 是 **0.6.0 才建立的**，此前发版没写过，后续必须先在它上面补条目再动版本号。
2. **更新 `README.md`（同为前置）** — 包内 README 首屏「本文对应 vX.Y.Z」改为目标版本；受本次变更影响的说明同步修正。npm 页面 README 只在发布新版本时更新，漏改后只能靠下一个版本补发。
3. **提交所有源码改动** — `feat:` / `fix:` 各自独立 commit，不要和版本号混在一起。
4. **确认版本号未被占用** — 注册表侧 `npm view <包名> versions --json`；git 侧 `git tag -l "<前缀>X.Y.Z"` 与 `git ls-remote --tags origin "refs/tags/<前缀>X.Y.Z"`，**两者都必须为空**（其他分支可能已发布过该号）。已被占用就改用更高版本号，**严禁删除、移动或覆盖已有 tag**。
5. **手改版本号（不要用 `npm version`）** — 直接编辑以下两处，保持一致：
   - `packages/<包名>/package.json` 的 `version`
   - `packages/<包名>/package-lock.json` 的 **顶层 `version`** 与 **`packages[""].version`**

   然后独立提交：`git commit -m "chore: 版本号 X.Y.Z"`。
6. **合并到 main 并核实 SHA** — `git fetch origin` + `git rev-parse origin/main`，确认 main 与 origin/main 一致。
7. **打 annotated tag 并推送** — 对已核实的 main SHA 打标：
   ```bash
   git tag -a "dsh-vX.Y.Z" -m "release X.Y.Z" <main-SHA>      # dsh-cohub
   git tag -a "opencode-vX.Y.Z" -m "release X.Y.Z" <main-SHA> # oh-my-opencode-cohub
   git push --follow-tags
   ```
8. **CI 自动构建 + 发布** — 根 workflow 以 OIDC 身份 `npm publish --provenance`，可在 GitHub Actions 页面观察进度。**不要在本地运行 `npm publish`**。

> ⚠️ **为什么禁止 `npm version`**：它会自己改版本号、自己 commit、自己打 **lightweight** tag，并触发 `preversion` / `version` / `postversion` lifecycle，与我们「docs/chore 分提交 + annotated tag 带 message + tag 打在已核实的 main SHA 上」的手控流程直接冲突。版本号一律手改。

> ⚠️ **lockfile 必须同步改**：CI 每个包都是 `npm ci`（`working-directory: packages/<包名>`，见 `.github/workflows/publish.yml:46` 与 `:84`）。`npm ci` 会校验 `package.json` 与 `package-lock.json` 的版本号是否一致，只改 `package.json` 而漏掉 lock 会直接 `EUSAGE` 失败（`package.json and package-lock.json are not in sync`），发布不触发——0.6.0 踩到过这一点。

## 发布后验证

CI 显示 `published` **不等于**用户装得上——必须做一次「发版后重装验证」：能装成功 + 版本号正确 + 核心功能在。这是 OpenCode 侧规范「安装安全：发版后重装验证」在 dsh 侧的落地。

### 验证方式：`dsh plugin --profile web add dsh-cohub@X.Y.Z`

DSH 的插件安装**统一走 `dsh` CLI**，没有别的官方入口。

**已实测的环境事实**（2026-10，`dsh --help` / `dsh plugin --help` 实跑输出）：

| 事实 | 证据 |
|------|------|
| `dsh` CLI 存在 | `C:\Users\14023\AppData\Roaming\npm\dsh.ps1`（npm 全局包，`Get-Command dsh` 命中）。**不在** `~/.dsh/bin/`——那里只有 `github-mcp-server.exe` |
| `dsh plugin` 是 pnpm 转发器 | `dsh plugin --help` 原文：*"manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory"* |
| 语法 | `dsh plugin --profile <name> <pnpm-args...>`；官方示例 *"dsh plugin --profile tui add &lt;package&gt;"* |
| 两个 profile 都用 **pnpm** | `~/.dsh/profiles/{desktop,web}/` 下是 `pnpm-lock.yaml` + `pnpm-workspace.yaml`，**没有** `package-lock.json`；`web/node_modules/.modules.yaml` 记录 `"packageManager": "pnpm@12.14.0"`、`nodeLinker: hoisted` |
| 安装目录无独立 CLI | `DeepSeek Harness\` 下只有 Electron 主程序 `DeepSeek Harness.exe`，**没有** `dsh.exe` / `dsh.cmd` |

```bash
# 首选：走 DSH CLI（= 在 profile 目录里 pnpm add，并自动登记 dsh.profile.bundles）
dsh plugin --profile web add dsh-cohub@X.Y.Z

# 等价手动方式（dsh CLI 不可用时；语义完全相同）
cd ~/.dsh/profiles/web && pnpm add dsh-cohub@X.Y.Z
```

> **为什么验证用 `web` profile**：`~/.dsh/profiles/web/package.json` 的 `dependencies` 里 `dsh-cohub` 是 **registry 版本号**（`"0.5.1"`），装的就是 npm 发布产物。
> `~/.dsh/profiles/desktop/package.json` 用的是 `link:C:/Users/14023/myproject/cohub/packages/dsh-cohub`——指向本地 checkout，**它验证不到 npm 产物**。要在 desktop 验证必须先临时改成版本号，那属于改本机 profile，不在发版流程内（也会打断你的本地开发链接）。

> **自动登记 bundles（文档声称，未实测）**：`packages/dsh-cohub/README.md:22` 称 `dsh plugin add` 安装后会自动把声明 `dsh.bundle` 的依赖加入 `dsh.profile.bundles`。若装完重启发现插件没挂上，先手工确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组里是否有 `"dsh-cohub"`。

### 验证什么（三条，缺一不可）

**① 能装成功** — 上面的 `dsh plugin add` 不报错。`ERR_PNPM_*` / `404` 均视为发版失败（常见原因：CI 发的是空包、`registry` 镜像未同步、`minimumReleaseAge` 拦截了过新版本）。

**② 版本号正确** — 读实际落盘的文件，不要只看命令回显：

```bash
# 检查 profile 里真正装进去的版本
node -p "require('C:/Users/14023/.dsh/profiles/web/node_modules/dsh-cohub/package.json').version"
# 期望输出：X.Y.Z
```

**③ 至少一个核心功能可用** — 重启该 profile（`dsh web`），在 GUI 里新建会话，确认 `delegate` / `delegate_batch` 工具存在且可调用。这两个工具由插件 `apply()` 注册，工具在 = 插件真的挂上了（比看日志可靠）。13 个 `co-*` 技能也应出现在技能列表中。

### 不装 profile 的轻量检查：`npm pack --dry-run`

只想确认 tarball 内容对、不想改动任何 profile 时，用这条（**已实测**：2026-10 对 `dsh-cohub@0.6.0` 实跑，输出 `total files: 13`、`lib/index.js 161.1kB`、`presets/` 齐全）：

```bash
cd "$(mktemp -d)"   # 装到临时目录，不碰任何 profile
npm pack dsh-cohub@X.Y.Z --dry-run
```

重点看三样：`lib/index.js` 存在且体积正常（约 160kB，**不是 0 字节**）、`cordis.patch.yml` 在包里、`presets/` 子目录完整。CI 漏 `npm run build` 时，这里会看不到 `lib/`——这正是第 3 节「构建产物被 gitignore」那条坑的可观测信号。

### 实测标注汇总

| 内容 | 状态 |
|------|------|
| `dsh --help` / `dsh plugin --help` 的存在与语法 | ✅ **已实测**（真实输出） |
| 两个 profile 用 pnpm、desktop 用 `link:`、web 用 registry 版本号 | ✅ **已实测**（读文件 + `.modules.yaml`） |
| `npm pack --dry-run` 的输出形态与文件清单 | ✅ **已实测**（对 0.6.0 实跑） |
| `dsh plugin --profile web add dsh-cohub@X.Y.Z` 端到端跑通 | ⚠️ **未实测**——本轮只做只读查证，未真的安装/切换任何 profile 的包 |
| `dsh plugin add` 自动登记 `dsh.profile.bundles` | ⚠️ **未实测**（来源：`packages/dsh-cohub/README.md:22` 文档声称） |
| `node -p require(...).version` 与 GUI 里见 `delegate` | ⚠️ **未实测**（标准做法，非本机实跑） |

## 如何查看/管理 Trusted Publisher

```bash
# 查看某包的 Trusted Publisher 列表
npm trust list <包名>

# 撤销某条 TP（按 trust id）
npm trust revoke <包名> --id=<id>
```

## 关键前置条件与坑（务必注意）

### 1. `repository.url` 必须与仓库完全一致（大小写敏感）

`package.json` 中的 `repository.url`（或 `repository` 字段解析出的 GitHub 仓库）必须与执行发布的 GitHub 仓库**字符级完全一致**（大小写敏感），否则 npm provenance 校验会硬报 `E422` 错误。

例如 `"repository": { "url": "git+https://github.com/Mr-cjf/cohub.git" }` 必须与 GitHub Actions 运行所在的 `Mr-cjf/cohub` 一一对应。

### 2. `actions/setup-node@v7` 是关键

v4–v6 导出假 token `XXXXX-XXXXX-XXXXX-XXXXX` 到 `.npmrc`，污染环境变量，导致 OIDC 认证失败。v7.0.0（2026-07-14）修复了此问题。因此我们的 workflow 统一使用 `@v7`，且**不需要**手写清空 `NODE_AUTH_TOKEN` 的 workaround。

### 3. 构建产物被 gitignore

`dist/`、`lib/` 等构建产物均在 `.gitignore` 中，不会随 git checkout 出现在 runner 上。CI 必须显式执行 `npm run build`，否则 `npm publish` 会发布空包或缺少产出。

### 4. Trusted Publisher 文件名只填文件名

npm 侧的 workflow filename 参数填 `publish.yml`（不含 `.github/workflows/` 前缀）。npm 会自动拼接成完整的 workflow 路径做校验。

### 5. 未发布的包无法预配 TP（**仅限首次预配场景**）

这是 npm API 层面的限制——配 TP 时 npm 会验证包是否存在。因此**仅当首次为该包预配 Trusted Publisher 时**，才需要先发布一个占位的空包（如 `0.0.1`）让它"存在"，再配 TP。

> ⚠️ **这是一次性的引导动作，不属于日常发版流程**——与上一节「日常发版流程」第 8 步「不要在本地运行 `npm publish`」**并不矛盾**，两者管的场景不同：
>
> | 场景 | 频率 | 由谁发布 |
> |------|------|----------|
> | 首次预配 TP 的占位空包 | **一次性**（每个包一生一次，`oh-my-opencode-cohub` / `dsh-cohub` 均已完成） | 可在本地发布，也可手工上传 |
> | 正式版本发版 | 每次发版 | **一律由 CI**（OIDC `npm publish --provenance`），本地永不执行 `npm publish` |
>
> 日常发版**永远不要**因为「怕包不存在」而在本地 `npm publish`：TP 配好之后包已存在，CI 走 OIDC 即可。

## 本机已知环境事实

| 项目 | 版本/状态 |
|------|-----------|
| npm | 11.17.0 |
| Node.js | v24.19.0 |
| bun | 1.4.2 |
| gh CLI | ❌ 未登录 |
| 默认浏览器 | Firefox |

- `gh` CLI 未登录意味着不能使用 `gh release create` 等命令在本地创建 GitHub Release——但不影响 `npm trust` 和 `npm publish`，这两者直接与 npm registry 交互。
- 本机 `%USERPROFILE%\.npmrc` 备份在 `C:\Users\14023\.npmrc.bak-20260916`（2024-08-14 旧 token 已过期时做的安全备份）。

## 失败教训：浏览器自动化为何不可行

在确定最终方案（`npm trust` CLI）之前，我们尝试了浏览器自动化路线（位于已删除的 `scripts/npm-tp/` 目录），**整体失败并被放弃**。以下是如实记录的问题链：

### 1. 登录态检测误报（致命缺陷 #1）

`isLoggedIn()` 的初版实现访问的是**不受保护的 URL**，导致在本应未登录的状态下**误报「已登录」**。这让后续所有自动化步骤建立在一个虚假的前提上。

### 2. 每 3 秒 `page.goto()` 清空登录表单（致命缺陷 #2）

后续版本改为每 3 秒对**用户正在输入的那个 page** 执行 `page.goto()`。每次 `goto` 刷新页面都会：
- **清空已填写的用户名/密码/2FA 输入**
- **抢走输入框焦点**
- 用户根本无法完成登录

### 3. `goto` 反复中止 Cloudflare 挑战（致命缺陷 #3）

同一个 `goto` 还导致 Cloudflare 的人机验证被反复打断——每次页面导航都会中止正在进行的 JS Challenge，验证永远走不完。超时截图证实页面卡在「正在进行安全验证」提示。

### 4. Cookie 判定规则设计缺陷（诊断盲区）

即使改为纯 cookie 轮询避免导航，cookie 判定规则也存在两重问题：
- **排除规则过窄**：只认名字含 `session` 的 cookie 为「登录会话 cookie」；但 npm 实际使用的会话 cookie 名字里**根本没有 `session`**。
- **日志缺位**：代码吞掉了 cookie 名称与数量，不打印任何诊断信息，造成完全无法排查的盲区。

### 5. 专用 Profile 路线因 `ERR_TOO_MANY_REDIRECTS` 退出

最后尝试的「clone daily Chrome profile → 用 Playwright 启动独立浏览器窗口」方案，在访问 `settings/~/packages` 时触发 `ERR_TOO_MANY_REDIRECTS`（重定向循环），浏览器直接报错，无有效产出。

### 6. 根因误判

在浏览器自动化上投入了大量时间后，最终发现**真正的拦路虎不是浏览器自动化技术本身，而是 `.npmrc` 中的 npm token 已于 2024-08-14 过期**。token 过期导致 `npm trust` CLI 在本地也一度失败，容易误以为是 CLI 本身的问题——直到我们用 `npm token create` 刷新 token 后，`npm trust` CLI 一次成功，无需任何浏览器交互。

### 正确路径

```bash
npm trust github <包名> --repo Mr-cjf/cohub --file publish.yml --allow-publish -y
```

这条命令通过 npm registry 的 OIDC 协议直接建立 GitHub Actions → npm 的信任链，完全绕过了浏览器手动配置。在 Chromium 报 `ERR_TOO_MANY_REDIRECTS` 的同一台机器上，这条命令 3 秒内返回成功。

**教训摘要**：在投入自动化之前，先验证核心前置条件（如 token 是否有效）。浏览器自动化面对 Cloudflare 保护的页面，不确定性和维护成本极高；能用 CLI/API 解决的问题，不要上线浏览器。

## 相关文件索引

| 文件 | 说明 |
|------|------|
| `.github/workflows/publish.yml` | 根级发布流水线（唯一生效） |
| `packages/oh-my-opencode-cohub/.github/workflows/publish.yml` | 已改写为说明性注释（不生效） |
| `packages/dsh-cohub/.github/workflows/publish.yml` | 已改写为说明性注释（不生效） |
| `packages/*/CHANGELOG.md` | 各包的变更日志 |
| `packages/oh-my-opencode-cohub/.opencode/rules/发版规范.md` | 发版权威规范（与本文冲突时以此为准） |
| `C:\Users\14023\.npmrc.bak-20260916` | 本机 `.npmrc` 备份（旧 token 已过期） |