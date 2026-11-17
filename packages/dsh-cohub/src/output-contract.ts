// dsh-cohub/src/output-contract.ts
//
// 波2b：12 个专职代理的「输出契约」定义（JSON Schema 子集）+ 启用等级（off/lite/strict）。
//
// 设计约束（为什么是独立模块，而不是塞进 skills.ts / generate-skills.ts）：
//   - schema 是**逻辑**（要进 typecheck、要被校验器消费），技能 Markdown 是**文案**；
//     把逻辑塞进生成物（src/skills.ts 由 skills/*.md 生成）会同时增加构建耦合
//     并让这份数据结构失去 `tsc --noEmit` 覆盖。故本文件是契约的**唯一来源**。
//   - 本波只做「定义 + 配置管道」：默认等级 off，没有任何运行时消费者，
//     因此对 delegate / spawn / prompt 的行为**零影响**（等价于新增死代码）。
//   - 校验器手写，不引任何第三方依赖（仓库硬约束：不得新增 npm 依赖）。
//
// 关键字子集（与 JSON Schema 对齐但只取必要部分）：
//   type / properties / required / items / enum / const / oneOf / description
// 刻意不支持：pattern / minimum / additionalProperties / $ref / allOf / anyOf / format。
// 理由：波3 的校验只用于「结构自检 + 违约提示」，花在正则/数值边界上的 token 与实现
// 成本换不来对应收益；需要更严时用 enum / const / oneOf 表达。

/** 输出契约的启用等级（默认 off） */
export type OutputContractLevel = "off" | "lite" | "strict";

/**
 * 契约节点的类型标签（JSON Schema `type` 的子集）。
 * 只允许 5 种：object / array / string / number / boolean（不支持 null / integer）。
 */
export type OutputContractType = "object" | "array" | "string" | "number" | "boolean";

/** 允许出现在 enum / const 里的标量字面量 */
export type OutputContractLiteral = string | number | boolean;

/**
 * 递归的契约节点。
 *
 * 所有关键字都是可选的：空对象 `{}` 表示「不约束」（校验恒通过）。
 * 递归通过 `properties`（值）、`items`（数组元素）、`oneOf`（任一分支）三处展开。
 */
export interface OutputContractSchema {
  /** 期望的 JSON 类型；缺省 = 不校验类型（仅校验同层的 enum/const/oneOf） */
  type?: OutputContractType;
  /** 面向人/模型的说明；不参与校验，可被 describeContractForPrompt 选择性忽略 */
  description?: string;
  /** 对象字段表：仅对 type=object 生效（type 缺省且值是对象时也生效） */
  properties?: Record<string, OutputContractSchema>;
  /** 必填字段名列表（本子集不支持 `required: false` 这种逐字段写法） */
  required?: string[];
  /** 数组元素契约：仅对 type=array 生效 */
  items?: OutputContractSchema;
  /** 枚举白名单：值必须是其中一项（严格相等比较） */
  enum?: OutputContractLiteral[];
  /** 常量约束：值必须严格等于该标量 */
  const?: OutputContractLiteral;
  /** 任一分支成立即通过 */
  oneOf?: OutputContractSchema[];
}

/**
 * 12 个角色的默认契约（就是最小而有用：每个 2-3 个字段，避免注入时 token 膨胀）。
 *
 * key 必须与 skills/ 下真实存在的角色名一致——`src/skills.ts` 的 COHUB_SKILLS 用
 * `co-` 前缀（co-explorer / co-oracle / ...），故这里同样带前缀，波3 直接用
 * `skill.name` 查表即可，无需二次映射。
 *
 * 为什么没有 `co-cordis`（skills/ 下第 13 个文件）：
 *   它是「创造模式」的插件/组合修复代理，产出是**交互式创作过程**（反复读写工程文件、
 *   与用户确认方案），不是一次性结构化报告；套 JSON 契约会与其现有工作方式冲突。
 *   故本波不配——未配名的 resolve 结果天然是 `schema: undefined`（等价 off）。
 *   同理 `co-orchestrator` 虽在契约表内，但它的产出是「调度摘要」，只有 1 个字段。
 *
 * 关于 required：这里把列出的字段**全部**设为必填。理由：列表型字段允许空数组 `[]`，
 * 因此「必填」的成本只是「键必须出现」，却能让 lite 档的违约提示精确指向真正漏掉的字段；
 * 若某角色确实允许整体省略某字段，波3 再按实测反馈放宽（本波宁严不松，但不校验内容长度）。
 */
export const DEFAULT_OUTPUT_CONTRACTS: Record<string, OutputContractSchema> = {
  // 定位类：报告「查了哪些文件 + 结论」
  "co-explorer": {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" } },
      answer: { type: "string" },
    },
    required: ["files", "answer"],
  },
  // 审查类：三态判决 + 理由 + 可复核锚点（anchors 用 "path:line" 文本）
  "co-oracle": {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "fail", "unknown"] },
      reasons: { type: "array", items: { type: "string" } },
      anchors: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "reasons", "anchors"],
  },
  // 研究类：来源 URL + 结论
  "co-librarian": {
    type: "object",
    properties: {
      sources: { type: "array", items: { type: "string" } },
      answer: { type: "string" },
    },
    required: ["sources", "answer"],
  },
  // 设计/实施类（写）：改了哪些文件 + 一句话说明
  "co-designer": {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
    },
    required: ["files", "summary"],
  },
  // 修复类（写）：变更点 + 自验方式/结果
  "co-fixer": {
    type: "object",
    properties: {
      changed: { type: "array", items: { type: "string" } },
      verification: { type: "string" },
    },
    required: ["changed", "verification"],
  },
  // 视觉/图片观察类：发现项 + 结论
  "co-observer": {
    type: "object",
    properties: {
      findings: { type: "array", items: { type: "string" } },
      answer: { type: "string" },
    },
    required: ["findings", "answer"],
  },
  // 多模型共识：总判决 + 各 councillor 的票
  "co-council": {
    type: "object",
    properties: {
      verdict: { type: "string" },
      votes: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "votes"],
  },
  // 规划类：步骤 + 风险（两项都允许空数组）
  "co-planner": {
    type: "object",
    properties: {
      steps: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
    },
    required: ["steps", "risks"],
  },
  // 三级规范分析（用户级 / 项目级 / 应用级）：规则条目 + 冲突项
  "co-rule-user": {
    type: "object",
    properties: {
      rules: { type: "array", items: { type: "string" } },
      conflicts: { type: "array", items: { type: "string" } },
    },
    required: ["rules", "conflicts"],
  },
  "co-rule-project": {
    type: "object",
    properties: {
      rules: { type: "array", items: { type: "string" } },
      conflicts: { type: "array", items: { type: "string" } },
    },
    required: ["rules", "conflicts"],
  },
  "co-rule-app": {
    type: "object",
    properties: {
      rules: { type: "array", items: { type: "string" } },
      conflicts: { type: "array", items: { type: "string" } },
    },
    required: ["rules", "conflicts"],
  },
  // 调度方：给用户看的收口摘要（要短，故只有 1 个字段）
  "co-orchestrator": {
    type: "object",
    properties: {
      summary: { type: "string" },
    },
    required: ["summary"],
  },
};

/** 契约 / 提示词的长度硬上限（describeContractForPrompt 截断到此值以内） */
export const OUTPUT_CONTRACT_PROMPT_MAX_CHARS = 400;

/**
 * 级别归一化：任何非 "lite" / "strict" 的输入（undefined / 拼错 / 空串 / 配置里被写坏的
 * 值）一律落到 "off"。
 *
 * 为什么需要：schemastery 的 `z.union([...])` 实测**不拒绝**不在字面量列表里的值
 * （`Config({... outputContract: "bogus" })` 原样返回 "bogus"），所以下游不能假定
 * 拿到的等级一定合法。保守归一 = 「读不懂就当没开」，与默认 off 的零行为变化语义一致。
 */
function normalizeLevel(raw: unknown): OutputContractLevel {
  return raw === "lite" || raw === "strict" ? raw : "off";
}

/**
 * 解析某技能应生效的输出契约。
 *
 * 等级优先级：显式 override（来自路由表 `skills[].outputContract`）> 默认 `"off"`。
 * 默认 off 是本波「零行为变化」的关键：未配置 = 不注入、不校验、不重写。
 *
 * schema 从 {@link DEFAULT_OUTPUT_CONTRACTS} 按名取；未登记的角色（如 co-cordis）
 * 返回 `schema: undefined` —— 此时等级即便是 lite/strict 也无契约可注入，等价 off。
 *
 * 命名归一：入参先 trim；若带前缀查不到，再试 `co-` 前缀版本（兼容波3 传裸角色名
 * 如 "explorer" 的写法）。纯字符串处理，无副作用。
 *
 * @param skillName 技能名（`src/skills.ts` 的 COHUB_SKILLS[].name，如 "co-fixer"）
 * @param levelOverride 路由表上的启用等级；缺省按 "off"
 */
export function resolveOutputContract(
  skillName: string,
  levelOverride?: OutputContractLevel,
): { schema?: OutputContractSchema; level: OutputContractLevel } {
  const level: OutputContractLevel = normalizeLevel(levelOverride);
  // 显式放宽为「含 undefined」的视图：Record<string, T> 直接下标会让 TS 误以为恒有值。
  const table: Record<string, OutputContractSchema | undefined> = DEFAULT_OUTPUT_CONTRACTS;
  const key = (typeof skillName === "string" ? skillName : "").trim();
  let schema = table[key];
  if (!schema && key.length > 0 && !key.startsWith("co-")) schema = table["co-" + key];
  return { schema, level };
}

/** 校验结果：通过则 ok=true；失败带字段路径级 errors（如 `$.reasons[0]`） */
export type OutputContractValidationResult = { ok: true } | { ok: false; errors: string[] };

/** 校验器最大递归深度（防御病态/自引用结构；本模块的契约字面量不会超） */
const MAX_VALIDATE_DEPTH = 32;

/** 单个错误的路径展示上限（避免一次上报几十条同类错） */
const MAX_ERRORS = 20;

/**
 * 轻量校验器：按契约子集检查任意值。
 *
 * 支持关键字：type / properties / required / items / enum / const / oneOf。
 * 未知额外字段**不**报错（本子集没有 additionalProperties）；`description` 不参与校验。
 *
 * 错误文本带有路径与期望，便于波3 直接把 errors 拼进「违约提示」：
 *   `$.verdict: 值 "maybe" 不在 enum 白名单内（期望 "pass" | "fail" | "unknown"）`
 *
 * @param value 待校验值（通常是子代理解析后的 JSON）
 * @param schema 契约节点
 */
export function validateAgainstContract(
  value: unknown,
  schema: OutputContractSchema,
): OutputContractValidationResult {
  const errors: string[] = [];
  walkContract(value, schema, "$", errors, 0);
  if (errors.length === 0) return { ok: true };
  return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
}

/** 递归校验内核（对外只暴露 validateAgainstContract） */
function walkContract(
  value: unknown,
  schema: OutputContractSchema,
  path: string,
  errors: string[],
  depth: number,
): void {
  if (errors.length >= MAX_ERRORS) return;
  if (depth > MAX_VALIDATE_DEPTH) {
    errors.push(path + ": 契约嵌套超过 " + MAX_VALIDATE_DEPTH + " 层，已中止校验");
    return;
  }

  // const 优先：常量约束本身就是最强约束，先判可给出更准确的错误
  if (schema.const !== undefined) {
    if (!sameLiteral(value, schema.const)) {
      errors.push(path + ": 期望常量 " + JSON.stringify(schema.const) + "，实际 " + describeValue(value));
      return;
    }
  }

  // enum：严格相等白名单
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.some(item => sameLiteral(value, item))) {
      errors.push(
        path + ": 值不在 enum 白名单内（期望 " + schema.enum.map(v => JSON.stringify(v)).join(" | ")
        + "），实际 " + describeValue(value),
      );
      return;
    }
  }

  // oneOf：任一分支通过即可；分支内部自行给出路径级错误，这里只报「都不匹配」
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matched = schema.oneOf.some(branch => validateAgainstContract(value, branch).ok);
    if (!matched) {
      errors.push(
        path + ": 不匹配 oneOf 的任何一支（期望 " + schema.oneOf.map(b => typeLabel(b, 0)).join(" | ")
        + "），实际 " + describeValue(value),
      );
    }
    return;
  }

  // type：类型不符即中止本节点的深层校验（继续走会产出噪声错误）
  if (schema.type !== undefined) {
    if (!matchesType(value, schema.type)) {
      errors.push(path + ": 期望 " + typeLabel(schema, 0) + "，实际 " + describeValue(value));
      return;
    }
  }

  // 对象：required 缺失 + properties 逐字段下钻
  const props = schema.properties;
  const isObjectLike = props !== undefined && isPlainObject(value);
  if (schema.type === "object" || isObjectLike) {
    if (isPlainObject(value)) {
      for (const name of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
          const child = props?.[name];
          errors.push(
            path + "." + name + ": 缺少必填字段（期望 " + (child ? typeLabel(child, 0) : "值") + "）",
          );
        }
      }
      for (const [name, child] of Object.entries(props ?? {})) {
        if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) continue;
        walkContract(value[name], child, path + "." + name, errors, depth + 1);
        if (errors.length >= MAX_ERRORS) return;
      }
    }
    return;
  }

  // 数组：逐元素下钻（路径带下标，便于模型定位到第几个元素错了）
  if (schema.type === "array" && Array.isArray(value)) {
    const items = schema.items;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        walkContract(value[i], items, path + "[" + i + "]", errors, depth + 1);
        if (errors.length >= MAX_ERRORS) return;
      }
    }
  }
}

/** 类型判定：number 只认同真数值（NaN/Infinity 在 JSON 里不存在，按错处理） */
function matchesType(value: unknown, type: OutputContractType): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

/** 普通对象判定（排除 null / 数组） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** enum/const 用的标量严格相等（JSON 标量只有 string/number/boolean/null） */
function sameLiteral(value: unknown, literal: OutputContractLiteral): boolean {
  return typeof value === typeof literal && (value as OutputContractLiteral) === literal;
}

/** 错误信息里对「实际值」的紧凑描述（字符串截断，避免回填超长模型输出） */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array(" + value.length + ")";
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    const text = value.length > 24 ? value.slice(0, 24) + "…" : value;
    return "string(" + JSON.stringify(text) + ")";
  }
  if (typeof value === "number") return "number(" + String(value) + ")";
  if (typeof value === "boolean") return "boolean(" + String(value) + ")";
  return typeof value;
}

/**
 * 紧凑的类型标签（用于错误信息与提示词）：`string[]` / `"a"|"b"` / `object{a,b}`。
 * 带深度上限，遇到病态嵌套时退化为 `…`。
 */
function typeLabel(schema: OutputContractSchema, depth: number): string {
  if (depth > 6) return "…";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(v => JSON.stringify(v)).join("|");
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return "(" + schema.oneOf.map(b => typeLabel(b, depth + 1)).join("|") + ")";
  }
  if (schema.type === "array") return schema.items ? typeLabel(schema.items, depth + 1) + "[]" : "array";
  if (schema.type === "object" || schema.properties) {
    const names = Object.keys(schema.properties ?? {});
    return names.length > 0 ? "object{" + names.join(",") + "}" : "object";
  }
  return schema.type ?? "any";
}

/**
 * 生成一段紧凑的中文「输出契约」说明（波3 注入 delegate 的 spawn prompt 用）。
 *
 * 保证返回值 ≤ {@link OUTPUT_CONTRACT_PROMPT_MAX_CHARS}（默认 400）字符：
 * 超出时按字符截断并补 `…`（宁可少给说明，也不让注入的 token 无上界）。
 *
 * @param schema 契约节点（通常是 DEFAULT_OUTPUT_CONTRACTS 里的一份）
 */
export function describeContractForPrompt(schema: OutputContractSchema): string {
  const required = new Set(schema.required ?? []);
  const props = schema.properties ?? {};
  const lines: string[] = [
    "输出契约：最终回复只输出一个合法 JSON 对象（不要代码块包裹，不要额外解释）：",
    "示例 " + JSON.stringify(exampleValue(schema, 0)) + "",
  ];
  for (const name of Object.keys(props)) {
    const child = props[name];
    lines.push("- " + name + ": " + typeLabel(child, 0) + (required.has(name) ? "（必填）" : "（可选）"));
  }
  const text = lines.join("\n");
  if (text.length <= OUTPUT_CONTRACT_PROMPT_MAX_CHARS) return text;
  return text.slice(0, OUTPUT_CONTRACT_PROMPT_MAX_CHARS - 1) + "…";
}

/**
 * 按契约生成一个极简示例值（用于提示词里的「示例」行）。
 * 取 enum 首项 / const 本体 / 类型的占位值；对象与数组各展开一层即可。
 */
function exampleValue(schema: OutputContractSchema, depth: number): unknown {
  if (depth > 6) return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return exampleValue(schema.oneOf[0], depth + 1);
  if (schema.type === "array") return schema.items ? [exampleValue(schema.items, depth + 1)] : [];
  if (schema.type === "object" || schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      out[name] = exampleValue(child, depth + 1);
    }
    return out;
  }
  if (schema.type === "number") return 0;
  if (schema.type === "boolean") return true;
  return "文本";
}

/**
 * 从子代理结果文本里提取 JSON（波3 校验的第一步）。三种形态依次尝试：
 *   ① 整段就是 JSON（先 trim）；
 *   ② ```json … ``` 或 ``` … ``` 代码块包裹；
 *   ③ 正文里夹一个 `{...}`（按花括号配平扫描，尊重字符串与转义）。
 *
 * 提取失败不等于「结果里没 JSON」，但按契约语义等价于违约（错误文本 `$: 未能…`），
 * 由调用方决定 lite 标记还是 strict 重写——这里只做提取，不做策略。
 *
 * 误判风险（已知，见文件头「关键字子集」的取舍）：配平扫描取的是**第一个** `{`；
 * 若正文先出现说明性 `{` 而没有合法 JSON，会取到一段不能解析的片段，最终仍判违约。
 * 这对 strict 只意味着「多一次重写」，对 lite 只意味着「多一条标记」，不会误判为合规。
 */
export function extractJsonCandidate(
  text: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "结果为空，没有可校验的 JSON" };
  const candidates: string[] = [trimmed];
  // ② 代码块包裹（```json / ```JSON / ``` 均可；非贪婪，取第一个闭合块）
  const fence = /```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/.exec(raw);
  if (fence && typeof fence[1] === "string") {
    const inner = fence[1].trim();
    if (inner.length > 0) candidates.push(inner);
  }
  // ③ 正文夹一个 {...}：从第一个 `{` 起按配平扫描
  const start = raw.indexOf("{");
  if (start >= 0) {
    const balanced = balancedBraceSlice(raw, start);
    if (balanced !== undefined) candidates.push(balanced);
  }
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch { /* 继续下一个形态 */ }
  }
  return { ok: false, reason: "未能从结果中提取 JSON（需要纯 JSON / ```json 代码块 / 正文中的 {...}）" };
}

/**
 * 从 start（必须是 `{`）起扫描配平的花括号片段。
 * 只做一次线性扫描：字符串内的 `{`/`}` 与转义字符不参与配平；
 * 扫描到文本末尾仍未配平（或长度超过 1MB 防御上限）时返回 undefined。
 */
function balancedBraceSlice(text: string, start: number): string | undefined {
  const MAX_SCAN = 1_048_576;
  const limit = Math.min(text.length, start + MAX_SCAN);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < limit; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/**
 * 组合步骤：提取 + 校验（波3 的 lite / strict 共用入口）。
 * 提取失败也返回 `{ ok: false }`，错误里带 `$:` 前缀，与校验器产出的路径风格一致。
 */
export function validateContractText(
  text: string,
  schema: OutputContractSchema,
): { ok: true } | { ok: false; errors: string[] } {
  const extracted = extractJsonCandidate(text);
  if (!extracted.ok) return { ok: false, errors: ["$: " + extracted.reason] };
  return validateAgainstContract(extracted.value, schema);
}

/**
 * 把校验错误渲染成**一行紧凑的中文标记**（lite 档追加到结果末尾用）：
 *   `[契约] 未满足：$.verification: 缺少必填字段（期望 string）；…`
 * 单条错误已由校验器压短（describeValue 截断），整行再加一道 500 字符上限，
 * 保证注入返回文本的尾巴不随错误数量膨胀。
 */
export function formatContractViolation(errors: string[]): string {
  const text = "[契约] 未满足：" + (errors.length > 0 ? errors.join("；") : "未提供错误详情");
  return text.length > 500 ? text.slice(0, 499) + "…" : text;
}
