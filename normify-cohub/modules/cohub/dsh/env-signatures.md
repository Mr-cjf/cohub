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
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:14.102Z"
fingerprint: 62efb74beec81ffce4d66f25982948bf67b0402497cf0046d61ab206685794aa
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
