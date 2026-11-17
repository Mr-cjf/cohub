// dsh-port/test/types/test-stubs.ts —— 测试桩工厂（typecheck:test 专用，纯类型/无副作用）
//
// 目的：把「宿主品牌类型（branded）无法逐字段构造」这件事集中到这一处断言，
// 让各测试文件只描述**它真正关心的字段**，不再各自手写不完整的半截桩对象。
//
// 硬约束（改动前先读）：
//   1. 品牌类型（ToolRunContext / SessionId / SubagentRun / FsTarget / FsVersion）只在
//      函数出口做**唯一一次** `as unknown as T` 断言——品牌类型无法逐字段构造，仅此处集中断言。
//   2. 工厂只返回**普通对象字面量**：不装定时器、不读写真实文件、不注册全局状态。
//      这批测试用 `node` 原生剥离类型直接跑（node >= 24），类型擦除后运行时行为
//      必须与原先手写的桩**逐字段一致**。因此工厂**只注入调用方显式给出的字段**
//      （signal 除外，见下），绝不凭空补 deferContext / concludeTurn / rootCallId /
//      token 等宿主能力字段：src/todo-nudge.ts:36 用
//      `typeof exec.deferContext === "function"` 做 fail-soft 分支，
//      凭空补上会让桩走另一条分支，从而改变既有测试语义。
//   3. 除 makeStubFs 外不 import 任何**值**（只用 `import type`）——类型擦除后本模块无运行时依赖。
//      唯一例外是 makeStubFs：cordis 插件必须是**类**（`root.plugin(MemoryFs)` 由宿主以
//      `new C(ctx)` 实例化并注册 `ctx.fs` 服务），故它必须继承 `FileSystem` 这个运行时值。
//      只有真正注册 fs 后端的 3 个测试会调用它，且它们本来就直接 import 同一个包。
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { SessionHeader, SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentRun } from "@deepseek-ai/dsh-subagent";
import FileSystem from "@deepseek-ai/dsh-fs";
import type {
  FsDeleteOutcome,
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsMoveOutcome,
  FsPathInfo,
  FsTarget,
  FsVersion,
  FsWriteIntent,
  FsWriteOutcome,
} from "@deepseek-ai/dsh-fs";
import { normalize, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** ToolRunContext 桩的可选初始化字段。
 *  故意用宽松类型：桩里的 agent / session 只复刻被测代码真正读到的几个字段
 *  （如 `agent.session.header.delegationDepth`），不冒充完整宿主对象。 */
export interface ToolRunContextStubInit {
  agent?: any;
  signal?: AbortSignal;
  callId?: any;
  name?: string;
  arguments?: unknown;
  toolSet?: any;
  parent?: any;
  rootCallId?: any;
  token?: any;
  deferContext?: (context: unknown) => void;
  concludeTurn?: () => void;
}

/** 造一个 delegate / council 工具 execute 用的 ToolRunContext 桩。
 *  - 只透传调用方给的字段，运行期形状 = 原本手写桩的形状（零行为漂移）；
 *  - signal 是唯一带缺省值的字段：未给时补一个**未中止**的 signal（宿主契约必填）。 */
export function makeToolRunContext(partial: ToolRunContextStubInit = {}): ToolRunContext {
  const base: { signal: AbortSignal } = { signal: new AbortController().signal };
  // 品牌类型无法逐字段构造，仅此处集中断言
  return { ...base, ...partial } as unknown as ToolRunContext;
}

/** 造品牌 SessionId。运行期是原样字符串（不加前缀、不做转换），零行为漂移。 */
export function makeSessionId(id: string = "p"): SessionId {
  // 品牌类型无法逐字段构造，仅此处集中断言
  return id as unknown as SessionId;
}

/** 造完整 SessionHeader（宿主必填四项 version/id/createdAt/isSeeded）。
 *  createdAt 固定为 0：桩不依赖真实时钟，保证类型擦除后行为可复现。 */
export function makeSessionHeader(over: Partial<SessionHeader> = {}): SessionHeader {
  const base = {
    // 宿主 SESSION_FORMAT_VERSION = 4（dsh-session/lib/types/types.d.ts:12）。
    // 这里写字面量而**不** import 该常量，避免给测试引入运行时依赖。
    version: 4 as const,
    id: makeSessionId(),
    createdAt: 0,
    isSeeded: false,
  };
  // 非品牌断言：仅把 spread 后的可选字段收窄回完整 SessionHeader
  return { ...base, ...over } as SessionHeader;
}

/** 造 SubagentRun（provider.start 的返回值）。
 *  result 用 Promise<any>：桩里的结果对象只复刻 { output, stopReason } 子集，
 *  不逐一复刻宿主 SubagentResult 的全量字段（品牌/完整形状在出口统一断言）。
 *  over 用于各用例自定义 dispose（如 dispose 计数），运行期与手写桩等价。 */
export function makeSubagentRun(
  id: string,
  result: Promise<any>,
  over: { id?: any; result?: any; dispose?: () => Promise<void> | void } = {},
): SubagentRun {
  const base = { id: makeSessionId(id), result, dispose: async () => {} };
  // 品牌类型无法逐字段构造，仅此处集中断言
  return { ...base, ...over } as unknown as SubagentRun;
}

/** FileSystem.writeText / patchText / editText / deleteFile / moveFile 的沙箱策略参数类型。
 *  用 `Parameters<>` 从基类签名派生，避免为此 import dsh-sandbox / dsh-fs-patch 的类型。 */
type SandboxPolicy = Parameters<FileSystem["writeText"]>[4];
/** `patchText` 的 hunk 列表类型（同上，派生而非 import）。 */
type HunkList = Parameters<FileSystem["patchText"]>[1];

/** 把绝对路径包成 FsTarget：targetKey 用路径本身（同一文件 → 同一 key，满足稳定身份要求），
 *  displayPath 是原绝对路径（模型/UI 可见的那个）。品牌断言仍集中在本模块。 */
function toTarget(absPath: string): FsTarget {
  // 品牌类型无法逐字段构造，仅此处集中断言
  return { targetKey: absPath as unknown as FsTarget["targetKey"], displayPath: absPath };
}

/**
 * 造一个满足 `FileSystem` 全部 16 个抽象成员的最小**内存**文件系统类。
 *
 * 为什么需要它：`FileSystem` 是 dsh-fs 的抽象 seam，真实后端（dsh-fs-local /
 * dsh-fs-sandbox）不在本包 node_modules，而宿主 0.2.x 的服务注入图要求
 * `ctx.fs` 存在（`WorkingDirectoryService.inject = ["fs", …]`），否则
 * SubagentRuntime 的 fiber 停在 state=0，整条 delegate 链路都无法起。
 *
 * 语义约定（改动前先读）：
 *   1. **真的能读写**：内容存在 `files`（绝对路径 → UTF-8 文本）里，
 *      writeText / editText / readText / readBytes / readByteRange / listDir /
 *      deleteFile / moveFile 都是真实实现，桩返回的 `version` 由「路径 + 内容长度」
 *      派生（同内容 → 同 version，内容变 → version 变，够做陈旧校验）。
 *   2. **未知路径的 stat 仍返回 directory**：与改造前手写 MemoryFs
 *      （`stat() { return { type: "directory" } }`）逐字段一致，
 *      保证 `WorkingDirectoryService.ensure()` 取 cwd 的行为零漂移。
 *   3. resolve 返回 FsTarget（0.2.x 契约）而非裸字符串；`processPath` 取其
 *      displayPath（= 规范化后的绝对路径），所以 ensure() 拿到的 cwd 与改造前相同。
 *   4. `watch` / `sandboxMode` / `processPathFromHostPath` 是基类非抽象成员，不覆盖。
 *   5. `patchText` 是本桩唯一未实现的操作（hunk 应用需要完整 patch 语义，本门禁不覆盖）；
 *      它显式抛错而不是静默返回假结果，避免把「没验证」伪装成「验证通过」。
 * @returns 可直接交给 cordis 的 `root.plugin(...)` 的后端类（继承 FileSystem 服务）。
 */
export function makeStubFs() {
  return class StubFileSystem extends FileSystem {
    /** 绝对路径 → UTF-8 文本内容。 */
    private readonly files = new Map<string, string>();

    /** 内容派生的 freshness token：内容不变 → token 不变。 */
    private versionOf(absPath: string): FsVersion {
      return `${absPath}:${this.files.get(absPath)?.length ?? 0}` as unknown as FsVersion;
    }

    async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
      return toTarget(normalize(resolvePath(opts?.cwd ?? process.cwd(), path)));
    }

    processPath(target: FsTarget): string {
      return target.displayPath;
    }

    fileUrl(target: FsTarget): string {
      return pathToFileURL(target.displayPath).href;
    }

    contains(parent: FsTarget, child: FsTarget): boolean {
      const base = parent.displayPath.replace(/[\\/]+$/, "");
      return child.displayPath === parent.displayPath
        || child.displayPath.startsWith(base + sep)
        || child.displayPath.startsWith(base + "/");
    }

    async stat(target: FsTarget, _signal?: AbortSignal): Promise<FsInfo | undefined> {
      const text = this.files.get(target.displayPath);
      // 未知路径按目录处理（与改造前 MemoryFs 一致，见上方语义约定 ②）
      if (text === undefined) return { version: this.versionOf(target.displayPath), type: "directory" };
      return { version: this.versionOf(target.displayPath), type: "file", size: Buffer.byteLength(text, "utf8") };
    }

    async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
      const info = await this.stat(await this.resolve(path, { cwd: opts?.cwd, signal }), signal);
      if (!info) return undefined;
      return info.type === "directory"
        ? { version: info.version, type: "directory" }
        : { version: info.version, type: "file", size: info.size };
    }

    async readText(target: FsTarget, _signal?: AbortSignal): Promise<string> {
      const text = this.files.get(target.displayPath);
      if (text === undefined) throw new Error("FS_NOT_FOUND: " + target.displayPath);
      return text;
    }

    async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
      const text = await this.readText(target, signal);
      return (async function* () { yield text; })();
    }

    async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
      const bytes = new TextEncoder().encode(await this.readText(target, signal));
      if (bytes.length > maxBytes) throw new Error("FS_TOO_LARGE: " + target.displayPath);
      return bytes;
    }

    async readByteRange(
      target: FsTarget,
      range: { offset: number; length: number },
      signal?: AbortSignal,
    ): Promise<Uint8Array> {
      const bytes = await this.readBytes(target, signal, Number.MAX_SAFE_INTEGER);
      return bytes.slice(range.offset, range.offset + range.length);
    }

    async listDir(target: FsTarget, _signal?: AbortSignal): Promise<FsDirEntry[]> {
      const base = target.displayPath.replace(/[\\/]+$/, "") + sep;
      const seen = new Map<string, FsDirEntry>();
      for (const filePath of this.files.keys()) {
        if (!filePath.startsWith(base)) continue;
        const rest = filePath.slice(base.length).split(sep);
        const name = rest[0]!;
        if (seen.has(name)) continue;
        seen.set(name, {
          name,
          type: rest.length === 1 ? "file" : "directory",
          target: toTarget(base + name),
          version: this.versionOf(base + name),
        });
      }
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    async writeText(
      target: FsTarget,
      content: string,
      expected?: FsWriteIntent,
      _signal?: AbortSignal,
      _sandboxPolicy?: SandboxPolicy,
    ): Promise<FsWriteOutcome> {
      const before = this.files.get(target.displayPath) ?? null;
      if (expected?.kind === "createIfAbsent" && before !== null) {
        throw new Error("FS_NOT_OBSERVED: " + target.displayPath);
      }
      if (expected?.kind === "replaceIfVersion"
        && (before === null || this.versionOf(target.displayPath) !== expected.version)) {
        throw new Error("FS_STALE_VERSION: " + target.displayPath);
      }
      this.files.set(target.displayPath, content);
      return {
        operation: before === null ? "create" : "update",
        version: this.versionOf(target.displayPath),
        before,
        after: content,
      };
    }

    async editText(
      target: FsTarget,
      edit: FsEditRequest,
      _expected?: { version: FsVersion },
      _signal?: AbortSignal,
      _sandboxPolicy?: SandboxPolicy,
    ): Promise<FsEditOutcome> {
      const before = this.files.get(target.displayPath);
      if (before === undefined) throw new Error("FS_STALE_VERSION: " + target.displayPath);
      if (edit.oldString.length === 0) throw new Error("FS_EDIT_NOT_FOUND: oldString 不能为空");
      const hits = before.split(edit.oldString).length - 1;
      if (hits === 0) throw new Error("FS_EDIT_NOT_FOUND: " + target.displayPath);
      if (hits > 1 && !edit.replaceAll) throw new Error("FS_AMBIGUOUS_EDIT: " + target.displayPath);
      // split/join 而非 String.replace：避免 `$&` 之类替换模板被解释
      const after = before.split(edit.oldString).join(edit.newString);
      this.files.set(target.displayPath, after);
      return { version: this.versionOf(target.displayPath), before, after };
    }

    async patchText(
      _target: FsTarget,
      _hunks: HunkList,
      _expected?: { version: FsVersion },
      _signal?: AbortSignal,
      _sandboxPolicy?: SandboxPolicy,
    ): Promise<FsEditOutcome> {
      throw new Error("StubFileSystem 未实现 patchText：hunk 应用不在本测试门禁覆盖范围，需扩展本桩");
    }

    async deleteFile(
      target: FsTarget,
      _expected?: { version: FsVersion },
      _signal?: AbortSignal,
      _sandboxPolicy?: SandboxPolicy,
    ): Promise<FsDeleteOutcome> {
      const before = this.files.get(target.displayPath) ?? null;
      this.files.delete(target.displayPath);
      return { before };
    }

    async moveFile(
      source: FsTarget,
      destination: FsTarget,
      _options: Parameters<FileSystem["moveFile"]>[2],
      _signal?: AbortSignal,
      _sandboxPolicy?: SandboxPolicy,
    ): Promise<FsMoveOutcome> {
      const sourceBefore = this.files.get(source.displayPath) ?? null;
      if (sourceBefore === null) throw new Error("FS_NOT_FOUND: " + source.displayPath);
      const before = this.files.get(destination.displayPath) ?? null;
      this.files.set(destination.displayPath, sourceBefore);
      this.files.delete(source.displayPath);
      return {
        sourceBefore,
        destination: {
          operation: before === null ? "create" : "update",
          version: this.versionOf(destination.displayPath),
          before,
          after: sourceBefore,
        },
        sourceDeleted: true,
      };
    }
  };
}
