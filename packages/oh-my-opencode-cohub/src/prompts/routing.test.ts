// @ts-nocheck — Bun 测试在运行时执行，类型由 bun:test 全局提供
// src/prompts/routing.test.ts
// 提示词契约测试：两层并行（单元内工具并行 / 单元间代理并行）与委派粒度优化。
// 只断言提示词文本中的路由/委派契约，不逐字锁长段；不声称文本测试能证明
// 真实模型策略遵循或省 token（那需要运行期观测，非文本断言可证）。
// 直接读取 src/prompts/*.md 源文件，不依赖构建产物（src/prompts/*.ts 是 gitignore 的生成物）。

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)));

function readPrompt(name: string): string {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

const orchestrator = readPrompt('orchestrator');
const planner = readPrompt('planner');
const explorer = readPrompt('explorer');
const fixer = readPrompt('fixer');

describe('主代理纯调度禁止条款（完整保留）', () => {
  test('角色开头禁止使用文件/代码工具，仅允许调度工具', () => {
    expect(orchestrator).toContain('绝不亲自使用任何文件/代码操作工具');
    expect(orchestrator).toContain('可使用的工具是调度工具（task、todowrite）');
  });

  test('critical 规则 2 禁止委派无例外，且无主代理轻量只读例外', () => {
    expect(orchestrator).toContain('所有工具操作必须委派——无例外');
    expect(orchestrator).toContain('Orchestrator 禁止使用任何文件/代码操作工具');
    // 已撤回的"主代理轻量只读直达"不得残留为例外
    expect(orchestrator).not.toContain('轻量只读');
    expect(orchestrator).not.toContain('可直接 read');
  });
});

describe('单元内工具并行：细粒度操作聚合到同一子代理', () => {
  test('同目标多文件只读：单个 explorer 内部并行 read/grep/glob，不逐文件拆代理', () => {
    expect(explorer).toContain('需要时并行发起多个搜索');
    expect(explorer).toContain('同一条消息内一次性并行 read');
    expect(orchestrator).toContain('工作单元');
    // 旧"不同文件即拆代理"的依据不得残留
    expect(orchestrator).not.toContain('涉及不同文件且无依赖');
  });

  test('同缺陷多搜索：聚合到单个 explorer 内部并行并汇总结论', () => {
    expect(explorer).toContain('首轮宽泛并行'); // glob+grep+ast 同轮
    expect(orchestrator).toContain('同缺陷多搜索');
  });

  test('紧耦合多文件修改：单个 fixer 单元内并行 read 后批量 edit', () => {
    expect(fixer).toContain('同一条消息内一次性并行 read 所有目标文件');
    expect(fixer).toContain('批量 edit/write');
    expect(orchestrator).toContain('紧耦合多文件修改');
  });
});

describe('单元间代理并行：可独立执行与验收的工作才拆代理', () => {
  test('可独立执行与验收的工作单元：并行派发多个 fixer，不按文件数拆', () => {
    expect(orchestrator).toContain('可独立执行与验收');
    expect(orchestrator).toContain('无实际依赖');
    expect(orchestrator).toContain('不按文件数/操作数拆代理');
  });

  test('同文件写冲突串行，但其他无关任务不陪等', () => {
    expect(orchestrator).toContain('其他任务不陪等');
    expect(planner).toContain('其他任务不陪等');
  });
});

describe('并行粒度契约：独立执行/验收为界，无文件数/复杂度/四项独立硬门槛', () => {
  test('负向：旧"修改不同文件的任务放同一 Wave"重排规则不得残留', () => {
    expect(orchestrator).not.toContain('修改不同文件的任务放同一 Wave');
  });

  test('负向：复杂度或"目标/上下文/判断/交付四项独立"硬门槛不得残留', () => {
    expect(orchestrator).not.toContain('真正独立的复杂工作');
    expect(orchestrator).not.toContain('目标/上下文/判断/交付真正独立');
    expect(planner).not.toContain('目标/上下文/判断/交付真正独立');
  });

  test('正向：共享总目标/基础上下文不自动要求合并，可独立验收的小任务可多代理并行', () => {
    expect(orchestrator).toContain('共享总目标');
    expect(orchestrator).toContain('不自动要求合并');
    expect(planner).toContain('共享总目标');
  });
});

describe('专责与独立审查不可因聚合绕开', () => {
  test('规则专责分析与 librarian 官方核验仍必要', () => {
    expect(orchestrator).toContain('规则专责分析');
    expect(orchestrator).toContain('librarian 官方核验');
  });

  test('验证阶段独立审查由 oracle/designer 承担，不与实现者合并', () => {
    expect(orchestrator).toContain('编译通过后');
    expect(orchestrator).toContain('@co-oracle 代码审查');
    expect(orchestrator).toContain('独立审查');
  });
});

describe('1.18.5 预算与会话隔离保留', () => {
  test('200K 软预算保留（默认 200000，非硬上限）', () => {
    expect(orchestrator).toContain('默认 200000');
  });

  test('跨任务新会话 + 交接简报，不清空历史', () => {
    expect(orchestrator).toContain('优先新会话 + 交接简报');
    expect(orchestrator).toContain('不强制换 session');
    expect(orchestrator).toContain('不清空历史');
  });
});

describe('Planner 两层计划', () => {
  test('方案须同时说明单元内工具并行与单元间代理并行', () => {
    expect(planner).toContain('单元内工具并行');
    expect(planner).toContain('单元间代理并行');
    expect(planner).toContain('不按文件数拆');
  });
});
