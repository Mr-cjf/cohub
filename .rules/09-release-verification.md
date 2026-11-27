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
