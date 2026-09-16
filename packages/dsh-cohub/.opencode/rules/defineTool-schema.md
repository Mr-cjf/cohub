# defineTool Schema DSL 约束

`@deepseek-ai/dsh-tools` 的 `defineTool` 使用一套**精简的 Value Schema DSL**，与完整 JSON Schema 有显著差异。
违反 DSL 约束会导致 DSH 启动时 `plugin tree failed to load`，且 `bun build` 不报错。

## 硬性规则

### 1. `required: false` 禁止使用

```typescript
// ❌ 错误：DSL 不支持 required: false
parameters: {
  skill: { type: "string", required: false },
}

// ✅ 正确：默认可选，无需标记
parameters: {
  skill: { type: "string" },
}
```

### 2. `items` 内部禁止 `required` 数组

```typescript
// ❌ 错误：items 内部不支持 required 数组
parameters: {
  tasks: {
    type: "array",
    items: {
      type: "object",
      properties: { skill: { type: "string" }, prompt: { type: "string" } },
      required: ["skill", "prompt"],  // ✘ 不被 DSL 支持
    },
  },
}

// ✅ 正确：在 description 中说明必填，execute 中运行时检查
parameters: {
  tasks: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        skill: { type: "string", description: "必填，专职代理技能名" },
        prompt: { type: "string", description: "必填，具体任务描述" },
      },
    },
  },
}
```

### 3. `type: "object"` 必须显式声明 `additionalProperties`

```typescript
// ❌ 错误：缺少 additionalProperties
items: {
  type: "object",
  properties: { ... },
}

// ✅ 正确：显式声明 true（允许额外属性）或 false（禁止额外属性）
items: {
  type: "object",
  additionalProperties: false,
  properties: { ... },
}
```

### 4. 顶层参数支持 `required: true` 逐属性标记

```typescript
// ✅ 正确：顶层参数支持逐属性 required: true
parameters: {
  prompt: { type: "string", required: true },
  skill:  { type: "string" },  // 默认可选
}
```

### 5. `type: "array"` 必须配套 `items`

```typescript
// ✅ 正确：array 类型必须有 items
parameters: {
  tasks: {
    type: "array",
    items: { type: "object", additionalProperties: false, properties: { ... } },
  },
}
```

## 验证清单

每次修改 `defineTool` 的 `parameters` 后，必须逐条检查：

- [ ] 是否存在 `required: false`？ → 删除
- [ ] `items` 内部是否有 `required` 数组？ → 删除，改 description 说明
- [ ] `type: "object"` 是否有 `additionalProperties`？ → 补上 `true` 或 `false`
- [ ] 顶层 `required: true` 是否只出现在属性级？ → 合法
- [ ] `type: "array"` 是否有配套 `items`？ → 补上

## 参考

- `@deepseek-ai/dsh-tools` 的 `ValueSchemaSpec` 类型定义
- 错误特征：DSH 启动时 `JsonSchemaError` + `plugin tree failed to load`