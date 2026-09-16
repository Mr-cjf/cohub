// dsh-port/src/co-cordis-plugin.ts —— Cordis 运行时工具插件（零冲突：只消费，不注册）
//
// 提供 7 个 co_* 工具，与 @deepseek-ai/dsh-tool-cordis 的 cordis_* 功能等价，
// 但**不调用 ctx.cordisInspect.register()**（那行才是进程单例冲突的根源）。
//
// 只挂在 cohub-cordis preset 里；co-orchestrator preset 不挂。
// co-cordis 子代理（delegate 委派）继承父 preset 的工具面，因此在 cohub-cordis
// 会话里的子代理也能看到并调用这些工具；在 co-orchestrator 会话里的子代理则不能。

import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "co-cordis-plugin";
export const inject = ["tools", "cordisInspect", "dynamicCordisRunner"];

function requireAgent(exec) {
  if (exec.agent === void 0) throw new Error("co-cordis 工具需要 Agent 支持的会话");
  return exec.agent;
}

export function apply(ctx) {
  // ── co_inspect_list ──────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "co_inspect_list",
    description: "列出 Host 端所有已知的 Cordis Inspect Provider，包含它们的平台、目的、方法名与输入/输出 schema。调用此工具后再用 co_inspect_query 查具体定义。",
    parameters: {},
    output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute() {
      return Promise.resolve({ providers: ctx.cordisInspect.list() });
    },
  }));

  // ── co_inspect_query ─────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "co_inspect_query",
    description: "按 platform + provider + method 查一个 Inspect Provider 的具体结构化定义。platform 和 provider 必须来自 co_inspect_list 的返回结果。输入格式必须满足该 method 的 inputSchema。Host 查询在本地执行。此工具只读，不能调用业务 Service 方法或修改运行时。",
    parameters: {
      platform: { type: "string", required: true, enum: ["host", "client"], description: "Provider 所属运行时平台" },
      provider: { type: "string", required: true, description: "Provider ID（来自 co_inspect_list）" },
      method: { type: "string", required: true, description: "方法名（来自 co_inspect_list）" },
      input: { type: "json", description: "查询输入（可选）；必须满足该方法的 inputSchema" },
    },
    output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const data = await ctx.cordisInspect.query(args.platform, args.provider, args.method, args.input, agent, exec.signal);
      return { platform: args.platform, provider: args.provider, method: args.method, data };
    },
  }));

  // ── co_inspect_self ─────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "co_inspect_self",
    description: "查当前会话通过 co_define / co_run 管理的动态 Cordis 插件清单。无参数时列出所有插件摘要；传入 pluginId 时返回该插件的简要状态与包列表；同时传入 pluginId + packageId 时返回该不可变包的具体源码与运行时诊断。",
    parameters: {
      pluginId: { type: "string", description: "插件 ID（省略时列出全部）；必须与 packageId 同时传入才能查具体包" },
      packageId: { type: "string", description: "包的不可变 ID；需要 pluginId 一起传入" },
    },
    output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    execute(args, exec) {
      const agent = requireAgent(exec);
      if (args.packageId !== void 0 && args.pluginId === void 0) throw new Error("co_inspect_self: packageId 需要 pluginId 一起传入");
      if (args.pluginId === void 0) {
        return Promise.resolve({
          mode: "plugins",
          plugins: ctx.dynamicCordisRunner.listPlugins(agent).map((ref) => ({
            pluginId: String(ref.pluginId),
            name: ref.name,
            purpose: ref.purpose,
            status: ref.status,
            currentPackageId: String(ref.currentPackageId),
            nextPackageId: ref.nextPackageId !== void 0 ? String(ref.nextPackageId) : void 0,
          })),
        });
      }
      const plugin = ctx.dynamicCordisRunner.inspectPlugin(agent, args.pluginId);
      if (args.packageId === void 0) {
        return Promise.resolve({
          mode: "plugin",
          pluginId: String(plugin.pluginId),
          name: plugin.name,
          purpose: plugin.purpose,
          status: plugin.status,
          packages: plugin.packages.map((pkg) => ({
            packageId: String(pkg.packageId),
            isCurrent: pkg.packageId === plugin.currentPackageId,
            isNext: pkg.packageId === plugin.nextPackageId,
          })),
        });
      }
      const pkg = ctx.dynamicCordisRunner.inspectPackage(agent, args.pluginId, args.packageId);
      return Promise.resolve({
        mode: "package",
        packageId: String(pkg.packageId),
        name: pkg.name,
        purpose: pkg.purpose,
        source: pkg.source,
        diagnostics: pkg.diagnostics,
      });
    },
  }));

  // ── co_define ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "co_define",
    description: "定义一个不可变的 Cordis Package。新建 Plugin 用 kind:'new'（提供 3-6 个小写字母前缀）；给已有 Plugin 追加用 kind:'existing'。至少提供 code.host 和 code.client 其中之一。每个 value 是一个返回 Cordis Plugin 的纯 JavaScript 函数体；无 TypeScript/JSX。定义完成后再用 co_run 激活。",
    parameters: {
      plugin: {
        required: true,
        oneOf: [{
          type: "object", additionalProperties: false,
          properties: { kind: { type: "string", const: "new", required: true }, idPrefix: { type: "string", required: true, description: "3-6 个小写字母语义前缀" } },
        }, {
          type: "object", additionalProperties: false,
          properties: { kind: { type: "string", const: "existing", required: true }, pluginId: { type: "string", required: true, description: "已有 Plugin 的精确 ID" } },
        }],
      },
      name: { type: "string", required: true, description: "简短可读的包名" },
      purpose: { type: "string", required: true, description: "一句话用途说明" },
      code: {
        type: "object", additionalProperties: false, required: true,
        properties: {
          host: { type: "string", description: "返回 Host 端 Cordis Plugin 的 JS 函数体" },
          client: { type: "string", description: "返回 Client（浏览器）端 Cordis Plugin 的 JS 函数体" },
        },
      },
    },
    output: {
      schema: { type: "object", properties: { pluginId: { type: "string", required: true }, packageId: { type: "string", required: true }, name: { type: "string", required: true }, purpose: { type: "string", required: true }, hasHostHalf: { type: "boolean" }, hasClientHalf: { type: "boolean" } }, additionalProperties: false },
      render: (_a, v) => [{ type: "text", text: `已定义 ${v.pluginId}/${v.packageId} (${v.name})；尚未运行，用 co_run 激活。` }],
    },
    execute(args, _exec) {
      const plugin = args.plugin.kind === "new"
        ? { kind: "new", idPrefix: args.plugin.idPrefix }
        : { kind: "existing", pluginId: args.plugin.pluginId };
      const receipt = ctx.dynamicCordisRunner.define({
        sessionId: requireAgent(_exec).id,
        plugin,
        name: args.name,
        purpose: args.purpose,
        code: {
          ...args.code.host === void 0 ? {} : { host: args.code.host },
          ...args.code.client === void 0 ? {} : { client: args.code.client },
        },
      });
      return Promise.resolve({
        pluginId: String(receipt.pluginId),
        packageId: String(receipt.packageId),
        name: receipt.name,
        purpose: receipt.purpose,
        hasHostHalf: receipt.hasHostHalf,
        hasClientHalf: receipt.hasClientHalf,
      });
    },
  }));

  // ── co_run ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "co_run",
    description: "激活一个动态插件。首次激活或重启用 mode:'run'；切换到同一 Plugin 下的另一个已定义 Package 用 mode:'update'。Client 端激活可能需要用户审批（返回 awaiting-approval）；Host 端激活成功后返回 running。",
    parameters: {
      pluginId: { type: "string", required: true, description: "Plugin ID（来自 co_define 的返回）" },
      packageId: { type: "string", required: true, description: "Package ID（来自 co_define 的返回）" },
      mode: { type: "string", required: true, enum: ["run", "update"], description: "run=首次/重启/回滚；update=切换到同一 Plugin 不同版本" },
    },
    output: { schema: { type: "json" }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v, null, 2) }] },
    async execute(args, exec) {
      const agent = requireAgent(exec);
      const receipt = await ctx.dynamicCordisRunner.run(agent, args.pluginId, args.packageId, args.mode, exec.signal);
      if (!receipt.ok) throw new Error(receipt.message);
      return {
        status: receipt.status,
        pluginId: args.pluginId,
        packageId: args.packageId,
        pluginRunId: String(receipt.pluginRunId),
        mode: receipt.mode,
        ...receipt.currentPackageId === void 0 ? {} : { currentPackageId: String(receipt.currentPackageId) },
        nextPackageId: String(receipt.nextPackageId),
        ...receipt.hostStatus === void 0 ? {} : { hostStatus: receipt.hostStatus },
      };
    },
  }));

  // ── co_stop ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "co_stop",
    description: "停止一个正在运行的动态 Plugin。保留其定义、版本指针与审批记录，可以后续用 co_run 重新激活或回滚。要彻底删除用 co_remove。",
    parameters: { pluginId: { type: "string", required: true, description: "要停止的 Plugin ID" } },
    output: { schema: { type: "object", properties: { stopped: { type: "boolean" } }, additionalProperties: false } },
    async execute(args, exec) {
      await ctx.dynamicCordisRunner.stop(requireAgent(exec), args.pluginId);
      return { stopped: true };
    },
  }));

  // ── co_remove ────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: "co_remove",
    description: "彻底删除一个动态 Plugin：先停止运行、取消审批请求，然后删除所有版本与授权。执行后其 pluginId、packageId 和 @ 引用全部失效。要保留版本以便重新激活用 co_stop。",
    parameters: { pluginId: { type: "string", required: true, description: "要彻底删除的 Plugin ID" } },
    output: { schema: { type: "object", properties: { removed: { type: "boolean" } }, additionalProperties: false } },
    async execute(args, exec) {
      await ctx.dynamicCordisRunner.undefine(requireAgent(exec), args.pluginId);
      return { removed: true };
    },
  }));
}