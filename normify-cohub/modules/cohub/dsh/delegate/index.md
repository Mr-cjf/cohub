---
uid: aa33bb44
id: cohub.dsh.delegate
parent: cohub.dsh
name: {zh: "委派引擎", en: "Delegate Engine"}
description:
  zh: >
      按skill名路由provider/model、注入精简指令后spawn子代理。子模块：tool（核心装配+spawn）与stall（停滞看门狗—旁路观测事件流、S1-S4判定提前中止）。支持P1环境契约注入、P1-2中止重试、P3-1停滞检测、P3-2契约持久化。
      
  en: >
      Routes by skill name to provider/model, injects brief, spawns subagents. Sub-modules: tool (core assembly+spawn) and stall (watchdog). Supports P1 contract injection, P1-2 retry, P3-1 stall detection, P3-2 contract persistence.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:14.100Z"
fingerprint: 0f001b39082147b7f631f5d876c5408a2c045ebba80c02043bcbd2275c8ac17a
source:
  - path: "packages/dsh-cohub/src/delegate.ts"
    line: 1
    end_line: 656
---
