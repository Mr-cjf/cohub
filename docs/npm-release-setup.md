# npm 发布配置文档

> 发布流水线：`.github/workflows/publish.yml`，用 Git tag 触发（`zcode-v*` / `opencode-v*` / `dsh-v*`）或手动 `workflow_dispatch`；认证靠 npm Trusted Publisher（OIDC），无需 NPM_TOKEN 或个人 access token。

## 架构说明

### 唯一生效的发布流水线

GitHub Actions **只加载仓库根目录** `.github/workflows/` 下的 workflow 文件。因此 `packages/oh-my-opencode-cohub/.github/workflows/publish.yml` 与 `packages/dsh-cohub/.github/workflows/publish.yml` 这两个子包工作流**不会被执行**——它们已在提交 `62e12b2` 中改写为说明性注释，提醒后来者去根级 workflow 找发布配置。

根级 `publish.yml` 包含 3 个 job，按 tag 前缀分流：

| Job | Tag 前缀 | 包名 | 构建工具 |
|-----|----------|------|----------|
| `publish-zcode` | `zcode-v*` | `packages/zcode-cohub` | bun |
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
| `zcode-cohub` | — | ❌ 尚未配置（见下方说明） |

### `zcode-cohub` 为何尚未配置

npm Trusted Publisher 是**包级配置**，配置 CLI 会调用 npm API 验证目标包是否存在。**包必须已存在于 npm registry 才能配 TP**——`zcode-cohub` 尚未首次发布，连包页面都不存在，因此目前无法为其添加 Trusted Publisher。

补配步骤（在 `zcode-cohub` 首次发布后执行）：

```bash
npm trust github zcode-cohub --repo Mr-cjf/cohub --file publish.yml --allow-publish -y
```

### 每个包必须单独配一条 TP

npm 没有「组织级」Trusted Publisher 功能。每个包需要各自执行一次 `npm trust` 命令，不能期望一条配置覆盖多个包。

### 2FA 要求

`npm trust` 属于「账号变更」类操作，需要 2FA。CLI 执行后会输出一个 `npmjs.com/auth/cli/<uuid>` 链接，需在浏览器中打开并确认。

### workflow 文件名只填文件名

npm 侧 Trusted Publisher 配置中的 workflow filename 参数只填 `publish.yml`（不含路径），因为 GitHub Actions 只加载根 `.github/workflows/` 下的文件。这与我们根级 workflow 的文件名一致。

## 日常发版流程

遵循仓库既有规范：

1. 更新 `CHANGELOG.md`（在对应包的目录下）
2. 提交所有改动
3. 确认版本号未被 npm registry 占用：`npm view <包名> versions --json | grep <版本号>`
4. 执行版本号升级：
   ```bash
   npm version patch   # 或 minor / major
   ```
5. 推送 tag：
   ```bash
   git push --follow-tags
   ```
6. CI 自动构建 + 发布（可在 GitHub Actions 页面观察进度）

> ⚠️ `npm version` 会同时修改 `package.json` 版本号、创建 git commit 与 tag。如果仓库有未提交的 WIP 改动，建议先 `git stash`。

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

### 5. 未发布的包无法预配 TP

这是 npm API 层面的限制——配 TP 时 npm 会验证包是否存在。必须先 `npm publish` 发布一次（哪怕是 `0.0.1` 空包），再配 TP。

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
| `C:\Users\14023\.npmrc.bak-20260916` | 本机 `.npmrc` 备份（旧 token 已过期） |