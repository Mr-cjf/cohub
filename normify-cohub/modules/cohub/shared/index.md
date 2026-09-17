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
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T09:08:13Z"
fingerprint: a0332342f41d1f1ef7f1ed465151186607df877401d23929fb54e399197fe265
source:
  - path: "cohub-shared/src/consensus.ts"
  - path: "cohub-shared/src/token-estimator.ts"
  - path: "cohub-shared/src/fs-json.ts"
  - path: "cohub-shared/src/fs-atomic.ts"
  - path: "cohub-shared/src/model.ts"
  - path: "cohub-shared/src/chinese.ts"
  - path: "cohub-shared/sync.ts"
---
