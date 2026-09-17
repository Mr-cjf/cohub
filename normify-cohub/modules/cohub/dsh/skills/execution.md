---
uid: d0dd00ee
id: cohub.dsh.skills.execution
parent: cohub.dsh.skills
name: {zh: "执行技能集", en: "Execution Skills"}
description:
  zh: >
      co-fixer（代码修改+构建+测试）、co-designer（UI/UX设计实现+视觉润色）、co-explorer（代码库搜索定位）、co-librarian（官方文档/API研究）、co-observer（图片/PDF视觉分析）五个执行技能。
      
  en: >
      co-fixer (code changes+build+test), co-designer (UI/UX design+visual polish), co-explorer (codebase search), co-librarian (docs/API research), co-observer (image/PDF analysis) — five execution skills.
      
revision: e379ff6ddc6e3d0bf13e27c1edb3e98f2364f52f
updated_at: "2026-09-17T01:26:22.112Z"
fingerprint: 44913c848ceb32f8140c4eabefc193cea920424b9031af1e5ca32e850825e1d0
source:
  - path: "packages/dsh-cohub/skills/fixer.md"
  - path: "packages/dsh-cohub/skills/designer.md"
  - path: "packages/dsh-cohub/skills/explorer.md"
  - path: "packages/dsh-cohub/skills/librarian.md"
  - path: "packages/dsh-cohub/skills/observer.md"
apis:
  - protocol: file
    path: "co-fixer"
    description:
      zh: >
          代码修改/构建/测试执行（读写+Bash）
          
      en: >
          Code changes/build/test execution (read-write+Bash)
          
  - protocol: file
    path: "co-designer"
    description:
      zh: >
          UI/UX设计实现/视觉润色/响应式布局（读写）
          
      en: >
          UI/UX design/visual polish/responsive layout (read-write)
          
  - protocol: file
    path: "co-explorer"
    description:
      zh: >
          代码库搜索定位：grep/glob/AST（只读）
          
      en: >
          Codebase search: grep/glob/AST (read-only)
          
  - protocol: file
    path: "co-librarian"
    description:
      zh: >
          官方文档/API/GitHub研究（只读+Web）
          
      en: >
          Docs/API/GitHub research (read-only+Web)
          
  - protocol: file
    path: "co-observer"
    description:
      zh: >
          图片/PDF/截图视觉分析（只读）
          
      en: >
          Image/PDF/screenshot visual analysis (read-only)
          
---
