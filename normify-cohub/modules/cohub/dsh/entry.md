---
uid: ff11aa22
id: cohub.dsh.entry
parent: cohub.dsh
name: {zh: "插件入口与注册", en: "Plugin Entry & Registration"}
description:
  zh: >
      CoHub DSH Cordis 插件入口：注入中文语言指令到 systemPrompt.section、注册 13 个 runtime skills、安装内置 agent preset、注册 delegate/delegate_batch/council_session 工具，并暴露 settings 配置 schema。
      
  en: >
      CoHub DSH Cordis plugin entry: injects Chinese-language instruction into systemPrompt, registers 13 runtime skills, installs built-in agent presets, registers delegate/delegate_batch/council_session tools, and exposes the settings configuration schema.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.329Z"
fingerprint: 888c741bb798c129fee28d23fd6ea0c596b3395641bef142a03598bd669946a5
source:
  - path: "packages/dsh-cohub/src/index.ts"
    line: 1
    end_line: 306
apis:
  - protocol: rpc
    path: "skills.register"
    description:
      zh: >
          注册13个co-*技能到runtime skills目录
          
      en: >
          Register 13 co-* skills to runtime skills
          
  - protocol: rpc
    path: "cohub:language"
    description:
      zh: >
          中文指令注入systemPrompt section（order=95）
          
      en: >
          Chinese instruction injected as systemPrompt section (order=95)
          
  - protocol: file
    path: "CohubSettingsSchema"
    description:
      zh: >
          cohub settings namespace schema
          
      en: >
          Cohub settings namespace schema
          
deps:
  - kind: call
    to: cohub.shared.chinese
  - kind: call
    to: cohub.dsh.preset-install
  - kind: call
    to: cohub.dsh.council
  - kind: call
    to: cohub.dsh.delegate.tool
  - kind: call
    to: cohub.dsh.delegate-batch
  - kind: call
    to: cohub.dsh.skills
  - kind: call
    to: cohub.dsh.env-signatures
---
