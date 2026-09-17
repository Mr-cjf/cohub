---
uid: 2b000001
id: cohub.zcode.entry
parent: cohub.zcode
tags: [mcp, entry, tools]
name: {zh: "MCP 入口", en: "MCP Entry"}
description:
  zh: >
      MCP 服务器入口：注册 delegate / council / scan / close-job 四个工具，启动 stdio transport。
      
  en: >
      MCP server entry point: registers four tools (delegate, council, scan, close-job) and starts the stdio transport.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:16.551Z"
fingerprint: d41c3a0d077cf8d7463c0bc413cbf6dbec5c331168977f20b83065fa47418228
source:
  - path: "packages/zcode-cohub/src/index.ts"
    line: 1
    end_line: 133
apis:
  - protocol: file
    path: "MCP stdio Server"
    description:
      zh: >
          注册 4 个 MCP 工具并启动 stdio transport
          
      en: >
          Registers 4 MCP tools and starts the stdio transport
          
deps:
  - kind: call
    to: cohub.zcode.tools.delegate
  - kind: call
    to: cohub.zcode.tools.council
  - kind: call
    to: cohub.zcode.tools.job-control
  - kind: call
    to: cohub.zcode.tools.scan
  - kind: call
    to: cohub.zcode.tracker
  - kind: call
    to: cohub.zcode.context.engine
  - kind: call
    to: cohub.zcode.context.strategy
---
