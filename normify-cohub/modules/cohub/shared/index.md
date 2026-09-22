---
uid: 7cf34c3f
id: cohub.shared
parent: cohub
tags: [shared, single-source]
name: {zh: "跨包共享层", en: "Cross-package Shared Layer"}
description:
  zh: >
      六个零平台依赖的纯逻辑模块的单一真源，经同步脚本复制到三个平台包，附 SHA-256 漂移检测。
      
  en: >
      Single source of truth for six platform-independent pure-logic modules, synced into the three platform packages with SHA-256 drift detection.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.368Z"
fingerprint: 6784da257daa66abaad24ab97e3daaf613ca661cfee4fc3d4400927c0160f9e8
source:
  - path: "cohub-shared/src/consensus.ts"
  - path: "cohub-shared/src/token-estimator.ts"
  - path: "cohub-shared/src/fs-json.ts"
  - path: "cohub-shared/src/fs-atomic.ts"
  - path: "cohub-shared/src/model.ts"
  - path: "cohub-shared/src/chinese.ts"
  - path: "cohub-shared/sync.ts"
---
