// dsh-port/src/preset-install.ts —— 内置 agent preset 的安装 / 升级台账
//
// 背景：本包把 presets/<id>/ 复制到用户 preset root（~/.dsh/.agent-presets/<id>/），
// 让安装者在 GUI 的 agent preset 选择器里直接用。两个必须解决的问题：
//
//   1. 升级不能丢修复。早期实现「目标目录存在就跳过」，导致老用户永远收不到
//      preset 文件里的后续改进（只有新增的 preset id 会被补上）。
//   2. 升级不能踩用户的自定义。用户改过的 preset 必须原样保留。
//
// 做法：在 preset root 的**上一级**写一份安装台账（<root>/../.cohub-preset-install.json，
// 故意放在 root 外，免得被 roster 当成一个 preset 目录扫到），记录每个 preset 的
// 安装版本与每个文件的 sha256。升级时逐文件比对：
//   - 当前哈希 ≠ 台账哈希 → 用户改过这个文件 → 跳过并告警（保留用户版本）
//   - 当前哈希 = 台账哈希（或文件缺失）→ 未被改动 → 用包内新版本覆盖
// 首次安装（无台账）直接全量复制；台账损坏或读写失败一律静默降级为「仅新增」的旧行为。
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";

/** 安装台账文件名（位于 preset root 的上一级，避免被 roster 扫描为 preset） */
const INSTALL_RECORD_NAME = ".cohub-preset-install.json";

/** 安装台账版本号 */
const INSTALL_RECORD_VERSION = 1;

/**
 * 合法 preset id 白名单：小写字母 / 数字 / 连字符，且必须以字母或数字开头。
 *
 * ⚠️ 为何必须校验（请勿删除此检查）：本文件的孤儿清理会用**台账里的键**直接
 * `join(userRoot, id)` 并 `rmSync(..., { recursive: true, force: true })`。台账是磁盘上
 * 的普通 JSON 文件（位于用户目录，可被篡改、损坏或由第三方写入），若键为
 * `../../Documents` 之类的相对路径，join 会逃出 preset root，recursive 删除就会
 * 落到 preset 目录**之外**的任意路径。凡是从台账读出的 id，在参与任何路径拼接 /
 * 删除之前都必须先过这个正则。
 */
const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 台账键是否是可安全用于路径拼接的 preset id（见 PRESET_ID_PATTERN 的说明） */
function isSafePresetId(id: unknown): id is string {
  return typeof id === "string" && PRESET_ID_PATTERN.test(id);
}

/** 单个 preset 的安装记录 */
export interface PresetInstallEntry {
  /** 记录写入时的插件版本 */
  version: string;
  /** 相对 preset 目录的文件路径 → sha256 */
  files: Record<string, string>;
}

interface InstallRecord {
  version: number;
  presets: Record<string, PresetInstallEntry>;
}

export interface PresetInstallResult {
  /** 首次安装的 preset id */
  installed: string[];
  /** 因包版本升级而增量更新的 preset id */
  updated: string[];
  /** 检测到用户改动、被跳过的文件（"<id>/<relPath>"） */
  skipped: string[];
  /** 因不再随包发布而被移除的 preset id（孤儿清理） */
  removed: string[];
  /** 台账损坏 / 读写失败等降级原因（有值表示台账不可用） */
  degraded?: string;
}

/** 递归收集目录下所有文件，返回相对路径 → sha256（相对路径统一用 / 分隔） */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        out[relative(dir, full).split("\\").join("/")] = createHash("sha256")
          .update(readFileSync(full))
          .digest("hex");
      }
    }
  };
  if (!existsSync(dir)) return out;
  walk(dir);
  return out;
}

/** 递归复制一份 preset 目录树（目录不存在则创建）；导出以便单测覆盖嵌套子目录 */
export function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

/** 只复制源目录中给定的文件（相对路径列表），保持子目录结构 */
function copyFiles(src: string, dst: string, relPaths: string[]): void {
  for (const rel of relPaths) {
    const to = join(dst, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(src, ...rel.split("/")), to);
  }
}

function recordPathFor(userRoot: string): string {
  return join(dirname(userRoot), INSTALL_RECORD_NAME);
}

/**
 * 规范化文本：去掉行尾空白、整行注释与首尾空行，CRLF→LF。
 * 与 raw 相等语义上更强的比较（可能更宽松），只用于「纳入台账」这一步的初判。
 */
function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * 初判两份文件内容是否「未被用户实质改动」。
 *
 * 这里刻意不引入 YAML 依赖（本包 peerDependencies 很窄，新增运行时依赖会放大安装面），
 * 改用「规范化文本」比较：字节完全相同，或去掉注释/行尾空白/首尾换行后相同 → 视为未改动。
 * 取舍：用户若只调了缩进或用引号包了同一个值，可能被判为「已改动」而跳过升级（保守，
 * 不覆盖用户文件）；反之只改注释也会被判为未改动，覆盖率提升。若日后需要精确的 YAML
 * 语义比较，可在本包加入 `yaml` 依赖并把此函数改成解析后 deepEqual。
 */
function sameContent(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeText(a) === normalizeText(b);
}

/**
 * 把「已存在、但台账未记录」的目录纳入台账（首次安装路径上遇到旧版本产物时调用）。
 *
 * 判定：包内文件在当前目录里**语义相同**的数量 > 0 → 视为本插件早前安装（甚至可能
 * 是用户改过其中某些文件），纳入台账并把**当前哈希**记为基线。这样后续升级能按
 * 「台账哈希 ≠ 当前哈希 = 用户改动」逐文件保护，而不是整目录覆盖。
 *
 * 返回 null 表示当前目录与包内没有任何语义一致的文件（含目录为空、全部不同）——
 * 那是用户自建或异源目录，不纳入台账，后续加载一律跳过它。
 */
function adoptExistingPreset(id: string, src: string, dst: string, version: string): PresetInstallEntry | null {
  const currentHashes = hashTree(dst);
  const imported: Record<string, string> = {};
  let matching = 0;
  for (const [rel, srcHash] of Object.entries(hashTree(src))) {
    const currentHash = currentHashes[rel];
    if (currentHash === undefined) continue;
    if (currentHash === srcHash) {
      imported[rel] = currentHash;
      matching += 1;
      continue;
    }
    // 字节不同：若规范化后相同，也算未改动（按当前哈希记入基线）
    try {
      const same = sameContent(
        readFileSync(join(src, ...rel.split("/")), "utf8"),
        readFileSync(join(dst, ...rel.split("/")), "utf8"),
      );
      if (same) {
        imported[rel] = currentHash;
        matching += 1;
      }
    } catch {
      /* 读失败按不同处理 */
    }
  }
  if (matching === 0) return null;
  return { version, files: imported };
}

/**
 * 读台账；不存在 / 损坏 / 版本不符都返回 null（调用方按「仅新增」降级）。
 *
 * 除结构校验外，这里还**逐键校验 preset id**并丢弃不合法键（见 PRESET_ID_PATTERN 注释）：
 * 台账键随后会被用于 join(userRoot, id) + rmSync(recursive)，不校验就等于把删除路径
 * 交给台账文件的内容决定。
 */
function readRecord(userRoot: string, logger?: any): InstallRecord | null {
  try {
    const raw = readFileSync(recordPathFor(userRoot), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      parsed.version === INSTALL_RECORD_VERSION &&
      parsed.presets &&
      typeof parsed.presets === "object" &&
      !Array.isArray(parsed.presets)
    ) {
      // 采取「过滤非法键」而非「整体判损坏」：整体判损坏会让升级直接退化成「仅新增」，
      // 等于任何人都能靠塞一个非法键关掉用户的 preset 升级能力（把安全修复变成可用性
      // 攻击面）；过滤则只丢弃不合法的那几条，合法条目照常工作 —— 且非法条目被清出
      // 内存中的 record，随后 writeRecordSafe 落盘时会被一并写掉。
      const presets: Record<string, PresetInstallEntry> = {};
      const dropped: string[] = [];
      for (const [id, entry] of Object.entries(parsed.presets as Record<string, PresetInstallEntry>)) {
        if (!isSafePresetId(id)) {
          dropped.push(id);
          continue;
        }
        presets[id] = entry;
      }
      if (dropped.length > 0) {
        logger?.warn?.(
          `cohub: 安装台账中含 ${dropped.length} 个非法 preset id，已忽略（可能是台账损坏或被伪造）：${dropped
            .map((id) => JSON.stringify(id))
            .join(", ")}`,
        );
      }
      return { version: INSTALL_RECORD_VERSION, presets };
    }
    return null;
  } catch {
    return null;
  }
}

function writeRecordSafe(userRoot: string, record: InstallRecord, logger: any): void {
  try {
    writeFileSync(recordPathFor(userRoot), JSON.stringify(record, null, 2), "utf8");
  } catch (error) {
    logger?.warn?.("cohub: 写入 preset 安装台账失败（升级判定将退化为「仅新增」）", error);
  }
}

/**
 * 安装 / 升级内置 agent preset。
 *
 * @param shippedDir 包内 presets 目录
 * @param userRoot   用户 preset root（~/.dsh/.agent-presets）
 * @param version    当前插件版本（记入台账，用于判断是否需要增量更新）
 * @param logger     可选日志
 */
export function installShippedPresets(
  shippedDir: string,
  userRoot: string,
  version: string,
  logger?: any,
): PresetInstallResult {
  const result: PresetInstallResult = { installed: [], updated: [], skipped: [], removed: [] };

  let entries: Dirent[];
  try {
    entries = readdirSync(shippedDir, { withFileTypes: true });
  } catch {
    result.degraded = "shipped presets dir unreadable";
    return result; // 没带 presets（本地源码开发）——静默跳过
  }

  let record = readRecord(userRoot, logger);
  /** 本次包内实际提供的 preset id 集合（用于识别需要清理的孤儿目录） */
  const entryIds = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  if (record === null) {
    // 无台账：可能是首次安装，也可能是老版本升级上来（旧实现不写台账）。
    // 统一走「仅新增」语义：已存在的目录不动，保证不踩用户或旧版内容。
    result.degraded = existsSync(recordPathFor(userRoot)) ? "install record unreadable" : undefined;
    record = { version: INSTALL_RECORD_VERSION, presets: {} };
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dst = join(userRoot, entry.name);
      // 目录已存在（用户自建、旧版本安装、或本插件此前的降级安装）→ 不复制内容，
      // 但尝试纳入台账：与包内有内容一致的文件会被记为「已知基线」，之后升级就能
      // 按文件比对保护用户改动；完全无一致文件的目录视为用户自建 / 异源，不纳入台账、
      // 之后每次加载一律跳过。
      if (existsSync(dst)) {
        const adopted = adoptExistingPreset(entry.name, join(shippedDir, entry.name), dst, version);
        if (adopted) {
          record.presets[entry.name] = adopted;
          logger?.info?.(`cohub: adopted existing agent preset ${entry.name} (${Object.keys(adopted.files).length} known file(s))`);
        }
        continue;
      }
      try {
        copyTree(join(shippedDir, entry.name), dst);
        record.presets[entry.name] = { version, files: hashTree(join(shippedDir, entry.name)) };
        result.installed.push(entry.name);
        logger?.info?.(`cohub: installed agent preset ${entry.name} into ${dst}`);
      } catch (error) {
        logger?.warn?.(`cohub: failed to install agent preset ${entry.name}`, error);
      }
    }
    // 降级路径同样清理孤儿（老用户升级上来时 cohub-standard 已被取代）
    for (const id of Object.keys(record.presets)) {
      if (entryIds.has(id)) continue;
      // 第二层防御：删除前再校验一次 id（台账键可能来自磁盘，绝不能直接拼进删除路径）
      if (!isSafePresetId(id)) {
        logger?.warn?.(`cohub: 跳过非法 preset id 的清理（疑似篡改的台账键）: ${JSON.stringify(id)}`);
        continue;
      }
      try {
        rmSync(join(userRoot, id), { recursive: true, force: true });
        delete record.presets[id];
        result.removed.push(id);
        logger?.info?.(`cohub: 已移除不再随包发布的 agent preset ${id}`);
      } catch (error) {
        logger?.warn?.(`cohub: 移除废弃 agent preset ${id} 失败`, error);
      }
    }
    writeRecordSafe(userRoot, record, logger);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const src = join(shippedDir, id);
    const dst = join(userRoot, id);
    const known = record.presets[id];

    try {
      // 台账未记录该 id：目录不存在 → 首次安装；目录已存在 → 不整目录覆盖，
      // 只尝试纳入台账（可能含用户改动；完全无一致文件则视为用户自建，跳过）。
      if (known === undefined) {
        if (existsSync(dst)) {
          const adopted = adoptExistingPreset(id, src, dst, version);
          if (adopted) {
            record.presets[id] = adopted;
            logger?.info?.(`cohub: adopted existing agent preset ${id} (${Object.keys(adopted.files).length} known file(s))`);
          } else {
            result.skipped.push(id + "/*");
            logger?.warn?.(
              `cohub: 目录 ${dst} 与包内 preset "${id}" 无任何一致文件，视为用户自建，已跳过（不纳入管理）`,
            );
          }
          continue;
        }
        copyTree(src, dst);
        record.presets[id] = { version, files: hashTree(src) };
        result.installed.push(id);
        logger?.info?.(`cohub: installed agent preset ${id} into ${dst}`);
        continue;
      }

      // 已记录且版本未变：无需动作
      if (known.version === version) continue;

      // 版本升级：逐文件比对，只覆盖未被用户改动的文件
      const srcHashes = hashTree(src);
      const currentHashes = hashTree(dst);
      const toCopy: string[] = [];
      for (const [rel, hash] of Object.entries(srcHashes)) {
        const current = currentHashes[rel];
        const recorded = known.files[rel];
        // 用户改过（当前哈希与台账不符，且文件确实存在）→ 跳过
        if (current !== undefined && recorded !== undefined && current !== recorded) {
          result.skipped.push(id + "/" + rel);
          logger?.warn?.(
            `cohub: preset "${id}" 的 ${rel} 已被本地修改，升级时跳过（保留你的版本；如需跟随上游请手动删除该文件所在 preset 目录）`,
          );
          continue;
        }
        // 未被改动 / 文件缺失 / 台账无该记录 → 用包内版本覆盖
        if (current === undefined || recorded === undefined || current === recorded) toCopy.push(rel);
      }
      if (toCopy.length > 0) {
        copyFiles(src, dst, toCopy);
        result.updated.push(id);
        logger?.info?.(`cohub: updated agent preset ${id} (${toCopy.length} file(s)) from ${known.version} to ${version}`);
      }
      // 同步台账（跳过用户改动的文件：其台账哈希保持旧值，下次升级仍会被识别为用户改动）
      const nextFiles: Record<string, string> = { ...known.files };
      for (const rel of toCopy) nextFiles[rel] = srcHashes[rel];
      // 包内被删除的文件：从台账移除（不删用户目录里的文件，保守）
      for (const rel of Object.keys(nextFiles)) {
        if (srcHashes[rel] === undefined) delete nextFiles[rel];
      }
      record.presets[id] = { version, files: nextFiles };
    } catch (error) {
      logger?.warn?.(`cohub: failed to update agent preset ${id}`, error);
    }
  }

  // 移除不再随包发布的 preset（曾记录、本次包内已无）：避免用户选择器里留下孤儿条目
  // （例：cohub-standard 已被 cohub-cordis 取代）。只清理台账确认由本插件安装过的 id。
  for (const id of Object.keys(record.presets)) {
    if (entryIds.has(id)) continue;
    // 第二层防御：删除前再校验一次 id（台账键可能来自磁盘，绝不能直接拼进删除路径）
    if (!isSafePresetId(id)) {
      logger?.warn?.(`cohub: 跳过非法 preset id 的清理（疑似篡改的台账键）: ${JSON.stringify(id)}`);
      continue;
    }
    try {
      rmSync(join(userRoot, id), { recursive: true, force: true });
      delete record.presets[id];
      result.removed.push(id);
      logger?.info?.(`cohub: 已移除不再随包发布的 agent preset ${id}`);
    } catch (error) {
      logger?.warn?.(`cohub: 移除废弃 agent preset ${id} 失败`, error);
    }
  }

  writeRecordSafe(userRoot, record, logger);
  return result;
}

/** 仅用于测试/维护：删除台账（下次安装回到「仅新增」语义） */
export function removeInstallRecord(userRoot: string): void {
  try {
    rmSync(recordPathFor(userRoot), { force: true });
  } catch {
    /* 忽略 */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 第二部分：把 preset **声明**幂等写入 profile 的 cordis.patch.yml
//
// 背景：新版宿主按 `@deepseek-ai/dsh-agent-preset` 的声明行注册 preset，
// 只把 presets/<id>/ 复制到 ~/.dsh/.agent-presets/ 并不足以让
// `agentPreset: "<id>"` 生效——profile 的 cordis.patch.yml 里还必须有一条
// `- insert: { id: preset-<id>, config: { id: <id>, ... } }`。
//
// 本步骤把声明从包内 presets/<id>/（preset.yml 的 name/description/order +
// agent.cordis.yml 的 plugins 行）**动态生成**，因此新增档位目录即自动获得声明，
// 不需要再同步维护一份手写清单（旧的手写做法正是本步骤要取代的）。
//
// 幂等键 = config.id：
//   - 未声明 → 追加到文件末尾（不重排既有内容）；
//   - 已声明且规范化后与生成内容一致 → 跳过，**不写盘**（字节不变、不产生备份）；
//   - 已声明但内容不同 → 保留用户版本、只记录 warning（用户可能有意改过）；
//   - 任何异常 → 只告警，绝不阻断插件挂载。
// ─────────────────────────────────────────────────────────────────────────────

export interface PresetPatchApplyResult {
  /** 目标 patch 文件（~/.dsh/profiles/<profile>/cordis.patch.yml） */
  patchPath: string;
  /** 本次追加的 preset id */
  appended: string[];
  /** 已存在且与包内一致（未动） */
  unchanged: string[];
  /** 已存在但内容不同 → 保留用户版本并告警 */
  conflicts: string[];
  /** 写入前生成的备份文件（仅在实际写盘时产生） */
  backup?: string;
  /** 降级原因（无可写内容 / 读失败 / 落盘失败等） */
  degraded?: string;
}

/** 单行 YAML 标量：JSON 双引号字符串是合法的 YAML 标量，且转义最省心 */
function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** 整体缩进一段 YAML（空行不补空格），用于把 agent.cordis.yml 塞进 plugins: 之下 */
function indentBlock(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : pad + line))
    .join("\n");
}

/** 从 preset.yml 里取 name / description / order（只做行级解析，不引入 YAML 依赖） */
function readPresetMeta(dir: string): { name?: string; description?: string; order?: number } {
  try {
    const raw = readFileSync(join(dir, "preset.yml"), "utf8").replace(/\r\n/g, "\n");
    const meta: { name?: string; description?: string; order?: number } = {};
    for (const line of raw.split("\n")) {
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const rest = m[2].trim();
      if (key === "order") {
        const n = Number(rest);
        if (Number.isFinite(n)) meta.order = n;
        continue;
      }
      if (key !== "name" && key !== "description") continue;
      if (rest === "" || rest === "|" || rest === "|-" || rest === ">" || rest === ">-") continue;
      meta[key] = rest.replace(/^(['"])(.*)\1$/, "$2");
    }
    return meta;
  } catch {
    return {};
  }
}

/**
 * 依据包内 presets 目录生成 profile patch 声明片段（每个 preset 一段 `- insert:`）。
 * 目录缺少 agent.cordis.yml 或 id 不合法时跳过该目录。
 */
export function buildPresetPatchDeclarations(shippedDir: string): Array<{ id: string; text: string }> {
  let entries: Dirent[];
  try {
    entries = readdirSync(shippedDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = entries
    .filter((entry) => entry.isDirectory() && isSafePresetId(entry.name))
    .map((entry) => entry.name)
    .filter((id) => existsSync(join(shippedDir, id, "agent.cordis.yml")))
    .sort();

  const out: Array<{ id: string; text: string }> = [];
  for (const id of ids) {
    const dir = join(shippedDir, id);
    const meta = readPresetMeta(dir);
    const plugins = readFileSync(join(dir, "agent.cordis.yml"), "utf8").trimEnd();
    const lines = ["- insert:", `    - id: preset-${id}`, "      name: '@deepseek-ai/dsh-agent-preset'", "      config:", `        id: ${id}`];
    if (meta.name !== undefined) lines.push(`        name: ${yamlScalar(meta.name)}`);
    if (meta.description !== undefined) lines.push(`        description: ${yamlScalar(meta.description)}`);
    if (meta.order !== undefined) lines.push(`        order: ${meta.order}`);
    lines.push("        plugins:", indentBlock(plugins, 10));
    out.push({ id, text: lines.join("\n") });
  }
  return out;
}

/**
 * 在 patch 文本中定位「声明了 presetId 的那一段 `- insert:`」。
 *
 * 判定条件（两者同时满足）：块内出现顶层项 `- id: preset-<id>`，且块内出现
 * `config: id: <id>`。后者用 `^\s+id:\s*<id>$` 匹配，不会误命中 `- id: ...` 行。
 */
function findPresetInsertBlock(text: string, presetId: string): { start: number; end: number; body: string } | null {
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s+insert\s*:/.test(lines[i])) starts.push(i);
  }
  const configId = new RegExp(`^\\s+id:\\s*['"]?${presetId}['"]?\\s*$`, "m");
  const itemId = new RegExp(`^\\s*-\\s*id:\\s*['"]?preset-${presetId}['"]?\\s*$`, "m");
  for (let k = 0; k < starts.length; k++) {
    const startLine = starts[k];
    // 块结束：下一个顶层列表项 / 下一个顶层键 / 文件末尾
    let endLine = lines.length;
    for (let i = startLine + 1; i < lines.length; i++) {
      if (/^(-\s|[A-Za-z_][\w.-]*\s*:)/.test(lines[i])) {
        endLine = i;
        break;
      }
    }
    if (k + 1 < starts.length && starts[k + 1] < endLine) endLine = starts[k + 1];
    const body = lines.slice(startLine, endLine).join("\n");
    if (itemId.test(body) && configId.test(body)) return { start: startLine, end: endLine, body };
  }
  return null;
}

/**
 * 把 cohub 需要的 preset 声明幂等写入目标 profile 的 cordis.patch.yml。
 *
 * @param shippedDir 包内 presets 目录
 * @param patchPath  目标 profile 的 cordis.patch.yml（父目录必须已存在）
 * @param logger     可选日志（warn 用于冲突与降级）
 */
export function applyPresetPatchDeclarations(
  shippedDir: string,
  patchPath: string,
  logger?: any,
): PresetPatchApplyResult {
  const result: PresetPatchApplyResult = { patchPath, appended: [], unchanged: [], conflicts: [] };

  let declarations: Array<{ id: string; text: string }>;
  try {
    declarations = buildPresetPatchDeclarations(shippedDir);
  } catch (error) {
    result.degraded = "declarations unbuildable";
    logger?.warn?.("cohub: 生成 preset 声明片段失败，跳过 profile patch 写入", error);
    return result;
  }
  if (declarations.length === 0) {
    result.degraded = "no shipped presets";
    return result;
  }

  // 不放宽这一条：profile 目录不存在时绝不创建（避免给不存在的 profile 造目录）
  if (!existsSync(dirname(patchPath))) {
    result.degraded = "profile dir missing";
    return result;
  }

  let original = "";
  try {
    original = readFileSync(patchPath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      result.degraded = "patch unreadable";
      logger?.warn?.(`cohub: 读取 ${patchPath} 失败，跳过 preset 声明写入`, error);
      return result;
    }
  }
  const existed = existsSync(patchPath);

  const toAppend: string[] = [];
  for (const decl of declarations) {
    const found = findPresetInsertBlock(original, decl.id);
    if (!found) {
      toAppend.push(decl.text);
      continue;
    }
    if (normalizeText(found.body) === normalizeText(decl.text)) {
      result.unchanged.push(decl.id);
      continue;
    }
    result.conflicts.push(decl.id);
    logger?.warn?.(
      `cohub: profile patch 里 preset "${decl.id}" 的声明与包内版本不一致，已保留你的版本（不覆盖）；` +
        "若要跟随上游更新，请手动删除该 preset 的 - insert: 段后重启",
    );
  }
  if (toAppend.length === 0) return result; // 幂等：无新增即不写盘、不备份

  try {
    if (existed) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
      const backup = `${patchPath}.bak-${stamp}`;
      copyFileSync(patchPath, backup);
      result.backup = backup;
    }
    // 只在末尾追加：保留原有格式与注释，不重排文件
    const separator = original.length === 0 ? "" : original.endsWith("\n") ? "\n" : "\n\n";
    const next = original + separator + toAppend.join("\n\n") + "\n";
    writeFileSync(patchPath, next, "utf8");
    result.appended.push(...declarations.filter((d) => toAppend.includes(d.text)).map((d) => d.id));
  } catch (error) {
    result.degraded = "patch write failed";
    logger?.warn?.(`cohub: 写入 ${patchPath} 失败（下一次启动会重试）`, error);
  }
  return result;
}

/**
 * 解析当前活动 profile 的 cordis.patch.yml 路径。
 *
 * 优先 `$DSH_PROFILE`；未设置时若 `~/.dsh/profiles/` 下恰好只有一个 profile 目录就用它；
 * 否则返回 null（多 profile 且无法判定时不猜，避免写错用户配置）。
 *
 * @param home DSH 家目录（`dshHomePath()`）
 * @param env  环境变量映射（测试可注入）
 */
export function resolveProfilePatchPath(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const root = join(home, "profiles");
  const explicit = env.DSH_PROFILE?.trim();
  if (explicit) return join(root, explicit, "cordis.patch.yml");
  try {
    const names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafePresetId(entry.name))
      .map((entry) => entry.name);
    if (names.length === 1) return join(root, names[0], "cordis.patch.yml");
  } catch {
    /* profiles 目录不存在：返回 null */
  }
  return null;
}
