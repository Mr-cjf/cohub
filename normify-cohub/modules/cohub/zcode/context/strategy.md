---
uid: 2b000013
id: cohub.zcode.context.strategy
parent: cohub.zcode.context
tags: [context, strategy]
name: {zh: "上下文策略", en: "Context Strategy"}
description:
  zh: >
      根据任务类型（delegate/council/scan）解析对应的上下文注入策略。
      
  en: >
      Resolves the context injection strategy based on task type (delegate, council, or scan).
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:44:22.003Z"
fingerprint: 43e68ca4b215e43408edbb121c2c199852563b74d44024118ded5c0e7a2b220b
source:
  - path: "packages/zcode-cohub/src/context/strategy.ts"
    line: 1
    end_line: 35
apis:
  - protocol: rpc
    path: "zcode.resolveStrategy"
    description:
      zh: >
          按任务类型解析上下文策略
      en: >
          Resolve context strategy by task type
---
