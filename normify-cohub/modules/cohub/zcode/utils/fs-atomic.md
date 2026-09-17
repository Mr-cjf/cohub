---
uid: 2b00001f
id: cohub.zcode.utils.fs-atomic
parent: cohub.zcode.utils
tags: [utils, fs]
name: {zh: "原子文件写", en: "Atomic File Write"}
description:
  zh: >
      仅重导出自共享层 cohub.shared 的 writeFileAtomic 函数。
      
  en: >
      Re-exports writeFileAtomic from the shared cohub.shared layer only.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.551Z"
fingerprint: 0ada4a2d4db6b810cd961d3e1150fcb25c07d4a5d15a27ff3017516d752c9dcd
source:
  - path: "packages/zcode-cohub/src/utils/fs-atomic.ts"
    line: 1
    end_line: 3
apis:
  - protocol: file
    path: "重导出 writeFileAtomic"
    description:
      zh: >
          原子文件写入（重导出共享层）
          
      en: >
          Atomic file write (re-exported from shared layer)
          
deps:
  - kind: call
    to: cohub.shared.fs-atomic
---
