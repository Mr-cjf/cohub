---
uid: ee77ff88
id: cohub.dsh.delegate-batch
parent: cohub.dsh
name: {zh: "批量并行委派", en: "Batch Parallel Delegate"}
description:
  zh: >
      一次调用并行启动多个子代理任务的工具（上限20）。每task独立AbortController超时控制，跳过N2停滞检测和P1-2重试，保持简单可靠。复用delegate.ts共享函数。
      
  en: >
      Tool for parallel spawning of multiple subagent tasks (max 20). Per-task AbortController timeout; skips N2 and P1-2 retry. Reuses shared functions from delegate.ts.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.326Z"
fingerprint: aeb8ea61f0ccbb79cd7b19a4d7c89d54e413da3cbfeed1af8091d4ab6b9f8e67
source:
  - path: "packages/dsh-cohub/src/delegate_batch.ts"
    line: 52
    end_line: 272
apis:
  - protocol: rpc
    path: "delegate_batch"
    description:
      zh: >
          批量并行启动子代理：每task独立AbortController+wallClockBudgetMs
          
      en: >
          Batch spawn: per-task AbortController + wallClockBudgetMs
          
deps:
  - kind: call
    to: cohub.dsh.delegate.tool
  - kind: call
    to: cohub.dsh.skills
---
