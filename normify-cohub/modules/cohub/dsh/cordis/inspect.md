---
uid: f6ff66aa
id: cohub.dsh.cordis.inspect
parent: cohub.dsh.cordis
name: {zh: "Inspect 只读查询", en: "Inspect Read-Only Queries"}
description:
  zh: >
      三个只读查询工具：co_inspect_list（列出所有Provider）、co_inspect_query（按platform+provider+method查具体定义）、co_inspect_self（查当前会话自己管理/创建/激活的动态插件清单）。
      
  en: >
      Three read-only query tools: co_inspect_list (list all providers), co_inspect_query (fetch definition by platform+provider+method), co_inspect_self (inspect own session's dynamic plugin inventory).
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.325Z"
fingerprint: 9b4fcefadc0e73ec4a51ea06c368544e5efe03da8088a465503c0cde859e52d8
source:
  - path: "packages/dsh-cohub/src/co-cordis-plugin.ts"
    line: 22
    end_line: 100
apis:
  - protocol: rpc
    path: "co_inspect_list"
    description:
      zh: >
          列出Host端所有已知Cordis Inspect Provider
          
      en: >
          List all known Cordis Inspect Providers on host
          
  - protocol: rpc
    path: "co_inspect_query"
    description:
      zh: >
          按platform+provider+method查具体定义
          
      en: >
          Query specific definition by platform+provider+method
          
  - protocol: rpc
    path: "co_inspect_self"
    description:
      zh: >
          查当前会话自己管理/创建/激活的动态插件清单
          
      en: >
          Inspect own session dynamic plugin inventory
          
---
