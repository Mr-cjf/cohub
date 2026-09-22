---
uid: c3cc33dd
id: cohub.dsh.client
parent: cohub.dsh
name: {zh: "Client 端设置卡片", en: "Client Settings Card"}
description:
  zh: >
      CoHub Client端设置卡片（React）：为每个专职代理提供provider/model选择器，含调度参数、重试配置、停滞检测阈值、环境契约持久化开关。注入settings.plugin.item slot。
      
  en: >
      CoHub Client settings card (React): provider/model selectors per agent, plus schedule/retry/stall/contract config. Injected into settings.plugin.item slot.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.324Z"
fingerprint: 614fc7d1e1193b7ded38d77086ee634a83e3e0f477f3d0063a8f1d583c4e1bf7
source:
  - path: "packages/dsh-cohub/src/client/index.js"
    line: 1
    end_line: 923
apis:
  - protocol: rpc
    path: "settings.plugin.item"
    description:
      zh: >
          CoHub代理模型设置卡片：12技能各配provider/model+调度/重试/停滞/契约
          
      en: >
          CoHub agent model settings card per-skill provider/model+schedule/retry/stall/contract
          
---
