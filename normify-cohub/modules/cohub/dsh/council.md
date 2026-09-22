---
uid: ff99aa11
id: cohub.dsh.council
parent: cohub.dsh
name: {zh: "多模型共识工具", en: "Multi-Model Council Tool"}
description:
  zh: >
      M4 council_session工具：并行ctx.subagents.start()，每councillor通过agentOptions路由到配置的provider/model，结果聚合为结构化文本返回给co-council综合。
      
  en: >
      M4 council_session: parallel ctx.subagents.start(), each councillor routed via agentOptions, results aggregated as structured text for co-council synthesis.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.326Z"
fingerprint: d7352cc1a4ff360a3213164785f14a8f8b615f4a4b71f369c223fac7c3ff532e
source:
  - path: "packages/dsh-cohub/src/council.ts"
    line: 87
    end_line: 170
apis:
  - protocol: rpc
    path: "council_session"
    description:
      zh: >
          并行启动多模型共识会议：所有councillor并行回答→聚合格式化
          
      en: >
          Parallel multi-model council: all councillors answer→aggregate+format
          
deps:
  - kind: call
    to: cohub.shared.model
  - kind: call
    to: cohub.dsh.delegate.tool
---
