/**
 * @fileoverview Saved split layout (Switchboard T5) riding on the owner tab layout:
 * validation, pruning of gone sessions, and the service's ownership check on write.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  materializeOrphans,
  normalizeTabLayout,
  splitSessionIds,
  validateTabLayout,
  type SplitLayout,
  type TabLayout,
  type TabRefMetadata,
} from '../src/tab-layout.js';
import { TabLayoutService } from '../src/tab-layout-service.js';

const pane = (s: string | null) => ({ t: 'p' as const, s });
const row = (a: unknown, b: unknown, r = 50) => ({ t: 's' as const, d: 'row' as const, r, a, b }) as never;
const col = (a: unknown, b: unknown, r = 50) => ({ t: 's' as const, d: 'col' as const, r, a, b }) as never;

const base = (split?: unknown): TabLayout =>
  ({
    version: 1,
    groups: [],
    ungrouped: [
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'b' },
      { kind: 'session', id: 'c' },
    ],
    updatedAt: '2026-10-06T00:00:00.000Z',
    ...(split === undefined ? {} : { split }),
  }) as TabLayout;

const meta = (id: string, ownerValid = true, order = 0): TabRefMetadata => ({
  kind: 'session',
  id,
  ownerValid,
  visible: true,
  order,
});

describe('validateTabLayout: split', () => {
  it('accepts the default three-pane shape (left 1 + right top/bottom 2) and keeps focus', () => {
    const split: SplitLayout = { root: row(pane('a'), col(pane('b'), pane('c')), 53.5), focus: 1 };
    const out = validateTabLayout(base(split));
    expect(out.split).toEqual(split);
    expect(splitSessionIds(out.split)).toEqual(['a', 'b', 'c']);
  });

  it('treats a layout without a split as unchanged (no split key appears)', () => {
    expect('split' in validateTabLayout(base())).toBe(false);
  });

  it('allows empty panes, and a stored layout round-trips byte for byte', () => {
    const split = { root: row(pane('a'), pane(null)) };
    const out = validateTabLayout(base(split));
    expect(JSON.stringify(validateTabLayout(out))).toBe(JSON.stringify(out));
  });

  it.each([
    ['a single pane', { root: pane('a') }, /at least two panes/],
    ['five panes', { root: row(row(row(pane('a'), pane('b')), pane('c')), row(pane('d'), pane('e'))) }, /more than 4/],
    ['a session in two panes', { root: row(pane('a'), pane('a')) }, /two panes/],
    ['a ratio below the floor', { root: row(pane('a'), pane('b'), 2) }, /\.r must be/],
    ['a ratio above the ceiling', { root: row(pane('a'), pane('b'), 99) }, /\.r must be/],
    ['a non-finite ratio', { root: row(pane('a'), pane('b'), Number.NaN) }, /\.r must be/],
    ['an unknown direction', { root: { t: 's', d: 'diag', r: 50, a: pane('a'), b: pane('b') } }, /\.d must be/],
    ['an unknown node type', { root: { t: 'x' } }, /\.t must be/],
    ['an empty session id', { root: row(pane(''), pane('b')) }, /session id or null/],
    ['an overlong session id', { root: row(pane('x'.repeat(201)), pane('b')) }, /session id or null/],
    ['a focus past the last pane', { root: row(pane('a'), pane('b')), focus: 2 }, /focus/],
    ['a negative focus', { root: row(pane('a'), pane('b')), focus: -1 }, /focus/],
    ['a fractional focus', { root: row(pane('a'), pane('b')), focus: 0.5 }, /focus/],
    ['a split that is not an object', 'row', /layout\.split must be an object/],
  ])('rejects %s', (_label, split, message) => {
    expect(() => validateTabLayout(base(split))).toThrow(message);
  });

  it('refuses a split nested deeper than four panes can need', () => {
    const deep = row(pane('a'), row(pane('b'), row(pane('c'), row(pane('d'), pane(null)))));
    expect(() => validateTabLayout(base({ root: deep }))).toThrow();
  });

  it('copies only known fields, so extra keys never reach storage', () => {
    const polluted = { t: 'p', s: 'a', evil: 1 };
    const withTwo = { root: row(polluted, pane('b')), junk: true };
    const out = validateTabLayout(base(withTwo));
    expect(JSON.stringify(out.split)).not.toMatch(/evil|junk/);
  });
});

describe('normalizeTabLayout: split', () => {
  const split = { root: row(pane('a'), col(pane('b'), pane('c'))), focus: 2 };

  it('empties a pane whose session belongs to someone else, keeping the others', () => {
    const out = normalizeTabLayout(base(split), [meta('a'), meta('b'), meta('c', false)]);
    expect(out.split?.root).toEqual(row(pane('a'), col(pane('b'), pane(null))));
    expect(out.split?.focus).toBe(2);
  });

  it('keeps a pane whose session has no metadata yet (unknown is not invalid)', () => {
    const out = normalizeTabLayout(base(split), [meta('a'), meta('b')]);
    expect(splitSessionIds(out.split)).toEqual(['a', 'b', 'c']);
  });

  it('repairs a duplicate session by emptying the later pane instead of throwing', () => {
    const dup = { root: row(pane('a'), pane('a')) };
    const out = normalizeTabLayout(base(dup), [meta('a'), meta('b')]);
    expect(out.split?.root).toEqual(row(pane('a'), pane(null)));
  });

  it('drops the split when no pane has a valid session left', () => {
    const out = normalizeTabLayout(base({ root: row(pane('a'), pane('b')) }), [meta('a', false), meta('b', false)]);
    expect('split' in out).toBe(false);
  });

  it('is idempotent', () => {
    const metadata = [meta('a'), meta('b'), meta('c')];
    const once = normalizeTabLayout(base(split), metadata);
    expect(normalizeTabLayout(once, metadata)).toEqual(once);
  });
});

describe('materializeOrphans: split', () => {
  it('empties the panes of removed sessions and drops a split nothing is left in', () => {
    const split = { root: row(pane('a'), pane('b')) };
    const one = materializeOrphans(base(split), ['b'], [meta('a'), meta('b')]);
    expect(one.split?.root).toEqual(row(pane('a'), pane(null)));
    const none = materializeOrphans(base(split), ['a', 'b'], [meta('c')]);
    expect('split' in none).toBe(false);
  });
});

describe('TabLayoutService.put: split', () => {
  function service(layout: TabLayout, owned: string[], foreign: string[]) {
    let stored: TabLayout | null = layout;
    const persisted = Object.fromEntries(
      [...owned.map((id) => [id, { id, owner: undefined }]), ...foreign.map((id) => [id, { id, owner: 'other' }])].map(
        ([id, record], index) => [id, { ...(record as object), createdAt: index }]
      )
    );
    const store = {
      getTabLayout: vi.fn(() => stored),
      getTabLayouts: vi.fn(() => ({})),
      getSessions: vi.fn(() => persisted),
      getSessionOrder: vi.fn(() => [...owned, ...foreign]),
      commitTabLayoutProjection: vi.fn((updates: Record<string, TabLayout>) => {
        stored = structuredClone(Object.values(updates)[0]);
        return { layouts: structuredClone(updates), sessionOrder: [...owned, ...foreign] };
      }),
    };
    const svc = new TabLayoutService({
      store: store as never,
      sessions: new Map() as never,
      readWebviews: async () => [],
      broadcast: vi.fn(),
      broadcastSessionOrder: vi.fn(),
      now: () => '2026-10-06T12:00:00.000Z',
    });
    svc.markRestorationComplete();
    return svc;
  }

  const current = base();

  it('stores a split whose panes are all the owner’s and returns it on the next read', async () => {
    const svc = service(current, ['a', 'b', 'c'], []);
    const first = await svc.get('@single');
    const split = { root: row(pane('a'), col(pane('b'), pane('c')), 60), focus: 1 };
    const result = await svc.put('@single', { ...first, split }, first.version);
    expect(result.status).toBe('updated');
    expect(result.layout.split).toEqual(split);
    expect((await svc.get('@single')).split).toEqual(split);
  });

  it('rejects a split that names another owner’s session', async () => {
    const svc = service(current, ['a', 'b', 'c'], ['x']);
    const first = await svc.get('@single');
    const split = { root: row(pane('a'), pane('x')) };
    await expect(svc.put('@single', { ...first, split }, first.version)).rejects.toThrow(/not owned/);
  });

  it('clears the split when a later write omits it', async () => {
    const svc = service(current, ['a', 'b', 'c'], []);
    const first = await svc.get('@single');
    const withSplit = await svc.put('@single', { ...first, split: { root: row(pane('a'), pane('b')) } }, first.version);
    const { split: _gone, ...without } = withSplit.layout;
    const cleared = await svc.put('@single', without, withSplit.layout.version);
    expect('split' in cleared.layout).toBe(false);
  });
});
