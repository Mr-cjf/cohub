---
uid: 2b000002
id: cohub.zcode.install
parent: cohub.zcode
tags: [install, cli]
name: {zh: "安装器", en: "Installer"}
description:
  zh: >
      一键安装脚本：注册 ZCode 插件、铺设 11 个角色 agent 到 ~/.zcode/agents/、复制 skills 与 hooks。
      
  en: >
      One-shot install script: registers the ZCode plugin, deploys 11 role agents to ~/.zcode/agents/, copies skills and hooks.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:41:48.156Z"
fingerprint: 97b60c2c7c346344d4261371eefdd3d4c1e67e18c15209759758a5c47ab8ca8c
source:
  - path: "packages/zcode-cohub/scripts/install.ts"
    line: 1
    end_line: 889
apis:
  - protocol: rpc
    path: "install"
    description:
      zh: >
          一键安装：插件注册 + 角色 agent 铺设 + 文件复制
          
      en: >
          One-shot install: plugin registration, role agent deployment, and file copy
          
---
