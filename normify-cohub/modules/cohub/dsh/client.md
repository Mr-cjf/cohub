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
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:22.108Z"
fingerprint: 663df4dd8cb56963462c6e4822f86ffa1515a399952c5609597798a430d65f9f
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
