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
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:09.892Z"
fingerprint: bf0cf4a2f0b7c357cd494f2936ff5d400041d36505d134569f3950a246a1e022
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
