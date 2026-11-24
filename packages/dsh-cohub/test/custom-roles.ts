// dsh-cohub/test/custom-roles.ts —— 自定义角色注册（src/custom-skills.ts）的离线验证
// 用法：node test/custom-roles.ts；由 scripts/test-all.mjs 自动发现。
//
// 被测契约（对应任务书五类）：
//   ① 自定义角色被注册成 runtime skill（名字进技能表 + 正文=prompt + metadata.tier）
//   ② 与内置角色重名 → 跳过 + warn，不抛错、不影响其余自定义角色
//   ③ 两个自定义重名 → 只留第一条 + warn
//   ④ 非法 tier → 跳过 + warn（顺带覆盖非法 kebab-case 名 / 缺名）
//   ⑤ Config 从 A 改成 B（模拟 volatile 提交）→ A 被注销、B 被注册；卸载时全部注销
// 全程使用 mock ctx（skills.register + logger），不依赖真实宿主。
import {
  BUILTIN_SKILL_NAMES,
  CUSTOM_SKILL_TIER_KEY,
  createCustomSkillRegistry,
  planCustomSkills,
  type CustomRoleInput,
} from "../src/custom-skills.ts";
import { COHUB_SKILLS } from "../src/skills.ts";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log("  " + name + ": " + (cond ? "PASS" : "FAIL"));
  if (cond) pass++; else fail++;
}
function group(title: string): void {
  console.log("===== " + title + " =====");
}

/** mock 技能服务：记录注册表并提供真实 disposer（注销后从表里消失） */
function makeMockSkills() {
  const registered = new Map<string, any>();
  const disposed: string[] = [];
  return {
    registered,
    disposed,
    register(skill: any) {
      if (registered.has(skill.name)) throw new Error("duplicate runtime skill: " + skill.name);
      registered.set(skill.name, skill);
      return () => {
        registered.delete(skill.name);
        disposed.push(skill.name);
      };
    },
  };
}

/** mock 日志：收集 warn/info 文本 */
function makeMockLogger() {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    warn(...args: unknown[]) { warns.push(args.map((a) => String((a as any)?.message ?? a)).join(" ")); },
    info(...args: unknown[]) { infos.push(args.map(String).join(" ")); },
  };
}

/** mock ctx：只有 skills.register 与 logger，够 createCustomSkillRegistry 用 */
function makeMockCtx() {
  const skills = makeMockSkills();
  const logger = makeMockLogger();
  return { ctx: { skills, logger }, skills, logger };
}

const ROLE_A: CustomRoleInput = {
  name: "my-reviewer",
  description: "审查我的代码风格",
  prompt: "你是我的代码风格审查员。",
  tier: "ro",
};
const ROLE_B: CustomRoleInput = {
  name: "my-builder",
  description: "跑构建并修错",
  prompt: "你是构建修错专家。",
  tier: "rw-shell",
};

// ── 用例 1：自定义角色被注册成技能 ────────────────────────────────────────
group("用例 1：自定义角色 → runtime skill");
{
  const { ctx, skills, logger } = makeMockCtx();
  const registry = createCustomSkillRegistry({ skills: ctx.skills, getRoles: () => [ROLE_A], logger: ctx.logger });
  registry.start(0); // intervalMs=0 → 只同步一次，不起定时器
  check("技能表出现 my-reviewer", skills.registered.has("my-reviewer"));
  const skill = skills.registered.get("my-reviewer");
  check("description 取自角色 description", skill?.description === ROLE_A.description);
  check("正文取自角色 prompt", skill?.content === ROLE_A.prompt);
  check("技能带 tier 元数据（metadata.tier=ro）", skill?.metadata?.[CUSTOM_SKILL_TIER_KEY] === "ro");
  check("active() 只列自定义技能", registry.active().length === 1 && registry.active()[0] === "my-reviewer");
  check("无 warning", logger.warns.length === 0);
  registry.dispose();
  check("dispose 后技能被注销", !skills.registered.has("my-reviewer"));
}

// ── 用例 2：与内置角色重名 → 跳过 + warn，不抛错 ────────────────────
group("用例 2：与内置角色重名");
{
  check("内置技能名基数 = COHUB_SKILLS 实际条数（不写死数字）", BUILTIN_SKILL_NAMES.length === COHUB_SKILLS.length && COHUB_SKILLS.length >= 13);
  const { ctx, skills, logger } = makeMockCtx();
  const registry = createCustomSkillRegistry({
    skills: ctx.skills,
    getRoles: () => [
      { name: "co-fixer", description: "冒名内置", prompt: "x", tier: "ro" },
      ROLE_A,
    ],
    logger: ctx.logger,
  });
  let threw = false;
  try { registry.start(0); } catch { threw = true; }
  check("不抛错", threw === false);
  check("重名的 co-fixer 未被注册成自定义技能", !skills.registered.has("co-fixer"));
  check("同批正常的 my-reviewer 仍被注册", skills.registered.has("my-reviewer"));
  check("产出一条「与内置角色重名」warn", logger.warns.some((w) => w.includes("co-fixer") && w.includes("内置角色重名")));
  registry.dispose();
}

// ── 用例 3：两个自定义重名 → 只留第一条 ──────────────────────────────────
group("用例 3：自定义角色之间重名");
{
  const { ctx, skills, logger } = makeMockCtx();
  const registry = createCustomSkillRegistry({
    skills: ctx.skills,
    getRoles: () => [
      { name: "my-reviewer", description: "第一条", prompt: "A", tier: "ro" },
      { name: "my-reviewer", description: "第二条", prompt: "B", tier: "rw" },
    ],
    logger: ctx.logger,
  });
  registry.start(0);
  check("只注册一条", registry.active().length === 1 && skills.registered.size === 1);
  check("保留第一条（description=第一条）", skills.registered.get("my-reviewer")?.description === "第一条");
  check("产出一条「保留第一条」warn", logger.warns.some((w) => w.includes("重名") && w.includes("保留第一条")));
  registry.dispose();
}

// ── 用例 4：非法 tier → 跳过 + warn（含脏名字） ──────────────────────────
group("用例 4：非法 tier 与非法名");
{
  const { ctx, skills, logger } = makeMockCtx();
  const registry = createCustomSkillRegistry({
    skills: ctx.skills,
    getRoles: () => [
      { name: "bad-tier", description: "档位拼错", prompt: "x", tier: "rwx" },
      { name: "Bad_Name", description: "大写下划线", prompt: "x", tier: "ro" },
      { name: "", description: "空名", prompt: "x", tier: "ro" },
      ROLE_B,
    ],
    logger: ctx.logger,
  });
  registry.start(0);
  check("非法 tier 未被注册", !skills.registered.has("bad-tier"));
  check("非法名未被注册", !skills.registered.has("Bad_Name") && !skills.registered.has(""));
  check("合法的 my-builder 仍被注册", skills.registered.has("my-builder"));
  check("tier 非法 warn 含合法值清单", logger.warns.some((w) => w.includes("tier 非法") && w.includes("rw-shell")));
  check("非法名 warn 含 kebab-case", logger.warns.some((w) => w.includes("kebab-case")));
  check("空名 warn 含「缺少角色名」", logger.warns.some((w) => w.includes("缺少角色名")));
  check("planCustomSkills 纯函数：不注册只规划", planCustomSkills([ROLE_A]).registrations.length === 1);
  check("planCustomSkills 空输入不抛错", planCustomSkills(undefined).registrations.length === 0);
  registry.dispose();
}

// ── 用例 5：Config 从 A 改成 B → 差量卸载/注册（热更新） ─────────────────
group("用例 5：Config 热变更（A → B）与卸载");
{
  const { ctx, skills } = makeMockCtx();
  let roles: CustomRoleInput[] = [ROLE_A]; // 模拟 volatile 提交：内容交换，引用由 getRoles 每次重读
  const registry = createCustomSkillRegistry({ skills: ctx.skills, getRoles: () => roles, logger: ctx.logger });
  registry.start(0);
  check("初始：my-reviewer 在位", skills.registered.has("my-reviewer"));

  roles = [ROLE_B]; // A → B
  registry.sync();
  check("变更后：旧技能 my-reviewer 被注销", !skills.registered.has("my-reviewer") && skills.disposed.includes("my-reviewer"));
  check("变更后：新技能 my-builder 被注册", skills.registered.has("my-builder"));
  check("active() 只剩新技能", registry.active().length === 1 && registry.active()[0] === "my-builder");

  // 内容不变 → 不重注册（差量，而非全量重建）
  const registeredBefore = skills.registered.get("my-builder");
  roles = [{ ...ROLE_B }];
  registry.sync();
  check("内容未变时不重注册（同一对象仍在位）", skills.registered.get("my-builder") === registeredBefore);
  check("未变时 disposer 未被调用", skills.disposed.filter((n) => n === "my-builder").length === 0);

  // 同一条角色改 tier → 注销旧条目再以新 metadata 注册
  roles = [{ ...ROLE_B, tier: "rw" }];
  registry.sync();
  check("改 tier 后 my-builder 以新档位重建", skills.registered.get("my-builder")?.metadata?.[CUSTOM_SKILL_TIER_KEY] === "rw");

  // 删除全部
  roles = [];
  registry.sync();
  check("清空 customRoles 后所有自定义技能被注销", skills.registered.size === 0 && registry.active().length === 0);

  // 卸载：先有技能再 dispose，全部注销
  roles = [ROLE_A, ROLE_B];
  registry.sync();
  check("重新加回两个角色", skills.registered.size === 2);
  registry.dispose();
  check("dispose 注销全部自定义技能", skills.registered.size === 0);
  check("dispose 后再 sync 不复活技能", (registry.sync(), skills.registered.size === 0));
}

console.log("");
console.log(`结果：PASS ${pass} / ${pass + fail}${fail > 0 ? `，FAIL ${fail}` : ""}`);
if (fail > 0) process.exit(1);
