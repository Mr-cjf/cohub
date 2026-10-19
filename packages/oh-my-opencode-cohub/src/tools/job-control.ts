// src/tools/job-control.ts
//
// close_job tool for oh-my-opencode-cohub.
// 允许主代理（co-orchestrator）关闭一个卡住或不必要的子代理后台任务：
// 先经 tracker.resolveCancelTarget() 只读精确定位目标，再执行真实
// ctx.client.session.abort()，仅在真实中止（或未绑定 child 的本地取消）成功后，
// 按捕获的 alias 将仍 running 的任务落 cancelled。
//
// 取消语义（Wave5 收紧，修复"旧 alias / session 首条历史中止真实复用 session"）：
// - taskId 为 alias：命中后必须检查 job.status==='running' 才发 SDK abort——
//   旧 alias 命中已终态 → 幂等返回、绝不中止真实复用中的 session；
// - taskId 为 sessionId：resolveCancelTarget 只认唯一活动 running；多个 running 共享
//   child → ambiguous 拒绝且不发 SDK abort；无 running（仅终态历史）→ no-match；
// - 绝不先把状态标为 cancelled 再发现 SDK abort 失败仍谎称取消成功：
//   先真实 abort，成功后才 markCancelledByAlias 落状态；
// - SDK ThrowOnError=false：必须检查 res.error（4xx/5xx resolve 而非 reject）；
//   网络层 throw 同样不得假成功；
// - 未绑定 child：可做本地取消（落 cancelled），但必须报告 session_aborted=false，
//   不中止任意会话；
// - onCancelled 仅在「本次从 running 真实取消落地」时回调一次；重复取消/未知/失败
//   不得假成功触发；回调自身异常不得引发二次 abort（try/catch 保护）。

import { tool } from '@opencode-ai/plugin';
import type { PluginInput } from '@opencode-ai/plugin';
import type { TaskTracker } from '../task-manager/tracker.js';
import { appendLog } from '../utils/log.js';

// zod access via tool.schema（与 council.ts 相同的模式）
const z = tool.schema;

/**
 * 创建 close_job 工具定义。
 *
 * 仅 co-orchestrator（主代理）允许调用（纵深防御，与权限配置层配合）。
 *
 * @param ctx          插件 input（提供 client 以调用 session.abort）
 * @param tracker      TaskTracker 实例（resolveCancelTarget / markCancelledByAlias）
 * @param onClosed     可选回调：工具执行完成后刷新状态（如 syncTrackerState；兼容旧语义，
 *                     每次执行返回前调用，与取消成败无关——保持既有行为）
 * @param onCancelled  可选回调：**仅当本次确实完成 running → cancelled**（markCancelledByAlias
 *                     reason==='ok'）时以捕获的 alias 回调一次；入口用于同步 engine.cancelled
 *                     与该 parent board。
 *                     重复取消（幂等）——含 await SDK abort 期间任务被其他路径终结/取消
 *                     （idle 完成、失败、另一 close）——不触发；未知/失败不触发；
 *                     回调抛错不影响返回（try/catch 保护）。
 */
export function createCloseJobTool(
  ctx: PluginInput,
  tracker: TaskTracker,
  onClosed?: () => void,
  onCancelled?: (alias: string) => void,
): Record<string, ReturnType<typeof tool>> {
  const close_job = tool({
    description:
      'Close (abort) a stuck or unnecessary subagent background task. ' +
      'Accepts the child Session ID (e.g. ses_xxx, shown in the Background Job Board) or the task alias (e.g. coe-1). ' +
      'The underlying subagent session is aborted via session.abort() and the task is marked cancelled. ' +
      'Only the co-orchestrator (primary) agent may invoke this tool.',

    args: {
      task_id: z.string().describe(
        'The child session ID (ses_xxx) or task alias (e.g. coe-1) of the task to close.',
      ),
    },

    async execute(
      args: { task_id: string },
      toolContext: { sessionID: string; agent: string },
    ): Promise<string> {
      // 权限校验（纵深防御）：仅 co-orchestrator / co-orchestrator-gpt；缺失身份视为拒绝
      if (!['co-orchestrator', 'co-orchestrator-gpt'].includes(toolContext.agent)) {
        throw new Error(
          `[oh-my-opencode-cohub] close_job can only be invoked by co-orchestrator/co-orchestrator-gpt. Current agent: ${toolContext.agent}`,
        );
      }

      // 1. 只读精确定位（不修改状态；sessionId 路径只认唯一活动 running）
      const target = tracker.resolveCancelTarget(args.task_id);
      if (!target.ok) {
        // 未知 / 歧义：不 abort、不假成功、不触发 onCancelled
        return JSON.stringify(
          { ok: false, task_id: args.task_id, reason: target.reason, session_aborted: false },
          null,
          2,
        );
      }
      const job = target.job;
      const alias = job.alias;

      // 2. 已终态（旧 alias 命中历史 / 重复取消）：幂等返回，
      //    不发 SDK abort（绝不中止真实复用中的 session）、不触发 onCancelled
      if (job.status !== 'running') {
        return JSON.stringify(
          {
            ok: true,
            task_id: args.task_id,
            alias,
            agent: job.agent,
            session_aborted: false,
            status: job.status,
            reason: 'idempotent',
          },
          null,
          2,
        );
      }

      // 3. 真实中止（仅当已绑定 child；未绑定走本地取消）
      let aborted = false;
      if (job.sessionId) {
        try {
          // SDK 默认 ThrowOnError=false：HTTP 4xx/5xx 会 resolve 出 { data, error } 而非 reject，
          // 必须显式检查 res.error 判别失败（catch 仅兜底网络层异常）
          const res = await ctx.client.session.abort({ path: { id: job.sessionId } });
          aborted = !res.error;
          if (res.error) {
            appendLog('job-control', `abort session ${job.sessionId} 失败`, res.error);
          }
        } catch (err) {
          // 网络层 throw：不假成功
          appendLog('job-control', `abort session ${job.sessionId} 抛出异常`, err);
          aborted = false;
        }
      }

      // 4. 真实中止失败（已绑定 child 且 abort 未成功）：不落 cancelled、不触发 onCancelled
      if (job.sessionId && !aborted) {
        return JSON.stringify(
          {
            ok: false,
            task_id: args.task_id,
            alias,
            agent: job.agent,
            session_aborted: false,
            status: job.status,
            reason: 'abort_failed',
          },
          null,
          2,
        );
      }

      // 5. 取消落地：真实 abort 成功，或未绑定 child 的本地取消。
      //    按捕获 alias 将仍 running 的任务落 cancelled（markCancelledByAlias 的 running 守卫：
      //    await 期间任务可能被其他路径终结/取消（idle 完成、失败、另一 close）→ idempotent，
      //    绝不把 completed/errored 改回 cancelled、不重复回调）。
      const up = tracker.markCancelledByAlias(alias);
      if (!up.ok) {
        // 竞态：目标已消失（如并发 prune），诚实报告失败，不假成功
        return JSON.stringify(
          { ok: false, task_id: args.task_id, alias, session_aborted: aborted, status: job.status, reason: 'stale' },
          null,
          2,
        );
      }

      // 6. 仅当本次确实完成 running → cancelled（reason==='ok'）才回调一次；
      //    idempotent（await 期间任务已被其他路径终结/取消）不重复回调；
      //    回调异常不得引发二次 abort（try/catch 保护）。
      if (up.reason === 'ok') {
        try {
          onCancelled?.(alias);
        } catch (err) {
          appendLog('job-control', `onCancelled 回调异常（不影响取消结果）`, err);
        }
      }

      // 7. 旧 onClosed 兼容：每次执行返回前调用（保持既有行为）
      onClosed?.();

      // 8. 任务结局真实：ok → cancelled；idempotent → 读取相同 alias 的实际保留状态返回
      //    （绝不虚报为 cancelled）；SDK abort 成功事实字段（session_aborted）原样保留。
      const actualStatus = up.reason === 'ok'
        ? 'cancelled'
        : (tracker.getJobByAlias(alias)?.status ?? job.status);
      return JSON.stringify(
        {
          ok: up.reason === 'ok' || up.reason === 'idempotent',
          task_id: args.task_id,
          alias,
          agent: job.agent,
          session_aborted: aborted,
          status: actualStatus,
          reason: up.reason,
        },
        null,
        2,
      );
    },
  });

  return { close_job };
}
