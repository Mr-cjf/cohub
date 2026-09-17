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
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:14.097Z"
fingerprint: 40398a367dcb5197862e31b78d6b0e55a7777131ca1ede0b4994060f81f35b91
source:
  - path: "cohub-shared/src/consensus.ts"
    line: 1
    end_line: 403
---
