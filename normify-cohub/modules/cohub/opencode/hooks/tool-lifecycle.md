---
uid: 1a29a291
id: cohub.opencode.hooks.tool-lifecycle
parent: cohub.opencode.hooks
name: {zh: "工具生命周期 Hook", en: "Tool Lifecycle Hook"}
description:
  zh: >
      tool.execute.before/after：任务注册与状态更新
      
  en: >
      tool.execute.before/after: task registration and status updates
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:54:08.899Z"
fingerprint: 08723fd31d2d61ce204a92350157f09bc335d08fe498b1845afa464720b4dd3d
source:
  - path: "packages/oh-my-opencode-cohub/src/index.ts"
    line: 462
    end_line: 611
apis:
  - protocol: file
    path: "tool.execute.before"
    description:
      zh: >
          工具执行前事件
          
      en: >
          Tool execute before event
          
  - protocol: file
    path: "tool.execute.after"
    description:
      zh: >
          工具执行后事件
          
      en: >
          Tool execute after event
          
---
