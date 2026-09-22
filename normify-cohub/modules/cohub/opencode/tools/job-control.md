---
uid: 1a26d261
id: cohub.opencode.tools.job-control
parent: cohub.opencode.tools
name: {zh: "任务控制", en: "Job Control"}
description:
  zh: >
      close_job 工具：终止后台任务
      
  en: >
      close_job tool: terminate background jobs
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.362Z"
fingerprint: 85786b1ce57c32f036802dcdd440f0b884068520a8698dcdb4f33f253f91b1f7
source:
  - path: "packages/oh-my-opencode-cohub/src/tools/job-control.ts"
    line: 1
    end_line: 80
apis:
  - protocol: rpc
    path: "close_job"
    description:
      zh: >
          关闭后台任务
          
      en: >
          Close background job
          
deps:
  - kind: call
    to: cohub.opencode.task-manager.tracker
  - kind: call
    to: cohub.opencode.utils
---
