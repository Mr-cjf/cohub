# cohub-shared

跨包共享的单一真源目录。8 个零平台依赖的纯逻辑模块集中维护在此（`src/` 共 9 个文件，另一个是 barrel `index.ts`），通过同步脚本复制到两个平台包。

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
| `src/constants.ts` | `COUNCIL_TIMEOUT_MS` / `WALL_CLOCK_BUDGET_MS` / `STALE_TASK_MS` / `STDIN_TIMEOUT_MS` | 跨包共享常量，消除各包重复魔数 |
| `src/log.ts` | `createLogger`（+ `LogConfig` / `LogFn` 类型） | 跨包诊断日志工厂：目录/前缀/按天轮转/保留天数/同步异步均可配置 |

`src/index.ts` 是 barrel（`export *` 转发上述 8 个模块），不参与同步。

## 按包保留名单（TARGET_RESERVED）

`sync.ts` 维护一份**按目标包区分**的文件保留名单：命中的文件名对该包**不同步**——既不会被写入，也不会因源文件变更而被覆盖。

原因各不相同：有的文件在该包**已无业务消费者**（继续同步只会引入死代码），有的是该包**自有的独立实现**（与共享版行格式/语义不兼容），还有的是**已被删除的死模块**（列入保留是为了防止同步脚本把它写回包内）。

当前保留名单：

| 目标包 | 不同步的文件 | 原因 |
|--------|--------------|------|
| `dsh-cohub` | `fs-atomic.ts`、`fs-json.ts`、`token-estimator.ts` | 包内无业务消费者，停同步 |
| `oh-my-opencode-cohub` | `fs-json.ts` | 包内无业务消费者，停同步 |

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

`checksums.json` 记录的是**目标文件**（含自动生成头部）的期望哈希，共 8 条，与上表 8 个模块一一对应。
