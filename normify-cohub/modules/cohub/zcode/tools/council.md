---
uid: 2b000005
id: cohub.zcode.tools.council
parent: cohub.zcode.tools
tags: [mcp, council, consensus]
name: {zh: "多模型共识", en: "Multi-Model Council"}
description:
  zh: >
      多模型并行共识：并行查询多个模型 → 收集结论 → 按语义相似度合成共识裁决。
      
  en: >
      Multi-model parallel council: queries multiple models in parallel, collects conclusions, and synthesizes a consensus verdict by semantic similarity.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.552Z"
fingerprint: 9e59d3f57ccc831a1c8d06d0882cbaa04a941cdbd1058bf4d1239a4e9da55054
source:
  - path: "packages/zcode-cohub/src/tools/council.ts"
    line: 1
    end_line: 255
apis:
  - protocol: rpc
    path: "co_council"
    description:
      zh: >
          并行查询多模型，按语义相似度合成共识裁决
          
      en: >
          Parallel multi-model query with consensus synthesis by semantic similarity
          
deps:
  - kind: call
    to: cohub.zcode.tracker
---
