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
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.347Z"
fingerprint: bf54e7d2212e882e4408bdf0d150ff198314948e96854fc03ac319c738a796c0
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
