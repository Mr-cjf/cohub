---
uid: bb22cc33
id: cohub.shared.consensus.summary
parent: cohub.shared.consensus
name: {zh: "结构化摘要提取", en: "Structured Summary Extraction"}
description:
  zh: >
      启发式从议员回复文本中提取结论句与关键实体/决策句。使用结论标记词（如"综上""结论""conclusion"）与实体标记词（如"决策""方案""entity"）匹配。
      
  en: >
      Heuristically extracts conclusion sentences and key entity/decision sentences from councillor response text using conclusion and entity markers.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:14.098Z"
fingerprint: 40398a367dcb5197862e31b78d6b0e55a7777131ca1ede0b4994060f81f35b91
source:
  - path: "cohub-shared/src/consensus.ts"
    line: 206
    end_line: 228
apis:
  - protocol: rpc
    path: "extractCouncillorSummary"
    description:
      zh: >
          启发式提取结构化摘要：分句→结论标记/实体标记匹配→返回conclusions+entities
          
      en: >
          Heuristic summary extraction: split sentences→match conclusion/entity markers→return conclusions+entities
          
---
