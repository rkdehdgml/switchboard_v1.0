/**
 * @fileoverview Switchboard T5 — the split work area in a real DOM (jsdom): up to four panes, side by
 * side or stacked, headers, focus, the picker, dividers (drag and keyboard), saving and restoring the
 * layout. The real terminal-split.js and constants.js run; only SplitTerminalPane (xterm + WebSocket)
 * is stubbed. Layout sizes are not measurable in jsdom, so the divider drag feeds a fake rect.
 *
 * Port: N/A (no server start)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const read = (p: string) => readFileSync(resolve('src/web/public', p), 'utf8');
const constantsSource = read('constants.js');
const splitSource = read('terminal-split.js');

type Session = { id: string; name: string; pid: number | null; mode: string; workingDir?: string; totalCost?: number };

class FakePane {
  static instances: FakePane[] = [];
  fits = 0;
  localFits = 0;
  destroyed = false;
  terminal = { focus: vi.fn() };
  constructor(
    public sessionId: string,
    public mountEl: Element
  ) {
    FakePane.instances.push(this);
  }
  connect() {
    return Promise.resolve();
  }
  fit() {
    this.fits++;
  }
  localFit() {
    this.localFits++;
  }
  destroy() {
    this.destroyed = true;
  }
}

interface Fetched {
  url: string;
  method: string;
  body?: any;
}

function boot(opts: { width?: number; sessions?: Session[]; active?: string; fetchPlan?: (f: Fetched) => any } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <main class="main">
         <aside><div class="tab-rail-foot">
           <button class="tab-rail-split-btn" data-dir="row"></button>
           <button class="tab-rail-split-btn" data-dir="col"></button>
         </div></aside>
         <div class="terminal-wrap" id="wrap"><div id="terminalContainer"></div></div>
       </main>
     </body></html>`,
    { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true }
  );
  const win = dom.window as unknown as Record<string, any>;
  Object.defineProperty(win, 'innerWidth', { value: opts.width ?? 1600, configurable: true });
  const rafQueue: Array<() => void> = [];
  win.requestAnimationFrame = (cb: () => void) => rafQueue.push(cb);
  win.cancelAnimationFrame = () => {};
  const fetched: Fetched[] = [];
  win.fetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const call: Fetched = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined };
    fetched.push(call);
    const out = opts.fetchPlan?.(call) ?? { status: 200, body: { success: true, data: {} } };
    return { ok: out.status < 400, status: out.status, json: async () => out.body };
  });
  const ctx = dom.getInternalVMContext();
  vm.runInContext(constantsSource, ctx, { filename: 'constants.js' });
  vm.runInContext(
    `class CodemanApp {
       renderSessionTabs() { this.__renders = (this.__renders || 0) + 1; }
       handleInit() {}
       selectSession(id) { this.activeSessionId = id; (this.__selected ||= []).push(id); return Promise.resolve(); }
       _onSessionDeleted(d) { (this.__deleted ||= []).push(d.id); }
     }
     globalThis.__CodemanApp = CodemanApp;`,
    ctx
  );
  vm.runInContext(splitSource, ctx, { filename: 'terminal-split.js' });
  win.SplitTerminalPane = FakePane;
  const App = win.__CodemanApp;
  const app = new App();
  const sessions = opts.sessions ?? [
    { id: 'a', name: 'alpha', pid: 1, mode: 'claude', workingDir: '/home/me/alpha', totalCost: 1.5 },
    { id: 'b', name: 'beta', pid: 2, mode: 'claude', workingDir: 'C:\\work\\beta', totalCost: 0.2 },
    { id: 'c', name: 'gamma', pid: 3, mode: 'shell' },
    { id: 'd', name: 'delta', pid: 4, mode: 'claude' },
    { id: 'e', name: 'epsilon', pid: 5, mode: 'claude' },
    { id: 'x', name: 'exited', pid: null, mode: 'claude' },
  ];
  Object.assign(app, {
    sessions: new Map(sessions.map((s) => [s.id, s])),
    sessionOrder: sessions.map((s) => s.id),
    activeSessionId: opts.active ?? 'a',
    activeWebviewId: null,
    detachedSessions: new Set<string>(),
    pendingHooks: new Map(),
    getSessionName: (s: Session) => s.name,
    _mobileOverviewState: () => 'working',
    sendResize: vi.fn(() => Promise.resolve(true)),
    showToast: vi.fn(),
    loadAppSettingsFromStorage: () => ({}),
    isSoloWindow: false,
  });
  const doc = win.document as Document;
  return {
    dom,
    win,
    app,
    doc,
    fetched,
    flushRaf() {
      while (rafQueue.length) rafQueue.shift()!();
    },
    rafQueue,
    leaves: () => [...doc.querySelectorAll('.split-leaf')] as HTMLElement[],
    letters: () => [...doc.querySelectorAll('.split-pane-letter')].map((n) => n.textContent),
    names: () => [...doc.querySelectorAll('.split-pane-name')].map((n) => n.textContent),
  };
}

beforeEach(() => {
  FakePane.instances = [];
});

describe('opening panes', () => {
  it('splits side by side: container > [Pane A (holding the terminal wrapper), divider, Pane B]', () => {
    const h = boot();
    h.app.openSplitPane('b');
    const root = h.doc.querySelector('.terminal-split-container')!;
    expect(root.classList.contains('split-node--row')).toBe(true);
    const kids = [...root.children];
    expect(kids.map((k) => k.className.split(' ')[0])).toEqual(['split-leaf', 'split-divider', 'split-leaf']);
    expect(kids[0].classList.contains('split-leaf--primary')).toBe(true);
    expect(kids[0].querySelector('.terminal-wrap')).toBe(h.doc.getElementById('wrap'));
    expect(h.letters()).toEqual(['A', 'B']);
    expect(h.names()).toEqual(['alpha', 'beta']);
    expect(FakePane.instances.map((p) => p.sessionId)).toEqual(['b']);
  });

  it('splits stacked when asked for a column', () => {
    const h = boot();
    h.app.openSplitPane('b', { dir: 'col' });
    const root = h.doc.querySelector('.terminal-split-container')!;
    expect(root.classList.contains('split-node--col')).toBe(true);
    const divider = root.querySelector('.split-divider')!;
    expect(divider.getAttribute('aria-orientation')).toBe('horizontal');
    expect(divider.classList.contains('split-divider--col')).toBe(true);
  });

  it('makes left 1 + right top/bottom 2 for a side-by-side split followed by a stacked one, left pane wider', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    const root = h.doc.querySelector('.terminal-split-container')! as HTMLElement;
    const [left, , right] = [...root.children] as HTMLElement[];
    expect(left.classList.contains('split-leaf--primary')).toBe(true);
    expect(right.classList.contains('split-node--col')).toBe(true);
    expect(right.querySelectorAll('.split-leaf')).toHaveLength(2);
    // flex-grow 1.15 : 1 → 53.49% / 46.51%
    expect(parseFloat(left.style.flexBasis)).toBeCloseTo(53.49, 1);
    expect(parseFloat(right.style.flexBasis)).toBeCloseTo(46.51, 1);
    expect(h.letters()).toEqual(['A', 'B', 'C']);
  });

  it('splits the FOCUSED pane: with A focused, a third pane stacks under A instead', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app._setSplitFocus(h.app._splitPrimaryKey);
    h.app.openSplitPane('c', { dir: 'col' });
    const root = h.doc.querySelector('.terminal-split-container')! as HTMLElement;
    const [first] = [...root.children] as HTMLElement[];
    expect(first.classList.contains('split-node--col')).toBe(true);
    expect(first.querySelector('.split-leaf--primary')).not.toBeNull();
  });

  it('holds four panes and refuses a fifth with a warning', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    h.app._setSplitFocus(h.app._splitPrimaryKey);
    h.app.openSplitPane('d', { dir: 'col' });
    expect(h.leaves()).toHaveLength(4);
    expect(h.letters()).toEqual(['A', 'B', 'C', 'D']);
    h.app.openSplitPane('e');
    expect(h.leaves()).toHaveLength(4);
    expect(h.app.showToast).toHaveBeenCalledWith('A split holds at most 4 panels', 'warning');
    expect(FakePane.instances.map((p) => p.sessionId)).toEqual(['b', 'c', 'd']);
  });

  it('disables both rail buttons (aria-disabled + the reason as the tooltip) at four panes', () => {
    const h = boot();
    const btns = () => [...h.doc.querySelectorAll('.tab-rail-split-btn')] as HTMLElement[];
    h.app.openSplitPane('b');
    expect(btns().map((b) => b.getAttribute('aria-disabled'))).toEqual(['false', 'false']);
    h.app.openSplitPane('c', { dir: 'col' });
    h.app._setSplitFocus(h.app._splitPrimaryKey);
    h.app.openSplitPane('d', { dir: 'col' });
    expect(btns().map((b) => b.getAttribute('aria-disabled'))).toEqual(['true', 'true']);
    expect(btns().map((b) => b.title)).toEqual(['A split holds at most 4 panels', 'A split holds at most 4 panels']);
    // …and a click on a disabled button does not open a picker
    h.app.onSplitButton({ stopPropagation() {}, currentTarget: btns()[0] }, 'row');
    expect(h.doc.getElementById('splitPickerMenu')).toBeNull();
  });

  it('refuses the same session twice, the active session, an exited one, and a popped-out one', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('b');
    h.app.openSplitPane('a');
    h.app.openSplitPane('x');
    h.app.detachedSessions.add('c');
    h.app.openSplitPane('c');
    expect(h.leaves()).toHaveLength(2);
  });

  it('does nothing in a narrow window or over a web tab', () => {
    const narrow = boot({ width: 900 });
    narrow.app.openSplitPane('b');
    expect(narrow.doc.querySelector('.terminal-split-container')).toBeNull();
    const web = boot();
    web.app.activeWebviewId = 'w1';
    web.app.openSplitPane('b');
    expect(web.doc.querySelector('.terminal-split-container')).toBeNull();
  });

  it('shows name, project folder, state and cost in each header, escaping nothing it should not trust', () => {
    const h = boot();
    h.app.sessions.get('b').name = '<img src=x onerror=alert(1)>';
    h.app.openSplitPane('b');
    h.app._updateSplitHeaders();
    const headers = [...h.doc.querySelectorAll('.split-pane-header')];
    expect(headers[0].querySelector('.split-pane-project-name')!.textContent).toBe('alpha');
    expect(headers[1].querySelector('.split-pane-project-name')!.textContent).toBe('beta');
    expect(headers[0].querySelector('.split-pane-cost')!.textContent).toBe('$1.50');
    expect(headers[1].querySelector('.split-pane-cost')!.textContent).toBe('$0.20');
    expect(headers[1].querySelector('img')).toBeNull();
    expect(headers[1].querySelector('.split-pane-name')!.textContent).toBe('<img src=x onerror=alert(1)>');
    const dot = headers[0].querySelector('.split-pane-dot')!;
    expect(dot.classList.contains('split-pane-dot--working')).toBe(true);
    expect(dot.getAttribute('aria-label')).toBe('Running');
    expect(headers[0].querySelector('.terminal-pane-b-close')).toBeNull(); // Pane A has no close
    expect(headers[1].querySelector('.terminal-pane-b-close')).not.toBeNull();
  });
});

describe('closing panes', () => {
  it('closes one side pane and keeps the rest', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    const paneC = FakePane.instances.find((p) => p.sessionId === 'c')!;
    const keyC = h.app._splitLeaves()[2].key;
    h.app.closeSplitPane({ key: keyC });
    expect(paneC.destroyed).toBe(true);
    expect(h.leaves()).toHaveLength(2);
    expect(h.letters()).toEqual(['A', 'B']);
    expect(FakePane.instances.find((p) => p.sessionId === 'b')!.destroyed).toBe(false);
  });

  it('closing the second-to-last pane puts the terminal wrapper back where it was', () => {
    const h = boot();
    const main = h.doc.querySelector('.main')!;
    h.app.openSplitPane('b');
    h.app.closeSplitPane({ key: h.app._splitLeaves()[1].key });
    expect(h.doc.querySelector('.terminal-split-container')).toBeNull();
    expect(h.doc.getElementById('wrap')!.parentElement).toBe(main);
    expect(h.app._splitTree).toBeNull();
    expect(h.app.sendResize).toHaveBeenCalledWith('a', { force: true });
  });

  it('closing with no key closes every pane', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    h.app.closeSplitPane();
    expect(FakePane.instances.every((p) => p.destroyed)).toBe(true);
    expect(h.doc.querySelector('.terminal-split-container')).toBeNull();
  });

  it('can split again after closing, with fresh panes', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.closeSplitPane();
    h.app.openSplitPane('c', { dir: 'col' });
    expect(h.letters()).toEqual(['A', 'B']);
    expect(h.names()).toEqual(['alpha', 'gamma']);
  });

  it('the × button on a side pane closes just that pane', () => {
    const h = boot();
    h.app.openSplitPane('b');
    (h.doc.querySelector('.terminal-pane-b-close') as HTMLElement).click();
    expect(h.doc.querySelector('.terminal-split-container')).toBeNull();
  });
});

describe('focus, letters and the rail buttons', () => {
  it('the newest pane is focused; focusin or pointerdown on another pane moves the ring', () => {
    const h = boot();
    h.app.openSplitPane('b');
    const [a, b] = h.leaves();
    expect(b.classList.contains('split-leaf--focused')).toBe(true);
    expect(a.classList.contains('split-leaf--focused')).toBe(false);
    a.dispatchEvent(new h.win.Event('pointerdown', { bubbles: true }));
    expect(a.classList.contains('split-leaf--focused')).toBe(true);
    expect(b.classList.contains('split-leaf--focused')).toBe(false);
    b.dispatchEvent(new h.win.Event('focusin', { bubbles: true }));
    expect(b.classList.contains('split-leaf--focused')).toBe(true);
  });

  it('the rail button of the focused pane’s split direction is marked current', () => {
    const h = boot();
    const current = () =>
      [...h.doc.querySelectorAll('.tab-rail-split-btn')].map((b) => b.classList.contains('is-current'));
    expect(current()).toEqual([false, false]);
    h.app.openSplitPane('b', { dir: 'col' });
    expect(current()).toEqual([false, true]);
    h.app.openSplitPane('c', { dir: 'row' });
    expect(current()).toEqual([true, false]);
  });

  it('letters follow depth-first order, for the rail badges', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    expect(['a', 'b', 'c', 'zzz'].map((id) => h.app._splitLetterForSession(id))).toEqual(['A', 'B', 'C', '']);
    h.app.closeSplitPane();
    expect(h.app._splitLetterForSession('a')).toBe('');
  });

  it('refreshes the rail when the layout changes', () => {
    const h = boot();
    const before = h.app.__renders ?? 0;
    h.app.openSplitPane('b');
    expect(h.app.__renders).toBeGreaterThan(before);
  });
});

describe('the picker', () => {
  const items = (h: ReturnType<typeof boot>) =>
    [...h.doc.querySelectorAll('.split-picker-item')].map((n) => n.textContent);

  it('lists sessions that are in no pane, never the exited one', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPicker(undefined, undefined, { dir: 'col' });
    expect(items(h)).toEqual(['gamma', 'delta', 'epsilon']);
  });

  it('wires each row to openSplitPane with the direction, and dismisses the menu', () => {
    const h = boot();
    h.win.app = h.app;
    h.app.openSplitPicker(undefined, undefined, { dir: 'col' });
    const row = h.doc.querySelector('.split-picker-item') as HTMLElement;
    expect(row.getAttribute('onclick')).toContain('"dir":"col"');
    // jsdom (runScripts outside-only) does not run inline handlers, so run the same call
    h.app.openSplitPane('b', { dir: 'col' });
    h.app._dismissSplitPicker();
    expect(h.doc.querySelector('.terminal-split-container')!.classList.contains('split-node--col')).toBe(true);
    expect(h.doc.getElementById('splitPickerMenu')).toBeNull();
  });

  it('says so when there is nothing to split with', () => {
    const h = boot({ sessions: [{ id: 'a', name: 'alpha', pid: 1, mode: 'claude' }] });
    h.app.openSplitPicker();
    expect(h.doc.querySelector('.split-picker-empty')!.textContent).toBe('No other sessions to split with');
  });

  it('at four panes it warns instead of opening', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    h.app._setSplitFocus(h.app._splitPrimaryKey);
    h.app.openSplitPane('d', { dir: 'col' });
    h.app.showToast.mockClear();
    h.app.openSplitPicker();
    expect(h.doc.getElementById('splitPickerMenu')).toBeNull();
    expect(h.app.showToast).toHaveBeenCalledWith('A split holds at most 4 panels', 'warning');
  });

  it('the header ▾ offers the pane’s own session plus the free ones, and picking swaps it', () => {
    const h = boot();
    h.app.openSplitPane('b');
    const keyB = h.app._splitLeaves()[1].key;
    h.app.openSplitPicker(undefined, undefined, { assignKey: keyB });
    expect(items(h)).toEqual(['beta', 'gamma', 'delta', 'epsilon']);
    h.app._splitAssignSession(keyB, 'c');
    const [old, next] = FakePane.instances;
    expect(old.destroyed).toBe(true);
    expect(next.sessionId).toBe('c');
    expect(h.names()).toEqual(['alpha', 'gamma']);
  });

  it('assigning a session another pane shows is refused', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    const keyB = h.app._splitLeaves()[1].key;
    h.app._splitAssignSession(keyB, 'c');
    expect(h.names()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('assigning to Pane A selects that session', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app._splitAssignSession(h.app._splitPrimaryKey, 'd');
    expect(h.app.__selected).toEqual(['d']);
  });
});

describe('dividers', () => {
  function drag(h: ReturnType<typeof boot>, divider: HTMLElement, points: Array<[number, number]>) {
    const node = divider.parentElement!;
    node.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600 }) as DOMRect;
    const fire = (type: string, x: number, y: number) =>
      divider.dispatchEvent(new h.win.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    fire('pointerdown', points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) fire('pointermove', x, y);
    h.flushRaf();
    fire('pointerup', points[points.length - 1][0], points[points.length - 1][1]);
  }

  it('a side-by-side divider resizes locally while dragging and sends the PTY resize ONCE, at the end', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.flushRaf();
    h.app.sendResize.mockClear();
    const pane = FakePane.instances[0];
    pane.fits = 0;
    const divider = h.doc.querySelector('.split-divider') as HTMLElement;
    h.app.fitAddon = { fit: vi.fn() };

    // move with the frame callback pending between events, as a browser would
    const node = divider.parentElement!;
    node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect;
    const fire = (type: string, x: number) =>
      divider.dispatchEvent(new h.win.MouseEvent(type, { clientX: x, clientY: 10, button: 0, bubbles: true }));
    fire('pointerdown', 500);
    for (const x of [450, 400, 350, 300]) {
      fire('pointermove', x);
      h.flushRaf();
    }
    // locally reflowed on every frame, PTY untouched so far
    expect(pane.localFits).toBe(4);
    expect(pane.fits).toBe(0);
    expect(h.app.sendResize).not.toHaveBeenCalled();
    fire('pointerup', 300);
    expect(pane.fits).toBe(1);
    expect(h.app.sendResize).toHaveBeenCalledTimes(1);
    expect(h.app.sendResize).toHaveBeenCalledWith('a', { force: true });
    const [first, , second] = [...node.children] as HTMLElement[];
    expect(first.style.flexBasis).toBe('30%');
    expect(second.style.flexBasis).toBe('70%');
    expect(divider.getAttribute('aria-valuenow')).toBe('30');
  });

  it('clamps the drag to 20%..80%', () => {
    const h = boot();
    h.app.openSplitPane('b');
    const divider = h.doc.querySelector('.split-divider') as HTMLElement;
    drag(h, divider, [
      [500, 0],
      [5, 0],
    ]);
    expect((divider.parentElement!.children[0] as HTMLElement).style.flexBasis).toBe('20%');
    drag(h, divider, [
      [200, 0],
      [990, 0],
    ]);
    expect((divider.parentElement!.children[0] as HTMLElement).style.flexBasis).toBe('80%');
  });

  it('a stacked divider follows the vertical position', () => {
    const h = boot();
    h.app.openSplitPane('b', { dir: 'col' });
    const divider = h.doc.querySelector('.split-divider') as HTMLElement;
    drag(h, divider, [
      [10, 300],
      [10, 150],
    ]);
    expect((divider.parentElement!.children[0] as HTMLElement).style.flexBasis).toBe('25%');
  });

  it('the drag only moves ITS branch: the other divider keeps its ratio', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    const dividers = [...h.doc.querySelectorAll('.split-divider')] as HTMLElement[];
    const inner = dividers.find((d) => d.classList.contains('split-divider--col'))!;
    const rootBefore = h.app._splitTree.r;
    drag(h, inner, [
      [0, 300],
      [0, 420],
    ]);
    expect(h.app._splitTree.r).toBe(rootBefore);
    expect(h.app._splitTree.b.r).toBe(70);
  });

  it('arrow keys move the seam by 2% and send one PTY resize after they stop', () => {
    vi.useFakeTimers();
    try {
      const h = boot();
      h.app.openSplitPane('b');
      h.app.sendResize.mockClear();
      const divider = h.doc.querySelector('.split-divider') as HTMLElement;
      const key = (k: string) =>
        divider.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      key('ArrowRight');
      key('ArrowRight');
      key('ArrowLeft');
      expect(divider.getAttribute('aria-valuenow')).toBe('52');
      key('ArrowUp'); // wrong axis for a side-by-side divider: ignored
      expect(divider.getAttribute('aria-valuenow')).toBe('52');
      expect(h.app.sendResize).not.toHaveBeenCalled();
      vi.advanceTimersByTime(400);
      expect(h.app.sendResize).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closing the split mid-drag releases the page-wide resize lock', () => {
    const h = boot();
    h.app.openSplitPane('b');
    const divider = h.doc.querySelector('.split-divider') as HTMLElement;
    divider.dispatchEvent(new h.win.MouseEvent('pointerdown', { clientX: 500, button: 0, bubbles: true }));
    expect(h.doc.body.classList.contains('split-pane-resizing')).toBe(true);
    h.app.closeSplitPane();
    expect(h.doc.body.classList.contains('split-pane-resizing')).toBe(false);
  });
});

describe('session deletion and selection with panes open', () => {
  it('a side pane’s session ending closes only that pane', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    h.app._onSessionDeleted({ id: 'c' });
    expect(h.names()).toEqual(['alpha', 'beta']);
    expect(h.app.__deleted).toEqual(['c']);
  });

  it('Pane A’s session ending promotes B and keeps C', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    h.app._closingSessions = new Set();
    h.app._onSessionDeleted({ id: 'a' });
    expect(h.app.__selected).toEqual(['b']);
    expect(h.leaves()).toHaveLength(2);
    expect(FakePane.instances.find((p) => p.sessionId === 'c')!.destroyed).toBe(false);
    expect(FakePane.instances.find((p) => p.sessionId === 'b')!.destroyed).toBe(true);
  });

  it('selecting a session a side pane shows closes that pane, then rebinds Pane A', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    h.app.selectSession('c');
    expect(h.names()).toEqual(['alpha', 'beta']);
    expect(h.app.__selected).toEqual(['c']);
  });
});

describe('saving the layout', () => {
  const layout = { version: 3, groups: [], ungrouped: [], updatedAt: '2026-10-06T00:00:00.000Z' };
  const ok = (l: object) => ({ status: 200, body: { success: true, data: { layout: l } } });

  it('PUTs the split (tree without runtime keys, Pane A’s session, ratios, focus) on the version it read', async () => {
    const h = boot({
      fetchPlan: (f) => (f.method === 'GET' ? ok(layout) : ok({ ...layout, version: 4, split: f.body.layout.split })),
    });
    h.app.openSplitPane('b');
    h.app.openSplitPane('c', { dir: 'col' });
    h.app._setSplitFocus(h.app._splitLeaves()[1].key);
    expect(await h.app.saveSplitLayout()).toBe(true);
    const put = h.fetched.find((f) => f.method === 'PUT')!;
    expect(put.url).toBe('/api/tab-layout');
    expect(put.body.baseVersion).toBe(3);
    const split = put.body.layout.split;
    expect(JSON.stringify(split)).not.toContain('key');
    expect(split.focus).toBe(1);
    expect(split.root.t).toBe('s');
    expect(split.root.a).toEqual({ t: 'p', s: 'a' });
    expect(split.root.b.a).toEqual({ t: 'p', s: 'b' });
    expect(split.root.b.b).toEqual({ t: 'p', s: 'c' });
    expect(h.app.showToast).toHaveBeenCalledWith('Layout saved', 'success');
    expect(h.app._savedSplit).toEqual(split);
  });

  it('retries once on a version conflict, against the layout the server answered with', async () => {
    let puts = 0;
    const h = boot({
      fetchPlan: (f) => {
        if (f.method === 'GET') return ok(layout);
        puts++;
        return puts === 1
          ? { status: 409, body: { success: false, data: { layout: { ...layout, version: 9 } } } }
          : ok({ ...layout, version: 10, split: f.body.layout.split });
      },
    });
    h.app.openSplitPane('b');
    expect(await h.app.saveSplitLayout()).toBe(true);
    const bodies = h.fetched.filter((f) => f.method === 'PUT').map((f) => f.body.baseVersion);
    expect(bodies).toEqual([3, 9]);
  });

  it('gives up after a second conflict and says so', async () => {
    const h = boot({
      fetchPlan: (f) =>
        f.method === 'GET'
          ? ok(layout)
          : { status: 409, body: { success: false, data: { layout: { ...layout, version: 9 } } } },
    });
    h.app.openSplitPane('b');
    expect(await h.app.saveSplitLayout()).toBe(false);
    expect(h.fetched.filter((f) => f.method === 'PUT')).toHaveLength(2);
    expect(h.app.showToast.mock.calls.at(-1)[1]).toBe('error');
  });

  it('reports a server error instead of throwing', async () => {
    const h = boot({
      fetchPlan: (f) =>
        f.method === 'GET'
          ? ok(layout)
          : { status: 400, body: { success: false, error: 'split pane session is not owned' } },
    });
    h.app.openSplitPane('b');
    expect(await h.app.saveSplitLayout()).toBe(false);
    expect(h.app.showToast.mock.calls.at(-1)[0]).toContain('split pane session is not owned');
  });

  it('reports an unreadable layout (the GET fails)', async () => {
    const h = boot({ fetchPlan: () => ({ status: 500, body: { success: false, error: 'boom' } }) });
    h.app.openSplitPane('b');
    expect(await h.app.saveSplitLayout()).toBe(false);
    expect(h.fetched.some((f) => f.method === 'PUT')).toBe(false);
  });

  it('with no split open, saving clears the saved one (a PUT without the split key)', async () => {
    const withSplit = {
      ...layout,
      split: { root: { t: 's', d: 'row', r: 50, a: { t: 'p', s: 'a' }, b: { t: 'p', s: 'b' } } },
    };
    const h = boot({ fetchPlan: (f) => (f.method === 'GET' ? ok(withSplit) : ok({ ...layout, version: 4 })) });
    expect(await h.app.saveSplitLayout()).toBe(true);
    const put = h.fetched.find((f) => f.method === 'PUT')!;
    expect('split' in put.body.layout).toBe(false);
    expect(h.app.showToast).toHaveBeenCalledWith('Saved layout cleared', 'success');
    expect(h.app._savedSplit).toBeNull();
  });
});

describe('restoring the layout', () => {
  const base = { version: 5, groups: [], ungrouped: [], updatedAt: '2026-10-06T00:00:00.000Z' };
  const row = (a: unknown, b: unknown, r = 50) => ({ t: 's', d: 'row', r, a, b });
  const col = (a: unknown, b: unknown, r = 50) => ({ t: 's', d: 'col', r, a, b });
  const p = (s: string | null) => ({ t: 'p', s });
  const saved = (split: unknown) => (f: Fetched) => ({
    status: 200,
    body: { success: true, data: { layout: { ...base, ...(split ? { split } : {}) } } },
  });

  it('rebuilds the panes, ratios and focus, and starts a terminal in each pane that has a session', async () => {
    const h = boot({ fetchPlan: saved({ root: row(p('a'), col(p('b'), p('c')), 61), focus: 2 }) });
    await h.app._restoreSplitLayout();
    expect(h.names()).toEqual(['alpha', 'beta', 'gamma']);
    expect(FakePane.instances.map((x) => x.sessionId)).toEqual(['b', 'c']);
    const root = h.doc.querySelector('.terminal-split-container') as HTMLElement;
    expect(root.style.flexBasis).toBe('');
    expect((root.children[0] as HTMLElement).style.flexBasis).toBe('61%');
    expect(h.leaves()[2].classList.contains('split-leaf--focused')).toBe(true);
    expect(h.app._savedSplit).not.toBeNull();
  });

  it('selects the saved Pane A session when it differs from the one the app restored', async () => {
    const h = boot({ active: 'd', fetchPlan: saved({ root: row(p('a'), p('b')) }) });
    await h.app._restoreSplitLayout();
    expect(h.app.__selected).toEqual(['a']);
    expect(h.names()).toEqual(['alpha', 'beta']);
  });

  it('a pane whose session is gone is left EMPTY with a chooser; the rest restores normally', async () => {
    const h = boot({ fetchPlan: saved({ root: row(p('a'), col(p('gone'), p('c')), 50) }) });
    await h.app._restoreSplitLayout();
    expect(h.leaves()).toHaveLength(3);
    expect(FakePane.instances.map((x) => x.sessionId)).toEqual(['c']);
    const empty = h.doc.querySelector('.split-leaf--empty')!;
    expect(empty.querySelector('.split-empty')!.textContent).toBe('Choose a session');
    expect(empty.querySelector('.split-pane-name')!.textContent).toBe('Empty');
  });

  it('leaves a pane empty for an exited, popped-out, or already-shown session', async () => {
    const h = boot({ fetchPlan: saved({ root: row(p('a'), col(p('x'), p('c'))) }) });
    h.app.detachedSessions.add('c');
    await h.app._restoreSplitLayout();
    expect(FakePane.instances).toHaveLength(0);
    expect(h.doc.querySelectorAll('.split-empty')).toHaveLength(2);
  });

  it('an empty pane can be filled from its chooser', async () => {
    const h = boot({ fetchPlan: saved({ root: row(p('a'), p('gone')) }) });
    await h.app._restoreSplitLayout();
    const key = h.app._splitLeaves()[1].key;
    h.app._splitAssignSession(key, 'd');
    expect(FakePane.instances.map((x) => x.sessionId)).toEqual(['d']);
    expect(h.doc.querySelector('.split-empty')).toBeNull();
  });

  it('does nothing without a saved split, in a narrow window, in a solo window, or when a split is already open', async () => {
    const none = boot({ fetchPlan: saved(null) });
    await none.app._restoreSplitLayout();
    expect(none.doc.querySelector('.terminal-split-container')).toBeNull();

    const narrow = boot({ width: 1000, fetchPlan: saved({ root: row(p('a'), p('b')) }) });
    await narrow.app._restoreSplitLayout();
    expect(narrow.fetched).toHaveLength(0);

    const solo = boot({ fetchPlan: saved({ root: row(p('a'), p('b')) }) });
    solo.app.isSoloWindow = true;
    await solo.app._restoreSplitLayout();
    expect(solo.fetched).toHaveLength(0);

    const open = boot({ fetchPlan: saved({ root: row(p('a'), p('b')) }) });
    open.app.openSplitPane('c');
    await open.app._restoreSplitLayout();
    expect(open.names()).toEqual(['alpha', 'gamma']);
  });

  it('runs once per page load', async () => {
    const h = boot({ fetchPlan: saved({ root: row(p('a'), p('b')) }) });
    await h.app._restoreSplitLayout();
    h.app.closeSplitPane();
    await h.app._restoreSplitLayout();
    expect(h.doc.querySelector('.terminal-split-container')).toBeNull();
    expect(h.fetched.filter((f) => f.method === 'GET')).toHaveLength(1);
  });

  it('survives a layout it cannot read, and a malformed saved split', async () => {
    const down = boot({ fetchPlan: () => ({ status: 500, body: { success: false } }) });
    await expect(down.app._restoreSplitLayout()).resolves.toBeUndefined();
    const bad = boot({ fetchPlan: saved({ root: { t: 'x' } }) });
    await bad.app._restoreSplitLayout();
    expect(bad.doc.querySelector('.terminal-split-container')).toBeNull();
  });
});

describe('narrowing the window', () => {
  it('closes an open split when the window drops below the desktop width', () => {
    const h = boot();
    h.app.openSplitPane('b');
    Object.defineProperty(h.win, 'innerWidth', { value: 900, configurable: true });
    h.app._applySplitButtonVisibility(true);
    expect(h.app._splitTree).toBeNull();
    expect(h.doc.querySelector('.terminal-split-container')).toBeNull();
  });
});

describe('dropping a dragged session on the work area (T3 residual)', () => {
  const rect = (l: number, t: number, w: number, hgt: number) => ({
    left: l,
    top: t,
    right: l + w,
    bottom: t + hgt,
    width: w,
    height: hgt,
    x: l,
    y: t,
  });
  /** Pretend the pointer is at (x, y) over `el`, which occupies `box`. */
  function pointOver(h: ReturnType<typeof boot>, el: Element, box: ReturnType<typeof rect>) {
    (el as HTMLElement).getBoundingClientRect = () => box as DOMRect;
    (h.doc as any).elementFromPoint = () => el;
  }
  const dragEvent = (x: number, y: number) => ({
    clientX: x,
    clientY: y,
    preventDefault: vi.fn(),
    dataTransfer: { dropEffect: '', effectAllowed: 'uninitialized', setData: vi.fn() },
  });
  const overlay = (h: ReturnType<typeof boot>) => h.doc.querySelector('.split-drop-overlay') as HTMLElement;

  it('splits side by side when the pointer is nearer a left/right edge, and previews the right half', () => {
    const h = boot();
    h.app._splitDragId = 'b';
    pointOver(h, h.doc.getElementById('wrap')!, rect(0, 0, 1000, 600));
    const e = dragEvent(30, 300);
    h.app._onSplitDragOver(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(overlay(h).classList.contains('is-on')).toBe(true);
    expect(overlay(h).classList.contains('is-refused')).toBe(false);
    expect((overlay(h).firstElementChild as HTMLElement).style.cssText).toContain('left: 50%');
    h.app._onSplitDrop(dragEvent(30, 300));
    expect(h.app._splitTree.d).toBe('row');
    expect(h.names()).toEqual(['alpha', 'beta']);
    expect(overlay(h).classList.contains('is-on')).toBe(false);
  });

  it('splits top and bottom near a top/bottom edge', () => {
    const h = boot();
    h.app._splitDragId = 'b';
    pointOver(h, h.doc.getElementById('wrap')!, rect(0, 0, 1000, 600));
    h.app._onSplitDragOver(dragEvent(500, 20));
    expect((overlay(h).firstElementChild as HTMLElement).style.cssText).toContain('top: 50%');
    h.app._onSplitDrop(dragEvent(500, 20));
    expect(h.app._splitTree.d).toBe('col');
  });

  it('splits the pane under the pointer, not the focused one', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app._setSplitFocus(h.app._splitLeaves()[0].key);
    const paneB = h.leaves()[1];
    h.app._splitDragId = 'c';
    pointOver(h, paneB, rect(600, 0, 500, 600));
    h.app._onSplitDragOver(dragEvent(850, 590));
    h.app._onSplitDrop(dragEvent(850, 590));
    // B was split top/bottom into B + C; A is untouched
    expect(h.app._splitTree.a.t).toBe('p');
    expect(h.app._splitTree.b).toMatchObject({ t: 's', d: 'col' });
    expect(h.names()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it.each([
    ['the active session', 'a', 'Already shown in a panel'],
    ['a session that is not running', 'x', 'This session is not running'],
  ])('refuses %s: no drop allowed, the overlay says why', (_l, id, why) => {
    const h = boot();
    h.app._splitDragId = id;
    pointOver(h, h.doc.getElementById('wrap')!, rect(0, 0, 1000, 600));
    const e = dragEvent(30, 300);
    h.app._onSplitDragOver(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(overlay(h).classList.contains('is-refused')).toBe(true);
    expect(overlay(h).querySelector('.split-drop-label')!.textContent).toBe(why);
    h.app._onSplitDrop(dragEvent(30, 300));
    expect(h.app._splitTree).toBeFalsy();
  });

  it('refuses a fifth pane, a narrow window, and a session already in another pane', () => {
    const h = boot();
    h.app.openSplitPane('b');
    h.app.openSplitPane('c');
    h.app.openSplitPane('d');
    const primary = h.leaves()[0];
    pointOver(h, primary, rect(0, 0, 1000, 600));
    (h.doc as any).elementFromPoint = () => h.doc.getElementById('wrap');
    h.app._splitDragId = 'e';
    h.app._onSplitDragOver(dragEvent(30, 300));
    expect(overlay(h).querySelector('.split-drop-label')!.textContent).toBe('A split holds at most 4 panels');
    h.app._onSplitDrop(dragEvent(30, 300));
    expect(h.app._splitLeaves()).toHaveLength(4);
    expect(h.app._splitDropRefusal('b')).toBe('limit');
    Object.defineProperty(h.win, 'innerWidth', { value: 900, configurable: true });
    expect(h.app._splitDropRefusal('e')).toBe('narrow');
  });

  it('ignores a drag that did not start on a session row, and a pointer outside the work area', () => {
    const h = boot();
    h.app._onSplitDragOver(dragEvent(10, 10));
    expect(overlay(h)).toBeNull();
    h.app._splitDragId = 'b';
    (h.doc as any).elementFromPoint = () => h.doc.querySelector('aside');
    h.app._onSplitDragOver(dragEvent(10, 10));
    expect(overlay(h)?.classList.contains('is-on') ?? false).toBe(false);
  });

  it('remembers the dragged row on dragstart', () => {
    const h = boot();
    h.doc.body.insertAdjacentHTML('beforeend', '<div class="session-tab" data-id="b"><span id="in"></span></div>');
    const e = {
      target: h.doc.getElementById('in'),
      dataTransfer: { setData: vi.fn(), effectAllowed: 'uninitialized' },
    };
    h.app._onSplitDragStart(e);
    expect(h.app._splitDragId).toBe('b');
    expect(e.dataTransfer.effectAllowed).toBe('move');
  });
});

afterEach(() => {
  vi.useRealTimers();
});
