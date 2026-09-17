---
uid: c3d4e5f6
id: cohub.shared.fs-json
parent: cohub.shared
name: {zh: "安全 JSON 文件读取", en: "Safe JSON File Reader"}
description:
  zh: >
      泛型安全读取 JSON 文件：文件缺失/解析失败/类型校验不通过均返回默认值，不会抛错。统一了 tracker 与 grep-counter 中的重复 try-cache 模式。
      
  en: >
      Generic safe JSON file reader: returns a default value on missing file, parse failure, or type-guard rejection — never throws. Unifies duplicated try-catch patterns from tracker and grep-counter.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:14.096Z"
fingerprint: dba19bfcb625af2c65e2924fa123e98ce52294454580c9b5acf5c87fd971392a
source:
  - path: "cohub-shared/src/fs-json.ts"
    line: 1
    end_line: 39
apis:
  - protocol: rpc
    path: "readJsonFileSafe"
    description:
      zh: >
          安全读 JSON：existsSync→readFileSync→JSON.parse→可选 validate 类型守卫
          
      en: >
          Safe JSON read with optional type guard validate
          
---
