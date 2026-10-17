// src/orchestration/contract.test.ts
// TDD: ContractManager 的 extract / buildPrompt / summarize

import type { AgentContract } from './types';

// ---- 最小化 bun:test 全局声明 ----
// Bun 运行时在全局注入 describe/test/expect；项目未安装 @types/bun，
// 因此用局部声明替代整文件 @ts-nocheck，使其余代码仍受类型检查约束。
interface ExpectResult {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toContain(expected: unknown): void;
  toMatch(expected: RegExp): void;
  toBeNull(): void;
  notToBeNull(): void;
  toBeLessThan(expected: number): void;
  readonly not: Omit<ExpectResult, 'not'>;
}
declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void): void;
declare function expect(actual: unknown): ExpectResult;

import { ContractManager, stripExistingContracts } from './contract';

describe('ContractManager', () => {
  // extract
  it('should extract contract block from output', () => {
    const mgr = new ContractManager();
    const output = `some text\n<!-- CONTRACT_BEGIN -->\n- 关键结果: 完成\n- 决策: 决定用 A\n- 修改文件: src/a.ts\n- 验证状态: passed\n- 验证详情: 10/10 tests\n- 待完成: 无\n- 警告: 无\n<!-- CONTRACT_END -->\nmore text`;
    const result = mgr.extract(output);
    expect(result).not.toBeNull();
    expect(result!.keyResult).toBe('完成');
    expect(result!.decisions).toEqual(['决定用 A']);
    expect(result!.filesChanged).toEqual(['src/a.ts']);
    expect(result!.validationStatus).toBe('passed');
    expect(result!.validationDetail).toBe('10/10 tests');
  });

  it('should return null when no contract block', () => {
    const mgr = new ContractManager();
    expect(mgr.extract('plain text without contract')).toBeNull();
  });

  it('should handle empty fields', () => {
    const mgr = new ContractManager();
    const output = `<!-- CONTRACT_BEGIN -->\n- 关键结果: 搜索完成\n- 决策: \n- 修改文件: \n- 验证状态: unknown\n<!-- CONTRACT_END -->`;
    const result = mgr.extract(output);
    expect(result).not.toBeNull();
    expect(result!.keyResult).toBe('搜索完成');
    expect(result!.decisions).toEqual([]);
    expect(result!.filesChanged).toEqual([]);
    expect(result!.validationStatus).toBe('unknown');
  });

  // buildPrompt
  it('should build prompt with constraints and prerequisites（不再重复输出目标）', () => {
    const mgr = new ContractManager();
    const prompt = mgr.buildPrompt({
      goal: '实现登录功能',
      prerequisites: [
        { from: 'exp-1', contract: { keyResult: '找到 AuthService', decisions: [], filesChanged: ['src/auth.ts'], validationStatus: 'passed', pendingItems: [], warnings: [] } },
      ],
      constraints: ['必须兼容 IE11'],
    });
    // 目标不再重复输出（避免与任务 prompt 中的目标重复膨胀）
    expect(prompt).not.toContain('实现登录功能');
    expect(prompt).not.toContain('- 目标:');
    // 真正约束与显式依赖交接保留
    expect(prompt).toContain('必须兼容 IE11');
    expect(prompt).toContain('exp-1');
    expect(prompt).toContain('找到 AuthService');
    expect(prompt).toContain('CONTRACT_END');
  });

  it('should build prompt with only constraints（真正约束保留）', () => {
    const mgr = new ContractManager();
    const prompt = mgr.buildPrompt({
      goal: '目标A',
      prerequisites: [],
      constraints: ['验收标准：测试通过'],
    });
    expect(prompt).toContain('验收标准：测试通过');
    expect(prompt).not.toContain('目标A');
    expect(prompt).toContain('CONTRACT_BEGIN');
  });

  it('should return empty string when only goal / empty constraints and prerequisites', () => {
    const mgr = new ContractManager();
    const prompt = mgr.buildPrompt({
      goal: '测试目标',
      prerequisites: [],
      constraints: [],
    });
    // 仅目标/空白约束/空前序：无实质内容 → 空字符串（入口仅追加非空契约，防空壳堆积）
    expect(prompt).toBe('');
  });

  // summarize
  it('should summarize multiple contracts', () => {
    const mgr = new ContractManager();
    const summary = mgr.summarize([
      { keyResult: 'A 完成', decisions: ['用 B'], filesChanged: ['a.ts'], validationStatus: 'passed', pendingItems: ['C'], warnings: [] },
      { keyResult: 'D 完成', decisions: ['用 E'], filesChanged: ['d.ts'], validationStatus: 'passed', pendingItems: [], warnings: ['注意 F'] },
    ]);
    expect(summary).toContain('A 完成');
    expect(summary).toContain('D 完成');
    expect(summary).toContain('注意 F');
  });
});

describe('stripExistingContracts', () => {
  const block = '<!-- CONTRACT_BEGIN -->\n- 关键结果: 测试\n<!-- CONTRACT_END -->';
  const goalOnlyBlock = '<!-- CONTRACT_BEGIN -->\n## 本任务前置上下文\n- 目标: 旧目标\n<!-- CONTRACT_END -->';

  it('should preserve non-goal-only CONTRACT block（含内容的契约块保守保留）', () => {
    const text = `前置内容\n${block}\n后置内容`;
    const result = stripExistingContracts(text);
    // 非空壳契约块（含关键结果等用户/子代理内容）不得被无差别删除
    expect(result).toContain('CONTRACT_BEGIN');
    expect(result).toContain('关键结果: 测试');
    expect(result).toContain('前置内容');
    expect(result).toContain('后置内容');
  });

  it('should remove goal-only shell block（插件自生成空壳被清理）', () => {
    const text = `前置内容\n${goalOnlyBlock}\n后置内容`;
    const result = stripExistingContracts(text);
    expect(result).not.toContain('CONTRACT_BEGIN');
    expect(result).not.toContain('CONTRACT_END');
    expect(result).not.toContain('- 目标: 旧目标');
    // 用户原文保留
    expect(result).toContain('前置内容');
    expect(result).toContain('后置内容');
  });

  it('should remove 30 goal-only shell blocks (g flag)', () => {
    const text = Array.from({ length: 30 }, () => goalOnlyBlock).join('\n');
    const result = stripExistingContracts(text);
    expect(result).not.toContain('CONTRACT_BEGIN');
    expect(result).not.toContain('CONTRACT_END');
    expect(result).not.toMatch(/<!-- CONTRACT/);
    // 块间换行符残留不影响功能，验证长度足够小
    expect(result.length).toBeLessThan(30);
  });

  it('should return text unchanged when no CONTRACT block', () => {
    const text = '普通文本，不含契约块';
    const result = stripExistingContracts(text);
    expect(result).toBe('普通文本，不含契约块');
  });

  it('should preserve exactly one CONTRACT_BEGIN in buildPrompt output', () => {
    const mgr = new ContractManager();
    const prompt = mgr.buildPrompt({
      goal: '测试目标',
      prerequisites: [],
      constraints: [],
    });
    const beginCount = (prompt.match(/CONTRACT_BEGIN/g) ?? []).length;
    const endCount = (prompt.match(/CONTRACT_END/g) ?? []).length;
    // 空参契约：buildPrompt 返回空字符串（不产生任何 CONTRACT 标记）
    expect(beginCount).toBe(0);
    expect(endCount).toBe(0);
    expect(prompt).toBe('');
  });
});