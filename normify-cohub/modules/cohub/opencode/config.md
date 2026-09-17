---
uid: 1a0ff001
id: cohub.opencode.config
parent: cohub.opencode
name: {zh: "配置加载器", en: "Config Loader"}
description:
  zh: >
      用户配置文件加载器
      
  en: >
      User config loader
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:09.892Z"
fingerprint: 08c3cdc9fe6a20467b49a14b3d78e15de686619b199a015ad86d7acba390ebf2
source:
  - path: "packages/oh-my-opencode-cohub/src/config/loader.ts"
    line: 1
    end_line: 58
apis:
  - protocol: rpc
    path: "loadCoHubConfig"
    description:
      zh: >
          加载 CoHub 用户配置
          
      en: >
          Load CoHub user configuration
          
deps:
  - kind: call
    to: cohub.opencode.context.types
  - kind: call
    to: cohub.opencode.task-manager.quality
  - kind: call
    to: cohub.opencode.tools.council
---
