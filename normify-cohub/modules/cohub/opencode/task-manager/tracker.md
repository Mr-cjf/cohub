---
uid: 1a22f221
id: cohub.opencode.task-manager.tracker
parent: cohub.opencode.task-manager
name: {zh: "任务追踪器", en: "Task Tracker"}
description:
  zh: >
      Background Job Board 任务追踪与统计
      
  en: >
      Background Job Board task tracking and statistics
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:09.892Z"
fingerprint: 5fbc7edd7bcc03a35c32392458fa8f89897ae1ca2ed84b125f09e704b3ed294a
source:
  - path: "packages/oh-my-opencode-cohub/src/task-manager/tracker.ts"
    line: 1
    end_line: 441
apis:
  - protocol: rpc
    path: "TaskTracker"
    description:
      zh: >
          任务追踪器
          
      en: >
          Task tracker
          
  - protocol: rpc
    path: "computeStats"
    description:
      zh: >
          计算任务统计
          
      en: >
          Compute task statistics
          
deps:
  - kind: call
    to: cohub.opencode.context.types
---
