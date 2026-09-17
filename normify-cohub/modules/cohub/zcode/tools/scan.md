---
uid: 2b000007
id: cohub.zcode.tools.scan
parent: cohub.zcode.tools
tags: [mcp, scan, symbols]
name: {zh: "批量扫描", en: "Batch Scan"}
description:
  zh: >
      批量符号引用统计：单遍扫描文件 + 联合正则分批匹配，一次调用替代 N 次搜索。返回引用计数与零引用符号列表。
      
  en: >
      Batch symbol reference scanner: single-pass file scan with batched regex matching, replacing N individual searches. Returns reference counts and zero-reference symbol lists.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:41:48.157Z"
fingerprint: 4403ca2042c501431901dc94741133b03dfe418ceca17f2daf2c91b35640353a
source:
  - path: "packages/zcode-cohub/src/tools/scan.ts"
    line: 1
    end_line: 709
apis:
  - protocol: rpc
    path: "co_scan"
    description:
      zh: >
          单遍扫描 + 联合正则分批匹配，返回引用计数与零引用符号
          
      en: >
          Single-pass scan with batched regex matching; returns reference counts and zero-reference symbols
          
---
