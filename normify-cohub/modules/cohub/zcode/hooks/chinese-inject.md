---
uid: 2b000009
id: cohub.zcode.hooks.chinese-inject
parent: cohub.zcode.hooks
tags: [hooks, chinese]
name: {zh: "中文注入", en: "Chinese Inject"}
description:
  zh: >
      SessionStart hook：在会话启动时注入中文语言要求到系统提示，确保所有回复使用中文。
      
  en: >
      SessionStart hook: injects a Chinese language requirement into the system prompt at session start.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:41:48.158Z"
fingerprint: fc4ce81ba8ccc7f134ad950f74c77dfa936b8ff0d843203d97ce3518f295fc0a
source:
  - path: "packages/zcode-cohub/src/hooks/chinese-inject.ts"
    line: 1
    end_line: 29
apis:
  - protocol: rpc
    path: "SessionStart"
    description:
      zh: >
          会话启动时注入中文语言要求
          
      en: >
          Inject Chinese language requirement at session start
          
---
