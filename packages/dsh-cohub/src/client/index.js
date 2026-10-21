window.__ModuleLoader__.load({
  id: "dsh-cohub",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");

    /* ────────────────────────────────────────────────────────────────
     * CoHub 代理模型设置页（DSH 0.2.1）
     *
     * 历史纠正（旧注释是错的，别再抄回去）：
     *   ❌「0.2 官方设置页会自动按 volatile 字段生成表单，无需客户端」
     *      → 官方 0.2.1 的 settings.section 导航与页面全部由客户端插件注册
     *        （general / models / plugins / agent-presets / account 都是这么做的）。
     *        官方 README 明说「目前没有已发布的客户端会那样渲染 volatile 字段」，
     *        所以本插件必须自带页面。
     *   ❌「旧 settingsScope 服务与 settings.plugin.item slot 已在 0.2 移除」
     *      → 是**改名**不是移除：settingsScope → configForms；
     *        settings.plugin.item → plugins.item / settings.section。
     *
     * 取证过的 0.2.1 契约（照抄官方插件写法，别再自己发明）：
     *   1. 页面挂 settings.section（list/root）。左侧导航由宿主
     *      ctx.slots.entries("settings.section") 按 order 升序投影，注册即出现，
     *      无需在别处登记。现有 order：general 0 / models 10 / plugins 15 /
     *      agent-presets 20 / account -100，本页取 12（模型与插件之间）。
     *   2. 读写配置走 ctx.configForms.get(<Loader entry id>)，namespace 就是
     *      cordis.patch.yml 里那一行的 id（"cohub"）：
     *        scope.getSnapshot() → { status: "loading"|"ready"|"unavailable",
     *                                value, base, user, revision, writable }
     *        scope.mutate(ops, expectedRevision) → Promise<boolean>
     *        scope.subscribe(fn) → () => void
     *      数组字段整体替换，所以一次 mutate 提交完整 skills 数组。
     *   3. 模型目录走 ctx.remote.session.modelCatalog()（{ ok, value }），
     *      value.groups = [{ id, name, models: [{ id, name, reasoning? }] }]；必须判 .ok。
     *      reasoning = { efforts: [{ id, name }], defaultEffort? }（dsh-llm LlmModelReasoningInfo），
     *      不支持的模型整个 reasoning 字段缺失（不是空数组）→ 推理强度下拉禁用。
     *      目录变化订阅 ctx.remote.$on("llm/adapters-updated", fn)。
     *   4. slot 的 inject 返回 { hooks: { <name>: <observable> }, ...props }，
     *      渲染器把 observable 绑成 props.use<Name>(selector)；
     *      observable 只需 { getSnapshot(), subscribe(fn) }（uSES 语义，
     *      getSnapshot 必须在未变化时返回同一引用）。
     *   5. 官方 dsh-client-ui-primitives 没有 Select/Dropdown，用原生 select。
     * ──────────────────────────────────────────────────────────────── */

    /** 设置字典命名空间，同时也是本插件客户端 slot 的 locale 命名空间。 */
    var NS = "cohub";
    /** 配置命名空间 = cordis.patch.yml 中本插件 Loader 行的 id。 */
    var ENTRY_ID = "cohub";
    /** 左侧导航位置：插在「模型」(10) 与「插件」(15) 之间。 */
    var SECTION_ORDER = 12;

    var inject = ["slots", "locale", "remote", "remote.session", "configForms"];

    /** src/skills.ts 中 COHUB_SKILLS 的真实清单与顺序。 */
    var SKILL_NAMES = [
      "co-orchestrator",
      "co-planner",
      "co-oracle",
      "co-explorer",
      "co-librarian",
      "co-observer",
      "co-fixer",
      "co-designer",
      "co-council",
      "co-rule-user",
      "co-rule-project",
      "co-rule-app",
      "co-cordis"
    ];

    var zh = {
      nav: "CoHub 代理",
      title: "CoHub 代理模型",
      description: "为每个专职代理单独指定模型供应商与模型。留空则继承父模型；配置失效时自动回退。",
      provider: "供应商",
      model: "模型",
      configured: "显式配置",
      inherited: "继承父模型",
      providerInherit: "（不配置，继承父模型）",
      modelInherit: "（继承父模型）",
      loading: "加载中…",
      unavailable: "当前设置不可用（宿主未提供 cohub 配置命名空间）。",
      readOnly: "当前连接只读，无法修改设置。",
      conflicted: "设置已在其他位置更新，请放弃修改后重试。",
      failed: "保存失败，请重试。",
      retry: "重试",
      dirty: "有未保存的修改。",
      save: "保存",
      saving: "保存中…",
      saved: "已保存。",
      discard: "放弃修改",
      reset: "重置",
      customModel: "输入模型 ID",
      selectProviderFirst: "请先选择供应商",
      loadProvidersFailed: "模型供应商列表加载失败",
      emptyModel: "该供应商未提供模型目录",
      unavailableOption: "{value}（不可用）",
      reasoningEffort: "推理强度",
      effortInherit: "（继承父会话）",
      effortSelectModelFirst: "请先选择模型",
      effortUnsupported: "该模型不支持",
      effortUnsupportedOption: "{value}（当前模型不支持）",
      "skill.co-orchestrator": "调度编排",
      "skill.co-planner": "方案制定",
      "skill.co-oracle": "架构/代码审查",
      "skill.co-explorer": "搜索方案制定",
      "skill.co-librarian": "资料研究",
      "skill.co-observer": "视觉分析",
      "skill.co-fixer": "代码修改方案",
      "skill.co-designer": "UI/UX 设计",
      "skill.co-council": "多模型共识",
      "skill.co-rule-user": "用户规则",
      "skill.co-rule-project": "项目规则",
      "skill.co-rule-app": "应用规则",
      "skill.co-cordis": "Cordis 插件"
    };

    var en = {
      nav: "CoHub agents",
      title: "CoHub Agent Models",
      description: "Pick a provider and model for each specialist agent. Leave blank to inherit the parent model; stale config auto-resets.",
      provider: "Provider",
      model: "Model",
      configured: "Explicit",
      inherited: "Inherited",
      providerInherit: "(not set — inherit parent model)",
      modelInherit: "(inherit parent model)",
      loading: "Loading…",
      unavailable: "This setting is unavailable (the Host does not serve the cohub configuration namespace).",
      readOnly: "This connection is read-only; settings cannot be changed.",
      conflicted: "Settings changed elsewhere. Discard your edits and retry.",
      failed: "Save failed. Please retry.",
      retry: "Retry",
      dirty: "Unsaved changes.",
      save: "Save",
      saving: "Saving…",
      saved: "Saved.",
      discard: "Discard",
      reset: "Reset",
      customModel: "Enter model ID",
      selectProviderFirst: "Select a provider first",
      loadProvidersFailed: "Failed to load the provider catalog",
      emptyModel: "This provider publishes no model catalog",
      unavailableOption: "{value} (unavailable)",
      reasoningEffort: "Reasoning effort",
      effortInherit: "(inherit from parent session)",
      effortSelectModelFirst: "Select a model first",
      effortUnsupported: "Not supported by this model",
      effortUnsupportedOption: "{value} (unsupported by this model)",
      "skill.co-orchestrator": "Orchestrator",
      "skill.co-planner": "Planner",
      "skill.co-oracle": "Architecture/code review",
      "skill.co-explorer": "Codebase search",
      "skill.co-librarian": "Research",
      "skill.co-observer": "Visual analysis",
      "skill.co-fixer": "Implementation",
      "skill.co-designer": "UI/UX design",
      "skill.co-council": "Multi-model consensus",
      "skill.co-rule-user": "User rules",
      "skill.co-rule-project": "Project rules",
      "skill.co-rule-app": "App rules",
      "skill.co-cordis": "Cordis plugins"
    };

    /** 无 locale 服务时的最小翻译（防止 props.t 缺失导致页面白屏）。 */
    function fallbackTranslate(key, params) {
      var template = zh[key] !== undefined ? zh[key] : key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, function (match, name) {
        return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
      });
    }

    function messageOf(error) {
      if (!error) return "unknown error";
      if (typeof error === "string") return error;
      if (error.message) return error.message;
      return String(error);
    }

    function modelLabel(model) {
      var id = typeof model.id === "string" ? model.id : "";
      var name = typeof model.name === "string" ? model.name : "";
      return name !== "" && name !== id ? name + " (" + id + ")" : id;
    }

    function providerLabel(group) {
      var id = typeof group.id === "string" ? group.id : "";
      var name = typeof group.name === "string" ? group.name : "";
      return name !== "" && name !== id ? name + " (" + id + ")" : id;
    }

    /**
     * 从模型目录条目里抽出可选推理档位。
     * 契约（dsh-llm LlmModelReasoningInfo）：
     *   model.reasoning = { efforts: [{ id, name }], defaultEffort? }
     * 不支持的模型**整个 reasoning 字段缺失**（不是空数组）→ 返回空数组，调用方据此禁用控件。
     * @param model - modelCatalog() 的 groups[].models[] 单项（任意形状，逐项校验）。
     * @returns [{ id, label }]；label 优先取 effort.name，缺失时退回 id。
     */
    function reasoningEffortsOf(model) {
      var reasoning = model && typeof model === "object" ? model.reasoning : undefined;
      if (!reasoning || typeof reasoning !== "object") return [];
      var list = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
      var out = [];
      for (var i = 0; i < list.length; i += 1) {
        var effort = list[i];
        if (!effort || typeof effort !== "object") continue;
        var id = typeof effort.id === "string" ? effort.id : "";
        if (id === "") continue;
        var name = typeof effort.name === "string" ? effort.name : "";
        out.push({ id: id, label: name !== "" ? name : id });
      }
      return out;
    }

    /**
     * 行的推理强度归一为字符串（缺字段 / 非字符串都当空串 = 不配置，继承父会话）。
     * 注意不能用 row.reasoningEffort !== "" 直接判断：老数据没有该键，undefined !== "" 为真。
     */
    function effortOf(row) {
      return row && typeof row.reasoningEffort === "string" ? row.reasoningEffort : "";
    }

    /* ── 纯数据层：settings value.skills ↔ 编辑行 ─────────────────── */

    function emptyRow(name) {
      return { name: name, provider: "", model: "", reasoningEffort: "", extra: {} };
    }

    function copyRow(row) {
      var extra = {};
      for (var key in row.extra) {
        if (Object.prototype.hasOwnProperty.call(row.extra, key)) extra[key] = row.extra[key];
      }
      return {
        name: row.name,
        provider: row.provider,
        model: row.model,
        reasoningEffort: effortOf(row),
        extra: extra
      };
    }

    /**
     * 把 settings 里的 skills 数组转成编辑行。
     * 除 name/provider/model/reasoningEffort 之外的字段（maxTokens 等）原样收进 extra，写回时保留。
     * @param skills - configForms 快照里的 value.skills（任意形状，逐项校验）。
     * @returns 编辑行数组（顺序与存储顺序一致）。
     */
    function rowsFromSkills(skills) {
      var rows = [];
      if (!Array.isArray(skills)) return rows;
      for (var i = 0; i < skills.length; i += 1) {
        var entry = skills[i];
        if (!entry || typeof entry.name !== "string" || entry.name === "") continue;
        var extra = {};
        for (var key in entry) {
          if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
          // reasoningEffort 已提升为一等字段，不能再进 extra，否则写回时会重复/冲突。
          if (key === "name" || key === "provider" || key === "model" || key === "reasoningEffort") continue;
          extra[key] = entry[key];
        }
        rows.push({
          name: entry.name,
          provider: typeof entry.provider === "string" ? entry.provider : "",
          model: typeof entry.model === "string" ? entry.model : "",
          reasoningEffort: typeof entry.reasoningEffort === "string" ? entry.reasoningEffort : "",
          extra: extra
        });
      }
      return rows;
    }

    /**
     * 编辑行 → 待写入的 skills 数组。
     * 规则（第 1 条是正确性关键）：
     *   1. provider 为空 → 整行不写入（= 继承父模型）；否则 delegate 会拿空 provider 建路由。
     *   2. model 为空 → 不写 model 键（供应商默认模型），绝不写空字符串（否则 UNKNOWN_MODEL）。
     *   3. reasoningEffort 为空 → 不写该键（绝不写空串），继承父会话的推理强度。
     *   4. extra（maxTokens 等）与未知 skill 名原样保留，不静默丢配置。
     * @param rows - 编辑行数组。
     * @returns 可提交给 configForms.mutate 的 skills 数组。
     */
    function rowsToSkills(rows) {
      var out = [];
      if (!Array.isArray(rows)) return out;
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        if (!row || typeof row.name !== "string" || row.name === "") continue;
        var provider = typeof row.provider === "string" ? row.provider : "";
        if (provider === "") continue;
        var item = {};
        for (var key in row.extra) {
          if (!Object.prototype.hasOwnProperty.call(row.extra, key)) continue;
          if (key === "reasoningEffort") continue; // 以一等字段为准，不让 extra 覆盖/重复
          item[key] = row.extra[key];
        }
        item.name = row.name;
        item.provider = provider;
        var model = typeof row.model === "string" ? row.model : "";
        if (model !== "") item.model = model;
        var effort = effortOf(row);
        if (effort !== "") item.reasoningEffort = effort;
        out.push(item);
      }
      return out;
    }

    /** 已知 13 个代理按固定顺序，未知 skill 名按存储顺序追加（不丢用户配置）。 */
    function displayRows(stored) {
      var known = {};
      var unknown = [];
      for (var i = 0; i < stored.length; i += 1) {
        if (SKILL_NAMES.indexOf(stored[i].name) >= 0) known[stored[i].name] = stored[i];
        else unknown.push(stored[i]);
      }
      var rows = [];
      for (var j = 0; j < SKILL_NAMES.length; j += 1) {
        var name = SKILL_NAMES[j];
        rows.push(known[name] !== undefined ? known[name] : emptyRow(name));
      }
      for (var k = 0; k < unknown.length; k += 1) rows.push(unknown[k]);
      return rows;
    }

    /* ── 极简 observable store（uSES：快照未变必须返回同一引用） ──── */

    function createStateStore(initial) {
      var current = initial;
      var listeners = [];
      return {
        getSnapshot: function () {
          return current;
        },
        subscribe: function (listener) {
          listeners.push(listener);
          return function () {
            var index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          };
        },
        set: function (next) {
          if (next === current) return;
          current = next;
          var snapshot = listeners.slice();
          for (var i = 0; i < snapshot.length; i += 1) {
            try {
              snapshot[i]();
            } catch (error) {
              /* 单个订阅者异常不阻断其他订阅者 */
            }
          }
        }
      };
    }

    var EMPTY_STATE = Object.freeze({
      status: "loading",
      writable: false,
      dirty: false,
      conflicted: false,
      saving: false,
      saved: false,
      failed: false,
      rows: [],
      providers: [],
      modelsByProvider: {},
      // effortsByModel[provider][modelId] = [{ id, label }]；模型不支持推理强度时该键缺失。
      effortsByModel: {},
      catalogStatus: "loading",
      catalogError: ""
    });

    /**
     * 把 configForms 的一个 ConfigForm 与模型目录合成一个带草稿的页面控制器。
     * @param ctx - 客户端 cordis 上下文（remote / locale）。
     * @param scope - ctx.configForms.get(ENTRY_ID)，可能为 null（宿主未提供服务）。
     * @returns { store, start, dispose, editRow, resetRow, discard, save, loadCatalog }
     */
    function buildSkillsController(ctx, scope) {
      var store = createStateStore(null);

      var draft = null;               // { rows, revision }
      var conflicted = false;
      var saving = false;
      var saved = false;
      var failed = false;
      var disposed = false;

      var catalogStatus = "loading";
      var catalogError = "";
      var catalogProviders = [];
      var catalogByProvider = {};
      // effortsByModel[provider][modelId] = [{ id, label }]，与 modelsByProvider 同批构建。
      var catalogEfforts = {};
      var catalogGeneration = 0;

      var lastValue;
      var lastRows = [];
      var published = null;

      function readScope() {
        if (!scope || typeof scope.getSnapshot !== "function") {
          return { status: "unavailable", writable: false, value: undefined, revision: undefined };
        }
        try {
          var snapshot = scope.getSnapshot();
          return snapshot && typeof snapshot === "object" ? snapshot : { status: "loading", writable: false };
        } catch (error) {
          return { status: "unavailable", writable: false };
        }
      }

      function currentRows() {
        var snapshot = readScope();
        if (snapshot.value !== lastValue) {
          lastValue = snapshot.value;
          lastRows = displayRows(rowsFromSkills(snapshot.value && snapshot.value.skills));
        }
        return lastRows;
      }

      function buildState() {
        var snapshot = readScope();
        return {
          status: snapshot.status || "loading",
          writable: snapshot.status === "ready" && snapshot.writable === true,
          dirty: draft !== null,
          conflicted: conflicted,
          saving: saving,
          saved: saved,
          failed: failed,
          rows: draft !== null ? draft.rows : currentRows(),
          providers: catalogProviders,
          modelsByProvider: catalogByProvider,
          effortsByModel: catalogEfforts,
          catalogStatus: catalogStatus,
          catalogError: catalogError
        };
      }

      function sameState(left, right) {
        if (left === null || left === undefined || right === null || right === undefined) return false;
        return left.status === right.status
          && left.writable === right.writable
          && left.dirty === right.dirty
          && left.conflicted === right.conflicted
          && left.saving === right.saving
          && left.saved === right.saved
          && left.failed === right.failed
          && left.rows === right.rows
          && left.providers === right.providers
          && left.modelsByProvider === right.modelsByProvider
          && left.effortsByModel === right.effortsByModel
          && left.catalogStatus === right.catalogStatus
          && left.catalogError === right.catalogError;
      }

      function publish() {
        if (disposed) return;
        var next = buildState();
        if (sameState(published, next)) return;
        published = next;
        store.set(next);
      }

      function onScopeChange() {
        if (disposed) return;
        // 自己的写入进行中不做冲突判定：revision 变化正是本次写入引起的。
        if (!saving && draft !== null) {
          var snapshot = readScope();
          if (snapshot.revision !== draft.revision) conflicted = true;
        }
        publish();
      }

      function beginDraft() {
        if (draft !== null) return draft;
        var snapshot = readScope();
        var rows = [];
        var source = currentRows();
        for (var i = 0; i < source.length; i += 1) rows.push(copyRow(source[i]));
        draft = { rows: rows, revision: snapshot.revision };
        return draft;
      }

      function canEdit() {
        if (disposed || saving || conflicted) return false;
        var snapshot = readScope();
        return snapshot.status === "ready" && snapshot.writable === true;
      }

      /** 某 provider+model 支持的推理档位 id 列表（目录未就绪或模型不支持时为空数组）。 */
      function effortIdsFor(provider, model) {
        if (provider === "" || model === "") return [];
        var byModel = catalogEfforts[provider];
        if (!byModel) return [];
        var list = byModel[model];
        if (!Array.isArray(list)) return [];
        var ids = [];
        for (var i = 0; i < list.length; i += 1) ids.push(list[i].id);
        return ids;
      }

      /**
       * 换供应商/模型后，已选强度若不在新模型的档位里就清空（避免写出必然被宿主拒的配置：
       * delegate 侧对不支持的档位会 UNSUPPORTED_REASONING_EFFORT）。
       * 档位未知（目录未就绪 / 手填 model / 模型不支持）时也清空——此时无法证明该强度仍有效。
       */
      function reconcileEffort(provider, model, effort) {
        if (effort === "") return "";
        var ids = effortIdsFor(provider, model);
        return ids.indexOf(effort) >= 0 ? effort : "";
      }

      function editRow(name, field, value) {
        if (field !== "provider" && field !== "model" && field !== "reasoningEffort") return;
        if (!canEdit()) return;
        var current = beginDraft();
        var next = [];
        var changed = false;
        for (var i = 0; i < current.rows.length; i += 1) {
          var row = current.rows[i];
          if (row.name !== name) {
            next.push(row);
            continue;
          }
          if (field === "provider") {
            if (row.provider === value) {
              next.push(row);
              continue;
            }
            // 换供应商后旧 model 一定属于旧目录，留着只会写出失效路由；
            // 推理档位属于「供应商+模型」这一对，也一并清空。
            next.push({
              name: row.name,
              provider: value,
              model: "",
              reasoningEffort: "",
              extra: row.extra
            });
            changed = true;
          } else if (field === "model") {
            if (row.model === value) {
              next.push(row);
              continue;
            }
            next.push({
              name: row.name,
              provider: row.provider,
              model: value,
              reasoningEffort: reconcileEffort(row.provider, value, effortOf(row)),
              extra: row.extra
            });
            changed = true;
          } else {
            if (effortOf(row) === value) {
              next.push(row);
              continue;
            }
            next.push({
              name: row.name,
              provider: row.provider,
              model: row.model,
              reasoningEffort: value,
              extra: row.extra
            });
            changed = true;
          }
        }
        if (!changed) return;
        draft.rows = next;
        saved = false;
        failed = false;
        publish();
      }

      function resetRow(name) {
        if (!canEdit()) return;
        var current = beginDraft();
        var next = [];
        var changed = false;
        for (var i = 0; i < current.rows.length; i += 1) {
          var row = current.rows[i];
          if (row.name !== name) {
            next.push(row);
            continue;
          }
          if (row.provider === "" && row.model === "" && effortOf(row) === "") {
            next.push(row);
            continue;
          }
          // 只清 provider/model/reasoningEffort：maxTokens 等页面不展示的字段留着，
          // 避免重置后静默丢配置。
          next.push({
            name: row.name,
            provider: "",
            model: "",
            reasoningEffort: "",
            extra: row.extra
          });
          changed = true;
        }
        if (!changed) return;
        draft.rows = next;
        saved = false;
        failed = false;
        publish();
      }

      function discard() {
        if (saving) return;
        draft = null;
        conflicted = false;
        saved = false;
        failed = false;
        publish();
      }

      function save() {
        if (disposed || saving || draft === null) return Promise.resolve(false);
        var snapshot = readScope();
        if (snapshot.status !== "ready" || snapshot.writable !== true || conflicted) return Promise.resolve(false);
        if (draft.revision !== undefined && snapshot.revision !== draft.revision) {
          conflicted = true;
          publish();
          return Promise.resolve(false);
        }
        var expected = draft.revision;
        var next = rowsToSkills(draft.rows);
        saving = true;
        saved = false;
        failed = false;
        publish();
        var request;
        try {
          request = scope.mutate([{ op: "set", path: ["skills"], value: next }], expected);
        } catch (error) {
          saving = false;
          failed = true;
          publish();
          return Promise.resolve(false);
        }
        return Promise.resolve(request).then(function (accepted) {
          if (disposed) return false;
          saving = false;
          if (accepted === true) {
            draft = null;
            conflicted = false;
            failed = false;
            saved = true;
            lastValue = undefined;
          } else {
            failed = true;
          }
          publish();
          return accepted === true;
        }, function () {
          if (disposed) return false;
          saving = false;
          failed = true;
          publish();
          return false;
        });
      }

      function loadCatalog() {
        catalogGeneration += 1;
        var generation = catalogGeneration;
        catalogStatus = "loading";
        catalogError = "";
        publish();

        var remote = ctx && ctx.remote;
        var request;
        try {
          if (!remote || !remote.session || typeof remote.session.modelCatalog !== "function") {
            throw new Error("remote.session.modelCatalog is unavailable");
          }
          request = remote.session.modelCatalog();
        } catch (error) {
          catalogStatus = "error";
          catalogError = messageOf(error);
          publish();
          return;
        }

        Promise.resolve(request).then(function (response) {
          if (disposed || generation !== catalogGeneration) return;
          if (!response || response.ok !== true) {
            catalogStatus = "error";
            catalogError = response && response.error ? messageOf(response.error) : "modelCatalog failed";
            publish();
            return;
          }
          var groups = response.value && Array.isArray(response.value.groups) ? response.value.groups : [];
          var providers = [];
          var byProvider = {};
          var effortsByModel = {};
          for (var i = 0; i < groups.length; i += 1) {
            var group = groups[i];
            if (!group || typeof group.id !== "string" || group.id === "") continue;
            var models = [];
            var effortsForProvider = {};
            var list = Array.isArray(group.models) ? group.models : [];
            for (var j = 0; j < list.length; j += 1) {
              var model = list[j];
              if (!model || typeof model.id !== "string" || model.id === "") continue;
              models.push({ id: model.id, label: modelLabel(model) });
              // 不支持推理强度的模型整个 reasoning 字段缺失 → reasoningEffortsOf 返回空数组，
              // 这里只在非空时登记，渲染层用「查不到 = 不支持」判定。
              var efforts = reasoningEffortsOf(model);
              if (efforts.length > 0) effortsForProvider[model.id] = efforts;
            }
            byProvider[group.id] = models;
            if (Object.keys(effortsForProvider).length > 0) effortsByModel[group.id] = effortsForProvider;
            providers.push({ id: group.id, label: providerLabel(group) });
          }
          providers.sort(function (left, right) {
            if (left.id === right.id) return 0;
            return left.id < right.id ? -1 : 1;
          });
          catalogProviders = providers;
          catalogByProvider = byProvider;
          catalogEfforts = effortsByModel;
          catalogStatus = "ready";
          catalogError = "";
          publish();
        }, function (error) {
          if (disposed || generation !== catalogGeneration) return;
          catalogStatus = "error";
          catalogError = messageOf(error);
          publish();
        });
      }

      function start() {
        var disposers = [];
        if (scope && typeof scope.subscribe === "function") {
          var offScope = scope.subscribe(onScopeChange);
          if (typeof offScope === "function") disposers.push(offScope);
        }
        var remote = ctx && ctx.remote;
        if (remote && typeof remote.$on === "function") {
          try {
            var offCatalog = remote.$on("llm/adapters-updated", function () {
              loadCatalog();
            });
            if (typeof offCatalog === "function") disposers.push(offCatalog);
          } catch (error) {
            /* 事件订阅失败只影响目录自动刷新，不阻断页面 */
          }
        }
        publish();
        loadCatalog();
        return function () {
          disposed = true;
          var snapshot = disposers;
          disposers = [];
          for (var i = 0; i < snapshot.length; i += 1) {
            try {
              snapshot[i]();
            } catch (error) {
              /* dispose 失败不影响其余清理 */
            }
          }
        };
      }

      publish();

      return {
        store: store,
        start: start,
        editRow: editRow,
        resetRow: resetRow,
        discard: discard,
        save: save,
        loadCatalog: loadCatalog
      };
    }

    /* ── 样式（复用官方 ---dsw-alias-* token，深浅色自动跟随） ─────── */

    function installCss() {
      if (typeof document === "undefined") return;
      var tagId = "dsh-cohub/cohub-section.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      var css = [
        ".cohub-section{max-width:820px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);}",
        ".cohub-title{margin:0;font-size:16px;font-weight:600;line-height:24px;}",
        ".cohub-desc{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px;}",
        ".cohub-notice{margin:0;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);}",
        ".cohub-notice-error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}",
        ".cohub-notice-warn{color:var(--dsw-alias-state-warning-primary,#8d6e00);}",
        ".cohub-notice-ok{color:var(--dsw-alias-state-success-primary);}",
        ".cohub-rows{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;}",
        ".cohub-row{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2);}",
        ".cohub-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".cohub-row-name{font-size:13px;font-weight:600;line-height:20px;}",
        ".cohub-row-id{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}",
        ".cohub-badge{margin-left:auto;border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;white-space:nowrap;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);}",
        ".cohub-badge-explicit{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}",
        // 四列：供应商 / 模型 / 推理强度 / 重置。三列下拉都等分剩余宽度，重置按钮自适应。
        ".cohub-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) auto;gap:8px;margin-top:8px;align-items:end;}",
        // 窄容器下 4 列会把下拉压到不可读：退成两列（前三个字段各占一行两列，按钮贴右下）。
        "@media (max-width:560px){.cohub-fields{grid-template-columns:minmax(0,1fr) minmax(0,1fr);}}",
        ".cohub-field{display:flex;flex-direction:column;gap:4px;min-width:0;}",
        ".cohub-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}",
        ".cohub-select,.cohub-input{box-sizing:border-box;width:100%;height:32px;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;font-size:13px;line-height:20px;}",
        ".cohub-select:focus-visible,.cohub-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none;}",
        ".cohub-select:disabled,.cohub-input:disabled{opacity:.6;cursor:default;}",
        ".cohub-row-reset{height:32px;border-radius:8px;padding:0 10px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);}",
        ".cohub-row-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary);}",
        ".cohub-row-reset:disabled{opacity:.45;cursor:default;}",
        ".cohub-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".cohub-status{margin:0;margin-right:auto;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
        ".cohub-status-error{color:var(--dsw-alias-state-error-primary);}",
        ".cohub-status-warn{color:var(--dsw-alias-state-warning-primary,#8d6e00);}",
        ".cohub-status-ok{color:var(--dsw-alias-state-success-primary);}",
        ".cohub-button{height:32px;font:inherit;cursor:pointer;border-radius:8px;padding:0 14px;font-size:13px;line-height:20px;}",
        ".cohub-button-primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border:none;}",
        ".cohub-button-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}",
        ".cohub-button-ghost{color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);}",
        ".cohub-button-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);}",
        ".cohub-button:disabled{opacity:.45;cursor:default;}"
      ].join("\n");
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-cohub";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    /* ── 组件 ─────────────────────────────────────────────────────── */

    /** uSES 选择器：整个快照。 */
    function selectAllSnapshot(value) {
      return value;
    }

    /** props.useCohubSkills 缺失时的常量 hook（保持 hook 调用顺序稳定）。 */
    function useStaticState(selector) {
      return selector(EMPTY_STATE);
    }

    /**
     * settings.section 页面。
     * @param props - 注入面：hooks.cohubSkills→useCohubSkills、动作、locale 提供的 t。
     * @returns 每个代理一行（供应商下拉 + 模型下拉/手填 + 推理强度下拉 + 重置）与保存/放弃。
     */
    function CohubSection(props) {
      var t = typeof props.t === "function" ? props.t : fallbackTranslate;
      var useSkills = typeof props.useCohubSkills === "function" ? props.useCohubSkills : useStaticState;
      var state = useSkills(selectAllSnapshot) || EMPTY_STATE;

      var header = [
        React.createElement("h2", { key: "title", className: "cohub-title" }, t("title")),
        React.createElement("p", { key: "desc", className: "cohub-desc" }, t("description"))
      ];

      if (state.status !== "ready") {
        return React.createElement("div", { className: "cohub-section" },
          header,
          React.createElement("p", { className: "cohub-notice" },
            state.status === "unavailable" ? t("unavailable") : t("loading"))
        );
      }

      var locked = !state.writable || state.saving || state.conflicted;
      var providers = state.providers || [];
      var modelsByProvider = state.modelsByProvider || {};
      var rows = state.rows || [];

      function renderRow(row) {
        var known = SKILL_NAMES.indexOf(row.name) >= 0;
        var label = known ? t("skill." + row.name) : row.name;
        var providerIds = [];
        var providerOptions = [
          React.createElement("option", { key: "__inherit", value: "" }, t("providerInherit"))
        ];
        for (var i = 0; i < providers.length; i += 1) {
          providerIds.push(providers[i].id);
          providerOptions.push(React.createElement("option", { key: providers[i].id, value: providers[i].id }, providers[i].label));
        }
        if (row.provider !== "" && providerIds.indexOf(row.provider) < 0) {
          // 已存但当前目录里没有：给一个不可选回显项，避免下拉显示成第一项造成误读。
          providerOptions.push(React.createElement("option", {
            key: "__missing-provider",
            value: row.provider,
            disabled: true
          }, state.catalogStatus === "ready" ? t("unavailableOption", { value: row.provider }) : row.provider));
        }

        var models = modelsByProvider[row.provider] || [];
        var modelControl;
        if (row.provider === "") {
          modelControl = React.createElement("select", { className: "cohub-select", value: "", disabled: true },
            React.createElement("option", { value: "" }, t("selectProviderFirst")));
        } else if (state.catalogStatus === "loading") {
          modelControl = React.createElement("select", { className: "cohub-select", value: "", disabled: true },
            React.createElement("option", { value: "" }, t("loading")));
        } else if (models.length > 0) {
          // 未保存 model 时必须插入 value="" 的占位项。否则 <select value=""> 会被浏览器
          // 渲染成列表第一项，用户以为已选、实际存的仍是空 → 子代理拿不到模型（UNKNOWN_MODEL）。
          var modelOptions = [React.createElement("option", { key: "__inherit", value: "" }, t("modelInherit"))];
          var modelIds = [];
          for (var m = 0; m < models.length; m += 1) {
            modelIds.push(models[m].id);
            modelOptions.push(React.createElement("option", { key: models[m].id, value: models[m].id }, models[m].label));
          }
          if (row.model !== "" && modelIds.indexOf(row.model) < 0) {
            modelOptions.push(React.createElement("option", {
              key: "__missing-model",
              value: row.model,
              disabled: true
            }, t("unavailableOption", { value: row.model })));
          }
          modelControl = React.createElement("select", {
            className: "cohub-select",
            value: row.model === "" ? "" : row.model,
            disabled: locked,
            "aria-label": label + " · " + t("model"),
            onChange: function (event) {
              props.editRow(row.name, "model", event.target.value);
            }
          }, modelOptions);
        } else {
          // 该供应商没有可用模型目录（或目录加载失败）→ 降级为手填 model id。
          modelControl = React.createElement("input", {
            className: "cohub-input",
            type: "text",
            value: row.model,
            disabled: locked,
            "aria-label": label + " · " + t("model"),
            placeholder: state.catalogStatus === "ready" ? t("emptyModel") + " / " + t("customModel") : t("customModel"),
            onChange: function (event) {
              props.editRow(row.name, "model", event.target.value);
            }
          });
        }

        var configured = row.provider !== "" || row.model !== "" || effortOf(row) !== "";

        // 第三个下拉：推理强度。档位来自模型目录（models[].reasoning.efforts），
        // 按「供应商 + 模型」这一对查表；不支持的模型整个 reasoning 字段缺失 → 禁用并提示。
        var currentEffort = effortOf(row);
        var efforts = [];
        if (row.provider !== "" && row.model !== "") {
          var byModel = state.effortsByModel && state.effortsByModel[row.provider];
          var list = byModel ? byModel[row.model] : undefined;
          if (Array.isArray(list)) efforts = list;
        }
        var effortControl;
        if (row.provider === "") {
          effortControl = React.createElement("select", { className: "cohub-select", value: "", disabled: true },
            React.createElement("option", { value: "" }, t("selectProviderFirst")));
        } else if (state.catalogStatus === "loading") {
          effortControl = React.createElement("select", { className: "cohub-select", value: "", disabled: true },
            React.createElement("option", { value: "" }, t("loading")));
        } else if (row.model === "") {
          effortControl = React.createElement("select", { className: "cohub-select", value: "", disabled: true },
            React.createElement("option", { value: "" }, t("effortSelectModelFirst")));
        } else if (efforts.length === 0) {
          // 模型目录里没有该模型的 reasoning 信息（或手填了不在目录里的 model id）→ 不支持。
          effortControl = React.createElement("select", { className: "cohub-select", value: "", disabled: true },
            React.createElement("option", { value: "" }, t("effortUnsupported")));
        } else {
          // 与模型下拉同理：value="" 的继承占位项必须在首位，否则浏览器把第一档显示成已选，
          // 而实际存的是空串（用户以为配了 high，其实继承父会话）。
          var effortOptions = [React.createElement("option", { key: "__inherit", value: "" }, t("effortInherit"))];
          var effortIds = [];
          for (var e = 0; e < efforts.length; e += 1) {
            effortIds.push(efforts[e].id);
            effortOptions.push(React.createElement("option", { key: efforts[e].id, value: efforts[e].id }, efforts[e].label));
          }
          if (currentEffort !== "" && effortIds.indexOf(currentEffort) < 0) {
            // 已配强度不在当前模型档位里（手改过 YAML / 换过模型）→ 给不可选回显项，别静默改成第一档。
            effortOptions.push(React.createElement("option", {
              key: "__missing-effort",
              value: currentEffort,
              disabled: true
            }, t("effortUnsupportedOption", { value: currentEffort })));
          }
          effortControl = React.createElement("select", {
            className: "cohub-select",
            value: currentEffort,
            disabled: locked,
            "aria-label": label + " · " + t("reasoningEffort"),
            onChange: function (event) {
              props.editRow(row.name, "reasoningEffort", event.target.value);
            }
          }, effortOptions);
        }

        return React.createElement("li", { key: row.name, className: "cohub-row" },
          React.createElement("div", { className: "cohub-row-head" },
            React.createElement("span", { className: "cohub-row-name" }, label),
            React.createElement("span", { className: "cohub-row-id" }, row.name),
            React.createElement("span", {
              className: configured ? "cohub-badge cohub-badge-explicit" : "cohub-badge"
            }, configured ? t("configured") : t("inherited"))
          ),
          React.createElement("div", { className: "cohub-fields" },
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("provider")),
              React.createElement("select", {
                className: "cohub-select",
                value: row.provider,
                disabled: locked,
                "aria-label": label + " · " + t("provider"),
                onChange: function (event) {
                  props.editRow(row.name, "provider", event.target.value);
                }
              }, providerOptions)
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("model")),
              modelControl
            ),
            React.createElement("div", { className: "cohub-field" },
              React.createElement("label", { className: "cohub-label" }, t("reasoningEffort")),
              effortControl
            ),
            React.createElement("button", {
              type: "button",
              className: "cohub-row-reset",
              disabled: locked || !configured,
              onClick: function () {
                props.resetRow(row.name);
              }
            }, t("reset"))
          )
        );
      }

      var items = [];
      for (var i = 0; i < rows.length; i += 1) items.push(renderRow(rows[i]));

      var status = null;
      var statusClass = "cohub-status";
      if (state.conflicted) {
        status = t("conflicted");
        statusClass += " cohub-status-warn";
      } else if (state.failed) {
        status = t("failed");
        statusClass += " cohub-status-error";
      } else if (state.saved) {
        status = t("saved");
        statusClass += " cohub-status-ok";
      } else if (state.dirty) {
        status = t("dirty");
      } else if (!state.writable) {
        status = t("readOnly");
      }

      return React.createElement("div", { className: "cohub-section" },
        header,
        !state.writable ? React.createElement("p", { className: "cohub-notice" }, t("readOnly")) : null,
        state.catalogStatus === "error"
          ? React.createElement("p", { className: "cohub-notice cohub-notice-error" },
            t("loadProvidersFailed") + (state.catalogError ? ": " + state.catalogError : ""),
            React.createElement("button", {
              type: "button",
              className: "cohub-row-reset",
              style: { marginLeft: "8px" },
              onClick: function () {
                props.retryCatalog();
              }
            }, t("retry")))
          : null,
        state.conflicted
          ? React.createElement("p", { className: "cohub-notice cohub-notice-warn" }, t("conflicted"))
          : null,
        React.createElement("ul", { className: "cohub-rows" }, items),
        React.createElement("div", { className: "cohub-actions" },
          status !== null ? React.createElement("p", { className: statusClass }, status) : null,
          React.createElement("button", {
            type: "button",
            className: "cohub-button cohub-button-ghost",
            disabled: !state.dirty || state.saving,
            onClick: function () {
              props.discard();
            }
          }, t("discard")),
          React.createElement("button", {
            type: "button",
            className: "cohub-button cohub-button-primary",
            disabled: !state.dirty || !state.writable || state.saving || state.conflicted,
            onClick: function () {
              props.save();
            }
          }, t(state.saving ? "saving" : "save"))
        )
      );
    }

    /* ── 插件体 ───────────────────────────────────────────────────── */

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "cohub: settings dictionaries");

      installCss();

      var scope = null;
      if (ctx.configForms && typeof ctx.configForms.get === "function") {
        try {
          scope = ctx.configForms.get(ENTRY_ID) || null;
        } catch (error) {
          scope = null;
        }
      }

      var controller = buildSkillsController(ctx, scope);

      ctx.effect(function () {
        return controller.start();
      }, "cohub: agent model settings wiring");

      var injected = function () {
        return {
          hooks: { cohubSkills: controller.store },
          editRow: function (name, field, value) {
            controller.editRow(name, field, value);
          },
          resetRow: function (name) {
            controller.resetRow(name);
          },
          discard: function () {
            controller.discard();
          },
          save: function () {
            return controller.save();
          },
          retryCatalog: function () {
            controller.loadCatalog();
          }
        };
      };

      // settings.section 的 label 是 thunk：宿主每次投影导航都重读，跟随语言切换。
      var navLabel = function () {
        return ctx.locale.bind(NS)("nav");
      };

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: ENTRY_ID,
          order: SECTION_ORDER,
          label: navLabel,
          locale: NS,
          inject: injected
        }, CohubSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    // 纯函数契约（仅 test/client-runtime-0.2.ts 断言用；宿主不读）。
    exports.__internals = {
      rowsFromSkills: rowsFromSkills,
      rowsToSkills: rowsToSkills,
      reasoningEffortsOf: reasoningEffortsOf
    };
    return module.exports;
  }
});
