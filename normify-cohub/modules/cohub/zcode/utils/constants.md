---
uid: 2b000022
id: cohub.zcode.utils.constants
parent: cohub.zcode.utils
tags: [constants, shared]
name: {zh: "包内常量", en: "Package Constants"}
description:
  zh: >
      zcode 自有共享常量：STALE_TASK_MS（30 分钟过期阈值）、STDIN_TIMEOUT_MS（3 秒超时）。
      
  en: >
      ZCode-owned shared constants: STALE_TASK_MS (30 min stale threshold) and STDIN_TIMEOUT_MS (3 sec timeout).
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:41:48.167Z"
fingerprint: ff3a7cd452c30fd32a784b966f3d484c13f83e74df28b5c33c10918b138c6be3
source:
  - path: "packages/zcode-cohub/src/shared/constants.ts"
    line: 1
    end_line: 16
apis:
  - protocol: file
    path: "STALE_TASK_MS"
    description:
      zh: >
          非终态任务过期阈值：30 分钟
          
      en: >
          Non-terminal task stale threshold: 30 minutes
          
  - protocol: file
    path: "STDIN_TIMEOUT_MS"
    description:
      zh: >
          stdin 同步读取超时：3 秒
          
      en: >
          Synchronous stdin read timeout: 3 seconds
          
---
