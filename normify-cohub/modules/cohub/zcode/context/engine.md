---
uid: 2b000010
id: cohub.zcode.context.engine
parent: cohub.zcode.context
tags: [context, engine]
name: {zh: "上下文引擎核心", en: "Context Engine Core"}
description:
  zh: >
      上下文引擎主逻辑：接收任务上下文结构，驱动提取→格式化→注入流程。
      
  en: >
      Core context engine: accepts task context structs and drives the extract → format → inject pipeline.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.552Z"
fingerprint: dad052a9a1b15ffdee45e573e6a23d7d0d13a717f00a691f913185c465ed7351
source:
  - path: "packages/zcode-cohub/src/context/engine.ts"
    line: 1
    end_line: 107
apis:
  - protocol: rpc
    path: "zcode.ContextEngine"
    description:
      zh: >
          驱动提取→格式化→注入流程
          
      en: >
          Drives the extract → format → inject pipeline
          
deps:
  - kind: call
    to: cohub.zcode.context.extractor
  - kind: call
    to: cohub.zcode.context.formatter
  - kind: call
    to: cohub.zcode.context.types
---
