---
uid: 1a23a231
id: cohub.opencode.task-manager.quality
parent: cohub.opencode.task-manager
name: {zh: "质量评估", en: "Quality Assessment"}
description:
  zh: >
      任务质量评估与开关控制
      
  en: >
      Task quality assessment and toggle control
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.358Z"
fingerprint: 4d4b54b053c8b01f70ae43f95a5b20acf62f5c0c30e8fa44a42bbd48039eeeb0
source:
  - path: "packages/oh-my-opencode-cohub/src/task-manager/quality.ts"
    line: 1
    end_line: 140
apis:
  - protocol: rpc
    path: "assessQuality"
    description:
      zh: >
          评估任务质量
          
      en: >
          Assess task quality
          
  - protocol: rpc
    path: "isQualityEnabled"
    description:
      zh: >
          检查质量评估是否启用
          
      en: >
          Check if quality assessment is enabled
          
---
