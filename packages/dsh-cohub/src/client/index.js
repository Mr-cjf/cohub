window.__ModuleLoader__.load({
  id: "dsh-cohub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");

    var NS = "cohub";
    var inject = ["slots", "locale", "remote", "remote.llm", "remote.session", "settingsScope"];

    var SKILL_ROWS = [
      { name: "co-orchestrator", label: "调度编排" },
      { name: "co-planner", label: "方案制定" },
      { name: "co-oracle", label: "架构/代码审查" },
      { name: "co-explorer", label: "搜索方案制定" },
      { name: "co-librarian", label: "资料研究" },
      { name: "co-observer", label: "视觉分析" },
      { name: "co-fixer", label: "代码修改方案" },
      { name: "co-designer", label: "UI/UX 设计" },
      { name: "co-council", label: "多模型共识" },
      { name: "co-rule-user", label: "用户规则" },
      { name: "co-rule-project", label: "项目规则" },
      { name: "co-rule-app", label: "应用规则" },

    ];

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
      useJobTrackingLabel: "Job 跟踪",
      adaptiveBatchLabel: "批间自适应",
      useJobTrackingAuto: "auto（自动）",
      useJobTrackingOn: "on（启用）",
      useJobTrackingOff: "off（关闭）",
      adaptiveBatchAuto: "auto（自适应）",
      adaptiveBatchOff: "off（固定）",
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
      useJobTrackingLabel: "Job tracking",
      adaptiveBatchLabel: "Adaptive batch",
      useJobTrackingAuto: "auto (automatic)",
      useJobTrackingOn: "on (enabled)",
      useJobTrackingOff: "off (disabled)",
      adaptiveBatchAuto: "auto (adaptive)",
      adaptiveBatchOff: "off (fixed)",
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

    function emptyDraft() {
      var draft = {};
      for (var i = 0; i < SKILL_ROWS.length; i += 1) {
        draft[SKILL_ROWS[i].name] = { provider: "", model: "", maxTokens: undefined };
      }
      return draft;
    }

    function rowFromSkill(skill) {
      return {
        provider: typeof skill.provider === "string" ? skill.provider : "",
        model: typeof skill.model === "string" ? skill.model : "",
        maxTokens: typeof skill.maxTokens === "number" ? skill.maxTokens : undefined
      };
    }

    function buildDraft(skills) {
      var draft = emptyDraft();
      if (Array.isArray(skills)) {
        for (var i = 0; i < skills.length; i += 1) {
          var skill = skills[i];
          if (!skill || typeof skill.name !== "string") continue;
          if (!Object.prototype.hasOwnProperty.call(draft, skill.name)) {
            draft[skill.name] = { provider: "", model: "", maxTokens: undefined };
          }
          draft[skill.name] = rowFromSkill(skill);
        }
      }
      return draft;
    }

    function isConfigured(row) {
      return row.provider !== "" || row.model !== "" || row.maxTokens !== undefined;
    }

    function nameSet(skills) {
      var set = new Set();
      if (Array.isArray(skills)) {
        for (var i = 0; i < skills.length; i += 1) {
          var skill = skills[i];
          if (skill && typeof skill.name === "string") set.add(skill.name);
        }
      }
      return set;
    }

    function useLlmTopology(api, remote) {
      var [state, setState] = React.useState({ providers: [], modelsByProvider: {}, loading: true, error: null });

      var load = React.useCallback(function () {
        var generation = 0;
        return async function () {
          generation += 1;
          var providers = [];
          var modelsByProvider = {};
          try {
            var responses = await Promise.all([
              api.llm.listConfigurableProviders(),
              api.session.modelCatalog()
            ]);
            var providersResponse = responses[0];
            var modelsResponse = responses[1];
            if (!providersResponse || !providersResponse.ok) {
              throw new Error(providersResponse && providersResponse.error ? providersResponse.error.message : "llm.listConfigurableProviders failed");
            }
            if (!modelsResponse || !modelsResponse.ok) {
              throw new Error(modelsResponse && modelsResponse.error ? modelsResponse.error.message : "session.modelCatalog failed");
            }
            var configurable = providersResponse.value || [];
            for (var i = 0; i < configurable.length; i += 1) {
              var item = configurable[i];
              if (item.declared === false) continue;
              providers.push({
                id: item.provider,
                label: item.displayName && item.displayName !== item.provider ? item.displayName + " (" + item.provider + ")" : item.provider,
                active: item.declared !== false
              });
            }
            var groups = (modelsResponse.value && modelsResponse.value.groups) || [];
            for (var j = 0; j < groups.length; j += 1) {
              var group = groups[j];
              if (!group || typeof group.id !== "string") continue;
              var models = (group.models || []).map(function (model) {
                return {
                  id: model.id,
                  label: model.name && model.name !== model.id ? model.name + " (" + model.id + ")" : model.id
                };
              });
              modelsByProvider[group.id] = models;
              var known = providers.some(function (provider) { return provider.id === group.id; });
              if (!known) {
                providers.push({
                  id: group.id,
                  label: group.name && group.name !== group.id ? group.name + " (" + group.id + ")" : group.id,
                  active: true
                });
              }
            }
            providers.sort(function (left, right) { return left.id.localeCompare(right.id); });
            setState({ providers: providers, modelsByProvider: modelsByProvider, loading: false, error: null });
          } catch (error) {
            setState({ providers: providers, modelsByProvider: modelsByProvider, loading: false, error: error && error.message ? error.message : String(error) });
          }
        };
      }, [api]);

      React.useEffect(function () {
        var run = load();
        run();
        var off = remote && remote.$on ? remote.$on("llm/adapters-updated", function () { run(); }) : undefined;
        return function () {
          if (typeof off === "function") off();
        };
      }, [load, remote]);

      return {
        providers: state.providers,
        modelsByProvider: state.modelsByProvider,
        loading: state.loading,
        error: state.error
      };
    }

    function installCss() {
      var tagId = "dsh-cohub/cohub-card.css";
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      var css = [
        ".cohub-card{max-width:760px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-3);}",
        ".cohub-title{margin:0;font-size:15px;font-weight:600;line-height:22px;}",
        ".cohub-desc{color:var(--dsw-alias-label-tertiary);margin:4px 0 0;font-size:13px;line-height:20px;}",
        ".cohub-status{margin:8px 0 0;font-size:12px;line-height:18px;}",
        ".cohub-rows{margin:14px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;}",
        ".cohub-row{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);}",
        ".cohub-row-head{display:flex;align-items:center;gap:8px;}",
        ".cohub-row-name{font-size:13px;font-weight:600;line-height:20px;}",
        ".cohub-row-id{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}",
        ".cohub-badge{margin-left:auto;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap;}",
        ".cohub-badge-explicit{color:var(--dsw-alias-state-success-primary);border:1px solid var(--dsw-alias-state-success-primary);}",
        ".cohub-badge-inherited{color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
        ".cohub-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;}",
        ".cohub-field{display:flex;flex-direction:column;gap:4px;}",
        ".cohub-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}",
        ".cohub-select,.cohub-input{box-sizing:border-box;width:100%;height:32px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;font-size:13px;line-height:20px;}",
        ".cohub-select:focus-visible,.cohub-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none;}",
        ".cohub-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px;}",
        ".cohub-button{height:32px;font:inherit;cursor:pointer;border-radius:8px;padding:0 12px;font-size:13px;line-height:20px;}",
        ".cohub-button-primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border:none;}",
        ".cohub-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}",
        ".cohub-button-ghost{color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);}",
        ".cohub-button-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);}",
        ".cohub-button:disabled{opacity:.45;cursor:default;}",
        ".cohub-error{color:var(--dsw-alias-state-error-primary);}",
        ".cohub-saved{color:var(--dsw-alias-state-success-primary);}",
        ".cohub-subtitle{margin:16px 0 0;font-size:13px;font-weight:600;line-height:20px;}",
        ".cohub-schedule{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;margin-top:10px;background:var(--dsw-alias-bg-layer-2);}",
        ".cohub-schedule-fields{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:8px;}",
        ".cohub-retry-fields{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;}",
        ".cohub-field-row{display:flex;flex-direction:column;gap:4px;margin-top:10px;}",
        ".cohub-stall-fields{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;}",
        ".cohub-envsig-fields{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px;}",
        ".cohub-checkbox-row{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer;}",
        ".cohub-notice{background:var(--dsw-alias-state-warning-bg,#fff8e1);color:var(--dsw-alias-state-warning-primary,#8d6e00);border:1px solid var(--dsw-alias-state-warning-border,#ffc107);border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:13px;line-height:20px;}",
        ".cohub-clear-btn{background:none;border:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:16px;line-height:1;padding:0 4px;margin-left:4px;}.cohub-clear-btn:hover{color:var(--dsw-alias-label-primary);}"
      ].join("\n");
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-cohub";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function CohubSettingsCard(props) {
      var scope = props.scope;
      var api = props.api;
      var remote = props.remote;
      var t = typeof props.t === "function" ? props.t : function (key) { return zh[key] || key; };

      if (!scope || !api) return null;

      var subscribe = React.useCallback(function (listener) { return scope.subscribe(listener); }, [scope]);
      var getSnapshot = React.useCallback(function () { return scope.getSnapshot(); }, [scope]);
      var snapshot = React.useSyncExternalStore(subscribe, getSnapshot);

      var [draft, setDraft] = React.useState(function () {
        return buildDraft(Array.isArray(snapshot.value && snapshot.value.skills) ? snapshot.value.skills : []);
      }, { key: "cohub" });
      var [dirty, setDirty] = React.useState(false);
      var [touched, setTouched] = React.useState(function () { return new Set(); });
      var [saving, setSaving] = React.useState(false);
      var [saved, setSaved] = React.useState(false);
      var [error, setError] = React.useState("");
      var [invalidNotice, setInvalidNotice] = React.useState(null);

      var [scheduleDraft, setScheduleDraft] = React.useState(function () {
        var s = snapshot.value && snapshot.value.schedule;
        return {
          maxParallelBatch: s && typeof s.maxParallelBatch === "number" ? s.maxParallelBatch : 3,
          wallClockBudgetMs: s && typeof s.wallClockBudgetMs === "number" ? s.wallClockBudgetMs : 600000,
          useJobTracking: s && typeof s.useJobTracking === "string" ? s.useJobTracking : "auto",
          adaptiveBatch: s && typeof s.adaptiveBatch === "string" ? s.adaptiveBatch : "auto"
        };
      });
      var [retryDraft, setRetryDraft] = React.useState(function () {
        var r = snapshot.value && snapshot.value.delegateRetry;
        return {
          maxRetries: r && typeof r.maxRetries === "number" ? r.maxRetries : 0,
          retryDelayMs: r && typeof r.retryDelayMs === "number" ? r.retryDelayMs : 1000,
          retryableReasons: Array.isArray(r && r.retryableReasons) ? r.retryableReasons : ["aborted"]
        };
      });
      var [stallDraft, setStallDraft] = React.useState(function () {
        var s = snapshot.value && snapshot.value.delegateRetry && snapshot.value.delegateRetry.stall;
        return {
          enabled: !!(s && s.enabled),
          consecutiveErrors: s && typeof s.consecutiveErrors === "number" ? s.consecutiveErrors : 3,
          idleMs: s && typeof s.idleMs === "number" ? s.idleMs : 180000,
          reasoningWithoutAction: s && typeof s.reasoningWithoutAction === "number" ? s.reasoningWithoutAction : 50,
          loopCount: s && typeof s.loopCount === "number" ? s.loopCount : 3,
          graceMs: s && typeof s.graceMs === "number" ? s.graceMs : 30000,
          recoverable: s && typeof s.recoverable === "boolean" ? s.recoverable : true
        };
      });
      var [envSigDraft, setEnvSigDraft] = React.useState(function () {
        var e = snapshot.value && snapshot.value.envSignatures;
        return {
          use: e && typeof e.use === "string" ? e.use : "auto",
          ttlMs: e && typeof e.ttlMs === "number" ? e.ttlMs : 604800000,
          confirmCount: e && typeof e.confirmCount === "number" ? e.confirmCount : 2
        };
      });
      var [scheduleTouched, setScheduleTouched] = React.useState(false);
      var [retryTouched, setRetryTouched] = React.useState(false);
      var [stallTouched, setStallTouched] = React.useState(false);
      var [envSigTouched, setEnvSigTouched] = React.useState(false);

      var topology = useLlmTopology(api, remote);

      React.useEffect(function () {
        if (!dirty) {
          setDraft(buildDraft(Array.isArray(snapshot.value && snapshot.value.skills) ? snapshot.value.skills : []));
          setTouched(new Set());
          var s = snapshot.value && snapshot.value.schedule;
          setScheduleDraft({
            maxParallelBatch: s && typeof s.maxParallelBatch === "number" ? s.maxParallelBatch : 3,
            wallClockBudgetMs: s && typeof s.wallClockBudgetMs === "number" ? s.wallClockBudgetMs : 600000,
            useJobTracking: s && typeof s.useJobTracking === "string" ? s.useJobTracking : "auto",
            adaptiveBatch: s && typeof s.adaptiveBatch === "string" ? s.adaptiveBatch : "auto"
          });
          var r = snapshot.value && snapshot.value.delegateRetry;
          setRetryDraft({
            maxRetries: r && typeof r.maxRetries === "number" ? r.maxRetries : 0,
            retryDelayMs: r && typeof r.retryDelayMs === "number" ? r.retryDelayMs : 1000,
            retryableReasons: Array.isArray(r && r.retryableReasons) ? r.retryableReasons : ["aborted"]
          });
          var st = snapshot.value && snapshot.value.delegateRetry && snapshot.value.delegateRetry.stall;
          setStallDraft({
            enabled: !!(st && st.enabled),
            consecutiveErrors: st && typeof st.consecutiveErrors === "number" ? st.consecutiveErrors : 3,
            idleMs: st && typeof st.idleMs === "number" ? st.idleMs : 180000,
            reasoningWithoutAction: st && typeof st.reasoningWithoutAction === "number" ? st.reasoningWithoutAction : 50,
            loopCount: st && typeof st.loopCount === "number" ? st.loopCount : 3,
            graceMs: st && typeof st.graceMs === "number" ? st.graceMs : 30000,
            recoverable: st && typeof st.recoverable === "boolean" ? st.recoverable : true
          });
          var e = snapshot.value && snapshot.value.envSignatures;
          setEnvSigDraft({
            use: e && typeof e.use === "string" ? e.use : "auto",
            ttlMs: e && typeof e.ttlMs === "number" ? e.ttlMs : 604800000,
            confirmCount: e && typeof e.confirmCount === "number" ? e.confirmCount : 2
          });
          setScheduleTouched(false);
          setRetryTouched(false);
          setStallTouched(false);
          setEnvSigTouched(false);
        }
      }, [snapshot, dirty]);

      var prevTopologyRef = React.useRef(topology.loading);
      React.useEffect(function () {
        var wasLoading = prevTopologyRef.current;
        prevTopologyRef.current = topology.loading;
        if (topology.loading) return;
        if (!wasLoading) return;

        var providerIds = new Set(topology.providers.map(function (p) { return p.id; }));
        var cleared = [];
        setDraft(function (prev) {
          var next = {};
          var changed = false;
          for (var key in prev) {
            var row = prev[key];
            var newRow = { provider: row.provider, model: row.model, maxTokens: row.maxTokens };
            if (row.provider && !providerIds.has(row.provider)) {
              newRow.provider = "";
              newRow.model = "";
              changed = true;
              cleared.push(key);
            } else if (row.provider && row.model) {
              var models = topology.modelsByProvider[row.provider] || [];
              var modelIds = new Set(models.map(function (m) { return m.id; }));
              if (!modelIds.has(row.model)) {
                newRow.model = "";
                changed = true;
                cleared.push(key);
              }
            }
            next[key] = newRow;
          }
          return changed ? next : prev;
        });
        if (cleared.length > 0) {
          var skillLabels = cleared.map(function (name) {
            var found = SKILL_ROWS.find(function (s) { return s.name === name; });
            return found ? found.label : name;
          });
          setInvalidNotice(
            t("invalidCleared").replace("{count}", String(cleared.length)) + " " +
            t("invalidClearedList").replace("{list}", skillLabels.join("、"))
          );
          setDirty(true);
          setSaved(false);
        }
      }, [topology.loading, topology.providers, topology.modelsByProvider]);

      var effectiveSkills = Array.isArray(snapshot.value && snapshot.value.skills) ? snapshot.value.skills : [];
      var baseNames = nameSet(snapshot.base && snapshot.base.skills);
      var userNames = nameSet(snapshot.user && snapshot.user.skills);
      var ready = snapshot.status === "ready";
      var writable = ready && snapshot.writable === true;

      function update(name, field, value) {
        setDraft(function (prev) {
          var next = {};
          for (var key in prev) next[key] = prev[key];
          next[name] = { provider: prev[name].provider, model: prev[name].model, maxTokens: prev[name].maxTokens };
          next[name][field] = value;
          return next;
        });
        setTouched(function (prev) {
          var next = new Set(prev);
          next.add(name);
          return next;
        });
        setDirty(true);
        setSaved(false);
        setError("");
      }

      function updateSchedule(field, value) {
        setScheduleDraft(function (prev) {
          var next = {};
          for (var key in prev) next[key] = prev[key];
          next[field] = value;
          return next;
        });
        setScheduleTouched(true);
        setDirty(true);
        setSaved(false);
        setError("");
      }

      function updateRetry(field, value) {
        setRetryDraft(function (prev) {
          var next = {};
          for (var key in prev) next[key] = prev[key];
          next[field] = value;
          return next;
        });
        setRetryTouched(true);
        setDirty(true);
        setSaved(false);
        setError("");
      }

      function updateStall(field, value) {
        setStallDraft(function (prev) {
          var next = {};
          for (var key in prev) next[key] = prev[key];
          next[field] = value;
          return next;
        });
        setStallTouched(true);
        setDirty(true);
        setSaved(false);
        setError("");
      }

      function updateEnvSig(field, value) {
        setEnvSigDraft(function (prev) {
          var next = {};
          for (var key in prev) next[key] = prev[key];
          next[field] = value;
          return next;
        });
        setEnvSigTouched(true);
        setDirty(true);
        setSaved(false);
        setError("");
      }

      function discard() {
        setDraft(buildDraft(effectiveSkills));
        setTouched(new Set());
        var s = snapshot.value && snapshot.value.schedule;
        setScheduleDraft({
          maxParallelBatch: s && typeof s.maxParallelBatch === "number" ? s.maxParallelBatch : 3,
          wallClockBudgetMs: s && typeof s.wallClockBudgetMs === "number" ? s.wallClockBudgetMs : 600000,
          useJobTracking: s && typeof s.useJobTracking === "string" ? s.useJobTracking : "auto",
          adaptiveBatch: s && typeof s.adaptiveBatch === "string" ? s.adaptiveBatch : "auto"
        });
        var r = snapshot.value && snapshot.value.delegateRetry;
        setRetryDraft({
          maxRetries: r && typeof r.maxRetries === "number" ? r.maxRetries : 0,
          retryDelayMs: r && typeof r.retryDelayMs === "number" ? r.retryDelayMs : 1000,
          retryableReasons: Array.isArray(r && r.retryableReasons) ? r.retryableReasons : ["aborted"]
        });
        var st = snapshot.value && snapshot.value.delegateRetry && snapshot.value.delegateRetry.stall;
        setStallDraft({
          enabled: !!(st && st.enabled),
          consecutiveErrors: st && typeof st.consecutiveErrors === "number" ? st.consecutiveErrors : 3,
          idleMs: st && typeof st.idleMs === "number" ? st.idleMs : 180000,
          reasoningWithoutAction: st && typeof st.reasoningWithoutAction === "number" ? st.reasoningWithoutAction : 50,
          loopCount: st && typeof st.loopCount === "number" ? st.loopCount : 3,
          graceMs: st && typeof st.graceMs === "number" ? st.graceMs : 30000,
          recoverable: st && typeof st.recoverable === "boolean" ? st.recoverable : true
        });
        var e = snapshot.value && snapshot.value.envSignatures;
        setEnvSigDraft({
          use: e && typeof e.use === "string" ? e.use : "auto",
          ttlMs: e && typeof e.ttlMs === "number" ? e.ttlMs : 604800000,
          confirmCount: e && typeof e.confirmCount === "number" ? e.confirmCount : 2
        });
        setScheduleTouched(false);
        setRetryTouched(false);
        setStallTouched(false);
        setEnvSigTouched(false);
        setDirty(false);
        setSaved(false);
        setError("");
      }

      async function save() {
        if (!dirty || saving || !writable) return;
        setSaving(true);
        setSaved(false);
        setError("");
        var next = [];
        for (var name in draft) {
          var row = draft[name];
          var item = { name: name };
          if (row.provider) item.provider = row.provider;
          if (row.model) item.model = row.model;
          if (row.maxTokens !== undefined) item.maxTokens = row.maxTokens;
          if (item.provider || item.model || item.maxTokens !== undefined) next.push(item);
        }
        try {
          if (next.length === 0) await scope.unset("skills");
          else await scope.set("skills", next);
          if (scheduleTouched) {
            var batch = parseInt(scheduleDraft.maxParallelBatch, 10);
            var wall = parseInt(scheduleDraft.wallClockBudgetMs, 10);
            if (!Number.isFinite(batch) || batch < 1) batch = 3;
            if (!Number.isFinite(wall) || wall < 0) wall = 600000;
            await scope.set("schedule", {
              maxParallelBatch: batch,
              wallClockBudgetMs: wall,
              useJobTracking: scheduleDraft.useJobTracking || "auto",
              adaptiveBatch: scheduleDraft.adaptiveBatch || "auto"
            });
          }
          if (retryTouched || stallTouched) {
            var retries = parseInt(retryDraft.maxRetries, 10);
            var delay = parseInt(retryDraft.retryDelayMs, 10);
            if (!Number.isFinite(retries) || retries < 0) retries = 0;
            if (!Number.isFinite(delay) || delay < 0) delay = 1000;
            var reasons = String(retryDraft.retryableReasons || "")
              .split(/[\s,]+/)
              .filter(function (s) { return s && s.length > 0; });
            if (reasons.length === 0) reasons = ["aborted"];
            var retryPayload = {
              maxRetries: retries,
              retryDelayMs: delay,
              retryableReasons: reasons
            };
            if (stallTouched) {
              var ce = parseInt(stallDraft.consecutiveErrors, 10);
              var idle = parseInt(stallDraft.idleMs, 10);
              var rwa = parseInt(stallDraft.reasoningWithoutAction, 10);
              var loop = parseInt(stallDraft.loopCount, 10);
              var grace = parseInt(stallDraft.graceMs, 10);
              if (!Number.isFinite(ce) || ce < 1) ce = 3;
              if (!Number.isFinite(idle) || idle < 0) idle = 180000;
              if (!Number.isFinite(rwa) || rwa < 1) rwa = 50;
              if (!Number.isFinite(loop) || loop < 1) loop = 3;
              if (!Number.isFinite(grace) || grace < 0) grace = 30000;
              retryPayload.stall = {
                enabled: !!stallDraft.enabled,
                consecutiveErrors: ce,
                idleMs: idle,
                reasoningWithoutAction: rwa,
                loopCount: loop,
                graceMs: grace,
                recoverable: !!stallDraft.recoverable
              };
            } else {
              var cur = snapshot.value && snapshot.value.delegateRetry;
              if (cur && cur.stall) retryPayload.stall = cur.stall;
            }
            await scope.set("delegateRetry", retryPayload);
          }
          if (envSigTouched) {
            var ttl = parseInt(envSigDraft.ttlMs, 10);
            var cc = parseInt(envSigDraft.confirmCount, 10);
            if (!Number.isFinite(ttl) || ttl < 0) ttl = 604800000;
            if (!Number.isFinite(cc) || cc < 1) cc = 2;
            await scope.set("envSignatures", {
              use: envSigDraft.use || "auto",
              ttlMs: ttl,
              confirmCount: cc
            });
          }
          setDirty(false);
          setTouched(new Set());
          setScheduleTouched(false);
          setRetryTouched(false);
          setStallTouched(false);
          setEnvSigTouched(false);
          setSaved(true);
        } catch (err) {
          setError(err && err.message ? err.message : String(err));
        } finally {
          setSaving(false);
        }
      }

      if (!ready) {
        return React.createElement("div", { className: "cohub-card" },
          React.createElement("h3", { className: "cohub-title" }, t("title")),
          React.createElement("p", { className: "cohub-desc" }, t("description")),
          React.createElement("p", { className: "cohub-status" }, t(snapshot.status === "unavailable" ? "unavailable" : "loading"))
        );
      }

      var rows = SKILL_ROWS.map(function (skill) {
        var row = draft[skill.name] || { provider: "", model: "", maxTokens: undefined };
        var models = topology.modelsByProvider[row.provider] || [];
        var modelOptions = models.map(function (model) {
          return React.createElement("option", { key: model.id, value: model.id }, model.label);
        });
        if (row.model && !models.some(function (m) { return m.id === row.model; })) {
          modelOptions.unshift(
            React.createElement("option", { key: "__current", value: row.model, disabled: true }, row.model + " (已失效)")
          );
        }
        var providerOptions;
        if (topology.loading) {
          providerOptions = [React.createElement("option", { key: "__loading", value: "", disabled: true }, t("loading"))];
        } else if (topology.error) {
          providerOptions = [React.createElement("option", { key: "__error", value: "", disabled: true }, t("loadProvidersFailed"))];
        } else if (topology.providers.length === 0) {
          providerOptions = [React.createElement("option", { key: "__empty", value: "", disabled: true }, t("loadProvidersFailed"))];
        } else {
          providerOptions = topology.providers.map(function (provider) {
            return React.createElement("option", { key: provider.id, value: provider.id }, provider.label);
          });
          if (row.provider && !topology.providers.some(function (p) { return p.id === row.provider; })) {
            providerOptions.unshift(
              React.createElement("option", { key: "__current-provider", value: row.provider, disabled: true }, row.provider + " (已失效)")
            );
          }
        }

        var modelControl;
        if (!row.provider) {
          modelControl = React.createElement("select", { className: "cohub-select", value: "", disabled: true },
            React.createElement("option", { value: "" }, t("selectProviderFirst"))
          );
        } else if (topology.loading) {
          modelControl = React.createElement("select", { className: "cohub-select", value: "", disabled: true },
            React.createElement("option", { value: "" }, t("loading"))
          );
        } else if (models.length > 0) {
          // 未保存 model 时插入一个 value="" 的占位项。否则 <select value=""> 会被浏览器
          // 渲染成列表第一项，让人误以为「已经选好了模型」，而实际保存值仍是空 —— 服务端随后
          // 只能继承父会话模型并可能以 UNKNOWN_MODEL 失败。
          var modelSelectOptions = [React.createElement("option", { key: "__inherit", value: "" }, t("modelPlaceholder"))].concat(modelOptions);
          modelControl = React.createElement("select", {
            className: "cohub-select",
            value: row.model || "",
            disabled: !writable,
            onChange: function (event) { update(skill.name, "model", event.target.value); }
          }, modelSelectOptions);
        } else {
          modelControl = React.createElement("input", {
            className: "cohub-input",
            value: row.model,
            disabled: !writable,
            placeholder: t("customModel"),
            onChange: function (event) { update(skill.name, "model", event.target.value); }
          });
        }

        var badgeClass = userNames.has(skill.name) || touched.has(skill.name) ? "cohub-badge cohub-badge-explicit" : baseNames.has(skill.name) ? "cohub-badge cohub-badge-inherited" : "cohub-badge cohub-badge-inherited";
        var badgeText = userNames.has(skill.name) || touched.has(skill.name) ? t("configured") : t("inherited");

        return React.createElement("li", { key: skill.name, className: "cohub-row" },
          React.createElement("div", { className: "cohub-row-head" },
            React.createElement("span", { className: "cohub-row-name" }, skill.label),
            React.createElement("span", { className: "cohub-row-id" }, skill.name),
            React.createElement("span", { className: badgeClass }, badgeText)
          ),
          React.createElement("div", { className: "cohub-fields" },
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("provider")),
              React.createElement("select", {
                className: "cohub-select",
                value: row.provider,
                disabled: !writable,
                onChange: function (event) { update(skill.name, "provider", event.target.value); }
              }, providerOptions),
              row.provider && writable ?
                React.createElement("button", { type: "button", className: "cohub-clear-btn", onClick: function () { update(skill.name, "provider", ""); update(skill.name, "model", ""); }, title: "清除" }, "\u00D7") :
                null
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("model")),
              modelControl,
              row.model && writable && row.provider ?
                React.createElement("button", { type: "button", className: "cohub-clear-btn", onClick: function () { update(skill.name, "model", ""); }, title: "清除" }, "\u00D7") :
                null
            )
          )
        );
      });

      return React.createElement("div", { className: "cohub-card" },
        React.createElement("h3", { className: "cohub-title" }, t("title")),
        React.createElement("p", { className: "cohub-desc" }, t("description")),
        topology.error ? React.createElement("p", { className: "cohub-status cohub-error" }, t("loadProvidersFailed") + ": " + topology.error) : null,
        invalidNotice ? React.createElement("div", { className: "cohub-notice" },
          React.createElement("span", null, invalidNotice)
        ) : null,
        React.createElement("ul", { className: "cohub-rows" }, rows),
        React.createElement("div", { className: "cohub-schedule" },
          React.createElement("h4", { className: "cohub-subtitle" }, t("scheduleTitle")),
          React.createElement("p", { className: "cohub-desc" }, t("scheduleDesc")),
          React.createElement("div", { className: "cohub-schedule-fields" },
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("batchSize")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 1, step: 1, value: scheduleDraft.maxParallelBatch, disabled: !writable, onChange: function (event) { updateSchedule("maxParallelBatch", event.target.value); } })
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("wallClock")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 0, step: 1000, value: scheduleDraft.wallClockBudgetMs, disabled: !writable, onChange: function (event) { updateSchedule("wallClockBudgetMs", event.target.value); } })
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("useJobTrackingLabel")),
              React.createElement("select", { className: "cohub-select", value: scheduleDraft.useJobTracking, disabled: !writable, onChange: function (event) { updateSchedule("useJobTracking", event.target.value); } },
                React.createElement("option", { value: "auto" }, t("useJobTrackingAuto")),
                React.createElement("option", { value: "on" }, t("useJobTrackingOn")),
                React.createElement("option", { value: "off" }, t("useJobTrackingOff"))
              )
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("adaptiveBatchLabel")),
              React.createElement("select", { className: "cohub-select", value: scheduleDraft.adaptiveBatch, disabled: !writable, onChange: function (event) { updateSchedule("adaptiveBatch", event.target.value); } },
                React.createElement("option", { value: "auto" }, t("adaptiveBatchAuto")),
                React.createElement("option", { value: "off" }, t("adaptiveBatchOff"))
              )
            )
          )
        ),
        React.createElement("div", { className: "cohub-retry" },
          React.createElement("h4", { className: "cohub-subtitle" }, t("maxRetries") + " / " + t("retryDelayMs")),
          React.createElement("div", { className: "cohub-retry-fields" },
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("maxRetries")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 0, step: 1, value: retryDraft.maxRetries, disabled: !writable, onChange: function (event) { updateRetry("maxRetries", event.target.value); } })
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("retryDelayMs")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 0, step: 100, value: retryDraft.retryDelayMs, disabled: !writable, onChange: function (event) { updateRetry("retryDelayMs", event.target.value); } })
            )
          ),
          React.createElement("div", { className: "cohub-field-row" },
            React.createElement("label", { className: "cohub-label" }, t("retryableReasons")),
            React.createElement("input", { className: "cohub-input", type: "text", value: (Array.isArray(retryDraft.retryableReasons) ? retryDraft.retryableReasons : []).join(", "), disabled: !writable, placeholder: "aborted, error", onChange: function (event) { updateRetry("retryableReasons", event.target.value); } }),
            React.createElement("p", { className: "cohub-desc" }, t("retryableReasonsHint"))
          )
        ),
        React.createElement("div", { className: "cohub-stall" },
          React.createElement("h4", { className: "cohub-subtitle" }, t("stallTitle")),
          React.createElement("p", { className: "cohub-desc" }, t("stallDesc")),
          React.createElement("label", { className: "cohub-checkbox-row" },
            React.createElement("input", { type: "checkbox", checked: !!stallDraft.enabled, disabled: !writable, onChange: function (event) { updateStall("enabled", event.target.checked); } }),
            " " + t("stallEnabled")
          ),
          React.createElement("div", { className: "cohub-stall-fields" },
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("consecutiveErrors")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 1, step: 1, value: stallDraft.consecutiveErrors, disabled: !writable || !stallDraft.enabled, onChange: function (event) { updateStall("consecutiveErrors", event.target.value); } })
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("idleMs")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 0, step: 1000, value: stallDraft.idleMs, disabled: !writable || !stallDraft.enabled, onChange: function (event) { updateStall("idleMs", event.target.value); } })
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("reasoningWithoutAction")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 1, step: 1, value: stallDraft.reasoningWithoutAction, disabled: !writable || !stallDraft.enabled, onChange: function (event) { updateStall("reasoningWithoutAction", event.target.value); } })
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("loopCount")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 1, step: 1, value: stallDraft.loopCount, disabled: !writable || !stallDraft.enabled, onChange: function (event) { updateStall("loopCount", event.target.value); } })
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("graceMs")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 0, step: 1000, value: stallDraft.graceMs, disabled: !writable || !stallDraft.enabled, onChange: function (event) { updateStall("graceMs", event.target.value); } })
            )
          ),
          React.createElement("label", { className: "cohub-checkbox-row" },
            React.createElement("input", { type: "checkbox", checked: !!stallDraft.recoverable, disabled: !writable || !stallDraft.enabled, onChange: function (event) { updateStall("recoverable", event.target.checked); } }),
            " " + t("recoverable")
          )
        ),
        React.createElement("div", { className: "cohub-envsig" },
          React.createElement("h4", { className: "cohub-subtitle" }, t("envSigTitle")),
          React.createElement("p", { className: "cohub-desc" }, t("envSigDesc")),
          React.createElement("div", { className: "cohub-envsig-fields" },
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("envSigUse")),
              React.createElement("select", { className: "cohub-select", value: envSigDraft.use, disabled: !writable, onChange: function (event) { updateEnvSig("use", event.target.value); } },
                React.createElement("option", { value: "auto" }, t("envSigUseAuto")),
                React.createElement("option", { value: "off" }, t("envSigUseOff")),
                React.createElement("option", { value: "manual" }, t("envSigUseManual"))
              )
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("envSigTtl")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 0, step: 86400000, value: envSigDraft.ttlMs, disabled: !writable, onChange: function (event) { updateEnvSig("ttlMs", event.target.value); } })
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("envSigConfirmCount")),
              React.createElement("input", { className: "cohub-input", type: "number", min: 1, step: 1, value: envSigDraft.confirmCount, disabled: !writable, onChange: function (event) { updateEnvSig("confirmCount", event.target.value); } })
            )
          )
        ),
        error ? React.createElement("p", { className: "cohub-status cohub-error" }, t("failed") + error) : null,
        saved ? React.createElement("p", { className: "cohub-status cohub-saved" }, t("saved")) : null,
        React.createElement("div", { className: "cohub-actions" },
          React.createElement("button", { type: "button", className: "cohub-button cohub-button-ghost", disabled: !dirty || saving, onClick: discard }, t("discard")),
          React.createElement("button", { type: "button", className: "cohub-button cohub-button-primary", disabled: !dirty || saving || !writable, onClick: save }, t(saving ? "saving" : "save"))
        )
      );
    }

    function apply(ctx) {
      installCss();
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "cohub: settings dictionaries");

      var scope = ctx.settingsScope.bind({ namespace: NS });
      var remote = ctx.remote;

      // alpha.2 后 settings.plugin.item slot 改成 keyed 类型（key = settings namespace）；
      // 按 .agents/notes/implemented/architecture/2026-08-12-plugin-owned-settings-surface.md，
      // 用 key/locale 注册，不再声明 id/order，也不需要 slots.inject 第三参数。
      ctx.slots.inject("settings.plugin.item", function () {
        return ctx.slots.register({
          name: "settings.plugin.item",
          key: NS,
          locale: NS,
          inject: function () {
            return { scope: scope, api: remote, t: ctx.locale.bind(NS), remote: remote };
          }
        }, CohubSettingsCard);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});


