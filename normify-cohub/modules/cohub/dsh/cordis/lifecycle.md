---
uid: a7aa77bb
id: cohub.dsh.cordis.lifecycle
parent: cohub.dsh.cordis
name: {zh: "插件生命周期管理", en: "Plugin Lifecycle Management"}
description:
  zh: >
      四个写操作工具：co_define（定义不可变Package）、co_run（激活/切换）、co_stop（停止保留定义）、co_remove（彻底删除）。Client端激活可能需要用户审批。
      
  en: >
      Four write tools: co_define (define immutable package), co_run (activate/switch), co_stop (stop but keep definition), co_remove (delete completely). Client-side activation may require user approval.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.326Z"
fingerprint: 9b4fcefadc0e73ec4a51ea06c368544e5efe03da8088a465503c0cde859e52d8
source:
  - path: "packages/dsh-cohub/src/co-cordis-plugin.ts"
    line: 103
    end_line: 206
apis:
  - protocol: rpc
    path: "co_define"
    description:
      zh: >
          定义不可变Cordis Package（new/existing）
          
      en: >
          Define immutable Cordis Package (new/existing)
          
  - protocol: rpc
    path: "co_run"
    description:
      zh: >
          激活/切换动态插件（run/update）
          
      en: >
          Activate/switch dynamic plugin (run/update)
          
  - protocol: rpc
    path: "co_stop"
    description:
      zh: >
          停止插件保留定义，可重新激活
          
      en: >
          Stop plugin keeping definition, re-runnable
          
  - protocol: rpc
    path: "co_remove"
    description:
      zh: >
          彻底删除插件：停止+取消审批+删除所有版本
          
      en: >
          Completely remove: stop+cancel approvals+delete all versions
          
---
