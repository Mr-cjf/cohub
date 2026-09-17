---
uid: 1a08a801
id: cohub.opencode.entry
parent: cohub.opencode
name: {zh: "插件入口", en: "Plugin Entry"}
description:
  zh: >
      注册 12 个 agent、7 类 hook、组装全部子系统
      
  en: >
      Registers 12 agents, 7 hook types, assembles all subsystems
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:09.891Z"
fingerprint: 08723fd31d2d61ce204a92350157f09bc335d08fe498b1845afa464720b4dd3d
source:
  - path: "packages/oh-my-opencode-cohub/src/index.ts"
    line: 1
    end_line: 821
apis:
  - protocol: rpc
    path: "oh-my-opencode-cohub plugin"
    description:
      zh: >
          插件主函数
          
      en: >
          Main plugin function
          
deps:
  - kind: call
    to: cohub.shared.chinese
  - kind: call
    to: cohub.opencode.instructions
  - kind: call
    to: cohub.opencode.task-manager.tracker
  - kind: call
    to: cohub.opencode.task-manager.quality
  - kind: call
    to: cohub.opencode.context.engine
  - kind: call
    to: cohub.opencode.context.strategy
  - kind: call
    to: cohub.opencode.config
  - kind: call
    to: cohub.opencode.tools.council
  - kind: call
    to: cohub.opencode.tools.job-control
  - kind: call
    to: cohub.opencode.utils
  - kind: call
    to: cohub.opencode.orchestration.engine
  - kind: call
    to: cohub.opencode.orchestration.contract
  - kind: call
    to: cohub.opencode.context.extractor
---
