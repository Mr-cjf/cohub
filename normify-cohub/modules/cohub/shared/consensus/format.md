---
uid: dd44ee55
id: cohub.shared.consensus.format
parent: cohub.shared.consensus
name: {zh: "结果格式化与协商", en: "Result Formatting & Deliberation"}
description:
  zh: >
      模型引用解析（parseModelReference）、组合展示（formatModelComposition）、自适应键（adaptiveKey）、议员结果格式化（formatCouncillorResults）、协商prompt构建（buildDeliberationPrompt）等展示层函数。
      
  en: >
      Model reference parsing, composition display, adaptive keys, councillor result formatting, and deliberation prompt building — all presentation-layer functions.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.364Z"
fingerprint: 16ec1b797750760deb69e2b63a377c124816c2788946e74f61907b1898214e2b
source:
  - path: "cohub-shared/src/consensus.ts"
    line: 128
    end_line: 135
  - path: "cohub-shared/src/consensus.ts"
    line: 141
    end_line: 145
  - path: "cohub-shared/src/consensus.ts"
    line: 152
    end_line: 154
  - path: "cohub-shared/src/consensus.ts"
    line: 159
    end_line: 162
  - path: "cohub-shared/src/consensus.ts"
    line: 306
    end_line: 403
apis:
  - protocol: rpc
    path: "formatCouncillorResults"
    description:
      zh: >
          格式化所有议员结果到结构化文本块，供council agent综合
          
      en: >
          Format all councillor results into structured text for council agent synthesis
          
  - protocol: rpc
    path: "formatCouncillorPrompt"
    description:
      zh: >
          合并用户prompt与可选的议员专属前缀
          
      en: >
          Merge user prompt with optional councillor-specific prefix
          
  - protocol: rpc
    path: "buildDeliberationPrompt"
    description:
      zh: >
          构建serial第二轮起的协商prompt：注入上一轮其他成员意见
          
      en: >
          Build deliberation prompt for serial round 2+: inject others' opinions
          
  - protocol: rpc
    path: "formatModelComposition"
    description:
      zh: >
          构建可读模型组合串，如"expert1: gpt-4, expert2: claude-3"
          
      en: >
          Build readable model composition string
          
  - protocol: rpc
    path: "adaptiveKey"
    description:
      zh: >
          (strategy,agent)自适应参数表键
          
      en: >
          Adaptive parameter table key: (strategy,agent)
          
  - protocol: rpc
    path: "parseModelReference"
    description:
      zh: >
          解析"provider/model"引用，格式无效返回null
          
      en: >
          Parse provider/model reference; returns null on invalid format
          
deps:
  - kind: call
    to: cohub.shared.model
---
