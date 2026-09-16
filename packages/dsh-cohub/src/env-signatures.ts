// dsh-port/src/env-signatures.ts —— P3-2（N1）执行器环境契约持久化
//
// 把 P0/P1 的「探测式」环境契约升级为「一次学习、持续使用」：
//   - 读取：spawn 前若命中缓存（指纹一致 + TTL 内）→ 用确定性契约文本前馈注入，跳过探针；
//   - 写入：delegate 运行中观测 session/event 的 tool/result 错误，同一环境契约类错误
//           归一化签名累计 ≥ confirmCount（缺省 2）→ 写缓存（观察一致才写入，防瞬态误判）；
//   - 自愈：错误仍出现（缓存错误 / 指纹未捕获的变化）→ 新签名覆盖旧值；
//           指纹变化 / TTL 过期 → 回退探针式。
//
// 跨环境三态（延续 v2/v3，不写死环境断言）：
//   探测 —— 运行期遥测提取签名（normalizeErrorSignature + errorCategories 分类）；
//           指纹 envFingerprint() 由 dsh/codeRuntime 版本（尽力探测，拿不到记 "unknown"）+ host + locale 构成；
//   配置 —— EnvSignatures.use: auto | manual | off（缺省 auto，但无缓存时行为不变）+ ttlMs/confirmCount/contract；
//   降级 —— 无缓存 / 指纹不匹配 / TTL 过期 / 读写失败 → 回退 DEFAULT_ENV_CONTRACT（探针式），行为不劣化。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { DEFAULT_ENV_CONTRACT } from "./env-contract.ts";
import { contentText } from "./text-utils.ts";

/** 缓存文件版本（结构不兼容时整体作废） */
export const CACHE_VERSION = 1;

/** 缓存缺省 TTL：7 天（到期重探，防环境静默升级） */
export const DEFAULT_TTL_MS = 604_800_000;

/** 缺省环境契约类错误子串（仅作观测分类，不写死为断言；可配置覆盖） */
export const DEFAULT_ERROR_CATEGORIES = [
  "require is not defined",
  "cannot use import statement",
  "import/export",
  "outside module",
  "referenceerror: require",
];

/** 环境指纹：任一字段变化 → 缓存作废（dsh/codeRuntime 尽力探测，拿不到记 "unknown"） */
export interface EnvFingerprint {
  dsh: string;
  codeRuntime: string;
  host: string;
  locale: string;
}

/** 已固化的执行器环境契约事实（moduleLoading=unknown 表示未固化，回退探针式） */
export interface EnvContractFacts {
  /** "await-import" | "require" | "static-import" | "unknown" */
  moduleLoading: string;
  topLevelAwait: boolean;
  wallClockLimitMs: number;
  hasJobTracking: boolean;
}

/** 缓存文件结构 */
export interface EnvSignatureCache {
  version: number;
  updatedAt: string;
  fingerprint: EnvFingerprint;
  contract: EnvContractFacts;
  errorSignatures: string[];
  confirmedCount: number;
}

/** P3-2（N1）配置（对应 Config.envSignatures；cachePath 为内部/测试可覆盖项） */
export interface EnvSignaturesConfig {
  /** auto（缺省，无缓存行为不变）/ off（完全关闭读写）/ manual（只读手动契约事实） */
  use?: "auto" | "off" | "manual";
  /** 缓存 TTL（毫秒），缺省 7 天 */
  ttlMs?: number;
  /** 同一签名确认次数后才写入，缺省 2（观察一致才写入，防瞬态误判） */
  confirmCount?: number;
  /** manual 模式部署直接给的契约事实（可选；moduleLoading=unknown 视为未提供） */
  contract?: EnvContractFacts;
  /** 环境契约类错误分类子串（仅观测分类用，缺省 DEFAULT_ERROR_CATEGORIES） */
  errorCategories?: string[];
  /** 内部：缓存文件路径覆盖（测试/低风险部署），缺省 dshHomePath("cohub", "env-signatures.json") */
  cachePath?: string;
}

/** 缺省缓存文件路径：<dshHome>/cohub/env-signatures.json */
export function envSignaturesCachePath(): string {
  return dshHomePath("cohub", "env-signatures.json");
}

const req = createRequire(import.meta.url);

/** 尽力探测已安装包版本；解析失败返回 "unknown"（不抛错、不写死） */
function probePackageVersion(spec: string): string {
  try {
    const pkg = req(spec) as { version?: string } | undefined;
    return typeof pkg?.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** 探测当前 locale（Intl），失败记 "unknown" */
function detectLocale(): string {
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
    return typeof locale === "string" && locale ? locale : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 计算当前环境指纹。deps 可覆盖（测试）；运行时尽力从已安装包读取版本，
 * 拿不到记 "unknown"——指纹因此退化为 host+locale，仍能区分跨环境差异。
 */
export function envFingerprint(deps?: Partial<EnvFingerprint>): EnvFingerprint {
  return {
    dsh: deps?.dsh ?? probePackageVersion("@deepseek-ai/dsh-subagent/package.json"),
    codeRuntime: deps?.codeRuntime ?? probePackageVersion("@deepseek-ai/dsh-code-runtime/package.json"),
    host: deps?.host ?? process.platform,
    locale: deps?.locale ?? detectLocale(),
  };
}

/** 读取缓存；文件缺失 / 解析失败 / 版本不符 → null（静默降级，不抛错） */
export function readEnvSignatures(path?: string): EnvSignatureCache | null {
  try {
    const file = path ?? envSignaturesCachePath();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as EnvSignatureCache;
    if (!parsed || typeof parsed !== "object" || parsed.version !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 写缓存（mkdir -p + JSON）；失败返回 false（静默降级，不抛错） */
export function writeEnvSignatures(data: EnvSignatureCache, path?: string): boolean {
  try {
    const file = path ?? envSignaturesCachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 缓存有效性：版本一致 + 指纹全字段一致 + 未超 TTL */
export function isCacheValid(
  cache: EnvSignatureCache | null | undefined,
  fingerprint: EnvFingerprint,
  ttlMs: number,
  now?: number,
): boolean {
  if (!cache || typeof cache !== "object") return false;
  if (cache.version !== CACHE_VERSION) return false;
  const fp = cache.fingerprint;
  if (!fp || typeof fp !== "object") return false;
  if (fp.dsh !== fingerprint.dsh || fp.codeRuntime !== fingerprint.codeRuntime
    || fp.host !== fingerprint.host || fp.locale !== fingerprint.locale) return false;
  const updated = Date.parse(String(cache.updatedAt ?? ""));
  if (!Number.isFinite(updated)) return false;
  return (now ?? Date.now()) - updated <= Math.max(0, ttlMs);
}

/**
 * 由缓存/手动契约事实生成「确定性契约文本」。
 * moduleLoading 为 unknown（未固化）时返回 null → 调用方回退探针式文本，行为不劣化。
 */
export function renderEnvContract(contract: EnvContractFacts | null | undefined): string | null {
  if (!contract || typeof contract !== "object") return null;
  const ml = contract.moduleLoading;
  const loadingLine =
    ml === "await-import"
      ? "1. 模块加载：使用动态导入 `await import('node:fs')`；无 `require`；禁止静态 `import` 语句。"
      : ml === "require"
        ? "1. 模块加载：使用 CommonJS `require('node:fs')`；不要使用静态 `import` 语句。"
        : ml === "static-import"
          ? "1. 模块加载：使用静态 `import` 语句（ESM）；不要使用 `require`。"
          : null;
  if (!loadingLine) return null;
  const wallClock = Math.max(0, Number(contract.wallClockLimitMs) || 0);
  return [
    "执行器环境契约（本环境已验证）",
    "",
    "已在本环境验证的确定性事实：",
    loadingLine,
    "2. 顶层 await：" + (contract.topLevelAwait !== false ? "可用（脚本体可直接 await）" : "不可用（需包在 async 函数内）") + "。",
    "3. 单次执行墙钟上限：约 " + (wallClock > 0 ? wallClock + "ms" : "由部署配置（未固化）") + "。",
    "4. 后台任务跟踪（job）：" + (contract.hasJobTracking ? "可用（job_list / job_output / job_kill）" : "不可用（前台同步等待）") + "。",
    "",
    "仍须遵守通用原则：自包含、先验证再批量、错误可回传。",
  ].join("\n");
}

/** 契约文本来源（用于选择注入标题与日志） */
export type EnvContractSource = "manual" | "manual-contract" | "cache" | "default";

/**
 * 按优先级选择契约文本：
 *   delegateEnvContract.text（P1 手工覆盖）> manual 的 Config contract > 命中缓存的自动契约 > DEFAULT（探针式）。
 * use="off" 不读缓存（手动 text 覆盖仍生效——那是 P1 独立机制，不属 N1）。
 */
export function pickEnvContractText(args: {
  manualText?: string;
  envSig: EnvSignaturesConfig;
  cached?: EnvSignatureCache | null;
  fingerprint: EnvFingerprint;
  now?: number;
}): { text: string; source: EnvContractSource } {
  if (args.manualText && args.manualText.trim()) {
    return { text: args.manualText, source: "manual" };
  }
  const use = args.envSig.use ?? "auto";
  const ttlMs = args.envSig.ttlMs ?? DEFAULT_TTL_MS;
  if (use === "manual") {
    const rendered = renderEnvContract(args.envSig.contract);
    if (rendered) return { text: rendered, source: "manual-contract" };
  }
  if (use !== "off") {
    const cached = args.cached;
    if (cached && isCacheValid(cached, args.fingerprint, ttlMs, args.now)) {
      const rendered = renderEnvContract(cached.contract);
      if (rendered) return { text: rendered, source: "cache" };
    }
  }
  return { text: DEFAULT_ENV_CONTRACT, source: "default" };
}

/** 归一化错误签名（tool/result data → 可比较字符串；无法提取返回 null） */
export function normalizeErrorSignature(data: any): string | null {
  if (!data || typeof data !== "object") return null;
  const err = data.error;
  if (typeof err === "string" && err.trim()) return "err:" + err.trim().slice(0, 120);
  if (err && typeof err === "object") {
    const msg = typeof (err as any).message === "string" ? (err as any).message : "";
    const code = typeof (err as any).code === "string" ? (err as any).code : "";
    if (msg || code) return "err:" + (code ? code + " " : "") + msg.slice(0, 120);
  }
  const text = contentText(data?.message?.content).trim();
  if (text) return "err:" + text.slice(0, 120);
  return data?.message?.isError === true ? "err:unknown" : null;
}

/** 是否为「环境契约类」错误（归一化签名命中任一类别子串，大小写不敏感；仅作观测分类） */
export function classifyEnvContractError(signature: string, categories?: string[]): boolean {
  const cats = categories && categories.length > 0 ? categories : DEFAULT_ERROR_CATEGORIES;
  const lower = signature.toLowerCase();
  return cats.some(c => typeof c === "string" && c.trim() && lower.includes(c.trim().toLowerCase()));
}

/**
 * P3-2（N1）环境契约学习器：spawn 前挂全局 session/event 总线（与 N2 看门狗相同的
 * 缓冲/绑定模式），按 session.id === run.id 归属子代理事件；累计「环境契约类错误」的
 * 归一化签名，flush() 时同一签名 ≥ confirmCount 且指纹有效 → 写缓存（观察一致才写入）。
 * 纯观测器：不修改子代理内容。读写失败静默降级。
 */
export class EnvSignatureLearner {
  private readonly fingerprint: EnvFingerprint;
  private readonly confirmCount: number;
  private readonly errorCategories: string[];
  private readonly write: (data: EnvSignatureCache) => boolean;
  private off: (() => void) | null = null;
  private boundId: string | null = null;
  private buffer = new Map<string, any[]>();
  private readonly counts = new Map<string, number>();
  private readonly errorSigs = new Set<string>();
  private sawAwaitImportSuccess = false;
  private wrote = false;
  private readonly maxBuffer = 5000;
  private readonly maxErrorSigs = 50;

  constructor(opts: {
    fingerprint: EnvFingerprint;
    confirmCount: number;
    errorCategories?: string[];
    write?: (data: EnvSignatureCache) => boolean;
  }) {
    this.fingerprint = opts.fingerprint;
    this.confirmCount = Math.max(1, Math.trunc(opts.confirmCount));
    this.errorCategories = opts.errorCategories && opts.errorCategories.length > 0 ? opts.errorCategories : DEFAULT_ERROR_CATEGORIES;
    this.write = opts.write ?? writeEnvSignatures;
  }

  /** 挂载事件总线；ctx.on 缺失（无事件源）返回 false → 调用方降级不观测 */
  attach(ctx: any): boolean {
    if (this.off) return true;
    if (typeof ctx?.on !== "function") return false;
    this.off = ctx.on("session/event", (session: any, event: any) => {
      const sid = session?.id;
      if (this.boundId === null) {
        // start 返回前：按 session.id 缓冲，稍后取 run.id 对应部分
        if (typeof sid === "string") {
          let list = this.buffer.get(sid);
          if (!list) { list = []; this.buffer.set(sid, list); }
          if (list.length < this.maxBuffer) list.push(event);
        }
        return;
      }
      if (sid !== this.boundId) return;
      this.consume(event);
    });
    return true;
  }

  /** start 返回后绑定 run.id 并回放缓冲事件 */
  bind(runId: string) {
    this.boundId = runId;
    const buffered = this.buffer.get(runId) ?? [];
    this.buffer.clear();
    for (const event of buffered) this.consume(event);
  }

  detach() {
    if (this.off) { try { this.off(); } catch { /* 已释放 */ } this.off = null; }
    this.buffer.clear();
    this.boundId = null;
  }

  /** 是否已达到写入确认（同类环境契约错误 ≥ confirmCount） */
  get confirmed(): boolean {
    for (const n of this.counts.values()) if (n >= this.confirmCount) return true;
    return false;
  }

  /**
   * 尝试写缓存：已确认且本 run 未写过 → 写；返回是否写入。
   * 仅推断 moduleLoading（从成功结果含 await import( 判定），否则保持 "unknown"
   * （renderEnvContract 回退探针式，行为不劣化）。其余字段取本环境探测观测值。
   */
  flush(): boolean {
    if (this.wrote || this.boundId === null) return false;
    if (!this.confirmed) return false;
    const data: EnvSignatureCache = {
      version: CACHE_VERSION,
      updatedAt: new Date().toISOString(),
      fingerprint: this.fingerprint,
      contract: {
        moduleLoading: this.sawAwaitImportSuccess ? "await-import" : "unknown",
        topLevelAwait: true,
        wallClockLimitMs: 600_000,
        hasJobTracking: true,
      },
      errorSignatures: [...this.errorSigs].slice(0, this.maxErrorSigs),
      confirmedCount: this.confirmCount,
    };
    if (this.write(data)) {
      this.wrote = true;
      return true;
    }
    return false;
  }

  private consume(event: any) {
    const type = event?.type;
    const d = event?.data ?? {};
    if (type !== "tool/result") return;
    const isError = d?.message?.isError === true || d?.error != null;
    if (isError) {
      const sig = normalizeErrorSignature(d) ?? "err:unknown";
      if (classifyEnvContractError(sig, this.errorCategories)) {
        this.counts.set(sig, (this.counts.get(sig) ?? 0) + 1);
        if (this.errorSigs.size < this.maxErrorSigs) this.errorSigs.add(sig);
      }
    } else {
      // 最佳努力：成功结果含 await import( → 推断 moduleLoading=await-import
      const text = contentText(d?.message?.content);
      if (/await\s+import\s*\(/i.test(text)) this.sawAwaitImportSuccess = true;
    }
  }
}