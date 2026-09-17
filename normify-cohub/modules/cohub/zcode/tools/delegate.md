---
uid: 2b000004
id: cohub.zcode.tools.delegate
parent: cohub.zcode.tools
tags: [mcp, delegate]
name: {zh: "委派装配", en: "Delegate Assembly"}
description:
  zh: >
      提示词装配器：匹配 skill → 注入上下文/纪律 → 返回 subagent_type / agent_prompt / inline_prompt，不 spawn。
      
  en: >
      Prompt assembler: matches skill, injects context/discipline, and returns subagent_type/agent_prompt/inline_prompt without spawning.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.552Z"
fingerprint: 76c0c2f9dfa58a622afdf04493003d3e952724565f8a249486e00c42ae596c5b
source:
  - path: "packages/zcode-cohub/src/tools/delegate.ts"
    line: 1
    end_line: 229
apis:
  - protocol: rpc
    path: "co_delegate"
    description:
      zh: >
          提示词装配：skill 匹配 → 上下文注入 → 返回装配结果
          
      en: >
          Prompt assembly: skill matching → context injection → returns assembly result
          
deps:
  - kind: call
    to: cohub.zcode.tracker
  - kind: call
    to: cohub.zcode.context.engine
  - kind: call
    to: cohub.zcode.skills-briefs
---
