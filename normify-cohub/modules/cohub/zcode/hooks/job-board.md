---
uid: 2b00000a
id: cohub.zcode.hooks.job-board
parent: cohub.zcode.hooks
tags: [hooks, job-board]
name: {zh: "作业看板", en: "Job Board"}
description:
  zh: >
      UserPromptSubmit hook：每次用户输入前刷新作业看板，展示运行中/已完成/失败的任务状态。
      
  en: >
      UserPromptSubmit hook: refreshes the job board before each user prompt, showing running/completed/failed task statuses.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.552Z"
fingerprint: 87f4cb1e7675d81faf5266ab368f811ecaedf8c61cb0993b5998d74bed771bec
source:
  - path: "packages/zcode-cohub/src/hooks/job-board.ts"
    line: 1
    end_line: 99
apis:
  - protocol: rpc
    path: "zcode.UserPromptSubmit.jobboard"
    description:
      zh: >
          用户输入前刷新作业看板面板
          
      en: >
          Refresh the job board panel before user input
          
deps:
  - kind: call
    to: cohub.zcode.utils.paths
---
