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
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:56:37.318Z"
fingerprint: 5f747ef0c8ce0bd0f45a94acbd21d00190a70585b4c6c9968ecbacede7d27b1c
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
