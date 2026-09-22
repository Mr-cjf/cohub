---
uid: 1a28f281
id: cohub.opencode.tools.model-stats
parent: cohub.opencode.tools
name: {zh: "模型统计", en: "Model Statistics"}
description:
  zh: >
      模型结果记录与失败排序
      
  en: >
      Record model results and sort councillors by failure
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.362Z"
fingerprint: 1e8ff4f51a7e2642ffc803301f06bb29431cf1c37ded76ad42c7330b989cdb59
source:
  - path: "packages/oh-my-opencode-cohub/src/tools/model-stats.ts"
    line: 1
    end_line: 143
apis:
  - protocol: rpc
    path: "recordModelResult"
    description:
      zh: >
          记录模型执行结果
          
      en: >
          Record model execution result
          
  - protocol: rpc
    path: "orderCouncillorsByFailure"
    description:
      zh: >
          按失败数排序 councillors
          
      en: >
          Order councillors by failure count
          
---
