---
uid: 2b00000d
id: cohub.zcode.hooks.grep-counter
parent: cohub.zcode.hooks
tags: [hooks, grep, co_scan]
name: {zh: "Grep 计数器", en: "Grep Counter"}
description:
  zh: >
      PostToolUse(Grep) hook：监听每次 Grep 调用，按会话统计滚动 10 分钟窗口内调用次数；超阈值时注入 co_scan 提醒。
      
  en: >
      PostToolUse(Grep) hook: monitors each Grep call, counts per-session calls in a rolling 10-minute window, and injects a co_scan reminder when the threshold is exceeded.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.552Z"
fingerprint: 0bb5d256777653f189f3cf3c0bdd13cc40ce0025b22daed143eab161d9d12824
source:
  - path: "packages/zcode-cohub/src/hooks/grep-counter.ts"
    line: 1
    end_line: 318
apis:
  - protocol: rpc
    path: "PostToolUse(Grep)"
    description:
      zh: >
          监听 Grep 调用次数，超阈值时注入 co_scan 提醒
          
      en: >
          Monitor Grep call count; inject co_scan reminder when threshold exceeded
          
deps:
  - kind: call
    to: cohub.zcode.utils.paths
  - kind: call
    to: cohub.zcode.hooks.stdin
  - kind: call
    to: cohub.shared.fs-json
---
