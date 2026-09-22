---
uid: a1aa11bb
id: cohub.dsh.env-signatures
parent: cohub.dsh
name: {zh: "环境契约持久化", en: "Env-Contract Persistence"}
description:
  zh: >
      P3-2（N1）执行器环境契约持久化：把P0/P1的每次探针升级为一次学习持续使用。包含环境指纹计算、缓存读写、契约文本生成、错误签名归一化与EnvSignatureLearner观测器。
      
  en: >
      P3-2 (N1) env-contract persistence: upgrade per-run probing to learn-once-reuse. Includes env fingerprint, cache read/write, contract text, error signature normalization, and EnvSignatureLearner.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.329Z"
fingerprint: 6216f329fcff0179a2543f756496919c3d2bae1ca31600356f82208e9eb6054b
source:
  - path: "packages/dsh-cohub/src/env-signatures.ts"
    line: 1
    end_line: 368
apis:
  - protocol: rpc
    path: "EnvSignatureLearner"
    description:
      zh: >
          环境契约学习器：挂事件总线→累计环境契约类错误签名→flush写缓存
          
      en: >
          Contract learner: attach bus→accumulate sigs→flush write cache
          
  - protocol: rpc
    path: "normalizeErrorSignature"
    description:
      zh: >
          归一化tool/result错误数据为可比较签名字符串
          
      en: >
          Normalize tool/result error to comparable signature
          
---
