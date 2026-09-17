---
uid: b8bb88cc
id: cohub.dsh.skills.orchestration
parent: cohub.dsh.skills
name: {zh: "调度编排技能", en: "Orchestration Skill"}
description:
  zh: >
      co-orchestrator 技能定义：纯调度者——分析需求→委派→审核。禁止直接文件操作，通过delegate/delegate_batch机制把工作分派给专职代理。
      
  en: >
      co-orchestrator skill definition: pure scheduler — analyze requirements, delegate, review. No direct file ops; dispatches work via delegate/delegate_batch to specialist agents.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:22.109Z"
fingerprint: 390e3780fe29dd8f51cf86b7b279632e7e943ff824cbc9af3d6d89a90d74a74c
source:
  - path: "packages/dsh-cohub/skills/orchestrator.md"
apis:
  - protocol: file
    path: "co-orchestrator"
    description:
      zh: >
          纯调度者：分析需求→委派→审核，禁止直接文件操作
          
      en: >
          Pure scheduler: analyze→delegate→review, no direct file ops
          
---
