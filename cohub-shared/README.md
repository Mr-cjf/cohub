# cohub-shared

跨包共享的单一真源目录。四个零平台依赖的纯逻辑模块集中维护在此，通过同步脚本复制到三个平台包。

## 原则

- **编辑源**：只改 `cohub-shared/src/`（手动维护的唯一真源）
- **不要编辑生成物**：`packages/*/src/shared/` 下的同名文件由 `bun cohub-shared/sync.ts` 生成，直接修改会在下次同步时被覆盖

## 共享模块

| 文件 | 导出符号 | 说明 |
|------|----------|------|
| `src/model.ts` | `shortModelLabel` | "provider/model" → "model" 展示短名 |
| `src/chinese.ts` | `CHINESE_LANGUAGE_INSTRUCTION` | 中文语言要求指令 |
| `src/fs-json.ts` | `readJsonFileSafe<T>` | 带默认值的 JSON 安全读取 |
| `src/fs-atomic.ts` | `writeFileAtomic` / `writeJsonFileAtomic` | 原子写入（防撕裂 JSON） |
| `src/token-estimator.ts` | `estimateTokens` / `enforcePromptBudget` / `truncateByTokens` | CJK 感知的 token 估算与预算截断 |
| `src/consensus.ts` | 共识算法常量、类型、纯函数与 `RetryBudget` | 多模型共识检测、重试决策、结果格式化 |

## 同步

```bash
# 执行同步（写入各包 src/shared/）
bun cohub-shared/sync.ts

# 仅检查漂移，不写入（CI 用，有漂移时退出码非 0）
bun cohub-shared/sync.ts --check
```

## 漂移检测

同步脚本在写入前比对目标文件哈希：
- 若目标文件已存在、但哈希既不等于旧 checksums 记录值、也不等于新源哈希 → **漂移警告**
- 同步脚本只覆盖"旧 checksums 里记录过的文件"或"目标不存在的新文件"，不会删除目标的其它文件