---
uid: d4e5f6a7
id: cohub.shared.fs-atomic
parent: cohub.shared
name: {zh: "原子文件写入", en: "Atomic File Writer"}
description:
  zh: >
      先写临时文件再 rename，防止读取端拿到撕裂的 JSON。出错 re-throw 并 finally 清理 .tmp。提供文本与 JSON 两个变体。
      
  en: >
      Write to temp file then rename, preventing torn JSON reads. Re-throws on error with finally-cleanup. Provides text and JSON variants.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.365Z"
fingerprint: 7558bb4142063614ea8bcc1b88e7042bbd865dc41de5b79e7b42388a633e86fa
source:
  - path: "cohub-shared/src/fs-atomic.ts"
    line: 1
    end_line: 32
apis:
  - protocol: rpc
    path: "writeFileAtomic"
    description:
      zh: >
          原子写入文本：写.tmp→rename→finally清理
          
      en: >
          Atomic text write: .tmp→rename→finally cleanup
          
  - protocol: rpc
    path: "writeJsonFileAtomic"
    description:
      zh: >
          JSON.stringify后调用writeFileAtomic
          
      en: >
          JSON.stringify then writeFileAtomic
          
---
