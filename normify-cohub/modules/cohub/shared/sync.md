---
uid: e1f2a3b4
id: cohub.shared.sync
parent: cohub.shared
name: {zh: "同步脚本", en: "Sync Script"}
description:
  zh: >
      把 cohub-shared/src/ 下的共享源文件复制到三个平台包的 shared/ 子目录，附带自动生成头部与 SHA-256 漂移检测。--check 模式仅检测漂移（退出码 1 = 有漂移）。
      
  en: >
      Copies shared sources into three platform packages' shared/ dirs with auto-generated headers and SHA-256 drift detection. --check mode only detects drift (exit 1 = drift).
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:14.099Z"
fingerprint: b6cf6a642194840d4d190901a963755c6b64157820048ab35e2130000a455163
source:
  - path: "cohub-shared/sync.ts"
    line: 1
    end_line: 165
apis:
  - protocol: rpc
    path: "sync --check"
    description:
      zh: >
          检测共享源到三包的漂移（退出码1=有漂移）；不加--check执行同步覆盖
          
      en: >
          Detect drift to three packages (exit 1=drift); without --check performs sync+overwrite
          
---
