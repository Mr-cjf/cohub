---
uid: 2b00000e
id: cohub.zcode.hooks.stdin
parent: cohub.zcode.hooks
tags: [hooks, stdin, shared]
name: {zh: "标准输入读取", en: "Stdin Reader"}
description:
  zh: >
      Hook 间共享的同步 stdin 读取工具：带超时的 readStdinSync 供 agent-tracker 和 grep-counter 共用。
      
  en: >
      Shared synchronous stdin reader for hooks: readStdinSync with timeout, shared by agent-tracker and grep-counter.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:41:48.159Z"
fingerprint: e09b5228adf00c9bcd600a051a308844b1bafaffd0d26968ab9d14b3615a4022
source:
  - path: "packages/zcode-cohub/src/hooks/shared/stdin.ts"
    line: 1
    end_line: 63
apis:
  - protocol: rpc
    path: "readStdinSync"
    description:
      zh: >
          带超时的同步 stdin 读取
          
      en: >
          Synchronous stdin read with timeout
          
---
