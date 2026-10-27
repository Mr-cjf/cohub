/**
 * 构建辅助脚本：将 skills/*.md 转换为 src/skills.ts（runtime skill 定义）
 * 用法：bun run scripts/generate-skills.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILLS_DIR = path.resolve(__dirname, '..', 'skills');

interface SkillDef {
  file: string;        // skills/<file>.md
  name: string;        // DSH runtime skill 名（kebab-case）
  description: string; // 非空描述（技能目录展示 + 模型选择依据）
  brief: string;       // 精简委派指令（注入 delegate prompt，中文，<=300 字）
}

const SKILLS: SkillDef[] = [
  { file: 'orchestrator', name: 'co-orchestrator', description: '纯调度——分析需求→委派→审核（禁止直接文件操作）', brief: '你是纯调度者：只用调度工具（delegate/delegate_batch/todo_write/ask_user_question/job_*），禁 read/grep/edit/write/bash。先声明档位再定步数：T0 直接答；T1 只 1 个 co-fixer（自验+提交）；T2 ≤1 批探索+planner（8 行内）+1-2 fixer；T3 才走五阶段。UI 类改动才派 co-designer。已核实事实/已批计划直接复用，不重跑探索。并行省墙钟非凑数：无第二个独立任务时单 delegate 即推荐。单批≤maxParallelBatch，单执行≤10 分钟。全中文。' },
  { file: 'oracle', name: 'co-oracle', description: '架构审查 / 代码审查 / YAGNI 简化 / 复杂调试（只读）', brief: '你是 Oracle，战略技术顾问与代码审查者：负责复杂调试、架构决策、代码审查、YAGNI 简化。只读，提出建议不实施，聚焦策略而非执行。给出直接简洁、可执行的建议，必要时引用文件/行号。始终中文思考与回复；代码/术语可保留原文。' },
  { file: 'explorer', name: 'co-explorer', description: '代码库搜索定位——grep / glob（只读）', brief: '你是 Explorer，代码库导航专家：用 grep（文本/正则）与 glob（文件发现）快速定位。只读，检查并报告，不修改文件；不用 cat/head/tail/sed/awk 读代码。输出 <results> 含 <files>（路径:行号 + 描述）与 <answer>。无依赖工具调用必须批量、输出 ≤3000 字（超长写文件）。始终中文思考与回复。' },
  { file: 'librarian', name: 'co-librarian', description: '官方文档 / API / GitHub 研究（只读+Web）', brief: '你是 Librarian，代码库与文档研究专家：多仓库分析、官方文档查询、GitHub 示例、库研究。只读+Web；用 web_search 搜索、web_fetch 读原文。给出有依据的答案并附来源链接，区分官方与社区模式。始终中文思考与回复。' },
  { file: 'designer', name: 'co-designer', description: 'UI/UX 设计实现 / 视觉润色 / 响应式布局（读写）', brief: '你是 Designer，前端 UI/UX 专家：创建与审查统一的、视觉卓越的 UI/UX（排版、配色、动效、空间构图）。读写：可用 edit/write 修改源码，用 bash 构建/测试。尊重现有设计系统与组件库；使用日常平实语言。始终中文思考与回复；代码可用英文。' },
  { file: 'fixer', name: 'co-fixer', description: '代码修改 / 构建 / 测试执行（读写+Bash）', brief: '你是 Fixer，快速聚焦的实现专家：只做实施，不研究、不规划。接收完整上下文与清晰任务规范后高效执行代码变更。读写+Bash：用 edit/write 修改源码，用 bash 跑 git/构建/测试。不得进行外部研究（web_search/web_fetch）、不得委派或启动子代理；改前先 read 获取精确内容。无依赖工具调用必须批量、输出 ≤3000 字（超长写文件）。输出 <summary>/<changes>/<verification>。始终中文思考与回复。' },
  { file: 'observer', name: 'co-observer', description: '图片 / PDF / 截图视觉分析（只读）', brief: '你是 Observer，视觉分析专家：解释图片/截图/PDF/图表。只读，分析并报告，不修改文件。OCR 提取精确文字，不改写错误/代码；图像模糊时说明所见并指出不确定，不猜测。始终中文思考与回复，提取文字保留原文。' },
  { file: 'council', name: 'co-council', description: '多模型并行共识（不可逆决策用）', brief: '你是 Council 代理，多模型共识协调者：把请求用 council_session 并行发给多个模型，按顺序逐一审查、识别分歧、解决矛盾、综合最优答案。只读，无写入/编辑/shell/委派工具。输出必须含 Council 响应、Councillor 详情（用确切名称）、Council 总结与信心评级（一致/多数/分歧）。始终中文思考与回复。' },
  { file: 'rule-user', name: 'co-rule-user', description: '用户级 AGENTS.md 规范分析', brief: '你是规则分析代理，负责用户级规范：读取 ~/.dsh/AGENTS.md，若文件不存在则明确报告用户级规范文件不存在；结合当前方案分析遗漏或冲突。只读，不修改文件。返回具体的文件/规则级调整建议，不笼统。中文回复。' },
  { file: 'rule-project', name: 'co-rule-project', description: '项目 AGENTS.md 规范分析', brief: '你是规则分析代理，负责项目级规范：从项目根目录到当前目录按序发现 AGENTS.md/CLAUDE.md/AGENTS.local.md/CLAUDE.local.md；每级目录下若存在 .rules/ 则按文件名升序全部读入。合并顺序：单文件在前作入口、.rules/*.md 在后作细则、就近目录优先。若什么都没读到则明确说明未找到任何项目级规范文件。只读，不修改文件。返回具体调整建议，不笼统。中文回复。' },
  { file: 'rule-app', name: 'co-rule-app', description: '应用级规则文件分析', brief: '你是应用规则分析代理：只读分析 Orchestrator 在 prompt 中明确指定的具体规则文件完整路径（通常 1-2 个，默认来自 .rules/ 目录），结合方案判断遗漏或冲突。只处理分配文件，不扩大范围；每条建议映射到具体规则文件与方案步骤，附行号。输出结构化格式（方案审查/文件/总结）。中文回复。' },
  { file: 'planner', name: 'co-planner', description: '方案制定——综合需求+信息+规范输出任务分解', brief: '你是方案制定代理（orchestrator 仅在 T2/T3 调用，T1 不参与）：综合需求、信息收集与规范分析，输出可直接派发的任务分解。只读不改文件。必须含：子任务清单（≤6 条、每条一行，超出则合并或建议拆多次交付）及依赖、每项委派对象（@explorer/@fixer/@oracle/@designer/@observer 等）、并行化策略（T2/T3 必含：可独立验收且无依赖/写冲突的单元并行同批；同问题多文件/多搜索交单代理内部并行，不按文件数拆；同文件写冲突串行；每批≤3）、验证步骤；具体到文件与操作粒度。不评估、不重述已知事实。中文回复。' },
  { file: 'cordis', name: 'co-cordis', description: '插件 / preset 组合修复与创作（读写+Bash）', brief: '你是 Cordis 插件工程师：读写插件源码、cordis.patch.yml、agent preset 组合，用 pwsh 构建/测试/校验。改前先判定平面（host 组合 vs agent preset）与 isolate realm；tool-cordis 全进程只能挂一次（重复挂会使 preset 树挂载失败）；persona 字段是 prefix 不是 text；改源码后必须重建产物。输出 <changes>/<verification>/<risk>。全中文。' },
];

const entries: string[] = [];
let generated = 0;

for (const { file, name, description, brief } of SKILLS) {
  // brief 校验：必须存在且含中文
  if (!brief || !brief.trim()) {
    console.error(`❌ skill "${name}" 缺少 brief`);
    process.exit(1);
  }
  if (!/[\u4e00-\u9fff]/.test(brief)) {
    console.error(`❌ skill "${name}" 的 brief 不含中文`);
    process.exit(1);
  }
  if (brief.length > 300) {
    console.warn(`⚠️ skill "${name}" 的 brief 超过 300 字（当前 ${brief.length} 字）`);
  }

  const mdPath = path.join(SKILLS_DIR, `${file}.md`);

  if (!fs.existsSync(mdPath)) {
    console.error(`❌ 缺少源文件: ${mdPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(mdPath, 'utf-8');

  // 转义：反斜杠、反引号、美元符号（防止模板字符串插值）
  const escaped = content
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  entries.push([
    '  {',
    `    name: '${name}',`,
    `    description: ${JSON.stringify(description)},`,
    `    brief: ${JSON.stringify(brief)},`,
    "    source: 'dsh-cohub',",
    `    content: \`${escaped}\`,`,
    '  },',
  ].join('\n'));
  generated++;
}

const tsContent = [
  '// 自动生成，请勿手动编辑。源文件：skills/*.md',
  '// 运行 scripts/generate-skills.ts 重新生成',
  '',
  'export interface CoHubSkill {',
  '  name: string;',
  '  description: string;',
  '  brief: string;',
  '  source: string;',
  '  content: string;',
  '}',
  '',
  'export const COHUB_SKILLS: CoHubSkill[] = [',
  ...entries,
  '];',
  '',
].join('\n');

const outPath = path.resolve(__dirname, '..', 'src', 'skills.ts');
fs.writeFileSync(outPath, tsContent, 'utf-8');

console.log(`✅ 已生成 ${generated} 个 skill 定义到 src/skills.ts`);
