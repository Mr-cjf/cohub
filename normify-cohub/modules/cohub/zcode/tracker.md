---
uid: 2b000015
id: cohub.zcode.tracker
parent: cohub.zcode
tags: [tracker, state]
name: {zh: "任务追踪器", en: "Task Tracker"}
description:
  zh: >
      任务状态文件（JSON）读写：登记/更新/完成/失败任务，由 hook 驱动的事件循环维护。
      
  en: >
      Task state file (JSON) read/write: register, update, complete, and fail tasks, maintained by a hook-driven event loop.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.551Z"
fingerprint: c1517e991dde5265c49b700a9317848b506fc60c4f3bb7c4b6d8e5b3b6ed4a44
source:
  - path: "packages/zcode-cohub/src/tracker.ts"
    line: 1
    end_line: 548
apis:
  - protocol: rpc
    path: "zcode.TaskTracker"
    description:
      zh: >
          任务追踪主类
          
      en: >
          Main task tracker class
          
  - protocol: rpc
    path: "zcode.readTrackerState"
    description:
      zh: >
          读取任务追踪状态
          
      en: >
          Read tracker state
          
  - protocol: rpc
    path: "zcode.registerExternalJob"
    description:
      zh: >
          登记外部作业
          
      en: >
          Register external job
          
  - protocol: rpc
    path: "zcode.completeOldestBySkill"
    description:
      zh: >
          按 skill 完成最旧任务
          
      en: >
          Complete oldest task by skill
          
  - protocol: rpc
    path: "zcode.failTaskBySkill"
    description:
      zh: >
          按 skill 标记任务失败
          
      en: >
          Fail task by skill
          
deps:
  - kind: call
    to: cohub.shared.fs-json
  - kind: call
    to: cohub.shared.fs-atomic
  - kind: call
    to: cohub.zcode.utils.paths
---
