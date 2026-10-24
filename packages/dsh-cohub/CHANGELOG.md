# Changelog

本文件记录 dsh-cohub 的所有重要变更。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.6.0] - 2026-10-24

### 新增

- **`delegate` 支持后台 job 模式**：开启 `delegateBackground` 后，子代理注册为 DSH 后台 job 并立即返回 jobId，主代理用 `job_output` 取结果或等待自动唤醒，等待期间可并行推进其他工作；默认关闭，jobs 服务不可用时自动降级为前台同步。
- **后台委派的显式开关与纪律**：`background: true` 可绕过总开关单独指定；技能文档补充了「何时该后台化、如何取结果、等待期如何并行、取消需用 `job_kill`、每个 agent 10 个并发上限」的完整规则。
- **子代理结果预算**：父会话工具结果按契约段保留 + 头尾裁剪 + 全文落盘 locator，防止长输出把上下文撑爆；复用平台 spillStore，不再自建存储。
- **子代理按角色裁剪工具表**：`toolFilter` 以 deny 方式收敛每个代理可见的工具，fail-soft 降级，越权调用在设计上就不成立。
- **子代理模型分层默认值**：只读类代理（explorer / oracle / librarian / observer）默认走 low reasoning effort，重型代理保留高投入，无需逐个手工配置。
- **CoHub 代理模型设置页（恢复）**：在设置页注册独立的 `settings.section`，13 个代理逐行配置 provider / model 双下拉，走 `configForms` 直接读写 volatile `skills`；未配置的代理保持继承父模型。
- **按代理配置推理强度**：设置页每行新增推理强度下拉，档位从 `modelCatalog()` 的 `models[].reasoning.efforts[]` 动态读取；模型不支持时禁用并提示，换模型时自动清空不兼容档位，空值不写入配置（继承父会话）。

### 修复

- **`delegate` 适配 DSH 0.2.1 `startActivation` API**：委派链路在新版运行时上恢复可用。
- **委派错误信息透传 `SubagentResult.diagnostic`**：子代理失败时父会话能看到原始诊断，而不是一句「未知错误」。
- **阻止子代理重复加载 orchestrator 技能**：修复子代理把 orchestrator 技能当成自身职责、错误地再套一层调度的浪费。
- **persona 身份判据收紧到首条用户消息**：此前判据过宽会误触发身份切换，现在只认任务书中的 `--- 你的具体任务 ---` 分隔符。
- **`toolFilter` 下发前求交集**：避免与运行时已有白名单冲突导致的无谓降级。
- **显式请求后台失败时回传降级原因**：不再静默变成前台同步，调用方能看到为什么没进后台。
- **后台 delegate 修正 job owner 与 jobs 服务获取**：owner 改为传 session id 字符串，并从 owner 的 ctx 取 jobs 服务，避免取到错误的挂载点。
- **后台 delegate 把结果写入 `job.result`**：此前结果落在别处，`job_output` 读不到。
- **preset 对齐运行时 0.2.1-rc.2**：preset 组合与当前运行时版本匹配，避免 peer 校验告警。

### 变更

- **任务分档 T0-T3**：单文件改动不再强制走完整五阶段流程，显著降低子代理数量与往返次数，小改动不再被大流程拖住。
- **验证收敛**：T1/T2 档位不再强制召唤 `co-oracle`，按档位选择验证强度。
- **单任务 5 分钟预算 + 先落盘证据纪律**：委派 prompt 附带统一模板，要求先写证据再汇报，超预算即收口。
- **preset compaction 阈值 0.8 → 0.5**：上下文压缩更早触发，长会话更稳。
- **设置页表述与依赖注入同步**：`dsh.client.inject` 补齐 `dsh-client-ui-settings` 与 `dsh-api-remotes`，README 更新到当前形态。

### 文档

- **preset 中 spill-policy 的版本与字段注释修正**：模型分层与 spill 策略的注释不再与实际运行时版本脱节。

## [0.5.1] - 2026-10-19

历史版本详见 git tag `dsh-v0.5.1` 及之前的提交。
