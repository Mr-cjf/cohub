---
uid: e5f6a7b8
id: cohub.shared.token-estimator
parent: cohub.shared
name: {zh: "Token 估算与预算截断", en: "Token Estimator & Budget Truncator"}
description:
  zh: >
      CJK 感知的 token 估算器：中/日/韩字符按 1 token，其余按 0.25 token/字符。提供 estimateTokens / truncateByTokens / enforcePromptBudget 三个公用函数。
      
  en: >
      CJK-aware token estimator: CJK chars = 1 token, others = 0.25 token/char. Exports estimateTokens, truncateByTokens, and enforcePromptBudget.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.369Z"
fingerprint: 6adf85dc543f1e45c12751277942db84410d7b377b63b3338b4677de19526558
source:
  - path: "cohub-shared/src/token-estimator.ts"
    line: 1
    end_line: 64
apis:
  - protocol: rpc
    path: "estimateTokens"
    description:
      zh: >
          估算文本token数：CJK 1 token/字符，其余 0.25
          
      en: >
          Estimate tokens: CJK 1/char, others 0.25/char
          
  - protocol: rpc
    path: "truncateByTokens"
    description:
      zh: >
          按token预算截断文本，超预算时保留头部
          
      en: >
          Truncate by token budget, keep head when over
          
  - protocol: rpc
    path: "enforcePromptBudget"
    description:
      zh: >
          强制prompt预算：未超→full；超→截断base
          
      en: >
          Enforce prompt budget: under→full; over→truncate base
          
---
