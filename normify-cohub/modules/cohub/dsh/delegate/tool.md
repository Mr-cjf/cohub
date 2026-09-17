---
uid: cc55dd66
id: cohub.dsh.delegate.tool
parent: cohub.dsh.delegate
name: {zh: "委派工具装配", en: "Delegate Tool Assembly"}
description:
  zh: >
      createDelegateTool核心装配：skill匹配→路由provider/model→注入brief+环境契约→spawn子代理。P1-1契约注入、P1-2自动重试、P3-3运行时配置解析均在此。
      
  en: >
      Core assembly: skill match→route provider/model→inject brief+contract→spawn. P1-1/P1-2/P3-3 all live here.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:56:37.318Z"
fingerprint: 0f001b39082147b7f631f5d876c5408a2c045ebba80c02043bcbd2275c8ac17a
source:
  - path: "packages/dsh-cohub/src/delegate.ts"
    line: 437
    end_line: 656
apis:
  - protocol: rpc
    path: "delegate"
    description:
      zh: >
          按skill路由provider/model→spawn子代理；支持重试+停滞检测
          
      en: >
          Route by skill→spawn; retry+stall support
          
deps:
  - kind: call
    to: cohub.dsh.skills
  - kind: call
    to: cohub.dsh.env-signatures
---
