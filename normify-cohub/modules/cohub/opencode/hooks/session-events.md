---
uid: 1a30b301
id: cohub.opencode.hooks.session-events
parent: cohub.opencode.hooks
name: {zh: "会话事件 Hook", en: "Session Events Hook"}
description:
  zh: >
      session.idle/deleted/error 事件处理
      
  en: >
      session idle, deleted, error event handling
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.348Z"
fingerprint: bf54e7d2212e882e4408bdf0d150ff198314948e96854fc03ac319c738a796c0
source:
  - path: "packages/oh-my-opencode-cohub/src/index.ts"
    line: 614
    end_line: 714
apis:
  - protocol: file
    path: "session.idle"
    description:
      zh: >
          会话空闲事件
          
      en: >
          Session idle event
          
  - protocol: file
    path: "session.deleted"
    description:
      zh: >
          会话删除事件
          
      en: >
          Session deleted event
          
  - protocol: file
    path: "session.error"
    description:
      zh: >
          会话错误事件
          
      en: >
          Session error event
          
---
