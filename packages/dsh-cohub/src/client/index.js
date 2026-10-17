window.__ModuleLoader__.load({
  id: "dsh-cohub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var NS = "cohub";
    // DSH 0.2 客户端服务收敛：本插件客户端仅使用 locale（设置字典注册）。
    // 0.2 官方设置页按活动 profile entry id 投影 Config 的 volatile 字段
    // （SettingsForms.describe() 从真实 Loader entry 的 fiber.runtime.Config 投影），
    // skills / schedule / delegateRetry 由官方自动生成表单并实时提交——不再需要自定义
    // settings 卡片。旧 settingsScope 服务与 settings.plugin.item slot 已在 0.2 移除，
    // 本包 0.5.0 不支持 DSH 0.1，不声明也不保留该兼容分支。
    var inject = ["locale"];

    var zh = {
      title: "CoHub 代理模型",
      description: "为每个专职代理单独指定模型供应商与模型。留空则继承父模型；配置失效时自动回退。",
      provider: "供应商",
      model: "模型",
      configured: "显式配置",
      inherited: "继承父模型",
      loading: "加载中…",
      unavailable: "当前设置不可用。",
      save: "保存",
      saving: "保存中…",
      discard: "放弃修改",
      saved: "已保存。",
      failed: "保存失败：",
      loadProvidersFailed: "模型供应商列表加载失败",
      customModel: "输入模型 ID",
      selectProviderFirst: "请先选择供应商",
      scheduleTitle: "调度参数（可选）",
      scheduleDesc: "影响 orchestrator 的并行批大小 / 墙钟预算与委派重试；留空使用默认值。",
      batchSize: "批大小（单批并行委派上限）",
      wallClock: "墙钟预算（毫秒）",
      maxRetries: "委派重试上限（0 = 不重试）",
      retryDelayMs: "重试间隔（毫秒）",
      retryableReasons: "可重试原因（逗号分隔）",
      retryableReasonsHint: "如 aborted, error；未知原因不重试",
      stallTitle: "停滞检测（可选）",
      stallDesc: "对委派子代理的运行期观测；启用后会自动中止 S1-S4 信号并复用重试机制。",
      stallEnabled: "启用停滞检测",
      consecutiveErrors: "S1 连续同类错误阈值",
      idleMs: "S2 无结果空转（毫秒）",
      reasoningWithoutAction: "S3 纯推理无动作阈值",
      loopCount: "S4 重复调用循环阈值",
      graceMs: "宽限窗口（毫秒）",
      recoverable: "可重试（触发后按 retryableReasons 判定）",
      envSigTitle: "环境契约持久化（可选）",
      envSigDesc: "把执行器环境契约从每次探针改为一次学习持续使用。",
      envSigUse: "契约模式",
      envSigUseAuto: "auto（默认：观察后写入）",
      envSigUseOff: "off（每次都探针）",
      envSigUseManual: "manual（只读 manual 配置）",
      envSigTtl: "缓存 TTL（毫秒）",
      envSigConfirmCount: "确认次数（达到后写入）",
      invalidCleared: "⚠️ 已检测到 {count} 个代理的配置失效，已自动重置为继承。",
      invalidClearedList: "受影响代理：{list}",
      providerPlaceholder: "选择供应商（留空则继承）",
      modelPlaceholder: "选择模型（留空则用供应商默认）"
    };
    var en = {
      title: "CoHub Agent Models",
      description: "Pick a provider and model for each specialist agent. Leave blank to inherit the parent model; stale config auto-resets.",
      provider: "Provider",
      model: "Model",
      configured: "Explicit",
      inherited: "Inherited",
      loading: "Loading…",
      unavailable: "This setting is unavailable.",
      save: "Save",
      saving: "Saving…",
      discard: "Discard",
      saved: "Saved.",
      failed: "Save failed: ",
      loadProvidersFailed: "Failed to load provider catalog",
      customModel: "Enter model ID",
      selectProviderFirst: "Select a provider first",
      scheduleTitle: "Scheduling (optional)",
      scheduleDesc: "Controls the orchestrator's parallel batch size, wall-clock budget, and delegate retries. Leave blank for defaults.",
      batchSize: "Batch size (max parallel delegates)",
      wallClock: "Wall-clock budget (ms)",
      maxRetries: "Delegate retry limit (0 = no retry)",
      retryDelayMs: "Retry delay (ms)",
      retryableReasons: "Retryable reasons (comma-separated)",
      retryableReasonsHint: "e.g. aborted, error; unknown reasons will not retry",
      stallTitle: "Stall detection (optional)",
      stallDesc: "Online observation of delegate subagents; when enabled, S1-S4 signals auto-abort and reuse the retry mechanism.",
      stallEnabled: "Enable stall detection",
      consecutiveErrors: "S1 consecutive identical errors",
      idleMs: "S2 idle timeout (ms)",
      reasoningWithoutAction: "S3 reasoning-without-action",
      loopCount: "S4 repeat-call loop",
      graceMs: "Grace window (ms)",
      recoverable: "Recoverable (trigger respects retryableReasons)",
      envSigTitle: "Env-contract persistence (optional)",
      envSigDesc: "Cache the executor env-contract after learning once; avoid probing every run.",
      envSigUse: "Contract mode",
      envSigUseAuto: "auto (default: observe then write)",
      envSigUseOff: "off (probe every time)",
      envSigUseManual: "manual (read manual config only)",
      envSigTtl: "Cache TTL (ms)",
      envSigConfirmCount: "Confirm count (write after threshold)",
      invalidCleared: "⚠️ Detected stale config for {count} agent(s); reset to inherit.",
      invalidClearedList: "Affected agents: {list}",
      providerPlaceholder: "Select provider (leave blank to inherit)",
      modelPlaceholder: "Select model (leave blank for provider default)"
    };

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "cohub: settings dictionaries");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
