---
uid: ab33cc44
id: cohub.dsh.presets
parent: cohub.dsh
name: {zh: "内置 Agent Preset", en: "Built-in Agent Presets"}
description:
  zh: >
      两个随包发布的agent preset定义：co-orchestrator（纯调度模式：分析→委派→审核，13技能+delegate工具）与 cohub-cordis（创造模式：全部工具面含co_* Cordis运行时工具）。
      
  en: >
      Two shipped agent presets: co-orchestrator (scheduler-only: analyze→delegate→review, 13 skills+delegate tools) and cohub-cordis (creation mode: full tool surface including co_* Cordis runtime tools).
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:22.113Z"
fingerprint: 52fe10ea3382f67642bba61f76a579d31d5e64f1576c3420fef6eb3965232472
source:
  - path: "packages/dsh-cohub/presets/co-orchestrator/agent.cordis.yml"
    line: 1
    end_line: 156
  - path: "packages/dsh-cohub/presets/cohub-cordis/agent.cordis.yml"
    line: 1
    end_line: 288
apis:
  - protocol: file
    path: "co-orchestrator preset"
    description:
      zh: >
          纯调度agent preset：分析需求→委派→审核，禁止直接文件操作
          
      en: >
          Scheduler-only preset: analyze→delegate→review, no direct file ops
          
  - protocol: file
    path: "cohub-cordis preset"
    description:
      zh: >
          创造模式agent preset：全部工具面含co_* Cordis运行时工具
          
      en: >
          Creation-mode preset: full tool surface including co_* Cordis runtime tools
          
---
