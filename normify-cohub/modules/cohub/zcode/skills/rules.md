---
uid: 2b00001a
id: cohub.zcode.skills.rules
parent: cohub.zcode.skills
tags: [skills, rules]
name: {zh: "规则技能", en: "Rules Skills"}
description:
  zh: >
      三个规则分析角色：co-rule-user（用户级 AGENTS.md）、co-rule-project（项目级 AGENTS.md）、co-rule-app（应用级 .zcode/rules/*.md）。
      
  en: >
      Three rule-analysis roles: co-rule-user (user-level AGENTS.md), co-rule-project (project-level AGENTS.md), co-rule-app (app-level .zcode/rules/*.md).
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:43:33.707Z"
fingerprint: b6fa91afc3c9214eecf485ad298910676106bc6b664bc3f81e0f868e30e9b006
source:
  - path: "packages/zcode-cohub/skills/rule-user/SKILL.md"
  - path: "packages/zcode-cohub/skills/rule-project/SKILL.md"
  - path: "packages/zcode-cohub/skills/rule-app/SKILL.md"
apis:
  - protocol: file
    path: "zcode.co-rule-user"
    description:
      zh: >
          用户级 AGENTS.md 分析
      en: >
          User-level AGENTS.md analysis
  - protocol: file
    path: "zcode.co-rule-project"
    description:
      zh: >
          项目级 AGENTS.md 分析
      en: >
          Project-level AGENTS.md analysis
  - protocol: file
    path: "zcode.co-rule-app"
    description:
      zh: >
          应用级规则分析
      en: >
          App-level rules analysis
---
