# DSH 插件发版规范（可直接复制到新项目）

> 本文是**独立可移植**的发版规范：把 `<pkg>` 换成你的包名、`<profile>` 换成目标 profile（如 `web`）即可落地。
> 本仓库的相关文档：`docs/npm-release-setup.md`（发布架构与 OIDC 配置实况）、`.rules/06-dsh-plugin-dev.md` 第十/十一章（构建与发版硬要点）。**冲突时以 `.github/workflows/publish.yml` 实际行为为准。**

核心原则一句话：**CI 从 tag 指向的 commit 取代码发布**，所以 tag 是「发布快照」，必须在所有改动就位后再打。

---

## 1. 一次性配置（新项目起步）

### 1.1 `package.json` 必备字段

```jsonc
{
  "name": "<pkg>",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "presets"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "scripts": {
    "build": "<你的五步构建链>",
    "prepublishOnly": "npm run build"
  },
  "repository": { "url": "git+https://github.com/<owner>/<repo>.git" }
}
```

要点：

- `files` 必须显式列出产物目录（`lib`）。`lib/`、`dist/` 在 `.gitignore` 里，**只能靠 `build` 生成**；漏 `build` 或漏 `files` 就会发布空包。
- `dsh.bundle.patch` 指向 `cordis.patch.yml`，且该文件必须同时出现在 `files` 里，否则装上后插件挂不上。
- `repository.url` 与 GitHub 仓库**大小写完全一致**，否则 provenance 校验硬报 `E422`（`docs/npm-release-setup.md`「关键前置条件」第 1 条）。
- `prepublishOnly` 与 CI 的 `npm run build` 会各跑一次 build（无害，但不要在里面做非幂等操作）。

### 1.2 `.github/workflows/publish.yml` 关键结构

只放**仓库根** `.github/workflows/`——GitHub Actions 不加载子包目录下的 workflow。文件名必须是 `publish.yml`（npm 侧 Trusted Publisher 校验用）。

```yaml
on:
  push:
    tags:
      - dsh-v*          # 或 opencode-v*
  workflow_dispatch:

permissions:
  contents: read
  id-token: write       # OIDC 必需

jobs:
  publish-dsh:
    if: startsWith(github.ref, 'refs/tags/dsh-v') || (github.event_name == 'workflow_dispatch' && inputs.package == '<pkg>')
    runs-on: ubuntu-latest
    concurrency:
      group: publish-dsh
      cancel-in-progress: false
    defaults:
      run:
        working-directory: packages/<pkg>
    steps:
      - uses: actions/checkout@v4          # 无 ref 参数 → 取 tag 指向的 commit
      - uses: actions/setup-node@v7        # v4–v6 会导出假 token 污染 OIDC
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: npm ci
      - run: npm run build
      - run: npm publish --provenance --access public
```

各要素作用：`job.if` 按 tag 前缀分流各包；`id-token: write` 是 OIDC 环境，**不需要也不使用 `NPM_TOKEN`**；`concurrency` 保证同包发布串行；`actions/checkout@v4`（无 `ref`）取 tag 指向的 commit —— 这是「提前打 tag」事故的直接成因；`setup-node@v7` 因为 v4–v6 会把假 token `XXXXX-XXXXX-XXXXX-XXXXX` 写进 `.npmrc` 破坏 OIDC；`npm ci` 严格校验版本一致；`npm run build` 因产物被 gitignore，不构建就是空包。

**npm CLI 版本**：OIDC 要求 npm CLI ≥ 11.5.1。本仓库靠 `node-version: 24` 自带的 npm 满足（当前 11.17.0）。若你的 Node 版本较低、自带 npm < 11.5.1，在 `npm ci` 前加一步：

```yaml
      - run: npm install -g npm@latest
```

可选但推荐的 CI 校验步骤（本仓库 `publish-dsh` 实测有效）：

```yaml
      - name: 版本一致性校验
        if: startsWith(github.ref, 'refs/tags/')
        run: |
          TAG_VERSION="${GITHUB_REF_NAME#dsh-v}"
          PKG_VERSION=$(node -p "require('./package.json').version")
          if [ "$TAG_VERSION" != "$PKG_VERSION" ]; then
            echo "❌ 版本不一致: tag=$TAG_VERSION, package.json=$PKG_VERSION"
            exit 1
          fi
          echo "✅ 版本一致: $TAG_VERSION"

      - name: 校验 README 版本锚点
        run: |
          VERSION=$(node -p "require('./package.json').version")
          ANCHOR=$(head -20 README.md | grep -E "本文对应.*v${VERSION}\b" | head -1)
          if [ -z "$ANCHOR" ]; then
            echo "::error::README.md 前 20 行未找到版本锚点「本文对应 v${VERSION}」"
            exit 1
          fi
          echo "README 版本锚点校验通过：$ANCHOR"
```

> 注意：版本一致性校验带 `if: startsWith(github.ref, 'refs/tags/')`，`workflow_dispatch` 手动触发时**跳过**；README 锚点校验不区分触发方式，永远执行。

### 1.3 npm 侧：Trusted Publisher（OIDC）

npm 没有「组织级」TP，**每个包单独配一条**：

```bash
npm trust github <pkg> --repo <owner>/<repo> --file publish.yml --allow-publish -y
```

- `--file` 只填 `publish.yml`，**不带** `.github/workflows/` 前缀（npm 自己拼接）。
- `npm trust` 属账号变更操作，需要 2FA（CLI 会给出 `npmjs.com/auth/cli/<uuid>` 链接）。
- 包尚未存在于 registry 时无法预配 TP：**一次性**先生成并发布一个占位版本（如 `0.0.1`），再配 TP。此引导动作之后，正式发版一律只走 CI，本地永不 `npm publish`。
- 查询/撤销：`npm trust list <pkg>` / `npm trust revoke <pkg> --id=<id>`。

### 1.4 关键坑：`actions/checkout` 不带 `ref` 参数

`actions/checkout@v4` 在 tag 触发时默认 checkout **该 tag 指向的 commit**，而不是 `main` 的最新 commit。

后果：如果 tag 是在开发过程中打的，之后又有新提交，那些提交**不会**进入发布产物——CI 依然会绿，包也依然能装，只是内容残缺。见第 6 节事故案例。

---

## 2. 版本号规则

**禁止 `npm version`**。它会自行改号、自行 commit、打 lightweight tag、触发 `preversion`/`version`/`postversion`，与「分提交 + annotated tag + tag 打在已核实的 main SHA 上」的手控流程冲突。

手改以下三处（**`package-lock.json` 有两处 `version`**）：

1. `packages/<pkg>/package.json` 的 `version`
2. `packages/<pkg>/package-lock.json` 顶层 `version`
3. `packages/<pkg>/package-lock.json` 的 `packages[""].version`

第 2/3 处漏改任何一处，CI 的 `npm ci` 直接报 `EUSAGE`：

```
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json are in sync. ... Invalid: lock file's <pkg>@X.Y.Z does not satisfy <pkg>@A.B.C
```

semver 判据：

| 变更性质 | 版本位 |
|----------|--------|
| 新增用户可见功能 | minor（`0.10.2` → `0.11.0`） |
| 仅修复、无新功能 | patch（`0.10.2` → `0.10.3`） |
| 破坏性变更 | major（0.x 阶段可放宽为 minor，但必须在 CHANGELOG 里写明破坏点） |

README 首屏版本锚点必须同步（CI 会校验，前 20 行内）：

```markdown
> 本文对应 **vX.Y.Z**；完整变更历史见 [CHANGELOG.md](./CHANGELOG.md)。
```

---

## 3. 发版前检查清单（按依赖顺序，逐条勾）

```bash
# ① 工作区干净（有输出就是有未提交改动，先处理）
git status --porcelain
# ② 关键测试全绿（按你的包实际脚本）
npm run test:runtime && npm run test:host && npm run typecheck
# ③ 构建产物最新
npm run build        # 或 bun run build
# ④ 版本号三处 + README 锚点一致
node -p "require('./package.json').version"
node -p "require('./package-lock.json').version"
node -p "require('./package-lock.json').packages[''].version"
head -20 README.md | grep "本文对应"
# ⑤ 远程无同名 tag（输出必须为空）
git ls-remote --tags origin | grep "refs/tags/dsh-vX.Y.Z"
# ⑥ 本地无同名 tag（输出必须为空）
git tag -l "dsh-vX.Y.Z"
# ⑦ 确认 tag 将指向的 commit 含全部要发的改动
git log --oneline dsh-v<上个版本>..HEAD
```

| # | 检查项 | 失败症状 |
|---|--------|----------|
| 1 | 工作区干净 | 未提交改动不会进 CI 构建，发布内容缺东西 |
| 2 | 测试全绿 | 发布出去的版本带已知缺陷，同版本号不可重发 |
| 3 | 构建成功 | `lib/` 缺失或空文件，装上去插件加载失败 |
| 4 | 四处版本一致 | CI 报版本校验失败，或 `npm ci` 报 `EUSAGE` |
| 5 | CHANGELOG 已写且只记实际发布内容 | 文档与实物不符，用户被误导 |
| 6/7 | tag 未占用 | `git push` 被拒；或误删已有 tag（严禁） |
| 8 | HEAD 含全部改动 | 发布残缺，只能发下一个版本补救（见第 6 节） |

CHANGELOG 条目在发版前用独立 `docs:` commit 提交，格式参考 Keep a Changelog，分「新增 / 修复 / 变更 / 移除」，每条写清**对使用者的影响**。

---

## 4. 执行顺序（顺序错了就出事）

```
改代码 → 提交 → push main → （再次确认 HEAD 含全部改动）→
打 annotated tag 指向该 commit → push tag → CI 自动发布
```

```bash
# 1. 改动与提交（代码、CHANGELOG、README、版本号分开提交）
git commit -am "feat: ..."
git commit -m "docs: CHANGELOG X.Y.Z"
git commit -m "chore: 版本号 X.Y.Z"
# 2. 推到 main 并核实 SHA：git rev-parse HEAD 与 origin/main 必须一致
git push origin main
git fetch origin && git rev-parse origin/main && git rev-parse HEAD
# 3. 再次核对：这个 commit 是否含全部要发的改动
git log --oneline dsh-v<上个版本>..HEAD
# 4. 打 annotated tag 指向该 commit
git tag -a "dsh-vX.Y.Z" -m "release X.Y.Z" <main-SHA>
# 5. 推送 tag，触发 CI
git push origin "refs/tags/dsh-vX.Y.Z"     # 或 git push --follow-tags
```

**为什么顺序不能颠倒**：CI 的 `actions/checkout` 取的是 **tag 指向的 commit**。提前打 tag 会把之后的提交全部排除在发布之外，而 CI 仍然 success。

---

## 5. 发布后验证（CI 绿 ≠ 能装）

```bash
# ① 版本已上架（注意传播延迟）
npm view <pkg> version

# ② 产物内容核对：解包看 lib/ 里有没有本次新增的关键符号
npm pack <pkg>@X.Y.Z
tar -xzf <pkg>-X.Y.Z.tgz
grep -r "<本次新增的关键符号>" package/lib/ | head
# 轻量替代：npm pack <pkg>@X.Y.Z --dry-run，确认 lib/index.js 存在且非 0 字节
```

registry 传播延迟约 **2–2.5 分钟**（实测：0.10.1 约 2 分钟、0.10.2 约 2.5 分钟、0.10.3 约 30 秒）。首次 `npm view` 查不到新版本是正常现象，**别误判为发布失败**。

```bash
# ③ 重装验证：走 registry 产物，而不是本地 link
dsh plugin --profile <profile> add <pkg>@X.Y.Z

# 确认落盘的真实版本（不要只看命令回显）
node -p "require('C:/Users/<you>/.dsh/profiles/<profile>/node_modules/<pkg>/package.json').version"
```

注意 `<profile>` 的选择：**必须选依赖里写 registry 版本号的那个 profile**；用 `link:` 指向本地 checkout 的 profile 验证不到 npm 产物。装完重启该 profile，确认插件注册的工具/命令真实可用（工具在 = 插件真挂上了，比看日志可靠）。

---

## 6. 事故案例：0.10.0 发布残缺

**现象**：tag 已推送、CI 全绿、`npm view` 与安装都正常，但装到的版本**缺少三个功能**。用户看到的包「看起来是新的」，实际内容是旧的。

**根因**：`dsh-v0.10.0` tag 在开发过程中就被打了并推送，它指向 `8872eae`，而后续三项改动（`4fc30ea` / `6ad6f33` / `ae2ca32`）都晚于该 commit。CI 的 `actions/checkout` 取 tag 指向的 commit → 三项改动全部没进包。

**后果**：npm 上同版本号不可重发（不能删除、覆盖已发布版本），只能发 `0.10.1` 补救，并在 CHANGELOG 新版本段声明 `0.10.0` 不完整。

**教训**：

1. tag 是「发布快照」，必须在**所有改动就位后**再打；不要在开发中途为了跑一次 CI 就打 tag。
2. 打之前用 `git log --oneline <上个tag>..HEAD` 核对：列出的每个 commit 都应该是你想发布的。
3. CI 全绿只证明「workflow 跑通了」，不证明「内容是全的」。

**补救措施**（写进 CHANGELOG 新版本段第一条）：

```markdown
### 修复

- **0.10.0 发布内容不完整，请升级**：`0.10.0` 的 git tag 指向的提交早于本版本多项改动，
  导致 npm 上的 `0.10.0` 实际缺失 <功能 A/B/C>。对使用者的影响：安装过 `0.10.0` 的请升级到 `0.10.1`。
```

---

## 7. 常见坑速查表

| 坑 | 症状 | 解法 |
|----|------|------|
| 锁文件只改一版 `version` | CI `npm ci` 报 `EUSAGE`（package.json 与 lock 不同步） | 改两处：顶层 + `packages[""].version` |
| README 锚点没更新 | CI 报 README 版本锚点校验失败（`::error::`） | 首屏加 `> 本文对应 **vX.Y.Z**`，确保在前 20 行内 |
| 提前打 tag | 发布内容缺后续改动，CI 却 success | 只能发新版本号补救，并在 CHANGELOG 声明前一版不完整 |
| `npm view` 查不到新版本 | 以为发布失败，重复打 tag | 等 2–3 分钟，registry 传播有延迟 |
| 用 `npm version` | 版本号与 lock 不一致、多出 lightweight tag | 手改三处 version，禁止 `npm version` |
| 在本地 `npm publish` | 绕过 CI 校验、无 provenance | 只走 CI；本地永不 publish（TP 引导占位版除外） |
| CHANGELOG 记了未发布的内容 | 文档与实物不符 | 只记实际发出去的内容 |
| 忘了 `npm run build` 后的产物 | 发布空包或缺 `lib/` | 检查 `files` 含 `lib`，CI 必须显式 build |
| workflow 放在子包目录 | CI 永不触发 | 只放仓库根 `.github/workflows/publish.yml` |
| `setup-node@v4~v6` | OIDC 认证失败（假 token 污染 `.npmrc`） | 用 `@v7`，不要手写清空 `NODE_AUTH_TOKEN` 的 workaround |
| `repository.url` 大小写不符 | `npm publish` 报 `E422` | 与 GitHub 仓库字符级一致 |
| 手动触发时跳过版本校验 | `workflow_dispatch` 发出错版本号 | 手动发布前自行核对 `package.json#version` |
