---
uid: 1a14e101
id: cohub.opencode.context.formatter
parent: cohub.opencode.context
name: {zh: "上下文格式化器", en: "Context Formatter"}
description:
  zh: >
      格式化任务上下文并替换占位符
      
  en: >
      Format task context and replace placeholders
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:52:23.359Z"
fingerprint: 7ad231e06d1ef8ffc78f8b8f79188584e57d5f4775aa0378381bea2825fc03e0
source:
  - path: "packages/oh-my-opencode-cohub/src/context/formatter.ts"
    line: 1
    end_line: 64
apis:
  - protocol: rpc
    path: "formatTaskContext"
    description:
      zh: >
          格式化任务上下文
          
      en: >
          Format task context
          
  - protocol: rpc
    path: "replaceMarkerWithContext"
    description:
      zh: >
          用上下文替换标记占位符
          
      en: >
          Replace marker placeholder with context
          
---
