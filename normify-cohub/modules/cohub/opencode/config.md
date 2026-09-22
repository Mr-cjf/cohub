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
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.342Z"
fingerprint: 4fd006d6c81f9479717d06dc2dd4a2aa62ce37d6e96d2e887f7e34228c0bc047
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
