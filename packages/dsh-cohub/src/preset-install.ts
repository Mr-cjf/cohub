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
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** 安装台账文件名（位于 preset root 的上一级，避免被 roster 扫描为 preset） */
const INSTALL_RECORD_NAME = ".cohub-preset-install.json";

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

/** 读台账；不存在 / 损坏 / 版本不符都返回 null（调用方按「仅新增」降级） */
function readRecord(userRoot: string): InstallRecord | null {
  try {
    const raw = readFileSync(recordPathFor(userRoot), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.presets && typeof parsed.presets === "object") {
      return parsed as InstallRecord;
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

  let entries;
  try {
    entries = readdirSync(shippedDir, { withFileTypes: true });
  } catch {
    result.degraded = "shipped presets dir unreadable";
    return result; // 没带 presets（本地源码开发）——静默跳过
  }

  let record = readRecord(userRoot);
  /** 本次包内实际提供的 preset id 集合（用于识别需要清理的孤儿目录） */
  const entryIds = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  if (record === null) {
    // 无台账：可能是首次安装，也可能是老版本升级上来（旧实现不写台账）。
    // 统一走「仅新增」语义：已存在的目录不动，保证不踩用户或旧版内容。
    result.degraded = existsSync(recordPathFor(userRoot)) ? "install record unreadable" : undefined;
    record = { version: 1, presets: {} };
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
