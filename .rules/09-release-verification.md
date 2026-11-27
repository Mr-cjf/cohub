# 发版前置：本地实例验证

> 起因：0.13.15 的 client 侧改动通过了 build 与全部单测，但在真实宿主里抛 `Invalid hook call`，导致设置页整节静默消失、用户看不到入口。测试通过 ≠ 能用。

## 硬性要求

任何**会影响运行时行为**的改动（client 代码、preset 注册、工具挂载、schema、派发逻辑），发版前必须走完下面四步。纯文档、CHANGELOG、版本号等元数据改动可跳过。

1. `bun run build` 与 `bun run test:all` 全绿。
2. **起一个隔离实例真实加载一次**（不碰用户正在用的 profile）：
   - 临时 `DSH_HOME`（`%TEMP%\cohub-e2e\<时间戳>\home`）
   - 从目标 profile 复制 `package.json` / `cordis.yml` / `cordis.patch.yml` / lock 等配置
   - `node_modules` 用 **junction** 指向原 profile 的 `node_modules`（`cmd /c mklink /J`），避免重装
   - 空闲端口启动：`node <dsh>/lib/bin.js --profile <p> --port <free> --no-open`
3. **验证到的层面**（按改动类型选）：
   - client：真实打开页面，确认目标 UI 出现、控制台无红错
   - preset / 团队：调 `POST /api/agentPresets/list` 确认 id 与 name；看日志里的注册行
   - 配置：`POST /api/settings/describe` 回读
   - 派发 / 权限：日志或单测证据
4. 全部通过才发版。**验证失败不许发版**，先修再验。

## 清理

先删 junction（`cmd /c rmdir`，绝不能用 `Remove-Item -Recurse`，会穿透到真实 node_modules），再删临时目录。

## 已知踩过的坑

- `ctx.logger.info` 不落 stdout/磁盘，验证时用 `console.log`
- client 组件经 `ctx.slots.register` 挂载，**禁止在组件函数体内用 React hook**（宿主可能直接函数调用渲染），状态走 controller 闭包 + `publish()`
- `git show 大文件 | awk '...exit'` 在文件超 64KB 时会 SIGPIPE（141），配合 `pipefail` 静默失败；先落盘再处理
- **UI 自动化验证用语义定位，不要用坐标点击**：`page.mouse.click(x, y)` 在 DSH 设置页里极易被遮罩层吞掉点击（表现为「面板莫名关闭」「点了没反应」）。改用 Playwright 的 `page.getByRole('button', { name })` / `page.getByText(text, { exact: true })`，必要时 `.first()`，一次即可点通。
- **启动屏需要循环过**：DSH 首次访问会走 6 步启动流程（授权 → 身份确认 → … → WELCOME）。用循环反复尝试点击 `授予访问权限 / 确认身份 / CONTINUE`，每次点击后 `waitForTimeout(1600)`，最后按一次 `Enter`，直到页面出现「新会话」字样再继续。
- **设置入口两个**：`Control+Alt+,` 快捷键最稳；失败再走「账号菜单 → 设置」。每次操作后用 `document.body.innerText` 断言状态（如 `/通用设置/` 判断设置页已打开），不要假设点击一定成功。
- **设置页的展开项要二次点击**：「角色类型」只出现在角色编辑表单里（需先点「添加角色」）；「队长提示词预览」只出现在团队编辑面板里（需先点「新建团队」或编辑）。断言前先确认面板已展开。
- **`file://` 被拦**：Playwright 无法直接打开本地 HTML（`Access to "file:" protocol is blocked`），预览原型只能让用户手动打开。
- **本地实例走系统代理会被劫持**：Playwright 访问 `127.0.0.1` 时静态资源可能全部 `ERR_FAILED`，而 `context.request` 直连同 URL 返回 200。用 `context.route('**/*')` 拦截并用 `context.request.fetch` 转发、剥掉 `content-encoding/content-length/transfer-encoding` 头，即可正常渲染。
- **涉及子代理边界 / 人格 / preset 挂载的改动，必须派一个真任务验证**：单测与产物 grep 都验不出「子代理拿到的 persona 对不对」。0.13.13 为了让 Agent 预设列表干净，改成"档位子代理不挂 preset、继承父组合 + `tools.restrict` 裁剪"——单测全绿、构建通过、列表也干净了，但子代理继承到了父代理（co-orchestrator）的 persona「绝不亲自调用任何文件工具」，system prompt 压过任务书，**所有子代理都拒绝改文件**。`restrict` 只能裁工具，裁不掉 persona。
- **验证方式**：重启后派一个**有副作用**的任务（改一个文件、跑一条命令），确认子代理真的执行了，而不是只看它"回复正常"。回复正常但拒绝动手，就是这个坑的典型症状。
- **判断口诀**：改动如果影响「子代理能做什么」，就必须让子代理实际做一次；影响「界面长什么样」，必须真人或 Playwright 点一次；只影响「字符串内容」，产物 grep 即可。
