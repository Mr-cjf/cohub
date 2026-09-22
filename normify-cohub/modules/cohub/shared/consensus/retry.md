---
uid: cc33dd44
id: cohub.shared.consensus.retry
parent: cohub.shared.consensus
name: {zh: "重试决策与预算", en: "Retry Decisions & Budget"}
description:
  zh: >
      失败分类（timeout/empty/error/quality-low）、variant降级、重试预算（RetryBudget）、T2重试决策表（decideRetryAction：连击2次→needs-human，分类上限→give-up）与重试提示追加。
      
  en: >
      Failure classification, variant downgrade, retry budget (RetryBudget), T2 retry decision table (decideRetryAction), and retry context appending.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.365Z"
fingerprint: 16ec1b797750760deb69e2b63a377c124816c2788946e74f61907b1898214e2b
source:
  - path: "cohub-shared/src/consensus.ts"
    line: 64
    end_line: 70
  - path: "cohub-shared/src/consensus.ts"
    line: 116
    end_line: 122
  - path: "cohub-shared/src/consensus.ts"
    line: 168
    end_line: 193
  - path: "cohub-shared/src/consensus.ts"
    line: 199
    end_line: 204
  - path: "cohub-shared/src/consensus.ts"
    line: 278
    end_line: 300
apis:
  - protocol: rpc
    path: "decideRetryAction"
    description:
      zh: >
          T2重试决策表：consecutiveStreak≥2→needs-human，分类上限→give-up，否→retry
          
      en: >
          T2 retry decision: streak≥2→needs-human, limit reached→give-up, else→retry
          
  - protocol: rpc
    path: "classifyFailure"
    description:
      zh: >
          错误消息→FailureCategory：empty/timeout/error
          
      en: >
          Map error message to failure category
          
  - protocol: rpc
    path: "downgradeVariant"
    description:
      zh: >
          variant降级一步：max→high→medium→low→undefined
          
      en: >
          Downgrade variant one step: max→high→medium→low→undefined
          
  - protocol: rpc
    path: "appendRetryContext"
    description:
      zh: >
          按失败类别追加重试引导到prompt
          
      en: >
          Append retry guidance to prompt by failure category
          
  - protocol: rpc
    path: "RetryBudget"
    description:
      zh: >
          共享重试预算：retriesLeft+maxElapsedMs+consumeRetry()
          
      en: >
          Shared retry budget: retriesLeft+maxElapsedMs+consumeRetry()
          
---
