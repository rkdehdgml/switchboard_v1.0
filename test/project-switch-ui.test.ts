/**
 * @fileoverview Switchboard T8 — the per-session project switch (project-switch.js) in jsdom: the pure
 * helpers, the popover, the confirmation for a live session, the order of the restart (new session first,
 * old one closed only after that worked), failure paths, escaping and Korean/Chinese coverage.
 *
 * Port: N/A (no server start)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const read = (p: string) => readFileSync(resolve('src/web/public', p), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};

interface Call {
  method: string;
  url: string;
  body?: any;
}

interface Options {
  language?: string;
  sessions?: Record<string, any>;
  cases?: Array<{ name: string; path: string }>;
  respond?: (call: Call) => any;
  state?: string;
  exitLabel?: string;
  split?: boolean;
}

const session = (over: Record<string, any> = {}) => ({
  id: 's1',
  name: 'w1-billing',
  mode: 'claude',
  pid: 4242,
  workingDir: '/home/u/billing',
  lastActivityAt: 1_700_000_000_000,
  ...over,
});

function boot(opts: Options = {}) {
  const dom = new JSDOM('<!doctype html><html lang="en"><body></body></html>', {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1:3600/',
  });
  const window = dom.window as any;
  const ctx = dom.getInternalVMContext();
  for (const f of ['i18n-ko.js', 'i18n.js']) vm.runInContext(read(f), ctx, { filename: f });
  window.CodemanI18n.configure({ language: opts.language ?? 'en' });

  const calls: Call[] = [];
  const toasts: Array<[string, string]> = [];
  const closed: Array<[string, boolean]> = [];
  const assigned: Array<[unknown, string]> = [];
  const selected: string[] = [];
  const order: string[] = [];
  let createdCount = 0;
  const sessions = new Map(Object.entries(opts.sessions ?? { s1: session() }));
  const cases = opts.cases ?? [];

  window.paneExitLabel = () => opts.exitLabel ?? '';
  window.fetch = async (url: string, init: any = {}) => {
    const call: Call = { method: init.method || 'GET', url, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    order.push(`${call.method} ${call.url.split('?')[0]}`);
    const custom = opts.respond?.(call);
    if (custom) return { json: async () => custom };
    if (url === '/api/cases') return { json: async () => ({ success: true, data: cases }) };
    if (url === '/api/cases/link') return { json: async () => ({ success: true, data: { case: call.body } }) };
    if (url === '/api/sessions' && call.method === 'POST') {
      createdCount++;
      return {
        json: async () => ({
          success: true,
          data: {
            session: session({ id: `new${createdCount}`, name: call.body.name, workingDir: call.body.workingDir }),
          },
        }),
      };
    }
    return { json: async () => ({ success: true, data: {} }) };
  };

  window.app = {
    sessions,
    pendingHooks: new Map(),
    _splitTree: opts.split === false ? null : {},
    _mobileOverviewState: () => opts.state ?? 'idle',
    _nextCaseSessionStartNumber: () => 3,
    getCaseSettings: () => ({}),
    loadAppSettingsFromStorage: () => ({}),
    buildEnvOverrides: () => ({}),
    getEffortSetting: () => '',
    isRalphTrackerEnabledByDefault: () => false,
    _ensureCreatedSessionVisible: async (id: string, snapshot: any) => {
      order.push(`visible ${id}`);
      sessions.set(id, snapshot);
    },
    _splitAssignSession: (key: unknown, id: string) => {
      order.push(`assign ${id}`);
      assigned.push([key, id]);
    },
    selectSession: (id: string) => {
      order.push(`select ${id}`);
      selected.push(id);
    },
    closeSession: async (id: string, kill: boolean) => {
      order.push(`close ${id}`);
      closed.push([id, kill]);
    },
    showToast: (m: string, k: string) => toasts.push([m, k]),
  };
  vm.runInContext(read('project-switch.js'), ctx, { filename: 'project-switch.js' });
  const doc = window.document as Document;
  const anchor = doc.createElement('button');
  anchor.className = 'psw-trigger';
  doc.body.append(anchor);
  return {
    window,
    doc,
    calls,
    toasts,
    closed,
    assigned,
    selected,
    order,
    sessions,
    anchor,
    ps: window.CodemanProjectSwitch,
    app: window.app,
  };
}

let current: ReturnType<typeof boot> | null = null;
const start = (opts: Options = {}) => (current = boot(opts));
afterEach(async () => {
  if (!current) return;
  await tick();
  current.window.close();
  current = null;
});

const text = (el: Element | null) => el?.textContent ?? '';
const clickNamed = (doc: Document, label: string) =>
  ([...doc.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement).click();

describe('pure helpers', () => {
  it('isSessionLive: no pid, a dead pane, stopped or error are not live; an unknown pane state is', () => {
    const { ps } = start();
    expect(ps.isSessionLive(session(), 'idle', '')).toBe(true);
    expect(ps.isSessionLive(session(), 'working', '')).toBe(true);
    expect(ps.isSessionLive(session(), 'needs', '')).toBe(true);
    expect(ps.isSessionLive(session(), 'waiting', '')).toBe(true);
    expect(ps.isSessionLive(session({ pid: null }), 'idle', '')).toBe(false);
    expect(ps.isSessionLive(session({ pid: undefined }), 'idle', '')).toBe(false);
    expect(ps.isSessionLive(session(), 'idle', 'exited (0)')).toBe(false);
    expect(ps.isSessionLive(session(), 'done', '')).toBe(false);
    expect(ps.isSessionLive(session(), 'error', '')).toBe(false);
    expect(ps.isSessionLive(null, 'idle', '')).toBe(false);
  });

  it('isBusyState: only working and needs-an-answer count as work in progress', () => {
    const { ps } = start();
    expect([
      ps.isBusyState('working'),
      ps.isBusyState('needs'),
      ps.isBusyState('idle'),
      ps.isBusyState('waiting'),
    ]).toEqual([true, true, false, false]);
  });

  it('caseNameFor folds a folder name into a valid, free case name', () => {
    const { ps } = start();
    expect(ps.caseNameFor('/mnt/d/dev/my app', new Set())).toBe('my-app');
    expect(ps.caseNameFor('/mnt/d/dev/한글', new Set())).toBe('project');
    expect(ps.caseNameFor('/x/api', new Set(['api', 'api-2']))).toBe('api-3');
    expect(ps.caseNameFor('/x/' + 'a'.repeat(100), new Set())).toHaveLength(60);
  });

  it('recentProjects: stored + session folders, newest first, current left out, capped at 5, deduped', () => {
    const { ps } = start();
    const sessions = new Map<string, any>([
      ['a', session({ workingDir: '/p/one', lastActivityAt: 100 })],
      ['b', session({ workingDir: '/p/two', lastActivityAt: 300 })],
      ['c', session({ workingDir: '/p/two/', lastActivityAt: 50 })],
      ['d', session({ workingDir: '/p/cur', lastActivityAt: 999 })],
      ['e', session({ workingDir: 'user@host:/remote', lastActivityAt: 998 })],
      ['f', session({ workingDir: '/p/three', lastActivityAt: 10 })],
      ['g', session({ workingDir: '/p/four', lastActivityAt: 20 })],
      ['h', session({ workingDir: '/p/five', lastActivityAt: 30 })],
    ]);
    const stored = [
      { path: '/p/stored', at: 500 },
      { path: '/p/one', at: 400 },
    ];
    const list = ps.recentProjects(sessions, '/p/cur', stored);
    expect(list.map((e: any) => e.path)).toEqual(['/p/stored', '/p/one', '/p/two', '/p/five', '/p/four']);
    expect(list.find((e: any) => e.path === '/p/one').at).toBe(400);
  });

  it('noteRecent keeps a bounded, deduped, newest-first list on this device', () => {
    const { ps, window } = start();
    for (let i = 0; i < 14; i++) ps.noteRecent(`/p/${i}`, 1000 + i);
    ps.noteRecent('/p/5', 5000);
    const stored = JSON.parse(window.localStorage.getItem('codeman-recent-projects'));
    expect(stored).toHaveLength(10);
    expect(stored[0]).toEqual({ path: '/p/5', at: 5000 });
    expect(stored.filter((e: any) => e.path === '/p/5')).toHaveLength(1);
  });

  it('survives a broken or hostile stored list', () => {
    const { ps, window } = start();
    window.localStorage.setItem('codeman-recent-projects', '{not json');
    expect(ps.recentProjects(new Map(), '/x')).toEqual([]);
    window.localStorage.setItem(
      'codeman-recent-projects',
      JSON.stringify([{ path: 5 }, null, { path: 'rel', at: 1 }, { path: '/ok', at: 2 }])
    );
    expect(ps.recentProjects(new Map(), '/x').map((e: any) => e.path)).toEqual(['/ok']);
  });
});

describe('popover', () => {
  it('shows the current folder in full, recent projects and the browse button, with the new-conversation warning', () => {
    const t = start({
      sessions: {
        s1: session(),
        s2: session({ id: 's2', workingDir: '/home/u/recent-one', lastActivityAt: Date.now() - 3600_000 }),
      },
    });
    t.ps.open(undefined, t.anchor, { app: t.app, key: 7, sessionId: 's1' });
    const pop = t.doc.querySelector('.psw-pop')!;
    expect(pop.getAttribute('role')).toBe('dialog');
    expect(text(pop.querySelector('.psw-current'))).toBe('/home/u/billing');
    const rows = [...pop.querySelectorAll('.psw-recent')];
    expect(rows).toHaveLength(1);
    expect(text(rows[0].querySelector('.psw-recent-name'))).toBe('recent-one');
    expect(text(rows[0].querySelector('.psw-recent-parent'))).toBe('/home/u');
    expect(text(rows[0].querySelector('.psw-recent-when'))).toMatch(/hour/);
    expect(text(pop.querySelector('#pswBrowse'))).toBe('Browse for a folder…');
    expect(text(pop.querySelector('.psw-warn'))).toContain('starts a new conversation');
    expect(t.doc.activeElement).toBe(rows[0]);
  });

  it('writes paths as text, never markup', () => {
    const evil = '/home/u/<img src=x onerror=alert(1)>';
    const t = start({
      sessions: { s1: session({ workingDir: evil }), s2: session({ id: 's2', workingDir: '/h/<b>x</b>' }) },
    });
    t.ps.open(undefined, t.anchor, { app: t.app, key: 1, sessionId: 's1' });
    expect(t.doc.querySelector('.psw-pop img, .psw-pop b')).toBeNull();
    expect(text(t.doc.querySelector('.psw-current'))).toBe(evil);
  });

  it('says why when the session is not a Claude session, and offers no switching', () => {
    const t = start({ sessions: { s1: session({ mode: 'shell' }) } });
    t.ps.open(undefined, t.anchor, { app: t.app, key: 1, sessionId: 's1' });
    expect(text(t.doc.querySelector('.psw-pop'))).toContain('Only Claude sessions can switch projects.');
    expect(t.doc.querySelector('#pswBrowse')).toBeNull();
    expect(t.doc.querySelector('.psw-recent')).toBeNull();
  });

  it('closes on Escape and on an outside click, but not on a click inside', async () => {
    const t = start();
    t.ps.open(undefined, t.anchor, { app: t.app, key: 1, sessionId: 's1' });
    await tick();
    (t.doc.querySelector('.psw-current') as HTMLElement).click();
    expect(t.doc.querySelector('.psw-pop')).not.toBeNull();
    t.doc.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(t.doc.querySelector('.psw-pop')).toBeNull();
    t.ps.open(undefined, t.anchor, { app: t.app, key: 1, sessionId: 's1' });
    await tick();
    t.doc.body.click();
    expect(t.doc.querySelector('.psw-pop')).toBeNull();
  });

  it('opening it again replaces the old one (one popover, no leaked listeners)', async () => {
    const t = start();
    const add = vi.spyOn(t.doc, 'addEventListener');
    const remove = vi.spyOn(t.doc, 'removeEventListener');
    for (let i = 0; i < 3; i++) {
      t.ps.open(undefined, t.anchor, { app: t.app, key: 1, sessionId: 's1' });
      await tick();
    }
    expect(t.doc.querySelectorAll('.psw-pop')).toHaveLength(1);
    t.doc.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const clickAdds = add.mock.calls.filter((c) => c[0] === 'click').length;
    const clickRemoves = remove.mock.calls.filter((c) => c[0] === 'click').length;
    expect(clickRemoves).toBe(clickAdds);
  });
});

describe('switching: an ended session', () => {
  it('switches at once, with no confirmation: opens the folder first, then closes the dead session', async () => {
    const t = start({ sessions: { s1: session({ pid: null }) }, state: 'done' });
    const result = await t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    expect(result).toBe('switched');
    expect(t.doc.querySelector('.psw-confirm')).toBeNull();
    // order: link the folder as a case, create the session, show it, only then close the old one
    const steps = t.order.filter((s) => /cases\/link|POST \/api\/sessions$|assign|close/.test(s));
    expect(steps).toEqual(['POST /api/cases/link', 'POST /api/sessions', 'assign new1', 'close s1']);
    expect(t.closed).toEqual([['s1', true]]);
    expect(t.assigned).toEqual([[7, 'new1']]);
  });

  it('a dead pane (exit label) counts as ended even though the state still says idle', async () => {
    const t = start({ exitLabel: 'exited (0)', state: 'idle' });
    expect(await t.ps.switchProject(t.app, 7, 's1', '/home/u/other')).toBe('switched');
    expect(t.doc.querySelector('.psw-confirm')).toBeNull();
    expect(t.closed).toEqual([['s1', true]]);
  });
});

describe('switching: a live session', () => {
  const live = (over: Options = {}) => start({ state: 'idle', ...over });

  it('asks first: two named choices with the recommended one focused, and nothing happens before the answer', async () => {
    const t = live();
    const pending = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    const box = t.doc.querySelector('.psw-confirm')!;
    expect(box.getAttribute('role')).toBe('alertdialog');
    expect(text(box)).toContain('Switching the project starts a new conversation.');
    expect(text(box)).toContain('/home/u/billing');
    expect(text(box)).toContain('/home/u/other');
    expect(t.doc.activeElement?.id).toBe('pswNewSession');
    expect(t.doc.getElementById('pswNewSession')!.className).toContain('psw-primary');
    expect(text(t.doc.getElementById('pswNewSession'))).toBe('New session (recommended)');
    expect(text(t.doc.getElementById('pswRestart'))).toBe('Restart this session');
    expect(t.calls).toEqual([]); // not even a request yet
    clickNamed(t.doc, 'Cancel');
    expect(await pending).toBe('cancelled');
    expect(t.calls).toEqual([]);
    expect(t.closed).toEqual([]);
    expect(t.doc.querySelector('.psw-confirm')).toBeNull();
  });

  it('Escape cancels exactly like the button', async () => {
    const t = live();
    const pending = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    t.doc.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(await pending).toBe('cancelled');
    expect(t.calls).toEqual([]);
  });

  it('"New session" opens the folder and leaves the old session untouched', async () => {
    const t = live();
    const pending = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    clickNamed(t.doc, 'New session (recommended)');
    expect(await pending).toBe('switched');
    expect(t.closed).toEqual([]);
    expect(t.assigned).toEqual([[7, 'new1']]);
    expect(t.toasts.at(-1)).toEqual(['New session started', 'success']);
    expect(t.sessions.has('s1')).toBe(true);
  });

  it('"Restart this session" opens the new session FIRST and closes the old one only afterwards', async () => {
    const t = live();
    const pending = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    clickNamed(t.doc, 'Restart this session');
    expect(await pending).toBe('switched');
    const steps = t.order.filter((s) => /POST \/api\/sessions$|interactive|assign|close/.test(s));
    expect(steps).toEqual(['POST /api/sessions', 'POST /api/sessions/new1/interactive', 'assign new1', 'close s1']);
    expect(t.toasts.at(-1)).toEqual(['Project switched', 'success']);
  });

  it('the restart copy mentions the interruption only when work is in progress', async () => {
    const busy = live({ state: 'working' });
    let pending = busy.ps.switchProject(busy.app, 7, 's1', '/home/u/other');
    await settle();
    expect(text(busy.doc.querySelector('.psw-confirm'))).toContain('Work in progress is interrupted');
    clickNamed(busy.doc, 'Cancel');
    await pending;
    await tick();
    busy.window.close();

    const idle = start({ state: 'idle' });
    pending = idle.ps.switchProject(idle.app, 7, 's1', '/home/u/other');
    await settle();
    expect(text(idle.doc.querySelector('.psw-confirm'))).not.toContain('Work in progress');
    expect(text(idle.doc.querySelector('.psw-confirm'))).toContain(
      'history file stays under the original project folder'
    );
    clickNamed(idle.doc, 'Cancel');
    await pending;
  });

  it('a failed start never closes the old session, reports the reason, and removes the half-made one by exact id', async () => {
    const t = live({
      respond: (call) =>
        call.url.endsWith('/interactive') ? { success: false, error: 'tmux is not available' } : null,
    });
    const pending = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    clickNamed(t.doc, 'Restart this session');
    expect(await pending).toBe('failed');
    expect(t.closed).toEqual([]);
    expect(t.assigned).toEqual([]);
    expect(t.toasts.at(-1)?.[1]).toBe('error');
    expect(t.toasts.at(-1)?.[0]).toContain('Could not switch the project');
    expect(t.toasts.at(-1)?.[0]).toContain('tmux is not available');
    const del = t.calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe('/api/sessions/new1?killMux=true');
  });

  it('a refused folder link stops everything before any session exists', async () => {
    const t = live({
      respond: (call) => (call.url === '/api/cases/link' ? { success: false, error: 'Folder not found: /x' } : null),
    });
    const pending = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    clickNamed(t.doc, 'Restart this session');
    expect(await pending).toBe('failed');
    expect(t.calls.some((c) => c.method === 'POST' && c.url === '/api/sessions')).toBe(false);
    expect(t.closed).toEqual([]);
  });

  it('reuses the case that already points at the folder instead of linking it again', async () => {
    const t = live({ cases: [{ name: 'other-case', path: '/home/u/other' }] });
    const pending = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    clickNamed(t.doc, 'New session (recommended)');
    await pending;
    expect(t.calls.some((c) => c.url === '/api/cases/link')).toBe(false);
    expect(t.calls.find((c) => c.method === 'POST' && c.url === '/api/sessions')?.body).toMatchObject({
      workingDir: '/home/u/other',
      name: 'w3-other-case',
    });
  });

  it('links a new folder under a free, valid name and retries once on a name clash', async () => {
    let first = true;
    const names: string[] = [];
    const t = live({
      cases: [{ name: 'other', path: '/elsewhere/other' }],
      respond: (call) => {
        if (call.url !== '/api/cases/link') return null;
        names.push(call.body.name);
        if (first) {
          first = false;
          return { success: false, error: 'A case with this name already exists in codeman-cases.' };
        }
        return { success: true, data: {} };
      },
    });
    const pending = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    clickNamed(t.doc, 'New session (recommended)');
    expect(await pending).toBe('switched');
    expect(names).toEqual(['other-2', 'other-3']);
  });

  it('the same folder is a no-op, and a second switch while one runs is refused', async () => {
    const t = live();
    expect(await t.ps.switchProject(t.app, 7, 's1', '/home/u/billing/')).toBe('unchanged');
    expect(t.calls).toEqual([]);
    const first = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    expect(await t.ps.switchProject(t.app, 7, 's1', '/home/u/third')).toBe('busy'); // only one at a time, confirmation included
    clickNamed(t.doc, 'Cancel');
    await first;
  });

  it('without a split open the new session is simply selected', async () => {
    const t = start({ split: false, state: 'idle' });
    const pending = t.ps.switchProject(t.app, null, 's1', '/home/u/other');
    await settle();
    clickNamed(t.doc, 'New session (recommended)');
    await pending;
    expect(t.selected).toEqual(['new1']);
    expect(t.assigned).toEqual([]);
  });

  it('remembers the chosen folder in the recent list', async () => {
    const t = live();
    const pending = t.ps.switchProject(t.app, 7, 's1', '/home/u/other');
    await settle();
    clickNamed(t.doc, 'New session (recommended)');
    await pending;
    expect(JSON.parse(t.window.localStorage.getItem('codeman-recent-projects'))[0].path).toBe('/home/u/other');
  });
});

describe('browse button', () => {
  it('uses the native dialog and switches to the chosen folder; a cancelled dialog does nothing', async () => {
    const t = start({ state: 'idle' });
    const asked: unknown[] = [];
    let answer: any = { status: 'cancelled' };
    t.window.CodemanFolderPicker = {
      isAvailable: () => true,
      choose: async (o: unknown) => (asked.push(o), answer),
    };
    t.ps.open(undefined, t.anchor, { app: t.app, key: 7, sessionId: 's1' });
    (t.doc.getElementById('pswBrowse') as HTMLButtonElement).click();
    await settle();
    expect(asked).toEqual([{ title: 'Select project folder', defaultPath: '/home/u/billing' }]);
    expect(t.calls).toEqual([]);
    expect(t.doc.querySelector('.psw-pop')).toBeNull();

    answer = { status: 'ok', wslPath: '/home/u/browsed' };
    t.ps.open(undefined, t.anchor, { app: t.app, key: 7, sessionId: 's1' });
    (t.doc.getElementById('pswBrowse') as HTMLButtonElement).click();
    await settle();
    expect(t.doc.querySelector('.psw-confirm')).not.toBeNull(); // live session: asks first
    clickNamed(t.doc, 'New session (recommended)');
    await settle();
    expect(t.calls.find((c) => c.method === 'POST' && c.url === '/api/sessions')?.body.workingDir).toBe(
      '/home/u/browsed'
    );
  });

  it('picking a recent project goes through the same switch', async () => {
    const t = start({
      state: 'idle',
      sessions: { s1: session(), s2: session({ id: 's2', workingDir: '/home/u/recent-one' }) },
    });
    t.ps.open(undefined, t.anchor, { app: t.app, key: 7, sessionId: 's1' });
    (t.doc.querySelector('.psw-recent') as HTMLButtonElement).click();
    await settle();
    expect(text(t.doc.querySelector('.psw-confirm'))).toContain('/home/u/recent-one');
    clickNamed(t.doc, 'Cancel');
    await settle();
    expect(t.calls).toEqual([]);
  });
});

describe('wiring and translation', () => {
  it('is wired: script after work-folders.js and before session-ui.js; the header has a session button and a project chip', () => {
    const html = read('index.html');
    expect(html.indexOf('src="project-switch.js"')).toBeGreaterThan(html.indexOf('src="work-folders.js"'));
    expect(html.indexOf('src="project-switch.js"')).toBeLessThan(html.indexOf('src="session-ui.js"'));
    const split = read('terminal-split.js');
    // the session name is the session picker, the chip is the folder switch (the T5 picker moved to the name)
    expect(split).toMatch(
      /sessionBtn\.addEventListener\('click', \(e\) => this\.openSplitPicker\(e, sessionBtn, \{ assignKey: key \}\)\)/
    );
    expect(split).toContain('window.CodemanProjectSwitch.open(e, project');
    expect(split).toContain("'Change the project of this session'");
  });

  it('every string the module shows has a Korean and a Chinese translation', async () => {
    const source = read('project-switch.js');
    const keys = new Set<string>();
    const grab = (re: RegExp) => {
      for (const m of source.matchAll(re)) keys.add(m[1].replace(/\\'/g, "'").replace(/\\"/g, '"'));
    };
    grab(/\bt\('((?:[^'\\]|\\.)*)'\)/g);
    grab(/\bt\("((?:[^"\\]|\\.)*)"\)/g);
    grab(/button\(\s*'((?:[^'\\]|\\.)*)'/g);
    grab(/\[\s*'((?:[^'\\]|\\.)*)',\s*(?:fromFolder|toFolder)\s*\]/g);
    for (const m of source.matchAll(
      /^\s+(?:busy\s*\?\s*)?["']((?:[^"'\\]|\\.)*[a-z](?:[^"'\\]|\\.)* (?:[^"'\\]|\\.)*)["']\s*:?\s*$/gm
    )) {
      keys.add(m[1]);
    }
    keys.add(
      "Work in progress is interrupted and this session's conversation is closed on screen. The history file stays under the original project folder."
    );
    keys.add(
      "This session's conversation is closed on screen. The history file stays under the original project folder."
    );
    expect(keys.size).toBeGreaterThan(14);
    for (const language of ['ko', 'zh-CN']) {
      const t = boot({ language });
      const missing = [...keys].filter((k) => t.window.CodemanI18n.t(k) === k);
      await tick();
      t.window.close();
      expect(missing, `${language} missing`).toEqual([]);
    }
  });

  it('the Korean copy keeps the sentences the spec fixes word for word', () => {
    const t = start({ language: 'ko' });
    const tr = (s: string) => t.window.CodemanI18n.t(s);
    expect(
      tr('Switching the project starts a new conversation. The current conversation is not moved to the other folder.')
    ).toBe('프로젝트를 바꾸면 새 대화로 시작합니다. 지금 대화는 다른 폴더로 옮겨지지 않습니다.');
    expect(
      tr('The current session and its conversation stay as they are. You can return to it from the rail at any time.')
    ).toBe('지금 세션과 대화는 그대로 남습니다. 레일에서 언제든 돌아갈 수 있습니다.');
    expect(
      tr(
        "Work in progress is interrupted and this session's conversation is closed on screen. The history file stays under the original project folder."
      )
    ).toBe(
      '진행 중인 작업이 중단되고, 이 세션의 대화는 화면에서 닫힙니다. 기록 파일은 원래 프로젝트 폴더 기준으로 남아 있습니다.'
    );
  });
});
