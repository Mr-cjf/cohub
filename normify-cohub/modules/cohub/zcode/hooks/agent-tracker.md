---
uid: 2b00000c
id: cohub.zcode.hooks.agent-tracker
parent: cohub.zcode.hooks
tags: [hooks, tracker, agent]
name: {zh: "代理追踪", en: "Agent Tracker"}
description:
  zh: >
      PreToolUse/PostToolUse hook：拦截 Agent spawn 自动登记任务（running），子代理结束时标记 completed，确保 job-board 不遗漏。
      
  en: >
      PreToolUse/PostToolUse hooks: intercept Agent spawns to auto-register tasks (running) and mark completed when child agents finish, ensuring job-board completeness.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.552Z"
fingerprint: 523cea820af6589df4790cf302a1d1961bf37bdb468b842a69248e769e6e0f3d
source:
  - path: "packages/zcode-cohub/src/hooks/agent-tracker.ts"
    line: 1
    end_line: 105
apis:
  - protocol: rpc
    path: "PreToolUse"
    description:
      zh: >
          Agent spawn 时自动登记任务
          
      en: >
          Auto-register task on Agent spawn
          
  - protocol: rpc
    path: "PostToolUse"
    description:
      zh: >
          子代理结束时标记任务完成
          
      en: >
          Mark task completed when child agent finishes
          
  - protocol: rpc
    path: "PostToolUseFailure"
    description:
      zh: >
          子代理失败时标记任务失败
          
      en: >
          Mark task failed on child agent failure
          
deps:
  - kind: call
    to: cohub.zcode.tracker
  - kind: call
    to: cohub.zcode.hooks.stdin
---
