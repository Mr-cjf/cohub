---
uid: 2b000011
id: cohub.zcode.context.extractor
parent: cohub.zcode.context
tags: [context, extract]
name: {zh: "上下文提取器", en: "Context Extractor"}
description:
  zh: >
      从任务上下文中提取关键数据：相关文件列表、关键决策、错误信息、结构化摘要。
      
  en: >
      Extracts key data from task context: relevant file lists, key decisions, errors, and structured summaries.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:44:07.026Z"
fingerprint: 33c2d54fadcb62feae04f2987e6c2de370ca5051aa7bb2b86e551afa8f291c53
source:
  - path: "packages/zcode-cohub/src/context/extractor.ts"
    line: 1
    end_line: 148
apis:
  - protocol: rpc
    path: "zcode.extractRelevantFiles"
    description:
      zh: >
          提取相关文件列表
      en: >
          Extract relevant file list
  - protocol: rpc
    path: "zcode.extractKeyDecisions"
    description:
      zh: >
          提取关键决策
      en: >
          Extract key decisions
  - protocol: rpc
    path: "zcode.extractErrors"
    description:
      zh: >
          提取错误信息
      en: >
          Extract error information
  - protocol: rpc
    path: "zcode.buildSummary"
    description:
      zh: >
          构建结构化摘要
      en: >
          Build structured summary
---
