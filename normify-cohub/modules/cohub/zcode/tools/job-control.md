---
uid: 2b000006
id: cohub.zcode.tools.job-control
parent: cohub.zcode.tools
tags: [mcp, job]
name: {zh: "作业控制", en: "Job Control"}
description:
  zh: >
      取消运行中的作业：根据 task_id 查找并中止对应子会话。
      
  en: >
      Cancels a running job: looks up the task_id and aborts the corresponding child session.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:41:48.157Z"
fingerprint: df85163e351daae52299517955115c058f460bf2ac1f939e6d0322de6dab083c
source:
  - path: "packages/zcode-cohub/src/tools/job-control.ts"
    line: 1
    end_line: 78
apis:
  - protocol: rpc
    path: "co_close_job"
    description:
      zh: >
          根据 task_id 查找并中止对应子会话
          
      en: >
          Look up task_id and abort the corresponding child session
          
---
