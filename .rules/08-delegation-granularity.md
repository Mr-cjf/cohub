# 委派粒度的对称约束（开发约束）

本文件规定「改动 orchestrator 委派粒度规则时必须遵守的开发纪律」，不是提示词内容的副本。三份包的提示词各自持有数值真源，本文件只记录改这些数值时的同步要求。

## 一、问题背景

「先聚合再并行」原先是**单边规则**：只禁拆太细，未禁包太大，同时还并存反向压力「单个 task 调用是最后手段」。结果是一条请求里 7 条独立核查诉求、跨 4 个模块域的只读审查被塞进单个 explorer，11 分钟 / 92 次工具调用才收敛。多派与聚合都不是问题，**失控的包容量**才是。

## 二、单包容量上限（镜像表）

数值真源在各包提示词，本表仅作镜像，用于改规则时对照：

| 项 | 上限 |
|---|---|
| 可独立判定的诉求（「是/否」「为什么」「在哪」独立问句数） | ≤3 |
| 涉及的模块或子系统域 | ≤2 |
| 跨模块交叉比对 / 多条件「同时成立」的合成判定 | **禁止入包** |

**事后判据**（不做事前预估）：同一子代理连续超时 2 次，或实际工具调用 >1.5× 预估 → 强制拆包，**不得原样重试**。

## 三、数值变更流程（必须三处同步）

改任一上限值时必须三处同时落地，**缺一即为不完整改动**：

| 包 | 文件 | 构建命令 |
|---|---|---|
| `packages/oh-my-opencode-cohub` | `src/prompts/orchestrator.md`、`src/prompts/planner.md` | `npm run build`（生成 `src/prompts/*.ts`） |
| `packages/dsh-cohub` | `skills/orchestrator.md`、`skills/planner.md`、`scripts/generate-skills.ts` 的 brief | `bun run build`（生成 `src/skills.ts`） |
| `packages/oh-my-codex-cohub` | `skills/cohub/references/batch-execution.md`、`references/efficiency.md`、`skills/cohub/SKILL.md` | `npm run build`（`validate.mjs`，仅校验） |

**禁止直接改生成物**：`packages/dsh-cohub/src/skills.ts` 与 `packages/oh-my-opencode-cohub/src/prompts/*.ts` 都是构建产物、已被 `.gitignore` 排除，手改会被下次构建覆盖。

## 四、必须同步更新契约测试

改 OC 侧 `src/prompts/orchestrator.md` 的委派粒度条款时，必须同步更新 `packages/oh-my-opencode-cohub/src/prompts/routing.test.ts`：

- **正向**：提示词必须含「粒度自检」、`跨模块` / `合成判定`、单包上限关键词
- **负向**：提示词**不得**含「单个 task 调用是最后手段」

理由：现有断言只验证「含聚合关键词」，没有任何上限断言——规则回退时测试不会报警。

## 五、对称违规判据

- **拆分过度**：拆开后产生对同一文件的重复读取 → 拆错了，应重新聚合
- **拆分不足**：单包诉求 / 模块域 / 合成判定超限 → 拆少了，必须拆包

两者同属违规。多派是正常形态，聚合也是正常形态，判据是**证据重叠度 + 包容量**，不是调用个数。并发包数量本身不设上限。

## 六、边界纪律

三包各自绑定自己的平台路径体系，改一个包时不串改其他包。**第三节的数值三处同步是唯一例外**——那是必须有意识地跨包改的情形。
