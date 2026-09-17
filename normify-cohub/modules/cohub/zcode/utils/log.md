---
uid: 2b000021
id: cohub.zcode.utils.log
parent: cohub.zcode.utils
tags: [utils, log]
name: {zh: "诊断日志", en: "Diagnostic Log"}
description:
  zh: >
      最佳尽力追加式诊断日志：写入 $TMPDIR/zcode-cohub.log，失败静默。
      
  en: >
      Best-effort append-only diagnostic logger: writes to $TMPDIR/zcode-cohub.log, fails silently.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:45:12.688Z"
fingerprint: adc8c3594e149dc20c35aaa160d9d466a25cc95424103b430bae8fd7dd3a982e
source:
  - path: "packages/zcode-cohub/src/utils/log.ts"
    line: 1
    end_line: 26
apis:
  - protocol: rpc
    path: "zcode.appendLog"
    description:
      zh: >
          追加式诊断日志写入
      en: >
          Append-only diagnostic log write
---
