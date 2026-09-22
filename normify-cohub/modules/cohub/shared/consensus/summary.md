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
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.365Z"
fingerprint: 16ec1b797750760deb69e2b63a377c124816c2788946e74f61907b1898214e2b
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
