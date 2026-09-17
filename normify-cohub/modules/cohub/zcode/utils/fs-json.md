---
uid: 2b000020
id: cohub.zcode.utils.fs-json
parent: cohub.zcode.utils
tags: [utils, fs, json]
name: {zh: "JSON 安全读", en: "JSON Safe Read"}
description:
  zh: >
      仅重导出自共享层 cohub.shared 的 readJsonFileSafe 函数。
      
  en: >
      Re-exports readJsonFileSafe from the shared cohub.shared layer only.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.551Z"
fingerprint: 80761d0b4626c3e614ee8bc53d46742ca85ca69430c7f3736a4462940995c9a9
source:
  - path: "packages/zcode-cohub/src/utils/fs-json.ts"
    line: 1
    end_line: 3
apis:
  - protocol: file
    path: "重导出 readJsonFileSafe"
    description:
      zh: >
          JSON 安全读取（重导出共享层）
          
      en: >
          Safe JSON read (re-exported from shared layer)
          
deps:
  - kind: call
    to: cohub.shared.fs-json
---
