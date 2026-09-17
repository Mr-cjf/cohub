---
uid: 1a25c251
id: cohub.opencode.tools.council
parent: cohub.opencode.tools
name: {zh: "Council 共识工具", en: "Council Consensus Tool"}
description:
  zh: >
      多模型并行共识：council_session+CouncilManager
      
  en: >
      Multi-model parallel consensus: council_session + CouncilManager
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:57:09.891Z"
fingerprint: caef08d982d79f193ff83a217bfb84f0b9c3840c962c68641ab8cbbd9757afb4
source:
  - path: "packages/oh-my-opencode-cohub/src/tools/council.ts"
    line: 1
    end_line: 725
apis:
  - protocol: rpc
    path: "opencode.council_session"
    description:
      zh: >
          启动 Council 共识会话
          
      en: >
          Start council consensus session
          
  - protocol: rpc
    path: "opencode.CouncilManager"
    description:
      zh: >
          Council 管理器
          
      en: >
          Council manager
          
deps:
  - kind: call
    to: cohub.shared.consensus.algorithm
  - kind: call
    to: cohub.shared.model
  - kind: call
    to: cohub.opencode.utils
  - kind: call
    to: cohub.opencode.task-manager.quality
  - kind: call
    to: cohub.opencode.tools.model-stats
  - kind: call
    to: cohub.opencode.tools.adaptive-params
---
