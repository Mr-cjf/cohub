// src/granularity.ts —— 任务粒度自检（「单包硬上限」的运行时版本）
//
// 编排纪律里「一个 task 只做一件事」是软约束（orchestrator 技能靠提示词自律）。
// 这里把它落成**可执行的运行时校验**：调用方（delegate_batch）可选传 scope 声明本次任务的
// 「可独立判定诉求数」与「模块域」，超限即拒绝派发并回传拆分建议，避免把 N 件事塞进一个包后
// 子代理被迫在一轮里做多个决策（判据纠缠、失败无法归因）。
//
// 语义（重要）：
//   - scope 未传 / undefined → **不校验**（ok: true）。历史调用与「不想声明」的场景保持零行为变化；
//   - 只校验**显式声明**的数字/数组，不尝试从 prompt 文本猜粒度（NLP 猜测会误伤，且不可解释）。

/** 单个任务的粒度声明（delegate_batch 的 task.scope 结构） */
export interface TaskScope {
  /** 可独立判定诉求数（每个「需要单独拍板/验收的点」算 1）。上限 3。 */
  demands?: number;
  /** 模块域（受影响的代码/领域模块名）。上限 2。 */
  domains?: string[];
}

/** 可独立判定诉求的单包硬上限 */
export const MAX_TASK_DEMANDS = 3;
/** 模块域的单包硬上限 */
export const MAX_TASK_DOMAINS = 2;

/** 校验结果：ok 时不带任何字段，失败时带可读的拆分建议 */
export type TaskScopeCheck = { ok: true } | { ok: false; error: string };

/** ≤ 上限的整数才计数；非法值（NaN / 负数 / 非整数 / 非 number）按「未声明」处理，不误伤 */
function usableCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

/**
 * 校验单个任务的粒度是否在「单包硬上限」内。
 *
 * 规则：可独立判定诉求 ≤3；模块域 ≤2（按 domains 数组长度）。
 * 超限返回拆分建议（点名超了哪一项、按上限算需要拆成几包）。
 * 未传 scope（undefined / null）视为不校验，返回 ok —— 见文件头「语义」。
 */
export function validateTaskScope(scope?: TaskScope | null): TaskScopeCheck {
  if (scope === undefined || scope === null || typeof scope !== "object") return { ok: true };

  const demands = usableCount(scope.demands);
  // domains 只数「非空字符串」条目：undefined / 空串 / 非数组都不参与计数（不误伤）
  const domains = Array.isArray(scope.domains)
    ? scope.domains.filter(d => typeof d === "string" && d.trim().length > 0)
    : undefined;

  const overDemands = demands !== undefined && demands > MAX_TASK_DEMANDS;
  const overDomains = domains !== undefined && domains.length > MAX_TASK_DOMAINS;
  if (!overDemands && !overDomains) return { ok: true };

  const parts: string[] = [];
  const packages: number[] = [];
  if (overDemands && demands !== undefined) {
    parts.push(`可独立判定诉求 ${demands} 项（上限 ${MAX_TASK_DEMANDS}）`);
    packages.push(Math.ceil(demands / MAX_TASK_DEMANDS));
  }
  if (overDomains && domains !== undefined) {
    const shown = domains.slice(0, 6).map(d => d.trim()).join(", ");
    const more = domains.length > 6 ? ` 等 ${domains.length} 个` : "";
    parts.push(`模块域 ${domains.length} 个（上限 ${MAX_TASK_DOMAINS}）：${shown}${more}`);
    packages.push(Math.ceil(domains.length / MAX_TASK_DOMAINS));
  }
  const packagesNeeded = Math.max(...packages);

  return {
    ok: false,
    error: `任务粒度超出单包硬上限：${parts.join("；")}。`
      + `建议拆分为 ${packagesNeeded} 个 task 分别派发（每个 ≤${MAX_TASK_DEMANDS} 诉求、≤${MAX_TASK_DOMAINS} 模块域），`
      + "拆完后各 task 可独立判定、独立验收，再由主代理汇总；若确认本任务本就该整体处理，"
      + "重发时省略 scope 字段即可跳过本校验。",
  };
}
