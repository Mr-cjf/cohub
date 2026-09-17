---
uid: 1a13d101
id: cohub.opencode.context.extractor
parent: cohub.opencode.context
name: {zh: "文件提取器", en: "File Extractor"}
description:
  zh: >
      从会话历史提取文件/决策/错误
      
  en: >
      Extract files, decisions, errors from session history
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:09.891Z"
fingerprint: 4d440f44802cb3e45a102fef1761f9764e81d42ac8109b235debbe4a59aec1f6
source:
  - path: "packages/oh-my-opencode-cohub/src/context/extractor.ts"
    line: 1
    end_line: 208
apis:
  - protocol: rpc
    path: "extractRelevantFiles"
    description:
      zh: >
          提取相关文件列表
          
      en: >
          Extract relevant file list
          
  - protocol: rpc
    path: "extractDecisions"
    description:
      zh: >
          提取决策记录
          
      en: >
          Extract decision records
          
  - protocol: rpc
    path: "extractErrors"
    description:
      zh: >
          提取错误信息
          
      en: >
          Extract error information
          
deps:
  - kind: call
    to: cohub.shared.token-estimator
---
