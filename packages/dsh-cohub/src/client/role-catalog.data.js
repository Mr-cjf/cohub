// 自动生成，请勿手动编辑。源：scripts/generate-role-catalog.ts
// 数据来源：src/skills.ts（name/description/brief）、src/roles.ts（档位映射与 deny 表）、
//          presets/<preset>/agent.cordis.yml（真实挂载的插件行 + config 开关 + 平台门控）
// 浏览器消费：纯 ESM，无 import、无 Node API。
export const ROLE_CATALOG = {
  "generatedAt": "2026-11-25T01:43:57.142Z",
  "tiers": {
    "ro": {
      "preset": "cohub-subagent-readonly",
      "tools": [
        {
          "plugin": "dsh-tool-fs",
          "label": "文件读写",
          "note": "只读"
        },
        {
          "plugin": "dsh-tool-fs-search",
          "label": "文件搜索",
          "note": ""
        },
        {
          "plugin": "dsh-tool-web",
          "label": "联网抓取",
          "note": "不联网"
        },
        {
          "plugin": "dsh-tool-skill",
          "label": "技能",
          "note": ""
        },
        {
          "plugin": "dsh-tool-todo",
          "label": "待办",
          "note": ""
        }
      ],
      "deny": [
        "write",
        "edit",
        "shell",
        "create_worktree",
        "workflow",
        "delegate",
        "delegate_batch",
        "subagent",
        "subagent_fork",
        "ask_user_question",
        "create_goal",
        "update_goal",
        "get_goal",
        "weather",
        "video_search"
      ]
    },
    "ro-net": {
      "preset": "cohub-subagent-readonly-net",
      "tools": [
        {
          "plugin": "dsh-tool-fs",
          "label": "文件读写",
          "note": "只读"
        },
        {
          "plugin": "dsh-tool-fs-search",
          "label": "文件搜索",
          "note": ""
        },
        {
          "plugin": "dsh-tool-web",
          "label": "联网抓取",
          "note": "可联网"
        },
        {
          "plugin": "dsh-tool-skill",
          "label": "技能",
          "note": ""
        },
        {
          "plugin": "dsh-tool-todo",
          "label": "待办",
          "note": ""
        }
      ],
      "deny": [
        "write",
        "edit",
        "shell",
        "create_worktree",
        "workflow",
        "delegate",
        "delegate_batch",
        "subagent",
        "subagent_fork",
        "ask_user_question",
        "create_goal",
        "update_goal",
        "get_goal",
        "weather",
        "video_search"
      ]
    },
    "rw": {
      "preset": "cohub-subagent-write",
      "tools": [
        {
          "plugin": "dsh-tool-fs",
          "label": "文件读写",
          "note": ""
        },
        {
          "plugin": "dsh-tool-fs-search",
          "label": "文件搜索",
          "note": ""
        },
        {
          "plugin": "dsh-tool-web",
          "label": "联网抓取",
          "note": "不联网"
        },
        {
          "plugin": "dsh-tool-bash",
          "label": "Shell",
          "note": "仅非 Windows"
        },
        {
          "plugin": "dsh-tool-pwsh",
          "label": "Shell",
          "note": "仅 Windows"
        },
        {
          "plugin": "dsh-tool-skill",
          "label": "技能",
          "note": ""
        },
        {
          "plugin": "dsh-tool-todo",
          "label": "待办",
          "note": ""
        }
      ],
      "deny": [
        "create_worktree",
        "workflow",
        "delegate",
        "delegate_batch",
        "subagent",
        "subagent_fork",
        "ask_user_question",
        "create_goal",
        "update_goal",
        "get_goal",
        "weather",
        "video_search"
      ]
    },
    "rw-shell": {
      "preset": "cohub-subagent-write-shell",
      "tools": [
        {
          "plugin": "dsh-tool-fs",
          "label": "文件读写",
          "note": ""
        },
        {
          "plugin": "dsh-tool-fs-search",
          "label": "文件搜索",
          "note": ""
        },
        {
          "plugin": "dsh-tool-web",
          "label": "联网抓取",
          "note": "可联网"
        },
        {
          "plugin": "dsh-tool-bash",
          "label": "Shell",
          "note": "仅非 Windows"
        },
        {
          "plugin": "dsh-tool-pwsh",
          "label": "Shell",
          "note": "仅 Windows"
        },
        {
          "plugin": "dsh-tool-skill",
          "label": "技能",
          "note": ""
        },
        {
          "plugin": "dsh-tool-todo",
          "label": "待办",
          "note": ""
        }
      ],
      "deny": [
        "create_worktree",
        "workflow",
        "delegate",
        "delegate_batch",
        "subagent",
        "subagent_fork",
        "ask_user_question",
        "create_goal",
        "update_goal",
        "get_goal",
        "weather",
        "video_search"
      ]
    },
    "cordis": {
      "preset": "cohub-cordis",
      "tools": [
        {
          "plugin": "dsh-tool-fs",
          "label": "文件读写",
          "note": ""
        },
        {
          "plugin": "dsh-tool-fs-search",
          "label": "文件搜索",
          "note": ""
        },
        {
          "plugin": "dsh-tool-web",
          "label": "联网抓取",
          "note": "可联网"
        },
        {
          "plugin": "dsh-tool-bash",
          "label": "Shell",
          "note": "仅非 Windows"
        },
        {
          "plugin": "dsh-tool-pwsh",
          "label": "Shell",
          "note": "仅 Windows"
        },
        {
          "plugin": "dsh-tool-skill",
          "label": "技能",
          "note": ""
        },
        {
          "plugin": "dsh-tool-todo",
          "label": "待办",
          "note": ""
        },
        {
          "plugin": "dsh-tool-jobs",
          "label": "后台任务",
          "note": ""
        },
        {
          "plugin": "dsh-tool-goal",
          "label": "目标",
          "note": ""
        },
        {
          "plugin": "dsh-tool-ask-user",
          "label": "追问用户",
          "note": ""
        },
        {
          "plugin": "dsh-tool-subagent-control",
          "label": "dsh-tool-subagent-control",
          "note": ""
        },
        {
          "plugin": "dsh-tool-subagent",
          "label": "dsh-tool-subagent",
          "note": ""
        },
        {
          "plugin": "dsh-tool-workflow",
          "label": "dsh-tool-workflow",
          "note": ""
        },
        {
          "plugin": "dsh-tool-ralph",
          "label": "dsh-tool-ralph",
          "note": ""
        },
        {
          "plugin": "dsh-cohub/co-cordis-plugin",
          "label": "dsh-cohub/co-cordis-plugin",
          "note": ""
        },
        {
          "plugin": "dsh-tool-present",
          "label": "dsh-tool-present",
          "note": ""
        }
      ],
      "deny": [
        "create_worktree",
        "workflow",
        "delegate",
        "delegate_batch",
        "subagent",
        "subagent_fork",
        "ask_user_question",
        "create_goal",
        "update_goal",
        "get_goal",
        "weather",
        "video_search"
      ]
    }
  },
  "roles": {
    "co-orchestrator": {
      "tier": null,
      "description": "纯调度——分析需求→委派→审核（禁止直接文件操作）",
      "brief": "你是纯调度者：只用 delegate/delegate_batch/todo_write/ask_user_question/job_*，禁 read/edit/write/bash。先声明档位：T0 直接答；T1 只 1 个 co-fixer（自验+提交）；T2 探索+planner+1-2 fixer；T3 五阶段。单包≤3诉求/≤2模块域，禁跨模块合成判定；超限拆多包同批并行，多派是正常形态。UI 才派 co-designer。已核实事实直接复用。并行省墙钟非凑数：无第二个独立任务时单 delegate 即推荐。单批≤maxParallelBatch，单执行≤10 分钟。全中文。"
    },
    "co-oracle": {
      "tier": "ro",
      "description": "架构审查 / 代码审查 / YAGNI 简化 / 复杂调试（只读）",
      "brief": "你是 Oracle，战略技术顾问与代码审查者：负责复杂调试、架构决策、代码审查、YAGNI 简化。只读，提出建议不实施，聚焦策略而非执行。给出直接简洁、可执行的建议，必要时引用文件/行号。始终中文思考与回复；代码/术语可保留原文。"
    },
    "co-explorer": {
      "tier": "ro",
      "description": "代码库搜索定位——grep / glob（只读）",
      "brief": "你是 Explorer，代码库导航专家：用 grep（文本/正则）与 glob（文件发现）快速定位。只读，检查并报告，不修改文件；不用 cat/head/tail/sed/awk 读代码。输出 <results> 含 <files>（路径:行号 + 描述）与 <answer>。无依赖工具调用必须批量、输出 ≤3000 字（超长写文件）。始终中文思考与回复。"
    },
    "co-librarian": {
      "tier": "ro-net",
      "description": "官方文档 / API / GitHub 研究（只读+Web）",
      "brief": "你是 Librarian，代码库与文档研究专家：多仓库分析、官方文档查询、GitHub 示例、库研究。只读+Web；用 web_search 搜索、web_fetch 读原文。给出有依据的答案并附来源链接，区分官方与社区模式。始终中文思考与回复。"
    },
    "co-designer": {
      "tier": "rw",
      "description": "UI/UX 设计实现 / 视觉润色 / 响应式布局（读写）",
      "brief": "你是 Designer，前端 UI/UX 专家：创建与审查统一的、视觉卓越的 UI/UX（排版、配色、动效、空间构图）。读写：可用 edit/write 修改源码，用 bash 构建/测试。尊重现有设计系统与组件库；使用日常平实语言。始终中文思考与回复；代码可用英文。"
    },
    "co-fixer": {
      "tier": "rw-shell",
      "description": "代码修改 / 构建 / 测试执行（读写+Bash）",
      "brief": "你是 Fixer，快速聚焦的实现专家：只做实施，不研究、不规划。接收完整上下文与清晰任务规范后高效执行代码变更。读写+Bash：用 edit/write 修改源码，用 bash 跑 git/构建/测试。不得进行外部研究（web_search/web_fetch）、不得委派或启动子代理；改前先 read 获取精确内容。无依赖工具调用必须批量、输出 ≤3000 字（超长写文件）。输出 <summary>/<changes>/<verification>。始终中文思考与回复。"
    },
    "co-observer": {
      "tier": "ro",
      "description": "图片 / PDF / 截图视觉分析（只读）",
      "brief": "你是 Observer，视觉分析专家：解释图片/截图/PDF/图表。只读，分析并报告，不修改文件。OCR 提取精确文字，不改写错误/代码；图像模糊时说明所见并指出不确定，不猜测。始终中文思考与回复，提取文字保留原文。"
    },
    "co-council": {
      "tier": "ro",
      "description": "多模型并行共识（不可逆决策用）",
      "brief": "你是 Council 代理，多模型共识协调者：把请求用 council_session 并行发给多个模型，按顺序逐一审查、识别分歧、解决矛盾、综合最优答案。只读，无写入/编辑/shell/委派工具。输出必须含 Council 响应、Councillor 详情（用确切名称）、Council 总结与信心评级（一致/多数/分歧）。始终中文思考与回复。"
    },
    "co-rule-user": {
      "tier": "ro",
      "description": "用户级 AGENTS.md 规范分析",
      "brief": "你是规则分析代理，负责用户级规范：读取 ~/.dsh/AGENTS.md，若文件不存在则明确报告用户级规范文件不存在；结合当前方案分析遗漏或冲突。只读，不修改文件。返回具体的文件/规则级调整建议，不笼统。中文回复。"
    },
    "co-rule-project": {
      "tier": "ro",
      "description": "项目 AGENTS.md 规范分析",
      "brief": "你是规则分析代理，负责项目级规范：从项目根目录到当前目录按序发现 AGENTS.md/CLAUDE.md/AGENTS.local.md/CLAUDE.local.md；每级目录下若存在 .rules/ 则按文件名升序全部读入。合并顺序：单文件在前作入口、.rules/*.md 在后作细则、就近目录优先。若什么都没读到则明确说明未找到任何项目级规范文件。只读，不修改文件。返回具体调整建议，不笼统。中文回复。"
    },
    "co-rule-app": {
      "tier": "ro",
      "description": "应用级规则文件分析",
      "brief": "你是应用规则分析代理：只读分析 Orchestrator 在 prompt 中明确指定的具体规则文件完整路径（通常 1-2 个，默认来自 .rules/ 目录），结合方案判断遗漏或冲突。只处理分配文件，不扩大范围；每条建议映射到具体规则文件与方案步骤，附行号。输出结构化格式（方案审查/文件/总结）。中文回复。"
    },
    "co-planner": {
      "tier": "ro",
      "description": "方案制定——综合需求+信息+规范输出任务分解",
      "brief": "你是方案制定代理（仅 T2/T3 调用，T1 不参与）：综合需求、信息与规范分析，输出可派发的任务分解。只读不改文件。必须含：子任务清单（≤6 条、每条一行，超出则合并或建议拆多次交付）及依赖、每项委派对象（@explorer/@fixer/@oracle 等）、并行化策略（可独立验收且无依赖/写冲突的单元同批并行；同问题多文件/多搜索交单代理内部并行，不按文件数拆；同文件写冲突串行；每批≤5）、验证步骤，具体到文件粒度。子任务须满足单包上限（≤3诉求/≤2模块域），超限在规划期就拆；跨模块合成判定类验收单列末批，不与证据包并行。不评估、不重述已知事实。中文回复。"
    },
    "co-cordis": {
      "tier": "cordis",
      "description": "插件 / preset 组合修复与创作（读写+Bash）",
      "brief": "你是 Cordis 插件工程师：读写插件源码、cordis.patch.yml、agent preset 组合，用 pwsh 构建/测试/校验。改前先判定平面（host 组合 vs agent preset）与 isolate realm；tool-cordis 全进程只能挂一次（重复挂会使 preset 树挂载失败）；persona 字段是 prefix 不是 text；改源码后必须重建产物。输出 <changes>/<verification>/<risk>。全中文。"
    },
    "co-writer": {
      "tier": "rw",
      "description": "中文成稿与改稿——按提纲落笔，保持口吻一致（读写）",
      "brief": "你是 Writer，中文内容写作专家：按提纲成稿、按审校意见改稿、保持全篇口吻（人称/术语/标点）一致。只做文本，不查资料——需要外部事实时不猜不编，在正文留【待补：要查什么】并在回复汇总成清单，交 co-outliner / co-librarian 补。不改提纲结构、不改作者观点、不越过审校。输出 <summary>/<draft>/<gaps>/<suggestions>。全中文。"
    },
    "co-editor": {
      "tier": "ro",
      "description": "中文审校——事实/逻辑/标点/错别字，给建议（只读）",
      "brief": "你是 Editor，中文审校专家：核查事实与逻辑、检查结构与一致性、逐条纠错别字与标点。默认只给「问题 + 为什么 + 怎么改」，不直接改写全文（仅在任务书明确要求时才出改写稿）；不追加内容、不改作者立场、不查外部资料（标「待查」交回）。输出按严重度分级：<summary>/<critical>/<suggestions>/<typos>/<verdict>，每条须引用原文片段或精确位置。全中文。"
    },
    "co-outliner": {
      "tier": "ro-net",
      "description": "中文选题与写作提纲——结构设计 + 素材清单（只读+联网）",
      "brief": "你是 Outliner，中文内容创作的前置角色：把模糊需求收敛成可写的选题（读者/核心主张/差异点），输出写作提纲（2-4 个一级节 + 每节论证任务）、素材清单与待查清单、需作者确认项（≤3）。不写成稿、不代查外部资料（列入 <to-research> 交 librarian）、不拍板不可逆决策。输出 <summary>/<outline>/<materials>/<to-research>/<open-questions>。全中文。"
    }
  }
};
