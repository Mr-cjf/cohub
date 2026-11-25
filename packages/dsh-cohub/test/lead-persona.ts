// dsh-cohub/test/lead-persona.ts —— 运行时按「团队队长」决定主代理人格的离线验证
// 用法：node test/lead-persona.ts（node >= 24 类型剥离）；由 scripts/test-all.mjs 自动发现。
//
// 被测对象（src/roles.ts）：
//   resolveActiveTeam 的 lead 回退规则 / resolveLeadPersona / renderLeadSection
//
// 核心关注点：
//   ① **向后兼容**：无团队时 resolveLeadPersona = null、renderLeadSection = ""（宿主丢弃空 section，
//      系统提示词与改动前逐字一致）；
//   ② 队长人格只取 **brief**（自定义角色取 prompt），不注入全文 content；
//   ③ 换队长不得丢掉调度纪律 —— 注入段必须同时出现队长的 brief 与 orchestrator 的调度纪律。
import { COHUB_SKILLS } from "../src/skills.ts";
import {
  PRIMARY_AGENT_ROLE,
  renderLeadSection,
  resolveActiveTeam,
  resolveLeadPersona,
  type TeamConfig,
} from "../src/roles.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string): void {
  console.log("===== " + title + " =====");
}

/** 内置角色的 brief（测试里按名查，避免写死长文案） */
function briefOf(name: string): string {
  const skill = COHUB_SKILLS.find((item) => item.name === name);
  if (skill === undefined) throw new Error("COHUB_SKILLS 缺少角色 " + name);
  return skill.brief;
}
/** brief 首句（到第一个「。」为止），用于验证「注入的是 brief 而非全文」 */
function firstSentence(text: string): string {
  const at = text.indexOf("。");
  return (at >= 0 ? text.slice(0, at + 1) : text).trim();
}

// ── 用例 1：无活动团队 → 无人格、提示词与现在一致 ─────────────────────────
group("用例 1：无 activeTeam → 不注入（系统提示词与改动前一致）");
const noTeam = { teams: [{ id: "writing", name: "写作组", lead: "co-writer", members: ["co-writer", "co-editor"] }] as readonly TeamConfig[] };
check("activeTeam 缺省 → resolveActiveTeam = null", resolveActiveTeam(noTeam) === null);
check("activeTeam 缺省 → resolveLeadPersona = null", resolveLeadPersona(noTeam) === null);
check("activeTeam 缺省 → renderLeadSection = \"\"（空 section 被宿主丢弃）", renderLeadSection(noTeam) === "");
check("activeTeam 指向不存在的团队 → 同样不注入", renderLeadSection({ ...noTeam, activeTeam: "ghost" }) === "");
check("members 为空的团队 → lead = \"\" 且不注入", (() => {
  const cfg = { teams: [{ id: "empty", name: "空组", members: [] as string[] }] as readonly TeamConfig[], activeTeam: "empty" };
  return resolveActiveTeam(cfg)?.lead === "" && renderLeadSection(cfg) === "";
})());

// ── 用例 2：lead = co-writer → persona 含 writer 的 brief 首句 ─────────────
group("用例 2：团队 lead=co-writer → 主代理人格 = co-writer 的 brief");
const writerCfg = {
  teams: [{ id: "writing", name: "写作组", lead: "co-writer", members: ["co-writer", "co-editor"] }] as readonly TeamConfig[],
  activeTeam: "writing",
};
const writerBrief = firstSentence(briefOf("co-writer"));
const writerPersona = resolveLeadPersona(writerCfg);
check("resolveActiveTeam.lead = co-writer", resolveActiveTeam(writerCfg)?.lead === "co-writer");
check("resolveLeadPersona 非空且 name = co-writer", writerPersona !== null && writerPersona.name === "co-writer");
check("persona 含 writer 的 brief 首句「" + writerBrief + "」",
  writerPersona !== null && writerPersona.persona.includes(writerBrief));
check("persona 是 brief 而非全文 content（长度 = brief 长度）",
  writerPersona !== null && writerPersona.persona === briefOf("co-writer"));
const writerSection = renderLeadSection(writerCfg);
check("注入段含队长人格首句", writerSection.includes(writerBrief));
check("注入段含边界声明「你仍是本会话的调度者」", writerSection.includes("你仍是本会话的调度者"));
check("注入段含可派队员名单（co-writer、co-editor）", writerSection.includes("co-writer、co-editor"));
check("注入段保留调度纪律（含 orchestrator brief）", writerSection.includes(briefOf(PRIMARY_AGENT_ROLE)));
check("注入段含「调度纪律」字样（防换队长丢本职）", writerSection.includes("调度纪律"));

// ── 用例 3：lead 指向不在 members 的角色 → 回退规则生效 ────────────────────
group("用例 3：lead 指向不在 members 的角色 → 按回退规则走");
// ③a：members 含 co-orchestrator → 回退到 co-orchestrator（默认主代理，不注入人格）
const fallbackOrch = {
  teams: [{ id: "t1", name: "含主代理组", lead: "co-ghost", members: [PRIMARY_AGENT_ROLE, "co-fixer"] }] as readonly TeamConfig[],
  activeTeam: "t1",
};
check("lead 不合法 + members 含 co-orchestrator → lead = co-orchestrator",
  resolveActiveTeam(fallbackOrch)?.lead === PRIMARY_AGENT_ROLE);
check("此时不注入队长人格（co-orchestrator 人格由 preset 自带）", renderLeadSection(fallbackOrch) === "");
// ③b：members 不含 co-orchestrator → 回退到第一个成员
const fallbackFirst = {
  teams: [{ id: "t2", name: "无主代理组", lead: " co-ghost ", members: ["co-fixer", "co-editor"] }] as readonly TeamConfig[],
  activeTeam: "t2",
};
check("lead 不合法 + members 不含 co-orchestrator → lead = members[0] = co-fixer",
  resolveActiveTeam(fallbackFirst)?.lead === "co-fixer");
check("回退后的 persona 取 co-fixer 的 brief",
  resolveLeadPersona(fallbackFirst)?.persona === briefOf("co-fixer"));
// ③c：lead 缺省 → 同样走回退（co-orchestrator 优先）
check("lead 缺省 + members 含 co-orchestrator → lead = co-orchestrator",
  resolveActiveTeam({ teams: [{ id: "t3", name: "T3", members: [PRIMARY_AGENT_ROLE, "co-writer"] }], activeTeam: "t3" })?.lead
  === PRIMARY_AGENT_ROLE);
check("lead 缺省 + members 不含 co-orchestrator → lead = members[0]",
  resolveActiveTeam({ teams: [{ id: "t4", name: "T4", members: ["co-writer", "co-editor"] }], activeTeam: "t4" })?.lead
  === "co-writer");

// ── 用例 4：自定义角色当队长 → 用其 prompt ────────────────────────────────
group("用例 4：自定义角色当队长 → persona = 其 prompt");
const customPrompt = "你是品牌文案主笔：只用 delegate 派活，所有对外文案统一口吻，不亲自改代码。";
const customCfg = {
  teams: [{ id: "brand", name: "品牌组", lead: "my-brand-lead", members: ["my-brand-lead", "co-writer"] }] as readonly TeamConfig[],
  activeTeam: "brand",
  customRoles: [{
    name: "my-brand-lead",
    description: "品牌文案主笔",
    prompt: customPrompt,
    tier: "rw" as const,
  }],
};
check("lead 命中自定义角色", resolveActiveTeam(customCfg)?.lead === "my-brand-lead");
const customPersona = resolveLeadPersona(customCfg);
check("persona = 自定义 prompt（逐字）", customPersona !== null && customPersona.persona === customPrompt);
check("title = 自定义 description", customPersona !== null && customPersona.title === "品牌文案主笔");
check("注入段含自定义 prompt", renderLeadSection(customCfg).includes(customPrompt));
check("自定义队长同样保留调度纪律", renderLeadSection(customCfg).includes(briefOf(PRIMARY_AGENT_ROLE)));

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log("");
console.log(`===== 汇总：PASS ${pass}，FAIL ${fail}（共 ${pass + fail} 个用例） =====`);
process.exit(fail === 0 ? 0 : 1);
