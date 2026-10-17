# Codex 插件开发

本规则仅适用于 `packages/oh-my-codex-cohub` 及仓库级 Codex marketplace。

- 使用 Codex 原生插件机制：`.codex-plugin/plugin.json`、`skills/*/SKILL.md`、`.mcp.json`。
- `.agents/plugins/marketplace.json` 是仓库安装入口，`source.path` 相对仓库根，必须留在仓库内。
- 技能和 Node.js ESM 文件直接加载，`build` 只做结构校验，不生成另一个源码副本。
- 插件清单和包清单的版本号须一致，MCP 服务从包清单读取版本。
- 用户规范根是 `~/.codex/`，应用规则是 `.codex/rules/`；Council 兼容旧 `~/.config/oh-my-codex-cohub/config.json`。
- 安装缓存由 Codex 管理，不手改。源码变化后运行 `npm run install:codex`，再新开会话。
- 代理角色是技能指令，不能把历史 `agents` 配置当成 Codex 原生模型注册。
- 验证命令：仓库根 `npm run build:codex` 和 `npm run test:codex`；测试使用隔离目录和本地模拟服务，不调用真实模型。
- API Key 只从环境读取，自定义密钥变量须同步声明到 `.mcp.json` 的 `env_vars`。

平台依据：[OpenAI 官方插件打包文档](https://developers.openai.com/plugins/build/plugins)。
