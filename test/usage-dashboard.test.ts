import { describe, it, expect } from 'vitest';
import { ingestLine, summarize, localDay, type FileDigest } from '../src/usage-dashboard.js';

const fresh = (id = 's1'): FileDigest => ({ sessionId: id, project: '', lastDay: null, costState: null, days: {} });
const feed = (lines: unknown[], d = fresh()) => {
  const seen = new Map();
  for (const l of lines) ingestLine(d, typeof l === 'string' ? l : JSON.stringify(l), seen);
  return d;
};
// Local-noon timestamps so the local calendar day is the same in every timezone.
const at = (day: string) => new Date(`${day}T12:00:00`).toISOString();
const asst = (day: string, id: string, usage: object, content: unknown[] = [], model = 'claude-opus-5-5') => ({
  type: 'assistant',
  timestamp: at(day),
  sessionId: 's1',
  cwd: '/work/my-proj',
  message: { id, model, usage, content },
});
const U = (output: number) => ({
  input_tokens: 0,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});
const cost = (total: number, models: Record<string, number>) => ({
  type: 'cost-state',
  totalCostUSD: total,
  hasUnknownModelCost: false,
  modelUsage: Object.fromEntries(
    Object.entries(models).map(([m, c]) => [
      m,
      { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: c },
    ])
  ),
});
const NOW = new Date('2026-10-02T15:00:00'); // Friday; week starts Monday 2026-09-28

describe('usage dashboard parsing', () => {
  it('de-duplicates a message repeated per content block', () => {
    const d = feed([
      asst('2026-10-02', 'm1', U(100)),
      asst('2026-10-02', 'm1', U(100)),
      asst('2026-10-02', 'm2', U(50)),
    ]);
    expect(d.days['2026-10-02'].models['claude-opus-5-5'].output).toBe(150);
  });

  it('uses only the LAST cost-state (cumulative snapshots are never summed)', () => {
    const d = feed([cost(1, { a: 1 }), cost(3, { a: 3 })]);
    expect(d.costState?.totalCostUSD).toBe(3);
  });

  it('skips garbage and lines missing required fields without throwing', () => {
    const d = feed([
      '{not json "usage"',
      '"usage"',
      { type: 'cost-state' },
      { type: 'assistant', message: { usage: {} } },
      null as any,
    ]);
    expect(d.costState).toBeNull();
    expect(d.days).toEqual({});
  });

  it('counts Skill and mcp tools but not ordinary tools, once per message', () => {
    const content = [
      { type: 'tool_use', name: 'Skill', input: { skill: 'tdd' } },
      { type: 'tool_use', name: 'mcp__plugin_x__do', input: {} },
      { type: 'tool_use', name: 'Bash', input: {} },
    ];
    const d = feed([asst('2026-10-02', 'm1', U(1), content), asst('2026-10-02', 'm1', U(1), content)]);
    expect(d.days['2026-10-02'].tools).toEqual({ 'skill:tdd': 1, 'mcp:plugin_x': 1 });
  });

  it('counts errors and permission denials separately, without parsing the line', () => {
    const line = (extra: string) =>
      `{"type":"user","timestamp":"${at('2026-10-02')}","message":{"content":[{"type":"tool_result","content":"${extra}","is_error":true}]}}`;
    const d = feed([line('boom'), line("The user doesn't want to proceed with this tool use. x")]);
    expect(d.days['2026-10-02']).toMatchObject({ errors: 1, denials: 1 });
  });

  it('localDay rejects non-dates', () => {
    expect(localDay('nope')).toBeNull();
    expect(localDay(5)).toBeNull();
  });
});

describe('usage dashboard summary', () => {
  it('spreads a session over its days in proportion to tokens, and the parts add up to the total', () => {
    const d = feed([
      asst('2026-10-01', 'a', U(100)),
      asst('2026-10-02', 'b', U(300)),
      cost(8, { 'claude-opus-5-5': 8 }),
    ]);
    const s = summarize([d], [], NOW);
    expect(s.costToday).toBeCloseTo(6);
    expect(s.costWeek).toBeCloseTo(8);
  });

  it('counts only the in-week share of a session that began last week', () => {
    const d = feed([
      asst('2026-09-20', 'a', U(100)),
      asst('2026-10-02', 'b', U(100)),
      cost(10, { 'claude-opus-5-5': 10 }),
    ]);
    expect(summarize([d], [], NOW).costWeek).toBeCloseTo(5);
  });

  it('keeps a side-call model with no per-day data on the last day, so nothing is dropped', () => {
    const d = feed([asst('2026-10-02', 'a', U(10)), cost(3, { 'claude-opus-5-5': 2, 'claude-haiku-4-5-20251001': 1 })]);
    const s = summarize([d], [], NOW);
    expect(s.costToday).toBeCloseTo(3);
    expect(s.models.map((m) => m.model)).toContain('claude-haiku-4-5-20251001');
  });

  it("uses a running session's live cost when there is no cost-state", () => {
    const d = feed([asst('2026-10-02', 'a', U(10))]);
    expect(summarize([d], [], NOW)).toMatchObject({ costToday: 0, unrecordedWeek: 1 });
    expect(summarize([d], [{ claudeSessionId: 's1', costUsd: 2.5 }], NOW).costToday).toBeCloseTo(2.5);
  });

  it('reports unknown-cost sessions instead of a number', () => {
    const d = feed([
      asst('2026-10-02', 'a', U(10)),
      { ...cost(5, { 'claude-opus-5-5': 5 }), hasUnknownModelCost: true },
    ]);
    expect(summarize([d], [], NOW)).toMatchObject({ costToday: 0, unknownCostWeek: 1 });
  });

  it('ranks projects and reports no data as hasData=false', () => {
    expect(summarize([], [], NOW)).toMatchObject({ hasData: false, cacheHitRate: null, costWeek: 0 });
    const d = feed([asst('2026-10-02', 'a', U(10)), cost(2, { 'claude-opus-5-5': 2 })]);
    expect(summarize([d], [], NOW).projects).toEqual([{ project: 'my-proj', costUsd: expect.closeTo(2) }]);
  });

  it('computes the cache hit rate from cache reads over all input', () => {
    const d = feed([
      asst('2026-10-02', 'a', {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
      }),
    ]);
    expect(summarize([d], [], NOW).cacheHitRate).toBeCloseTo(0.8);
  });
});
