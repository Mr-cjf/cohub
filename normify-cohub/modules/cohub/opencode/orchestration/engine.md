---
uid: 1a17a171
id: cohub.opencode.orchestration.engine
parent: cohub.opencode.orchestration
name: {zh: "编排引擎核心", en: "Orchestration Engine Core"}
description:
  zh: >
      创建编排层：集成 contract/retry/scheduler
      
  en: >
      Create orchestration layer integrating contract, retry, scheduler
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:09.892Z"
fingerprint: 670311138229fe9f1aa611349f27ad2e77a5c33174476e801bc267517fb7e3c5
source:
  - path: "packages/oh-my-opencode-cohub/src/orchestration/engine.ts"
    line: 1
    end_line: 136
apis:
  - protocol: rpc
    path: "createOrchestrationLayer"
    description:
      zh: >
          创建编排层
          
      en: >
          Create orchestration layer
          
deps:
  - kind: call
    to: cohub.opencode.task-manager.tracker
  - kind: call
    to: cohub.opencode.orchestration.contract
  - kind: call
    to: cohub.opencode.orchestration.retry
  - kind: call
    to: cohub.opencode.orchestration.scheduler
---
