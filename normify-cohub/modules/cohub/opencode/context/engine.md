---
uid: 1a12c101
id: cohub.opencode.context.engine
parent: cohub.opencode.context
name: {zh: "上下文引擎", en: "Context Engine"}
description:
  zh: >
      协调 extractor/formatter/strategy
      
  en: >
      Coordinates extractor, formatter, strategy
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.342Z"
fingerprint: 13d47a83e659a35cd9e67f02b4991f0d38d3a619b3958600881a3c956a0d1e11
source:
  - path: "packages/oh-my-opencode-cohub/src/context/engine.ts"
    line: 1
    end_line: 281
apis:
  - protocol: rpc
    path: "ContextEngine"
    description:
      zh: >
          上下文引擎类
          
      en: >
          Context engine class
          
deps:
  - kind: call
    to: cohub.opencode.context.extractor
  - kind: call
    to: cohub.opencode.context.formatter
---
