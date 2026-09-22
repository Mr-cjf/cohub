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
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.359Z"
fingerprint: 1b16da4dfe3dd9fc38cbee7dd081bb8384ee87c86eb449e052760e148f08a61c
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
