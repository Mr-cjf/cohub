---
uid: 4d000003
id: cohub.opencode.cli.main
parent: cohub.opencode.cli
tags: [cli, opencode, entrypoint]
name: {zh: "CLI 命令入口", en: "CLI Command Entry"}
description:
  zh: >
      OpenCode 插件安装、卸载与统计的命令行入口
      
  en: >
      Entry point for plugin install, uninstall, and statistics commands
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.342Z"
fingerprint: e0fed8b0d59fedc7663d5f307eac2f896b8bf3ff089bc60ca708922b41b8a3b1
source:
  - path: "packages/oh-my-opencode-cohub/src/cli/index.ts"
    line: 1
    end_line: 217
apis:
  - protocol: rpc
    path: "opencode.cli.install"
    description:
      zh: >
          安装插件到 OpenCode 配置
          
      en: >
          Install plugin into OpenCode config
          
  - protocol: rpc
    path: "opencode.cli.uninstall"
    description:
      zh: >
          从 OpenCode 配置卸载插件
          
      en: >
          Uninstall plugin from OpenCode config
          
  - protocol: rpc
    path: "opencode.cli.stats"
    description:
      zh: >
          输出插件使用统计
          
      en: >
          Print plugin usage statistics
          
---
