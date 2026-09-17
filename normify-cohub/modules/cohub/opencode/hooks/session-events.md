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
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:54:08.899Z"
fingerprint: 08723fd31d2d61ce204a92350157f09bc335d08fe498b1845afa464720b4dd3d
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
