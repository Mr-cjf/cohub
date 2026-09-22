---
uid: f6a7b8c9
id: cohub.shared.consensus
parent: cohub.shared
name: {zh: "多模型共识算法", en: "Multi-Model Consensus Algorithm"}
description:
  zh: >
      多模型共识的纯逻辑实现：类型定义、分词、Jaccard 相似度、成对一致性、共识判定、重试决策、结果格式化。子模块按 A 类（零依赖）→ B 类（仅依赖 A）→ 格式化 → 重试分层。
      
  en: >
      Pure-logic multi-model consensus: types, tokenization, Jaccard, pairwise agreement, consensus detection, retry decisions, result formatting. Sub-modules layered: class A → class B → formatting → retry.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.365Z"
fingerprint: 16ec1b797750760deb69e2b63a377c124816c2788946e74f61907b1898214e2b
source:
  - path: "cohub-shared/src/consensus.ts"
    line: 1
    end_line: 403
---
