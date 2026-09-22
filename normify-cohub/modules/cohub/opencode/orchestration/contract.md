---
uid: 1a18b181
id: cohub.opencode.orchestration.contract
parent: cohub.opencode.orchestration
name: {zh: "合约管理器", en: "Contract Manager"}
description:
  zh: >
      管理代理间合约与消息去重
      
  en: >
      Manage inter-agent contracts and message dedup
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.350Z"
fingerprint: 9a60b8890d71ce2827f5bd9c60be52045e362d89c3a1a7344354cdd5c4c024be
source:
  - path: "packages/oh-my-opencode-cohub/src/orchestration/contract.ts"
    line: 1
    end_line: 93
apis:
  - protocol: rpc
    path: "ContractManager"
    description:
      zh: >
          合约管理器
          
      en: >
          Contract manager
          
  - protocol: rpc
    path: "stripExistingContracts"
    description:
      zh: >
          去重已有合约内容
          
      en: >
          Strip existing contract content
          
---
