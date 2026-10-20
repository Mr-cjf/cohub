# 子代理模型配置

本参考是模型配置入口。配置优先级、字段合并、工具能力校验、每批一次解析、原生 spawn 参数和失败处理均以[效率规范](efficiency.md)为唯一规则源；角色指令仍以各 `skills/co-*/SKILL.md` 为准。

## 配置

角色设置使用 `subagents.defaults` 与 `subagents.roles.<role>` 中的 `model`、`reasoning_effort` 字段。合并规则及旧配置处理见[效率规范](efficiency.md)；配置结构示例见[示例配置](../../../config/cohub.example.json)。

```json
{
  "subagents": {
    "defaults": {
      "model": null,
      "reasoning_effort": null
    },
    "roles": {
      "co-explorer": {
        "model": null,
        "reasoning_effort": null
      },
      "co-oracle": {
        "model": null,
        "reasoning_effort": null
      }
    }
  }
}
```

模型选择必须通过当前原生工具能力校验；没有有效覆盖时保留原生继承。完整约束以[效率规范](efficiency.md)为准。

## 部署映射（参考）

每个模型一律使用其自身支持的最高档推理强度（`ultra` 或 `max`），不存在跨模型统一的最高档；`ccs-minimax/MiniMax-M3` 无 `medium` 档。

| 角色 | model | effort |
|------|-------|--------|
| co-orchestrator | gpt-6.1-sol | ultra |
| co-planner | gpt-6-astra | ultra |
| co-oracle | gpt-6-astra | ultra |
| co-librarian | gpt-6-luna | max |
| co-explorer | gpt-6-luna | max |
| co-designer | gpt-6-luna | max |
| co-fixer | gpt-6-luna | max |
| co-observer | gpt-6-luna | max |
| co-council | gpt-6-astra | ultra |
| co-rule-user | ccs-minimax/MiniMax-M3.1-Flash | max |
| co-rule-project | ccs-minimax/MiniMax-M3 | ultra |
| co-rule-app | ccs-minimax/MiniMax-M3 | ultra |

## Resolver

Resolver 只解析和校验参数，不会启动代理。插件包目录中的调用示例：

```sh
npm run resolve:agents -- --roles co-explorer,co-oracle --cwd . --capabilities runtime-caps.json
```

覆盖、能力输入和真实原生派发流程统一见[效率规范](efficiency.md)及 [`scripts/resolve-agents.mjs`](../../../scripts/resolve-agents.mjs)。
