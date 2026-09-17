---
uid: 2b00000b
id: cohub.zcode.hooks.orchestrate-remind
parent: cohub.zcode.hooks
tags: [hooks, orchestrator]
name: {zh: "调度提醒", en: "Orchestrate Remind"}
description:
  zh: >
      UserPromptSubmit hook：提示主代理遵循 orchestrator 调度纪律——先分析需求再委派而非直接执行。
      
  en: >
      UserPromptSubmit hook: reminds the primary agent to follow orchestrator discipline — analyze first, then delegate.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:45:29.052Z"
fingerprint: b98465e1713d068893cff0bcbdd1d3a08aa45b955de150b3f9b2df2cbad8d7b2
source:
  - path: "packages/zcode-cohub/src/hooks/orchestrate-remind.ts"
    line: 1
    end_line: 12
apis:
  - protocol: rpc
    path: "zcode.UserPromptSubmit.remind"
    description:
      zh: >
          提醒主代理遵循 orchestrator 调度纪律
      en: >
          Remind the primary agent of orchestrator discipline
---
