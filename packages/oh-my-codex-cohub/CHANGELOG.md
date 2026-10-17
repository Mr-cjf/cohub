# 变更记录

## 1.6.2（2026-10-17）

- Council 兼容 `summary` / `full` 两种结果模式：默认省略 `result_mode` 时保持既有 full 行为；`summary` 下省略成员正文并标注「原始长度 / 已省略」，chair 综合与错误信息完整保留。
- 无 chair 显式配置时回退到任一成员观点，不丢失立场。
- chair 汇总保留元信息与完整错误：broken 成员错误完整上抛且不标记成功。
- 纯调度语义与既有两层聚合行为保持不变。

## 1.6.1（2026-10-15）

- 修复 Orchestrator 入口启停时改写受管区块外用户空白和尾部内容的问题。
- 修复入口文件并发修改保护：最终提交前再次校验，原子替换失败时不覆盖用户文件。
- 修复测试解析器读取真实用户配置导致的污染，完整测试恢复为 56/56 通过。

## 1.6.0（2026-10-15）

- 增加可撤销的默认 Orchestrator 入口：`orchestrator:status`、`orchestrator:enable`、`orchestrator:disable`。
- 启用入口后，普通工程、部署状态、故障排查、测试和远程检查任务默认先委派 worker；闲聊、用户明确豁免和更高优先级规则继续跳过。
- 管理脚本保留用户 AGENTS 内容，支持幂等启停、override 选择、CRLF、备份和损坏标记拒绝写入。
- 明确指导模式与严格权限隔离的边界；当前版本不把 Hooks 或模型提示包装成严格模式保证。

## 1.5.1（2026-10-14）

- 明确 `dispatch_prepare` / `dispatch_send` 两阶段派发：先收齐全部就绪任务及完整参数，再连续提交原生调用；容量不足时保留队列。
- 增加实际派发时间、启动 spread 和任务重叠量的验收记录要求，并说明宿主启动间隔的边界。
- 将派发准备、发送与模型解析约束集中到效率规范，其他技能改为引用。

## 1.5.0（2026-10-14）

- 新增按角色解析的 `subagents` 配置，可为 defaults 和各 `co-*` 角色指定模型及 `reasoning_effort`，并按字段合并项目、用户与临时覆盖。
- 新增 `resolve:agents` 批量解析 CLI；CLI 输出供 Codex 原生子代理工具使用的参数，不自行启动子代理。
- 旧 `agents` 字段不生效；运行时从当前工具能力校验显式模型与推理强度。
- 更新配置示例、JSON Schema 与本地结构校验。

## 1.4.0（2026-10-14）

- 精简普通任务流程，按宿主容量调度无冲突的就绪任务；移除插件默认并发上限。
- 统一委派上下文、任务状态和结果回传规范，改用字符软预算并保留必要契约。
- 新增日志摘要与检查证据 helper；调用方提供已完成日志和真实退出码，helper 不运行项目命令。
- 增加 Codex 技能引用/frontmatter 结构校验及辅助命令文档。

## 1.3.0（2026-10-13）

- 增加 Codex 原生批量操作规范，并接入主编排、调度、规划、执行、设计、定位和审查技能。
- 批量文件读取与补丁合并；文件及生成目录、锁文件等共享资源均纳入写入冲突判断。
- 按运行时名额分批派发独立代理，默认每批最多 3 个，完成后为已就绪任务补位。
- 独立命令一轮并行调用，逐项核对退出码、错误及运行会话；依赖命令按顺序执行。
- 支持 `implementation-only` 执行批次，由指定负责人统一验证；区分已实现、已验证和失败阻断状态。

## 1.2.0（2026-10-13）

- 纳入 `Mr-cjf/cohub` monorepo，项目内源码成为唯一维护来源。
- 添加仓库 marketplace、结构校验、MCP 测试和本地安装命令。
- Council 配置迁入 `~/.codex/oh-my-codex-cohub/`，兼容旧路径和 `COHUB_CONFIG`。
- 修复 MCP API Key 环境变量转发，统一版本号及仓库链接。
- 项目规范代理读取 `.rules/*.md`；说明技能不会自动注册固定模型的 Codex 子代理。

## 1.1.0（2026-08-04）

- 同步参考插件 1.12.x 特性：
  - ContextGuard 上下文卫士（`none` / `relevant` / `summary` 策略 + 「📋 任务上下文」注入，见 `skills/cohub/references/context-guard.md`）
  - 四阶段并行决策框架（信息收集/规则分析总是并行；执行按文件冲突并行或串行；验证并行）
  - 任务看板（Task Board）与最终对账、产出复用
  - co-oracle vs co-council 选择指南（可逆→oracle，不可逆→council）
  - 历史子代理模型建议：仅 orchestrator 用 Pro，其余用 Flash（旧 `agents` 配置不生效）
  - 配置外化与「AI 配置文案」说明
- 更新 co-orchestrator / co-oracle / co-council / co-fixer / co-planner 提示词

## 1.0.1（2026-08-01）

- co-rule-app 完全 Codex 化：只读取 `.codex/rules/*.md`，移除 `.opencode/rules/` 回退

## 1.0.0（2026-08-01）

- 首个 Codex 插件版 CoHub
- 12 个中文代理技能（co-orchestrator / co-oracle / co-librarian / co-explorer / co-designer / co-fixer / co-observer / co-council / co-rule-user / co-rule-project / co-rule-app / co-planner）
- 主编排技能 cohub：六步工作流 + 纯调度 Orchestrator 规则
- council_session / council_presets MCP 工具（零依赖 Node 实现）
- 配置示例与 JSON Schema
