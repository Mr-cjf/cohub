// dsh-cohub/src/builtin-teams.ts —— 内置团队（随包发布，与用户自建 Config.teams 并列）
//
// 为什么单独成文件：这两套团队**不是用户配置**，而是包的事实源数据；team-presets.ts（注册为
// Agent 预设）与 roles.ts（会话限员判定）都要读它，但本文件不能反过来依赖它们（否则成环）。
// 因此这里只导出纯数据 + 形状类型，不 import 任何模块。
//
// 成员名必须与 roles.ts 的 `BUILTIN_ROLE_TIERS` 逐字一致（档位表是「角色能否被派发」的正源）。
// test/builtin-teams.ts 会逐字校验，新增 / 改名内置角色时两边一起改。
//
// 注册规则（实现见 team-presets.ts 的 buildTeamPresetDefs）：
//   · 内置团队先产出（order 40 / 41），用户团队 order 从 50 起；
//   · 用户团队用同名 id（如 dev）时**用户优先**，内置该条跳过；
//   · 内置团队永不被「Config.teams 变化」注销（它们不在配置里），只在插件 dispose 时统一卸载。

/** 内置团队（结构与 roles.ts 的 TeamConfig 兼容，额外带 builtin 来源标记） */
export interface BuiltinTeam {
  /** 团队 id（决定预设 id：`cohub-team-<id>`） */
  readonly id: string;
  /** 显示名（进 Agent 预设选择器） */
  readonly name: string;
  /** 一句话说明 */
  readonly description: string;
  /** 成员角色名（必须是内置角色名，见 BUILTIN_ROLE_TIERS） */
  readonly members: readonly string[];
  /** 队长角色名：co-orchestrator = 主代理本身，不额外注入人格 */
  readonly lead: string;
  /** 恒为 true：标记来源，便于调用方区分内置 / 用户团队 */
  readonly builtin: true;
}

/**
 * 内置团队表。
 *
 * `dev`：软件开发全流程——实施（fixer）/ 设计（designer）/ 定位（explorer）/ 审查（oracle）/
 *        方案（planner）/ 文档（librarian）/ 视觉（observer）/ 共识（council）/ 规则三件套 /
 *        插件组合（cordis）。
 * `writing`：中文内容创作——选题提纲（outliner）/ 成稿改稿（writer）/ 审校（editor）。
 */
export const BUILTIN_TEAMS: readonly BuiltinTeam[] = [
  {
    id: "dev",
    name: "开发团队",
    description: "通用软件开发团队：调度 + 12 个专职子代理",
    members: [
      "co-fixer",
      "co-designer",
      "co-explorer",
      "co-oracle",
      "co-planner",
      "co-librarian",
      "co-observer",
      "co-council",
      "co-rule-user",
      "co-rule-project",
      "co-rule-app",
      "co-cordis",
    ],
    lead: "co-orchestrator",
    builtin: true,
  },
  {
    id: "writing",
    name: "写作团队",
    description: "中文内容创作团队：选题、成稿、审校",
    members: ["co-writer", "co-editor", "co-outliner"],
    lead: "co-orchestrator",
    builtin: true,
  },
];
