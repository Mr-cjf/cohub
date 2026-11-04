/**
 * OpenCode 2.x 事件桥接
 *
 * v1 的事件形状是 `{ type, properties: {...} }`（或部分分支直接放 properties），
 * v2 统一成 `{ type, id, created, data: {...} }`。`src/index.ts` 里的事件处理
 * 逻辑已经围绕 v1 形状写了大量的防御性提取（`extractSessionIdFromEvent` 等），
 * 这里把它需要的字段重新塑形，而不是让业务代码分叉出两套事件解析。
 */

/** v2 事件的最小形状 */
export interface V2Event {
  type?: string;
  data?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

/**
 * 把 v2 事件还原成 v1 处理逻辑能够消费的 `{ type, properties }`。
 *
 * 映射规则：
 * - `session.idle` / `session.deleted` 等：v2 的 `data.sessionID` → v1 的 `properties.sessionID`
 * - 工具 part 更新：v2 的 `data` 里已经是完整 part 结构，直接透传为 `properties.part`
 * - 其余事件：`data` 整体作为 properties（字段名一致的直接可用）
 */
export function toV1Event(event: V2Event): { type: string; properties?: Record<string, unknown> } {
  const type = typeof event.type === 'string' ? event.type : '';
  const data = event.data ?? event.properties;

  if (!data || typeof data !== 'object') {
    return { type };
  }

  const properties: Record<string, unknown> = { ...data };

  // v1 侧用 `properties.info.id` / `properties.sessionID` 两种路径取会话标识，
  // v2 的 data.sessionID 是权威来源，两个位置都补齐以免提取逻辑落空。
  if (typeof data.sessionID === 'string') {
    properties.sessionID = data.sessionID;
    const info = properties.info;
    if (!info || typeof info !== 'object') {
      properties.info = { id: data.sessionID };
    }
  }

  // v1 的 `message.part.updated` 把 part 放在 properties.part；
  // v2 的 message.* 事件结构不同，只有在确实带 part 形态时才映射。
  if (typeof type === 'string' && type.startsWith('session.message')) {
    if (properties.part === undefined) {
      const candidate = data as Record<string, unknown>;
      if (typeof candidate.type === 'string' && candidate.type === 'tool') {
        properties.part = candidate;
      }
    }
  }

  return { type, properties };
}

/**
 * v2 事件名 → v1 业务逻辑使用的语义类型。
 *
 * 下面是**实测**（OpenCode 2.2.5 真实会话）里出现的事件名，映射原则：
 * - 只映射 `src/index.ts` 事件处理分支真正消费的语义，其余返回 undefined 直接跳过；
 * - v2 的 `session.idle` 与 v1 同名，直接透传；
 * - 子任务失败/取消在 v2 由 `session.execution.failed` / `.interrupted` 表达；
 * - v2 没有 `message.part.updated` 的同名事件，工具结局改由 `session.tool.*` 表达，
 *   因此不再映射该类型（v1 分支拿不到 part 也不会误判）。
 */
export function mapEventType(type: string): string | undefined {
  switch (type) {
    case 'session.idle':
      return 'session.idle';
    case 'session.deleted':
      return 'session.deleted';
    case 'session.status':
      return 'session.status';
    // v2 的重试事件承载 attempt/at，v1 侧按 session.status(retry) 观测
    case 'session.retry.scheduled':
      return 'session.status';
    // 执行失败：v1 用 session.error 的观测分支（仅诊断、不终结）
    case 'session.execution.failed':
    case 'session.step.failed':
      return 'session.error';
    default:
      return undefined;
  }
}
