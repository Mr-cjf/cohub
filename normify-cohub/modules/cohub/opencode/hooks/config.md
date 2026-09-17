---
uid: 1a32d321
id: cohub.opencode.hooks.config
parent: cohub.opencode.hooks
name: {zh: "配置 Hook", en: "Config Hook"}
description:
  zh: >
      config/dispose：双重注册与中文注入
      
  en: >
      config/dispose: dual registration and Chinese injection
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:54:08.898Z"
fingerprint: 08723fd31d2d61ce204a92350157f09bc335d08fe498b1845afa464720b4dd3d
source:
  - path: "packages/oh-my-opencode-cohub/src/index.ts"
    line: 402
    end_line: 459
apis:
  - protocol: file
    path: "config"
    description:
      zh: >
          配置事件
          
      en: >
          Config event
          
  - protocol: file
    path: "dispose"
    description:
      zh: >
          销毁事件
          
      en: >
          Dispose event
          
---
