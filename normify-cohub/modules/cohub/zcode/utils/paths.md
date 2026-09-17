---
uid: 2b00001e
id: cohub.zcode.utils.paths
parent: cohub.zcode.utils
tags: [utils, paths]
name: {zh: "路径工具", en: "Path Utils"}
description:
  zh: >
      状态目录与追踪文件路径解析：getStateDir 返回插件数据目录，getTrackerFilePath 返回任务状态文件全路径。
      
  en: >
      State directory and tracker file path resolution: getStateDir returns the plugin data directory, getTrackerFilePath returns the task state file path.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:41:48.166Z"
fingerprint: 187030745366a64ba02fe2ef5e6d1fd97bd850ce79fffb07f57dc62b19497207
source:
  - path: "packages/zcode-cohub/src/utils/paths.ts"
    line: 1
    end_line: 22
apis:
  - protocol: rpc
    path: "getStateDir"
    description:
      zh: >
          返回插件数据目录
          
      en: >
          Return the plugin data directory
          
  - protocol: rpc
    path: "getTrackerFilePath"
    description:
      zh: >
          返回任务状态文件全路径
          
      en: >
          Return the full tracker file path
          
---
