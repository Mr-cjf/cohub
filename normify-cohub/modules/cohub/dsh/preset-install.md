---
uid: b2bb22cc
id: cohub.dsh.preset-install
parent: cohub.dsh
name: {zh: "Preset 安装与升级", en: "Preset Install & Upgrade"}
description:
  zh: >
      内置agent preset的安装、升级与孤儿清理。通过.cohub-preset-install.json台账逐文件SHA-256比对：不丢修复（覆盖未改文件）、不踩用户自定义（跳过已改文件）、清理不再发布的孤儿preset。
      
  en: >
      Installs, upgrades, and cleans built-in agent presets via per-file SHA-256 ledger: never miss fixes, never overwrite user changes, remove orphaned presets.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.332Z"
fingerprint: 0f4ca3e56748fa799380ccf57b37b3eecd0a50dc4a3f8fce6f81c53b32bea6e3
source:
  - path: "packages/dsh-cohub/src/preset-install.ts"
    line: 1
    end_line: 353
apis:
  - protocol: rpc
    path: "installShippedPresets"
    description:
      zh: >
          安装/升级内置preset：逐文件SHA-256比对→覆盖未改/跳过已改/清理孤儿
          
      en: >
          Install/upgrade presets: per-file SHA-256→overwrite/skip/remove
          
  - protocol: rpc
    path: "hashTree"
    description:
      zh: >
          递归收集目录下所有文件的相对路径→SHA-256
          
      en: >
          Recursively collect file relative-path→SHA-256
          
  - protocol: rpc
    path: "copyTree"
    description:
      zh: >
          递归复制目录树（目录不存在则创建）
          
      en: >
          Recursively copy dir tree (mkdir if absent)
          
---
