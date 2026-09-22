---
uid: a1b2c3d4
id: cohub.shared.model
parent: cohub.shared
name: {zh: "模型标签提取", en: "Model Label Extractor"}
description:
  zh: >
      从 "provider/model" 形式提取末尾模型名，供 council 结果与 UI 展示短标签。是共享层中最小、被三包共同引用的纯函数。
      
  en: >
      Extracts the trailing model name from a "provider/model" string for short labels in council results and UI. The smallest pure helper in the shared layer, referenced by all three platform packages.
      
revision: 64bca9899ac80ea2f7f66aabcfa2206a0f32388b
updated_at: "2026-09-22T02:25:52.368Z"
fingerprint: ab461238c23eae6e86fd791aef2a1cca2d99891ce412f6353a66aa11c8a5c266
source:
  - path: "cohub-shared/src/model.ts"
    line: 1
    end_line: 8
apis:
  - protocol: rpc
    path: "shortModelLabel"
    description:
      zh: >
          从 provider/model 提取 / 后的模型名
          
      en: >
          Extract model name after / in provider/model
          
---
