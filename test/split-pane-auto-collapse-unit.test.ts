// test/split-pane-auto-collapse-unit.test.ts
// Port: N/A (no server/browser — loaded via `vm`, like session-close-fallback.test.ts).
//
// Fast, CI-visible unit coverage for the `_onSessionDeleted` prototype patch in
// terminal-split.js (whole-branch review finding I6). The "a side pane ends" branch
// already has real-Chromium coverage in test/split-pane-auto-collapse.browser.test.ts,
// but that suite is excluded from `npm test` (see Testing in CLAUDE.md), and the
// "Pane A ends, another pane gets promoted" branch had NO coverage anywhere — it is the
// one whose correctness depends on exact ordering: the promoted session id must be
// captured BEFORE `closeSplitPane()` runs (which removes that pane from the layout), or
// the promoted session id is lost. This file pins that ordering plus the sibling branches
// (a side pane ends, unrelated session ends) so a regression fails in the normal CI
// gate rather than only in the browser suite nobody runs by default.
//
// Switchboard T5 generalised the split from "Pane A + Pane B" to up to four panes (a layout
// tree, constants.js CodemanSplitPane.split*), so each case also runs with three panes: only
// the pane whose session ended closes, and Pane A's promotion picks the next pane that holds a
// session.
//
// The same vm harness also pins two merge-time fixes from the final review of
// #453 that no browser test reaches: closeSplitPane() tearing down a divider
// drag that is still in progress (the body-level `split-pane-resizing` lock
// otherwise outlived the split), and openSplitPane() re-applying the picker's
// own exclusions for a row that went stale while the menu sat open.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A class-list stub backed by a Set, enough for add/remove/toggle/contains. */
function fakeClassList() {
  const classes = new Set<string>();
  return {
    add: (...names: string[]) => names.forEach((c) => classes.add(c)),
    remove: (...names: string[]) => names.forEach((c) => classes.delete(c)),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !classes.has(c);
      if (on) classes.add(c);
      else classes.delete(c);
      return on;
    },
    contains: (c: string) => classes.has(c),
  };
}

/**
 * The only `document` surface the methods under test touch: `body.classList`
 * (the drag's cursor/selection lock) and `querySelector` (reassignable per test so a
 * test can plant a sentinel).
 */
const fakeDocument = {
  body: { classList: fakeClassList() },
  querySelector: (_selector: string): unknown => null,
  querySelectorAll: (_selector: string): unknown[] => [],
  getElementById: (_id: string): unknown => null,
};

const rafCalls: Array<() => void> = [];
const cancelledRafs: number[] = [];

type Split = {
  splitLeaves: (root: unknown) => Array<{ key: number; s: string | null }>;
  splitAddPane: (root: unknown, key: number, dir: string, leaf: unknown) => unknown;
  splitRemovePane: (root: unknown, key: number) => unknown;
};

let codemanSplitPane: Split;

function loadCodemanAppClass() {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const constantsSrc = readFileSync(resolve(dir, 'constants.js'), 'utf8');
  const terminalSplitSrc = readFileSync(resolve(dir, 'terminal-split.js'), 'utf8');
  const win: Record<string, unknown> = { innerWidth: 1600 };
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // innerWidth clears the desktop-only gate so openSplitPane() reaches the
    // exclusions under test.
    window: win,
    document: fakeDocument,
    requestAnimationFrame: (fn: () => void) => rafCalls.push(fn),
    cancelAnimationFrame: (id: number) => cancelledRafs.push(id),
  });
  // constants.js defines the pure layout helpers (window.CodemanSplitPane) and the width gate.
  vm.runInContext(constantsSrc, context, { filename: 'constants.js' });
  codemanSplitPane = win.CodemanSplitPane as Split;
  // A minimal fake CodemanApp — terminal-split.js only needs the methods it wraps to already exist
  // on the prototype, and none of the wrapped bodies execute at module-load time (only inside
  // method calls), so no xterm/WebSocket globals are needed here.
  const fakeAppSrc = `
    class CodemanApp {
      _onSessionDeleted(data) {
        (this.__originalDeletedCalls ??= []).push(data);
      }
      selectSession(id) {
        (this.__originalSelectSessionCalls ??= []).push(id);
      }
      renderSessionTabs() {}
      handleInit() {}
    }
  `;
  vm.runInContext(`${fakeAppSrc}\n${terminalSplitSrc}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp as {
    prototype: {
      _onSessionDeleted: (this: unknown, data: { id: string }) => unknown;
      closeSplitPane: (this: unknown, options?: { key?: number; skipPrimaryResize?: boolean }) => unknown;
      openSplitPane: (this: unknown, sessionId: string, opts?: { dir?: string }) => unknown;
      selectSession: (this: unknown, sessionId: string, opts?: unknown) => unknown;
      _installSplitDividerDrag: (this: unknown, divider: unknown, nodeKey: number, dir: string) => unknown;
    };
  };
}

const CodemanApp = loadCodemanAppClass();

type Rec = { el: { remove: ReturnType<typeof vi.fn> }; pane: { destroy: ReturnType<typeof vi.fn> } | null };

type TestApp = {
  activeSessionId: string | null;
  _splitTree: unknown;
  _splitPrimaryKey: number | null;
  _splitFocusKey: number | null;
  _splitRecs: Map<number, Rec>;
  _splitContainerEl: unknown;
  _splitPrimaryEl: unknown;
  _closingSessions: Set<string>;
  closeSplitPane: ReturnType<typeof vi.fn>;
  selectSession: ReturnType<typeof vi.fn>;
  __originalDeletedCalls?: Array<{ id: string }>;
};

/**
 * A split-active instance. Pane A (key 1) shows `activeSessionId`; each entry of `extras` is a
 * further pane (keys 2, 3, ...) holding that session (null = an empty pane), split side by side.
 */
function makeSplitActiveApp(extras: Array<string | null> = ['session-b']): TestApp {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as TestApp;
  app.activeSessionId = 'session-a';
  let tree: unknown = { t: 'p', key: 1, s: null };
  app._splitRecs = new Map([[1, { el: { remove: vi.fn() }, pane: null }]]);
  extras.forEach((session, i) => {
    const key = i + 2;
    tree = codemanSplitPane.splitAddPane(tree, key - 1, 'row', { t: 'p', key, s: session });
    app._splitRecs.set(key, { el: { remove: vi.fn() }, pane: session ? { destroy: vi.fn() } : null });
  });
  app._splitTree = tree;
  app._splitPrimaryKey = 1;
  app._splitFocusKey = 1;
  app._splitContainerEl = null;
  app._splitPrimaryEl = null;
  // Empty by default: the app's OWN closeSession() is not mid-await for this
  // delete, so the promotion below is expected to fire. See the dedicated
  // test further down for the non-empty (_closingSessions owns it) case.
  app._closingSessions = new Set();
  // closeSplitPane is mocked but mirrors the REAL implementation's one
  // observable side effect relevant here: the closed pane leaves the layout. If the wrapper read
  // the promoted session AFTER calling closeSplitPane instead of before, this would surface as
  // selectSession(undefined) below.
  app.closeSplitPane = vi.fn((options?: { key?: number }) => {
    if (options?.key !== undefined) {
      app._splitTree = codemanSplitPane.splitRemovePane(app._splitTree, options.key);
    } else {
      app._splitTree = null;
    }
  });
  app.selectSession = vi.fn();
  return app;
}

const shownSessions = (app: TestApp) =>
  app._splitTree ? codemanSplitPane.splitLeaves(app._splitTree).map((l) => l.s) : [];

describe('terminal-split.js _onSessionDeleted wrapper (I6)', () => {
  it('Pane A ends: closes Pane B and promotes its session via selectSession(ORIGINAL session id)', () => {
    const app = makeSplitActiveApp();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    // activeSessionId is still the deleted id while the split collapses (the
    // original handler, called last, is what retires it), so the closing
    // resize must be skipped or it targets a session the server already
    // removed; selectSession() below sizes the promoted session itself.
    expect(app.closeSplitPane).toHaveBeenCalledWith({ key: 2, skipPrimaryResize: true });
    // Pinned ordering: selectSession must receive the id the promoted pane held
    // BEFORE closeSplitPane ran (which removes it), not whatever is left after.
    // { auto: true } because this is an app-driven promotion, not the user
    // clicking a tab — it must not spend the promoted session's idle alert.
    expect(app.selectSession).toHaveBeenCalledWith('session-b', { auto: true });
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-a' }]);
  });

  it('Pane B ends: closes that pane without promoting anything', () => {
    const app = makeSplitActiveApp();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-b' });

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    // Pane A's session is alive and stays active: the closing resize is
    // wanted here, so no skip option must be passed.
    expect(app.closeSplitPane).toHaveBeenCalledWith({ key: 2 });
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-b' }]);
  });

  it('an unrelated session ending leaves the split untouched', () => {
    const app = makeSplitActiveApp();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-c' });

    expect(app.closeSplitPane).not.toHaveBeenCalled();
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app._splitTree).not.toBeNull();
    expect(shownSessions(app)).toEqual([null, 'session-b']);
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-c' }]);
  });

  it('the original _onSessionDeleted always fires, split-active or not', () => {
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as TestApp;
    app.activeSessionId = 'session-a';
    app._splitTree = null;
    app._splitRecs = new Map();
    app._closingSessions = new Set();
    app.closeSplitPane = vi.fn();
    app.selectSession = vi.fn();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

    expect(app.closeSplitPane).not.toHaveBeenCalled();
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-a' }]);
  });

  it('Pane A ends via the user closing its OWN tab: still closes the promoted pane, but skips the promotion', () => {
    // closeSession() (app.js) adds the id to _closingSessions BEFORE awaiting
    // the delete, then owns the follow-up selection itself once it lands —
    // selecting the other pane's session here too would race it for which tab wins.
    const app = makeSplitActiveApp();
    app._closingSessions.add('session-a');

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-a' }]);
  });

  describe('with three panes (A | B | C)', () => {
    it('Pane A ends: B is promoted and C keeps its place', () => {
      const app = makeSplitActiveApp(['session-b', 'session-c']);

      CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

      expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
      expect(app.closeSplitPane).toHaveBeenCalledWith({ key: 2, skipPrimaryResize: true });
      expect(app.selectSession).toHaveBeenCalledWith('session-b', { auto: true });
      expect(shownSessions(app)).toEqual([null, 'session-c']);
    });

    it('Pane A ends while B is empty: the next pane with a session (C) is promoted, B stays empty', () => {
      const app = makeSplitActiveApp([null, 'session-c']);

      CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

      expect(app.closeSplitPane).toHaveBeenCalledWith({ key: 3, skipPrimaryResize: true });
      expect(app.selectSession).toHaveBeenCalledWith('session-c', { auto: true });
      expect(shownSessions(app)).toEqual([null, null]);
    });

    it('Pane A ends with only empty panes left: the whole split closes and nothing is promoted', () => {
      const app = makeSplitActiveApp([null, null]);

      CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

      expect(app.closeSplitPane).toHaveBeenCalledWith({ skipPrimaryResize: true });
      expect(app.selectSession).not.toHaveBeenCalled();
    });

    it('Pane C ends: only C closes, the other two are untouched', () => {
      const app = makeSplitActiveApp(['session-b', 'session-c']);

      CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-c' });

      expect(app.closeSplitPane).toHaveBeenCalledWith({ key: 3 });
      expect(app.selectSession).not.toHaveBeenCalled();
      expect(shownSessions(app)).toEqual([null, 'session-b']);
    });
  });
});

describe('terminal-split.js selectSession wrapper (I2)', () => {
  it('selecting a session a side pane shows closes THAT pane first, then rebinds Pane A', () => {
    const app = makeSplitActiveApp(['session-b', 'session-c']);
    const events: string[] = [];
    app.closeSplitPane = vi.fn((options?: { key?: number }) => events.push(`close:${options?.key}`));
    const original = (app as unknown as { __originalSelectSessionCalls?: string[] }).__originalSelectSessionCalls;
    expect(original).toBeUndefined();

    CodemanApp.prototype.selectSession.call(app, 'session-c');

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    expect(app.closeSplitPane).toHaveBeenCalledWith({ key: 3 });
    expect((app as unknown as { __originalSelectSessionCalls: string[] }).__originalSelectSessionCalls).toEqual([
      'session-c',
    ]);
    expect(events).toEqual(['close:3']);
  });

  it('selecting a session no pane shows leaves the split alone', () => {
    const app = makeSplitActiveApp(['session-b']);

    CodemanApp.prototype.selectSession.call(app, 'session-z');

    expect(app.closeSplitPane).not.toHaveBeenCalled();
  });
});

// ── closeSplitPane() vs a divider drag in progress ──────────────────────────

type DragEl = ReturnType<typeof fakeElement>;

/** A DOM element stub: class list, a listener registry, pointer-capture spies. */
function fakeElement() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    style: {} as Record<string, string>,
    classList: fakeClassList(),
    parentElement: null as unknown,
    listeners,
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  };
}

function listenerCount(el: DragEl, type: string): number {
  return el.listeners.get(type)?.size ?? 0;
}

type DragTestApp = TestApp & {
  _splitDividerDragTeardown?: (() => void) | null;
  sendResize: ReturnType<typeof vi.fn>;
};

describe('closeSplitPane() tears down a divider drag that is still in progress', () => {
  afterEach(() => {
    fakeDocument.querySelector = () => null;
    fakeDocument.body.classList.remove('split-pane-resizing', 'split-pane-resizing--col');
  });

  /**
   * A split-active app with the REAL _installSplitDividerDrag() wired to a stub divider, then
   * armed the way the browser arms it: a primary-button pointerdown on the divider. The stub
   * container hands closeSplitPane() the primary pane's wrapper so it runs its full collapse
   * (reparent, remove, resize) rather than an early return.
   */
  function makeDraggingApp(dir = 'row') {
    const app = makeSplitActiveApp() as DragTestApp;
    // Use the real closeSplitPane here, not the mock.
    app.closeSplitPane = (CodemanApp.prototype.closeSplitPane as (typeof app)['closeSplitPane']).bind(app);
    app.sendResize = vi.fn(() => Promise.resolve(true));
    const wrap = fakeElement();
    const container = { querySelector: () => wrap, parentElement: { insertBefore: vi.fn() }, remove: vi.fn() };
    app._splitContainerEl = container;
    app._splitPrimaryEl = { remove: vi.fn() };
    const divider = fakeElement();

    CodemanApp.prototype._installSplitDividerDrag.call(app, divider, 99, dir);
    const [onDown] = divider.listeners.get('pointerdown')!;
    onDown({ button: 0, pointerId: 7, preventDefault: vi.fn() });
    return { app, divider, container };
  }

  it('precondition: pointerdown arms the page-wide resize lock, capture and the drag listeners', () => {
    const { divider } = makeDraggingApp();

    expect(fakeDocument.body.classList.contains('split-pane-resizing')).toBe(true);
    expect(divider.classList.contains('dragging')).toBe(true);
    expect(divider.setPointerCapture).toHaveBeenCalledWith(7);
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
      expect(listenerCount(divider, type), type).toBe(1);
    }
  });

  it('a stacked divider also switches the page-wide cursor to row-resize', () => {
    makeDraggingApp('col');
    expect(fakeDocument.body.classList.contains('split-pane-resizing--col')).toBe(true);
  });

  it('clears body.split-pane-resizing, releases capture and drops the drag listeners', () => {
    const { app, divider, container } = makeDraggingApp('col');

    CodemanApp.prototype.closeSplitPane.call(app);

    // The lock is `cursor: col-resize; user-select: none` on EVERY element
    // (styles.css); left set, it outlives the split until a reload.
    expect(fakeDocument.body.classList.contains('split-pane-resizing')).toBe(false);
    expect(fakeDocument.body.classList.contains('split-pane-resizing--col')).toBe(false);
    expect(divider.classList.contains('dragging')).toBe(false);
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
      expect(listenerCount(divider, type), type).toBe(0);
    }
    expect(app._splitDividerDragTeardown).toBeNull();
    expect(app._splitTree).toBeNull();
    expect(container.remove).toHaveBeenCalledTimes(1);
    // An ordinary close still resizes the (live) primary pane's session.
    expect(app.sendResize).toHaveBeenCalledWith('session-a', { force: true });
  });

  it('destroys the pane it closes', () => {
    const { app } = makeDraggingApp();
    const pane = app._splitRecs.get(2)!.pane!;

    CodemanApp.prototype.closeSplitPane.call(app);

    expect(pane.destroy).toHaveBeenCalledTimes(1);
  });

  it('cancels a reflow frame the drag had queued', () => {
    const { app, divider } = makeDraggingApp();
    const [onMove] = divider.listeners.get('pointermove')!;
    onMove({ clientX: 400, clientY: 300 });
    const queuedRafId = rafCalls.length;

    CodemanApp.prototype.closeSplitPane.call(app);

    expect(cancelledRafs).toContain(queuedRafId);
  });

  it('closeSplitPane({ skipPrimaryResize: true }) collapses without resizing the primary session', () => {
    const { app, container } = makeDraggingApp();

    CodemanApp.prototype.closeSplitPane.call(app, { skipPrimaryResize: true });

    expect(app.sendResize).not.toHaveBeenCalled();
    expect(app._splitTree).toBeNull();
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(fakeDocument.body.classList.contains('split-pane-resizing')).toBe(false);
  });
});

// ── openSplitPane() re-applies the picker's exclusions ──────────────────────

type OpenTestApp = TestApp & {
  activeWebviewId: string | null;
  sessions: Map<string, { pid: number | null; name?: string }>;
  detachedSessions: Set<string>;
};

describe('openSplitPane() re-applies the picker exclusions at open time', () => {
  // buildSplitPickerSessions() (constants.js) never lists a detached session
  // or one with `pid === null`, but the menu can sit open while a listed
  // session's CLI exits or gets popped out, and the row's click carries only
  // the id. openSplitPane() must refuse those the same way the picker would
  // have (silently, like its neighbouring gates) BEFORE touching the DOM.
  const DOM_REACHED = 'sentinel: openSplitPane reached the DOM stage';

  function makeApp(): OpenTestApp {
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as OpenTestApp;
    app.activeSessionId = 'session-a';
    app.activeWebviewId = null;
    app._splitTree = null;
    app._splitRecs = new Map();
    app._closingSessions = new Set();
    app.closeSplitPane = vi.fn();
    app.selectSession = vi.fn();
    app.sessions = new Map([
      ['session-a', { pid: 101, name: 'w1-active' }],
      ['session-exited', { pid: null, name: 'w2-exited' }],
      ['session-detached', { pid: 103, name: 'w3-detached' }],
      ['session-ok', { pid: 104, name: 'w4-ok' }],
    ]);
    app.detachedSessions = new Set(['session-detached']);
    return app;
  }

  beforeEach(() => {
    fakeDocument.querySelector = vi.fn(() => {
      throw new Error(DOM_REACHED);
    });
  });
  afterEach(() => {
    fakeDocument.querySelector = () => null;
  });

  it('control: a listed, attached session gets past every guard to the DOM stage', () => {
    const app = makeApp();
    expect(() => CodemanApp.prototype.openSplitPane.call(app, 'session-ok')).toThrow(DOM_REACHED);
    expect(fakeDocument.querySelector).toHaveBeenCalledWith('.terminal-wrap');
  });

  it('refuses a session whose CLI has exited (pid === null) without touching the DOM', () => {
    const app = makeApp();
    expect(CodemanApp.prototype.openSplitPane.call(app, 'session-exited')).toBeUndefined();
    expect(fakeDocument.querySelector).not.toHaveBeenCalled();
    expect(app._splitTree).toBeNull();
  });

  it('refuses a detached (popped-out) session', () => {
    const app = makeApp();
    expect(CodemanApp.prototype.openSplitPane.call(app, 'session-detached')).toBeUndefined();
    expect(fakeDocument.querySelector).not.toHaveBeenCalled();
    expect(app._splitTree).toBeNull();
  });

  it('refuses an id with no session record at all', () => {
    const app = makeApp();
    expect(CodemanApp.prototype.openSplitPane.call(app, 'session-ghost')).toBeUndefined();
    expect(fakeDocument.querySelector).not.toHaveBeenCalled();
    expect(app._splitTree).toBeNull();
  });

  it('refuses the session Pane A already shows, and a session another pane already shows', () => {
    const app = makeApp();
    expect(CodemanApp.prototype.openSplitPane.call(app, 'session-a')).toBeUndefined();
    expect(fakeDocument.querySelector).not.toHaveBeenCalled();

    const split = makeSplitActiveApp(['session-ok']) as unknown as OpenTestApp;
    split.sessions = app.sessions;
    split.detachedSessions = app.detachedSessions;
    split.activeWebviewId = null;
    expect(CodemanApp.prototype.openSplitPane.call(split, 'session-ok')).toBeUndefined();
    expect(fakeDocument.querySelector).not.toHaveBeenCalled();
  });

  it('a refusal leaves an already-open split alone', () => {
    const app = makeSplitActiveApp(['session-ok']) as unknown as OpenTestApp;
    app.activeWebviewId = null;
    app.sessions = new Map([
      ['session-a', { pid: 101 }],
      ['session-exited', { pid: null }],
      ['session-ok', { pid: 104 }],
    ]);
    app.detachedSessions = new Set();
    const before = JSON.stringify(app._splitTree);

    CodemanApp.prototype.openSplitPane.call(app, 'session-exited');

    expect(app.closeSplitPane).not.toHaveBeenCalled();
    expect(JSON.stringify(app._splitTree)).toBe(before);
  });
});
