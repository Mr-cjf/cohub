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
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.348Z"
fingerprint: bf54e7d2212e882e4408bdf0d150ff198314948e96854fc03ac319c738a796c0
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
