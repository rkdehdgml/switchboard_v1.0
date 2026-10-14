// Port: N/A (pure helpers, loaded via `vm` like split-pane-helpers.test.ts).
//
// The split layout tree (Switchboard T5): which pane splits where, the 4-pane cap, the default
// three-pane shape, and the save/restore round trip including the ways a saved layout can be bad.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function load() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'constants.js' });
  return (context.window as { CodemanSplitPane: any }).CodemanSplitPane;
}

const T = load();
const leaf = (key: number, s: string | null) => ({ t: 'p', key, s });
let counter = 100;
const nextKey = () => counter++;
const sessions = (root: any) => T.splitLeaves(root).map((l: any) => l.s);

describe('splitAddPane', () => {
  it('splits a pane side by side or stacked and puts the new pane second', () => {
    const a = leaf(1, 'a');
    const row = T.splitAddPane(a, 1, 'row', leaf(2, 'b'));
    expect(row).toMatchObject({ t: 's', d: 'row', r: 50 });
    expect(sessions(row)).toEqual(['a', 'b']);
    const col = T.splitAddPane(a, 1, 'col', leaf(2, 'b'));
    expect(col).toMatchObject({ d: 'col' });
  });

  it('makes the default three-pane shape (left 1 + right top/bottom 2) with the left pane wider', () => {
    const two = T.splitAddPane(leaf(1, 'a'), 1, 'row', leaf(2, 'b'));
    const three = T.splitAddPane(two, 2, 'col', leaf(3, 'c'));
    expect(three.d).toBe('row');
    expect(three.a.s).toBe('a');
    expect(three.b).toMatchObject({ t: 's', d: 'col' });
    expect(sessions(three)).toEqual(['a', 'b', 'c']);
    // flex-grow 1.15 : 1 on the two columns
    expect(three.r).toBeCloseTo(53.49, 1);
    expect(T.SPLIT_DEFAULT_THIRD_RATIO).toBeCloseTo(53.49, 1);
  });

  it('leaves the ratio alone when the third pane makes any other shape, or the divider was already moved', () => {
    const two = T.splitAddPane(leaf(1, 'a'), 1, 'row', leaf(2, 'b'));
    const threeColumns = T.splitAddPane(two, 2, 'row', leaf(3, 'c'));
    expect(threeColumns.r).toBe(50);
    const moved = T.splitSetRatio(two, two.key, 40);
    expect(T.splitAddPane(moved, 2, 'col', leaf(3, 'c')).r).toBe(40);
  });

  it('refuses a fifth pane and a target that is not there', () => {
    let root: any = leaf(1, 'a');
    for (let k = 2; k <= 4; k++) root = T.splitAddPane(root, k - 1, 'row', leaf(k, `s${k}`));
    expect(T.splitLeaves(root)).toHaveLength(4);
    expect(T.splitCanAddPane(root)).toBe(false);
    expect(T.splitAddPane(root, 1, 'col', leaf(5, 'e'))).toBeNull();
    expect(T.splitAddPane(leaf(1, 'a'), 99, 'row', leaf(2, 'b'))).toBeNull();
  });

  it('refuses an unknown direction', () => {
    expect(T.splitAddPane(leaf(1, 'a'), 1, 'diag', leaf(2, 'b'))).toBeNull();
  });

  it('can build a 2 x 2 grid and keeps the primary pane first', () => {
    let root: any = T.splitAddPane(leaf(1, 'a'), 1, 'row', leaf(2, 'b'));
    root = T.splitAddPane(root, 2, 'col', leaf(3, 'c'));
    root = T.splitAddPane(root, 1, 'col', leaf(4, 'd'));
    expect(T.splitLeaves(root)).toHaveLength(4);
    expect(T.splitLeaves(root)[0].key).toBe(1);
  });

  it('does not change the tree it was given', () => {
    const a = leaf(1, 'a');
    const frozen = JSON.stringify(a);
    T.splitAddPane(a, 1, 'row', leaf(2, 'b'));
    expect(JSON.stringify(a)).toBe(frozen);
  });
});

describe('splitRemovePane', () => {
  const three = () => T.splitAddPane(T.splitAddPane(leaf(1, 'a'), 1, 'row', leaf(2, 'b')), 2, 'col', leaf(3, 'c'));

  it('lets the sibling take the removed pane’s place', () => {
    const next = T.splitRemovePane(three(), 3);
    expect(sessions(next)).toEqual(['a', 'b']);
    expect(next.b).toMatchObject({ t: 'p', key: 2 });
  });

  it('goes back to a single pane when only the primary is left', () => {
    const two = T.splitAddPane(leaf(1, 'a'), 1, 'row', leaf(2, 'b'));
    expect(T.splitRemovePane(two, 2)).toMatchObject({ t: 'p', key: 1 });
  });

  it('returns the tree unchanged for a key that is not in it', () => {
    const root = three();
    expect(sessions(T.splitRemovePane(root, 99))).toEqual(['a', 'b', 'c']);
  });
});

describe('splitSetRatio / splitSetSession', () => {
  it('clamps the ratio to the 20..80 floor and ceiling, for one branch only', () => {
    let root: any = T.splitAddPane(leaf(1, 'a'), 1, 'row', leaf(2, 'b'));
    root = T.splitAddPane(root, 2, 'col', leaf(3, 'c'));
    const inner = root.b;
    expect(T.splitSetRatio(root, inner.key, 3).b.r).toBe(20);
    expect(T.splitSetRatio(root, inner.key, 97).b.r).toBe(80);
    expect(T.splitSetRatio(root, inner.key, 35).b.r).toBe(35);
    expect(T.splitSetRatio(root, inner.key, 35).r).toBe(root.r);
  });

  it('puts a session in one pane or empties it', () => {
    const root = T.splitAddPane(leaf(1, 'a'), 1, 'row', leaf(2, null));
    expect(sessions(T.splitSetSession(root, 2, 'z'))).toEqual(['a', 'z']);
    expect(sessions(T.splitSetSession(root, 1, null))).toEqual([null, null]);
  });
});

describe('splitSerialize / splitDeserialize', () => {
  const sample = () => {
    let root: any = T.splitAddPane(leaf(1, 'a'), 1, 'row', leaf(2, 'b'));
    root = T.splitAddPane(root, 2, 'col', leaf(3, null));
    return root;
  };

  it('strips runtime keys and records which pane has focus', () => {
    const saved = T.splitSerialize(sample(), 2);
    expect(JSON.stringify(saved)).not.toContain('key');
    expect(saved.focus).toBe(1);
    expect(saved.root.a).toEqual({ t: 'p', s: 'a' });
    expect(saved.root.b.b).toEqual({ t: 'p', s: null });
  });

  it('has nothing to save for a single pane or a split with no session in it', () => {
    expect(T.splitSerialize(leaf(1, 'a'), 1)).toBeNull();
    expect(T.splitSerialize(T.splitAddPane(leaf(1, null), 1, 'row', leaf(2, null)), 1)).toBeNull();
  });

  it('round-trips structure, ratios, sessions and focus', () => {
    const saved = T.splitSerialize(T.splitSetRatio(sample(), sample().key, 30), 3);
    const back = T.splitDeserialize(saved, nextKey);
    expect(JSON.stringify(T.splitSerialize(back.root, back.focusKey))).toBe(JSON.stringify(saved));
  });

  it('gives every restored node a fresh unique key', () => {
    const back = T.splitDeserialize(T.splitSerialize(sample(), 1), nextKey);
    const keys: number[] = [];
    const walk = (n: any) => {
      keys.push(n.key);
      if (n.t === 's') {
        walk(n.a);
        walk(n.b);
      }
    };
    walk(back.root);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps a session named twice in its first pane only', () => {
    const saved = { root: { t: 's', d: 'row', r: 50, a: { t: 'p', s: 'a' }, b: { t: 'p', s: 'a' } } };
    expect(sessions(T.splitDeserialize(saved, nextKey).root)).toEqual(['a', null]);
  });

  it('clamps a saved ratio so no pane starts as a sliver', () => {
    const saved = { root: { t: 's', d: 'col', r: 7, a: { t: 'p', s: 'a' }, b: { t: 'p', s: 'b' } } };
    expect(T.splitDeserialize(saved, nextKey).root.r).toBe(20);
  });

  it('falls back to the first pane when the saved focus is out of range', () => {
    const saved = { root: { t: 's', d: 'row', r: 50, a: { t: 'p', s: 'a' }, b: { t: 'p', s: 'b' } }, focus: 9 };
    const back = T.splitDeserialize(saved, nextKey);
    expect(back.focusKey).toBe(T.splitLeaves(back.root)[0].key);
  });

  it.each([
    ['null', null],
    ['a string', 'row'],
    ['no root', {}],
    ['a single pane', { root: { t: 'p', s: 'a' } }],
    ['an unknown node', { root: { t: 'x' } }],
    ['a bad direction', { root: { t: 's', d: 'up', r: 50, a: { t: 'p', s: 'a' }, b: { t: 'p', s: 'b' } } }],
    ['a non-numeric ratio', { root: { t: 's', d: 'row', r: '50', a: { t: 'p', s: 'a' }, b: { t: 'p', s: 'b' } } }],
    ['a missing child', { root: { t: 's', d: 'row', r: 50, a: { t: 'p', s: 'a' } } }],
    [
      'five panes',
      {
        root: {
          t: 's',
          d: 'row',
          r: 50,
          a: { t: 's', d: 'row', r: 50, a: { t: 'p', s: '1' }, b: { t: 'p', s: '2' } },
          b: {
            t: 's',
            d: 'row',
            r: 50,
            a: { t: 's', d: 'row', r: 50, a: { t: 'p', s: '3' }, b: { t: 'p', s: '4' } },
            b: { t: 'p', s: '5' },
          },
        },
      },
    ],
  ])('returns null (no split) for %s instead of throwing', (_label, saved) => {
    expect(T.splitDeserialize(saved, nextKey)).toBeNull();
  });
});

describe('splitLetter', () => {
  it('letters panes A to D and nothing beyond', () => {
    expect([0, 1, 2, 3, 4].map(T.splitLetter)).toEqual(['A', 'B', 'C', 'D', '']);
  });
});
