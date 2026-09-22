---
uid: dd66ee77
id: cohub.dsh.delegate.stall
parent: cohub.dsh.delegate
name: {zh: "停滞看门狗", en: "Stall Watchdog"}
description:
  zh: >
      N2停滞检测器（P3-1）：挂全局session/event总线，按run.id归属子代理事件，在线估计S1-S4信号（连续同类错误/无结果空转/纯推理无动作/重复调用循环），提前中止子代理并复用P1重试机制。默认关闭。
      
  en: >
      N2 stall detector (P3-1): attaches to session/event bus, dispatches by run.id, estimates S1-S4 signals, pre-aborts and reuses P1 retry. Disabled by default.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.327Z"
fingerprint: aa3f39fcf47e9dc7769232a67a4e3e75baafe7e5391cf58e23959c07ee4b408b
source:
  - path: "packages/dsh-cohub/src/delegate.ts"
    line: 36
    end_line: 52
  - path: "packages/dsh-cohub/src/delegate.ts"
    line: 121
    end_line: 288
apis:
  - protocol: rpc
    path: "StallWatchdog"
    description:
      zh: >
          N2停滞看门狗类：attach→consume→S1-S4检查→abort回调
          
      en: >
          Stall watchdog: attach→consume→S1-S4 checks→abort callback
          
---
