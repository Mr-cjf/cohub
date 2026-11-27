// dsh-cohub/src/preset-runtime.ts —— 档位 preset 的**运行时注册**（消除「声明写入晚于启动加载」）
//
// 背景（问题）：
//   旧链路只有「把声明写进 profile 的 cordis.patch.yml」这一条路（见 preset-install.ts 第二部分）。
//   该声明由 profile 的 Loader 在**启动时**读取，而 dsh-cohub 的 apply() 是在 Loader 已经把
//   组合加载完之后才跑的 —— 于是「本次写进去的声明」要等到**下一次重启**才生效。
//   表现就是：装了新版本 cohub，选择器里还没有 cohub-subagent-write-shell，必须重启。
//
// 本文件的办法（正向修复）：
//   宿主提供 `agentPresets` 服务，`await ctx.agentPresets.register({ id, name, description,
//   order, plugins })` 是**当场生效**的：register 内部立即 activate() → mountPreset()，
//   返回 unregister 句柄；id 重复才抛 `Duplicate agent preset`（见 delegate.ts 里对
//   'Unknown agent preset: <id>' 的既有说明）。因此本模块在 apply() 里直接把**全部档位预设**
//   （cohub-cordis + 4 个子代理档位 readonly / readonly-net / write / write-shell）注册进内存
//   注册表，**不依赖任何落盘声明、不需要重启**。
//   为什么 4 个档位必须各自独立预置：persona 只能由 preset 提供，tools.restrict 只裁工具、
//   裁不掉 persona。子代理继承父组合时会把父代理（co-orchestrator 等）的「纯调度者」persona
//   当成自己的 system prompt，与任务书冲突时 system 优先 → 子代理拒绝改文件。
//
// 声明从哪来：
//   唯一事实源仍是包内 `presets/<id>/`（preset.yml 的 name/description/order +
//   agent.cordis.yml 的 plugins 行），与 preset-install.ts 写入 patch 的那份完全同源，
//   不存在「两套清单要同步维护」的问题。
//
// YAML → JS 对象怎么解（不新增任何 npm 依赖）：
//   agent.cordis.yml 是**受限 YAML 子集**（块序列 / 块映射 / 块标量 |- / 引号标量 /
//   布尔 / 数字 / 注释 / `!!js` 自定义标签）。仓库里没有已声明的 YAML 解析依赖，
//   而本包**禁止新增依赖**，故这里自带一个约 150 行的子集解析器 {@link parseMiniYaml}，
//   只覆盖 preset 组合文件里真实出现的语法；遇到不认识的写法一律 fail-soft（跳过该档位并 warn），
//   绝不半解析出错误的组合。
//
//   `!!js <expr>` 的处理（关键）：
//     YAML 里写作 `disabled: !!js process.platform === 'win32'`。原样把字符串
//     `"!!js process.platform === 'win32'"` 交给宿主是危险的——宿主若不做 YAML 标签求值，
//     非空字符串是 truthy，会把 `tool-pwsh` 也一起禁掉（win32 下反了、非 win32 也反了）。
//     所以这里**在注册前按当前进程的 process.platform 就地求值成真正的布尔**：
//     只支持 preset 里实际使用的两种比较写法（`===` / `!==`，可带前置 `!`），
//     不 eval、不引入代码执行面。
//
//   `!!js "fileURLToPath(new URL('skills/', baseUrl))"` 的处理（cohub-cordis 的 customSkillDirs）：
//     YAML 里写作 `- !!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"`。
//     baseUrl 是 **preset 自己的目录**（注释见该 yml），因此这里按「该 preset 目录的绝对路径」把它
//     求值成真正的字符串：`<presetsDir>/<presetId>/skills`。若不求值而交给宿主，
//     skill-filesystem 的 `customSkillDirs: string[]` 会拿到非字符串并让整个 preset 挂载失败。
//     同样不 eval，只做受控的「相对段 + baseUrl」拼接，并拒绝逃出 preset 目录的 `..`。
//
//   无法识别的 `!!js`（两个求值器都不认）：
//     **丢弃该键 / 该数组项**并 warn —— 绝不把对象或未求值字符串塞进宿主配置（那是一颗地雷）。
//     注册前另有 {@link assertCustomSkillDirs} 兜底：`customSkillDirs` 里非 string 的项一律剔除。

import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 本包内置的 agent preset 目录（随 files 字段打包进 npm 包） */
export const COHUB_PRESETS_DIR: string = fileURLToPath(new URL("../presets/", import.meta.url));

/** 一个可直接交给 agentPresets.register() 的 preset 定义 */
export interface CohubPresetDef {
  /** preset id（= presets/ 下的目录名，也是 agentPreset 字段的取值） */
  readonly id: string;
  /** 显示名（preset.yml 的 name） */
  readonly name: string;
  /** 一句话说明（preset.yml 的 description） */
  readonly description?: string;
  /** 排序（preset.yml 的 order；缺省不传，由宿主决定） */
  readonly order?: number;
  /** 组合行（agent.cordis.yml 解析结果） */
  readonly plugins: unknown[];
}

/** 最小日志接口（cordis 的 logger 与测试 mock 都能满足） */
interface Logger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// 第一部分：受限 YAML 子集解析器（零依赖）
//
// 只支持 preset 组合文件里真实用到的语法，刻意不支持锚点 / 多文档 / 流式风格：
//   · 注释行（整行 `#`）与行内 ` #` 注释
//   · 块序列 `- item`（item 可以是内联映射 `/ - id: x`、内联标量、或更深层子块）
//   · 块映射 `key: value` / `key:` + 缩进子块
//   · 块标量 `|` `|-` `>` `>-`（persona 的 prefix/suffix 用的就是 `|-`）
//   · 标量：单/双引号字符串、数字、true/false/null、普通字符串（含 `!!js ...` 原样保留）
// ─────────────────────────────────────────────────────────────────────────────

/** 解析结果类型（够用即可；调用方按 unknown 消费） */
export type MiniYamlNode =
  | string
  | number
  | boolean
  | null
  | MiniYamlNode[]
  | { [key: string]: MiniYamlNode };

interface SourceLine {
  /** 原始行（块标量要按原文裁剪缩进，故必须保留） */
  raw: string;
  /** 前导空格数 */
  indent: number;
  /** 去掉首尾空白后的内容（判定语法用） */
  content: string;
}

/** 单/双引号去引号（双引号按 JSON 的转义规则还原；失败则退化为去引号） */
function unquoteScalar(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    // YAML 单引号里只有 '' 是转义
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/** 剥掉行内注释（` #` 之后；引号内的 # 不动）。preset 文件里只有独立行注释，此处仅作防御。 */
function stripInlineComment(text: string): string {
  const trimmed = text;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed;
  const at = trimmed.search(/\s#/);
  return at < 0 ? trimmed : trimmed.slice(0, at);
}

/** 标量 → 原始形态值（字符串 / 数字 / 布尔 / null；`!!js` 前缀保持为字符串） */
function parseScalar(text: string): MiniYamlNode {
  const bare = stripInlineComment(text).trim();
  if (bare === "") return null;
  if (bare === "true") return true;
  if (bare === "false") return false;
  if (bare === "null" || bare === "~") return null;
  if (bare.startsWith('"') || bare.startsWith("'")) return unquoteScalar(bare);
  // `!!js <expr>`：**原样保留整个字符串**（含标签），由 materializeJsTags() 在注册前求值
  if (bare.startsWith("!!js ") || bare === "!!js") return bare;
  if (/^-?\d+$/.test(bare)) return Number(bare);
  if (/^-?\d+\.\d+$/.test(bare)) return Number(bare);
  return bare;
}

/**
 * 解析受限 YAML 子集。
 *
 * 实现取「行数组 + 游标 + 递归缩进」：序列项 `- id: x` 会被就地改写成
 * 等效的映射行（缩进 +2），从而复用同一份映射解析逻辑，不做两套语法。
 */
export function parseMiniYaml(text: string): MiniYamlNode {
  const lines: SourceLine[] = text.replace(/\r\n/g, "\n").split("\n").map((raw) => {
    const trimmedStart = raw.trimStart();
    return { raw, indent: raw.length - trimmedStart.length, content: trimmedStart.trimEnd() };
  });
  let cursor = 0;

  const skipIgnorable = (): void => {
    while (cursor < lines.length) {
      const line = lines[cursor]!;
      if (line.content === "" || line.content.startsWith("#")) cursor++;
      else break;
    }
  };

  /** 读块标量（| > |- >-）：直到缩进 <= 父缩进为止，按原文裁掉公共缩进 */
  const readBlockScalar = (header: string, parentIndent: number): string => {
    const folded = header.startsWith(">");
    const strip = header.endsWith("-");
    const collected: string[] = [];
    const pendingBlank: string[] = [];
    let blockIndent = -1;
    while (cursor < lines.length) {
      const line = lines[cursor]!;
      if (line.content === "") {
        pendingBlank.push("");
        cursor++;
        continue;
      }
      if (line.indent <= parentIndent) break;
      if (blockIndent < 0) blockIndent = line.indent;
      if (pendingBlank.length > 0) {
        collected.push(...pendingBlank);
        pendingBlank.length = 0;
      }
      collected.push(line.raw.slice(blockIndent));
      cursor++;
    }
    const body = folded ? collected.join(" ") : collected.join("\n");
    return strip ? body : body + "\n";
  };

  const parseMap = (indent: number): { [key: string]: MiniYamlNode } => {
    const out: { [key: string]: MiniYamlNode } = {};
    for (;;) {
      skipIgnorable();
      if (cursor >= lines.length) break;
      const line = lines[cursor]!;
      if (line.indent !== indent) break;
      // 序列项不能被当映射键（`- id: x` 会误匹配 key="- id"），遇到就交回上层
      if (line.content === "-" || line.content.startsWith("- ")) break;
      const match = /^([^:#][^:]*?):(?:\s+([\s\S]*))?$/.exec(line.content);
      if (match === null) break;
      const key = unquoteScalar(match[1]!.trim());
      const rest = (match[2] ?? "").trim();
      cursor++;
      if (rest === "") {
        const child = parseBlock(indent + 1);
        out[key] = child;
        continue;
      }
      if (/^[|>][+-]?\d*$/.test(rest)) {
        out[key] = readBlockScalar(rest, indent);
        continue;
      }
      out[key] = parseScalar(rest);
    }
    return out;
  };

  const parseSeq = (indent: number): MiniYamlNode[] => {
    const out: MiniYamlNode[] = [];
    for (;;) {
      skipIgnorable();
      if (cursor >= lines.length) break;
      const line = lines[cursor]!;
      if (line.indent !== indent) break;
      if (!(line.content === "-" || line.content.startsWith("- "))) break;
      const rest = line.content === "-" ? "" : line.content.slice(2).trim();
      if (rest === "") {
        cursor++;
        out.push(parseBlock(indent + 1));
        continue;
      }
      // `- !!js <expr>` 是**标量序列项**，不能进映射解析：表达式里可能带 `node:url` 的冒号，
      // 会被 `key: value` 正则误切成对象（cohub-cordis 的 customSkillDirs 正是栽在这里）。
      if (/^!!js(\s|$)/.test(rest)) {
        cursor++;
        out.push(parseScalar(rest));
        continue;
      }
      // 就地改写为等效映射行（缩进 +2），让 `- id: x` 与后续同项键走同一套映射解析
      lines[cursor] = { raw: " ".repeat(indent + 2) + rest, indent: indent + 2, content: rest };
      out.push(parseBlock(indent + 1));
    }
    return out;
  };

  const parseBlock = (minIndent: number): MiniYamlNode => {
    skipIgnorable();
    if (cursor >= lines.length) return null;
    const line = lines[cursor]!;
    if (line.indent < minIndent) return null;
    if (line.content === "-" || line.content.startsWith("- ")) return parseSeq(line.indent);
    return parseMap(line.indent);
  };

  const root = parseBlock(0);
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// 第二部分：`!!js` 标签物化（YAML 标签 → 当前进程的真实布尔）
// ─────────────────────────────────────────────────────────────────────────────

const JS_TAG_PREFIX = /^!!js\s+([\s\S]+)$/;

/** `fileURLToPath(new URL('<rel>', baseUrl))`，允许带 `process.getBuiltinModule('node:url').` 前缀 */
const URL_DIR_EXPR =
  /^(?:process\s*\.\s*getBuiltinModule\(\s*(['"])node:url\1\s*\)\s*\.\s*)?fileURLToPath\(\s*new\s+URL\(\s*(['"])([^'"]*)\2\s*,\s*baseUrl\s*\)\s*\)$/;

/** 求值失败时的「丢弃」哨兵：数组项被 splice、映射键被 delete，绝不落进宿主配置 */
const DROP_JS_TAG: unique symbol = Symbol("cohub.dropJsTag");

/**
 * 求值 preset 里实际使用的 `!!js` 表达式。
 *
 * 支持：`process.platform === 'win32'` / `!== 'win32'`（可带前置 `!`，可带 `[...]` 之外的空白）。
 * 不支持的一律返回 undefined（调用方保留原字符串）。
 */
export function evaluatePlatformExpr(expr: string, platform: string = process.platform): boolean | undefined {
  const text = expr.trim();
  const negated = text.startsWith("!") && !text.startsWith("!==");
  const body = negated ? text.replace(/^!+/, "").trim() : text;
  const match = /^process\.platform\s*(===|!==|==|!=)\s*(['"])([\w.-]+)\2$/.exec(body);
  if (match === null) return undefined;
  const op = match[1]!;
  const target = match[3]!;
  const equal = op === "===" || op === "==";
  const result = equal ? platform === target : platform !== target;
  return negated ? !result : result;
}

/**
 * 识别并求值 `fileURLToPath(new URL('<rel>/', baseUrl))` 形式的 `!!js`（cohub-cordis 的
 * `skill-filesystem.config.customSkillDirs`）。
 *
 * 语义：`baseUrl` = **该 preset 自己的目录**（yml 里这么注释），故结果 = `resolve(baseDir, rel)`。
 * 不做任何代码求值；相对段为绝对路径或试图 `..` 逃出 preset 目录时返回 undefined（视为不可识别）。
 */
export function evaluateUrlDirExpr(expr: string, baseDir: string): string | undefined {
  const match = URL_DIR_EXPR.exec(unquoteScalar(expr.trim()));
  if (match === null) return undefined;
  const relative = match[3]!;
  if (relative === "" || relative.startsWith("/") || relative.startsWith("\\") || /^[a-zA-Z]:/.test(relative)) return undefined;
  const root = resolve(baseDir);
  const target = resolve(root, relative);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(prefix)) return undefined;
  return target;
}

/**
 * 注册前兜底断言：`skill-filesystem.config.customSkillDirs` 的每一项都必须是 string。
 *
 * 非字符串项（旧解析器把 `!!js "…node:url…"` 当映射键时产生的对象）就地剔除并 warn；
 * 整个键不是数组时直接丢弃该键 —— 宁可少一个技能目录，也不要让整个 preset 挂载失败。
 */
export function assertCustomSkillDirs(plugins: readonly unknown[], logger?: Logger): void {
  for (const line of plugins) {
    if (line === null || typeof line !== "object" || Array.isArray(line)) continue;
    const record = line as Record<string, unknown>;
    if (record.name !== "@deepseek-ai/dsh-skill-filesystem") continue;
    const config = record.config;
    if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
    const cfg = config as Record<string, unknown>;
    if (!("customSkillDirs" in cfg)) continue;
    const dirs = cfg.customSkillDirs;
    if (!Array.isArray(dirs)) {
      logger?.warn?.(`cohub: skill-filesystem.customSkillDirs 不是数组（${typeof dirs}），已丢弃该键`);
      delete cfg.customSkillDirs;
      continue;
    }
    const kept = dirs.filter((entry): entry is string => typeof entry === "string");
    if (kept.length !== dirs.length) {
      logger?.warn?.(`cohub: skill-filesystem.customSkillDirs 含 ${dirs.length - kept.length} 个非字符串项，已剔除`);
      cfg.customSkillDirs = kept;
    }
  }
}

/**
 * 把组合行里所有 `!!js <expr>` 字符串就地换成求值结果。
 *
 * 无法求值的表达式**保留原字符串**并交给宿主（logger 只 warn，不改变其它行）。
 * 返回值同时给出被替换的键路径，便于测试与排查。
 */
export function materializeJsTags(
  node: unknown,
  logger?: Logger,
  platform: string = process.platform,
  path = "plugins",
  baseDir?: string,
): unknown {
  if (typeof node === "string") {
    const match = JS_TAG_PREFIX.exec(node.trim());
    if (match === null) return node;
    const rawExpr = match[1]!.trim();
    // `!!js "…"`：外层引号属于 YAML 标量，不是表达式的一部分
    const expr = unquoteScalar(rawExpr);
    const boolValue = evaluatePlatformExpr(expr, platform);
    if (boolValue !== undefined) return boolValue;
    if (baseDir !== undefined) {
      const dirValue = evaluateUrlDirExpr(expr, baseDir);
      if (dirValue !== undefined) return dirValue;
    }
    // 求不出来就**丢弃**（不是原样交给宿主）：对象 / 未求值字符串都会把宿主配置搞崩
    logger?.warn?.(`cohub: 无法求值的 !!js 表达式，已丢弃该键以免把非字符串值交给宿主：${path} = ${rawExpr}`);
    return DROP_JS_TAG;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const value = materializeJsTags(node[i], logger, platform, `${path}[${i}]`, baseDir);
      if (value === DROP_JS_TAG) {
        node.splice(i, 1);
        i--;
        continue;
      }
      node[i] = value;
    }
    return node;
  }
  if (node !== null && typeof node === "object") {
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = materializeJsTags(record[key], logger, platform, `${path}.${key}`, baseDir);
      if (value === DROP_JS_TAG) {
        delete record[key];
        continue;
      }
      record[key] = value;
    }
    return record;
  }
  return node;
}

// ─────────────────────────────────────────────────────────────────────────────
// 第三部分：读包内 presets/ → 档位定义
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由**团队注册**接管的 preset id（档位注册必须跳过，否则同 id 撞 `Duplicate agent preset`）。
 *
 * `co-orchestrator` 由 team-presets.ts 以「开发团队」的名义注册（见 builtin-teams.ts 的
 * `dev.presetId`）：presets/co-orchestrator/ 仍是它的**工具面事实源**（团队组装照抄那排插件），
 * 但 name / description / persona 换成团队版，注册权也归团队。
 *
 * 4 个档位子代理 preset（readonly / readonly-net / write / write-shell）**由本模块注册**：
 * 每个档位必须挂独立预设，才能拿到「专职子代理」persona（继承父组合会让子代理继承
 * co-orchestrator 的纯调度 persona 而拒绝改文件，restrict 裁不掉 persona）。
 * `cohub-cordis` 同理（另需 tool-cordis 工具）。
 */
export const TEAM_OWNED_PRESET_IDS: readonly string[] = ["co-orchestrator"];

/** preset id 合法性：与 preset-install.ts 的 isSafePresetId 同义（目录名，不允许路径穿越） */
function isSafePresetId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..");
}

/** 读 preset.yml 的 name / description / order（走同一个小解析器，不做第二套行级逻辑） */
function readPresetMeta(dir: string): { name?: string; description?: string; order?: number } {
  try {
    const node = parseMiniYaml(readFileSync(join(dir, "preset.yml"), "utf8"));
    if (node === null || typeof node !== "object" || Array.isArray(node)) return {};
    const record = node as Record<string, MiniYamlNode>;
    const name = typeof record.name === "string" ? record.name : undefined;
    const description = typeof record.description === "string" ? record.description : undefined;
    const order = typeof record.order === "number" && Number.isFinite(record.order) ? record.order : undefined;
    return { name, description, order };
  } catch {
    return {};
  }
}

/**
 * 扫描包内 presets/<id>/，合成可直接注册的档位定义。
 *
 * 跳过规则（fail-soft，任一不合格只 warn，不影响其它档位）：
 *   · 目录名非法 / 缺 agent.cordis.yml / 解析结果不是数组；
 *   · 目录名 ∈ {@link TEAM_OWNED_PRESET_IDS}（`co-orchestrator` 由开发团队注册接管）。
 * 顺序：order 升序，其次 id 字典序（与宿主选择器的稳定顺序一致）。
 */
export function loadCohubPresetDefs(presetsDir: string = COHUB_PRESETS_DIR, logger?: Logger): CohubPresetDef[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(presetsDir, { withFileTypes: true });
  } catch (error) {
    logger?.warn?.(`cohub: 读取内置 preset 目录失败（${presetsDir}）`, error);
    return [];
  }

  const defs: CohubPresetDef[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafePresetId(entry.name)) continue;
    // 注册权已交给团队（team-presets.ts）：跳过档位注册，避免同 id 撞 Duplicate
    if (TEAM_OWNED_PRESET_IDS.includes(entry.name)) {
      logger?.info?.(`cohub: preset ${entry.name} 由团队注册接管（内置 dev 团队），档位注册跳过`);
      continue;
    }
    const dir = resolve(presetsDir, entry.name);
    const agentFile = join(dir, "agent.cordis.yml");
    if (!existsSync(agentFile)) continue;
    try {
      const parsed = parseMiniYaml(readFileSync(agentFile, "utf8"));
      if (!Array.isArray(parsed) || parsed.length === 0) {
        logger?.warn?.(`cohub: preset ${entry.name} 的 agent.cordis.yml 解析结果不是非空数组，已跳过`);
        continue;
      }
      const meta = readPresetMeta(dir);
      // baseDir = 该 preset 自己的目录（yml 里 baseUrl 的语义）：
      // `!!js "fileURLToPath(new URL('skills/', baseUrl))"` 在这里被求值成绝对路径字符串
      const plugins = materializeJsTags(parsed, logger, process.platform, "plugins", dir) as unknown[];
      // 注册前兜底：customSkillDirs 必须全是 string（非字符串会被 skill-filesystem 的配校验拒绝）
      assertCustomSkillDirs(plugins, logger);
      defs.push({
        id: entry.name,
        name: meta.name ?? entry.name,
        ...(meta.description === undefined ? {} : { description: meta.description }),
        ...(meta.order === undefined ? {} : { order: meta.order }),
        plugins,
      });
    } catch (error) {
      logger?.warn?.(`cohub: 解析 preset ${entry.name} 失败，已跳过`, error);
    }
  }

  defs.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  return defs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 第四部分：注册 / 幂等 / 卸载
// ─────────────────────────────────────────────────────────────────────────────

/** 每个 agentPresets 注册表各自的 handle 表（按 registry 隔离，避免多实例串味） */
const handlesByRegistry = new WeakMap<object, Map<string, () => unknown>>();

/**
 * 取 agentPresets 注册表。
 *
 * 走 reflect.get('agentPresets', false) 这条**非强校验**通道，与 index.ts 里 subagents 的
 * 防御式写法一致：本插件没有把 agentPresets 写进 inject（旧宿主没有这个服务，写进 inject
 * 会让整个插件停在 INACTIVE），所以直接读 ctx.agentPresets 在 cordis proxy 下会抛
 * "cannot get property without inject"；reflect 缺失时返回 undefined，绝不抛。
 */
function resolveRegistry(ctx: any): any {
  try {
    const fromReflect = ctx?.reflect?.get?.("agentPresets", false);
    if (fromReflect) return fromReflect;
  } catch {
    /* 老宿主无 reflect：继续走属性直读 */
  }
  try {
    return ctx?.agentPresets;
  } catch {
    return undefined;
  }
}

function handlesOf(registry: object): Map<string, () => unknown> {
  let map = handlesByRegistry.get(registry);
  if (map === undefined) {
    map = new Map<string, () => unknown>();
    handlesByRegistry.set(registry, map);
  }
  return map;
}

/** 是否是「id 重复」错误（宿主文案：Duplicate agent preset） */
function isDuplicateError(error: unknown): boolean {
  const message = String((error as { message?: unknown })?.message ?? error ?? "");
  return /duplicate/i.test(message);
}

/**
 * 幂等前置：把「这个 id 已经注册过」的注册清掉。
 *
 * 探测顺序（宿主版本间接口有差异，故全部走可选链）：
 *   ① 本模块自己注册时拿到的 unregister 句柄；
 *   ② registry.get(id) 返回的条目上的 unregister（或 registry.delete(id)）。
 */
function releaseExisting(registry: any, id: string): boolean {
  const owned = handlesOf(registry).get(id);
  if (typeof owned === "function") {
    handlesOf(registry).delete(id);
    try {
      owned();
      return true;
    } catch {
      /* 句柄失效就继续走 ② */
    }
  }
  let existing: any;
  try {
    existing = typeof registry.get === "function" ? registry.get(id) : undefined;
  } catch {
    existing = undefined;
  }
  if (existing !== undefined && existing !== null) {
    if (typeof existing.unregister === "function") {
      existing.unregister();
      return true;
    }
    if (typeof registry.delete === "function") {
      registry.delete(id);
      return true;
    }
  }
  return false;
}

/** 兜底释放：只在 register 抛 Duplicate 后使用（说明宿主另有登记，试遍已知卸载入口） */
function forceRelease(registry: any, id: string): boolean {
  if (releaseExisting(registry, id)) return true;
  for (const method of ["unregister", "remove", "delete"] as const) {
    const fn = registry?.[method];
    if (typeof fn !== "function") continue;
    try {
      fn.call(registry, id);
      return true;
    } catch {
      /* 换下一个入口 */
    }
  }
  return false;
}

/**
 * 运行时注册全部档位 preset。
 *
 * 语义：
 *   · agentPresets 服务缺失（旧宿主 / 精简组合）→ 只 info 一次并返回，**不抛**（patch 声明兜底）；
 *   · 每个档位先 releaseExisting 再 register（幂等：重复 apply / 热重载都不会撞 Duplicate）；
 *   · 单个档位失败只 warn，继续处理其余档位（绝不因为一个档位拖垮插件启动）。
 *
 * @returns 已注册的 id 与失败的 id（供日志/测试）
 */
export async function registerCohubPresets(
  ctx: any,
  logger?: Logger,
  presetsDir: string = COHUB_PRESETS_DIR,
): Promise<{ registered: string[]; failed: string[] }> {
  const registry = resolveRegistry(ctx);
  const result: { registered: string[]; failed: string[] } = { registered: [], failed: [] };
  if (!registry || typeof registry.register !== "function") {
    logger?.info?.("cohub: agentPresets 服务不可用，档位 preset 交由 profile patch 声明（需重启生效）");
    return result;
  }

  const defs = loadCohubPresetDefs(presetsDir, logger);
  for (const def of defs) {
    try {
      // 注册前最后一道闸：customSkillDirs 里只要有一个非 string，宿主就会让整个 preset 挂载失败
      assertCustomSkillDirs(def.plugins, logger);
      releaseExisting(registry, def.id);
      let handle: unknown;
      try {
        handle = await registry.register(def);
      } catch (error) {
        if (!isDuplicateError(error) || !forceRelease(registry, def.id)) throw error;
        // 已被外部登记：卸载后再注册一次（仅此处重试，且只重试一次）
        handle = await registry.register(def);
      }
      if (typeof handle === "function") handlesOf(registry).set(def.id, handle as () => unknown);
      result.registered.push(def.id);
    } catch (error) {
      result.failed.push(def.id);
      logger?.warn?.(`cohub: 运行时注册 preset ${def.id} 失败（将其余档位继续）`, error);
    }
  }
  if (result.registered.length > 0) {
    logger?.info?.(`cohub: 已运行时注册 ${result.registered.length} 个档位 preset（${result.registered.join(", ")}），无需重启`);
  }
  return result;
}

/**
 * 卸载本模块注册的全部档位 preset（插件 dispose 时调用）。
 *
 * 幂等：没有注册过的 registry 直接返回；单个 unregister 抛错只 warn。
 */
export function unregisterCohubPresets(ctx: any, logger?: Logger): string[] {
  const registry = resolveRegistry(ctx);
  if (!registry || typeof registry !== "object") return [];
  const handles = handlesByRegistry.get(registry);
  if (handles === undefined || handles.size === 0) return [];
  const removed: string[] = [];
  for (const [id, handle] of [...handles.entries()]) {
    handles.delete(id);
    try {
      handle();
      removed.push(id);
    } catch (error) {
      logger?.warn?.(`cohub: 卸载 preset ${id} 失败（忽略）`, error);
    }
  }
  if (removed.length > 0) logger?.info?.(`cohub: 已卸载 ${removed.length} 个运行时 preset（${removed.join(", ")}）`);
  return removed;
}
