/**
 * @fileoverview Switchboard T4 — Home pinned tab + usage dashboard: the pinned row, tab
 * hand-off, empty/limit states, escaping of log-derived text, wiring and strings.
 *
 * Port: N/A (no server start)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const read = (p: string) => readFileSync(resolve('src/web/public', p), 'utf8');
const homeSource = read('home-dashboard.js');
const i18nSource = read('i18n.js');
const appSource = read('app.js');
const webviewSource = read('webview-tabs.js');
const indexHtml = read('index.html');
const styles = read('styles.css');

const SUMMARY = {
  generatedAt: Date.parse('2026-10-02T05:00:00Z'),
  today: '2026-10-02',
  weekStart: '2026-09-28',
  hasData: true,
  costToday: 1.09,
  costWeek: 40.64,
  unrecordedWeek: 0,
  unknownCostWeek: 0,
  cacheHitRate: 0.98,
  models: [
    { model: 'claude-opus-5-5', costUsd: 23.5, input: 14936, output: 276586, cacheRead: 47032115, cacheWrite: 1 },
  ],
  projects: [{ project: 'proj', costUsd: 9.5 }],
  tools: { skills: [{ name: 'tdd', count: 3 }], mcp: [], errors: 4, denials: 1 },
};

function harness(opts: { sessions?: Array<[string, string]> } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <main class="main"><div id="sessionTabs"><div class="session-tab active" data-id="s1"></div></div>
       <div class="home-layer" id="homeLayer"></div></main></body></html>`,
    { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true }
  );
  const win = dom.window as unknown as Record<string, any>;
  class CodemanApp {}
  win.CodemanApp = CodemanApp;
  win.escapeHtml = (s: string) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  vm.runInContext(i18nSource, dom.getInternalVMContext(), { filename: 'i18n.js' });
  // The product default is Korean; these assertions read the English source strings.
  win.CodemanI18n.configure({ language: 'en' });
  vm.runInContext(homeSource, dom.getInternalVMContext(), { filename: 'home-dashboard.js' });
  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  app.$ = (id: string) => win.document.getElementById(id);
  app.sessions = new Map((opts.sessions ?? []).map(([id]) => [id, { id }]));
  const states = new Map(opts.sessions ?? []);
  app._mobileOverviewState = (s: { id: string }) => states.get(s.id);
  app.homeActive = true;
  return { dom, app, layer: () => win.document.getElementById('homeLayer') as HTMLElement };
}

describe('Home tab row', () => {
  it('is pinned: no close button, not draggable, no Alt+N number, labelled with its shortcut', () => {
    const { app, dom } = harness();
    const holder = dom.window.document.createElement('div');
    holder.innerHTML = app.renderHomeTab();
    const row = holder.firstElementChild!;
    expect(row.getAttribute('data-home')).toBe('1');
    expect(row.getAttribute('role')).toBe('tab');
    expect(row.getAttribute('title')).toContain('Alt+0');
    expect(row.querySelector('.tab-close, .tab-number, [draggable]')).toBeNull();
    expect(row.querySelector('.tab-home-pin')).not.toBeNull();
  });

  it('marks exactly one tab active: Home steals the highlight from a session row', () => {
    const { app, dom } = harness();
    const tabs = dom.window.document.getElementById('sessionTabs')!;
    tabs.insertAdjacentHTML('afterbegin', app.renderHomeTab());
    app._updateHomeTab();
    expect(tabs.querySelectorAll('.session-tab.active')).toHaveLength(1);
    expect(tabs.querySelector('.session-tab--home')!.classList.contains('active')).toBe(true);
    app._hideHome();
    expect(app.homeActive).toBe(false);
    expect(dom.window.document.querySelector('.main')!.classList.contains('home-active')).toBe(false);
  });
});

describe('dashboard rendering', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness({
      sessions: [
        ['a', 'working'],
        ['b', 'needs'],
        ['c', 'waiting'],
        ['d', 'done'],
      ],
    });
  });

  it('shows the four KPI tiles; active sessions exclude finished ones and flag the waiting count', () => {
    h.app._homeData = SUMMARY;
    h.app._renderHome();
    const tiles = [...h.layer().querySelectorAll('.home-tile')].map((t) => t.textContent!.replace(/\s+/g, ' ').trim());
    expect(tiles[0]).toContain('$1.09');
    expect(tiles[1]).toContain('$40.64');
    expect(tiles[2]).toContain('3');
    expect(tiles[2]).toContain('2 waiting');
    expect(tiles[3]).toContain('98%');
    expect(h.layer().querySelector('.home-tile-sub--warn')).not.toBeNull();
  });

  it('with no data shows "No records yet", not zeros', () => {
    h.app._homeData = { ...SUMMARY, hasData: false };
    h.app._renderHome();
    expect(h.layer().textContent).toContain('No records yet');
    expect(h.layer().querySelector('.home-tile')).toBeNull();
  });

  it('with data but nothing this week shows dashes and "no records this week", not $0.00 and empty bars', () => {
    h.app._homeData = {
      ...SUMMARY,
      models: [],
      projects: [],
      costToday: 0,
      costWeek: 0,
      cacheHitRate: null,
      tools: { skills: [], mcp: [], errors: 0, denials: 0 },
    };
    h.app._renderHome();
    const text = h.layer().textContent!;
    expect(text).not.toContain('$0.00');
    expect(text).toContain('No records this week yet');
    expect(h.layer().querySelectorAll('.home-bar-fill')).toHaveLength(0);
  });

  it('plan limits: a word always accompanies the colour, and a missing window says so', () => {
    h.app._planUsage = {
      fiveHour: { usedPercentage: 72, resetAt: 1790927000000 },
      sevenDay: { usedPercentage: 91, resetAt: 1791000000000 },
    };
    h.app._homeData = SUMMARY;
    h.app._renderHome();
    const states = [...h.layer().querySelectorAll('.home-limit-state')].map((e) => e.textContent!.trim());
    expect(states).toEqual(['! Watch', '▲ Critical']);
    expect(h.layer().querySelector('[role=meter][aria-valuenow="91"]')).not.toBeNull();

    h.app._planUsage = { fiveHour: { usedPercentage: 10, resetAt: 1 } };
    h.app._renderHome();
    expect(h.layer().textContent).toContain('✓ Plenty');
    expect(h.layer().textContent).toContain('No reading yet');
  });

  it('every string taken from the logs is escaped (project, model, skill and server names)', () => {
    const evil = '<img src=x onerror=alert(1)>';
    h.app._homeData = {
      ...SUMMARY,
      models: [{ ...SUMMARY.models[0], model: evil }],
      projects: [{ project: evil, costUsd: 1 }],
      tools: { skills: [{ name: evil, count: 1 }], mcp: [{ name: evil, count: 1 }], errors: 0, denials: 0 },
    };
    h.app._renderHome();
    expect(h.layer().querySelector('img')).toBeNull();
    expect(h.layer().innerHTML).toContain('&lt;img');
  });

  it('notes name the sessions missing from the totals', () => {
    h.app._homeData = { ...SUMMARY, unrecordedWeek: 4, unknownCostWeek: 2 };
    h.app._renderHome();
    expect(h.layer().querySelector('.home-notes')!.textContent).toContain('4 sessions have no recorded cost');
    expect(h.layer().querySelector('.home-notes')!.textContent).toContain(
      '2 sessions use a model with unknown pricing'
    );
  });

  it('a failed load shows a message instead of a blank tab', () => {
    h.app._homeData = null;
    h.app._homeError = true;
    h.app._renderHome();
    expect(h.layer().textContent).toContain('Could not load usage data');
  });

  it('does not touch the DOM while the tab is not open', () => {
    h.app.homeActive = false;
    h.app._homeData = SUMMARY;
    h.app._renderHome();
    expect(h.layer().innerHTML).toBe('');
  });

  it('refresh is throttled: SSE bursts schedule at most one fetch', async () => {
    let fetches = 0;
    (h.dom.window as any).fetch = async () => (
      fetches++,
      { ok: true, json: async () => ({ success: true, data: SUMMARY }) }
    );
    await h.app.refreshHome(true);
    h.app._scheduleHomeRefresh();
    h.app._scheduleHomeRefresh();
    h.app._scheduleHomeRefresh();
    expect(fetches).toBe(1);
    expect(h.app._homeRefreshTimer).toBeTruthy(); // one pending timer, not three
    clearTimeout(h.app._homeRefreshTimer);
  });
});

describe('wiring', () => {
  it('Alt+0 opens Home only on the vertical rail', () => {
    expect(appSource).toMatch(/code === 'Digit0' && this\._tabOrientation\(\) === 'vertical'/);
  });

  it('the rail draws Home first, and a zero-session rail still rebuilds to draw it', () => {
    expect(appSource).toMatch(/parts\.unshift\(this\.renderHomeTab\(\)\)/);
    expect(appSource).toMatch(/homeTabUnchanged/);
  });

  it('other tabs take the stage back from Home, and no session row stays highlighted under it', () => {
    expect(appSource).toMatch(/this\._hideHome\?\.\(\);/);
    expect(webviewSource).toMatch(/this\._hideHome\?\.\(\);/);
    expect((appSource.match(/&& !this\.homeActive/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it('the rail search never hides Home; Enter on Home or a web tab opens it', () => {
    expect(appSource).toMatch(/session-tab:not\(\.session-tab--home\)/);
    expect(appSource).toMatch(/focused\.dataset\.home\) return this\.openHome\(\)/);
  });

  it('SSE handlers feed the dashboard (no polling timer of its own)', () => {
    expect(appSource).toMatch(/_scheduleHomeRefresh\?\.\(\)/);
    expect(appSource).toMatch(/this\._planUsage = data\.planUsage/);
    expect(homeSource).not.toMatch(/setInterval/);
  });

  it('index.html: layer sits beside the terminal, script loads after webview-tabs.js', () => {
    expect(indexHtml).toContain('id="homeLayer"');
    expect(indexHtml.indexOf('webview-tabs.js')).toBeLessThan(indexHtml.indexOf('home-dashboard.js'));
  });

  it('CSS: Home sorts before every group header; the dashboard follows the chart rules', () => {
    expect(styles).toMatch(/\.session-tab--home \{\s*order: -1;/);
    expect(styles).toMatch(/\.main\.home-active \.terminal-wrap/);
    // single bar colour from tokens, no grid lines, no dual axes
    expect(styles).toMatch(/\.home-bar-fill \{[^}]*var\(--data-bar\)/);
    expect(styles).toMatch(/\.home-bar-track \{[^}]*var\(--data-track\)/);
    expect(styles).toMatch(/\.home-tile-val--money \{ color: var\(--data-money\)/);
  });

  it('every dashboard string has a Korean and a Chinese translation', () => {
    const keys = [...homeSource.matchAll(/\bT\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    keys.push('Home', 'Usage', 'Today', 'This week', 'Active sessions', 'Cache hit rate');
    // Prettier unquotes identifier-like keys (`updated: '...'`), so accept both spellings.
    const has = (k: string) =>
      new RegExp(`(^|\\s)(['"]${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]|${k}):`, 'm').test(i18nSource);
    const missing = [...new Set(keys)].filter((k) => !has(k));
    expect(missing).toEqual([]);
    for (const k of ['Plenty', 'Watch', 'Critical', 'Plan limits', 'Permission denials']) {
      expect((i18nSource.match(new RegExp(`(^|\\s)['"]?${k}['"]?:`, 'gm')) || []).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('Home as the landing page (no welcome screen on the rail layouts)', () => {
  const terminalSource = read('terminal-ui.js');
  const start = terminalSource.indexOf('  showWelcome() {');
  const end = terminalSource.indexOf('  hideWelcome() {');
  // The mixin method, lifted out so it runs against a stand-in `this`.
  const showWelcome = new Function(`return ({${terminalSource.slice(start, end)}})`)().showWelcome as () => void;

  function land(orientation: 'vertical' | 'horizontal', homeActive = false) {
    const dom = new JSDOM('<!doctype html><div class="welcome-overlay visible" id="welcomeOverlay"></div>', {
      url: 'http://localhost/',
    });
    const calls: string[] = [];
    const self = {
      homeActive,
      _tabOrientation: () => orientation,
      shouldUseMobileOverview: () => false,
      hideMobileOverview: () => calls.push('hideMobileOverview'),
      hideHomeSessions: () => calls.push('hideHomeSessions'),
      openHome: () => calls.push('openHome'),
      loadTunnelStatus: () => calls.push('loadTunnelStatus'),
      applyWelcomeCliVisibility: () => calls.push('welcomeCli'),
      loadHistorySessions: () => calls.push('history'),
      initSearchPanel: () => calls.push('search'),
      showHomeSessions: () => calls.push('showHomeSessions'),
      _updateCjkInputState: () => undefined,
    };
    const g = globalThis as Record<string, unknown>;
    const prev = g.document;
    g.document = dom.window.document;
    try {
      showWelcome.call(self);
    } finally {
      g.document = prev;
    }
    return { calls, overlay: dom.window.document.getElementById('welcomeOverlay')! };
  }

  it('opens Home and hides the welcome page where the rail has a Home row', () => {
    const { calls, overlay } = land('vertical');
    expect(calls).toContain('openHome');
    expect(calls).not.toContain('loadTunnelStatus');
    expect(overlay.classList.contains('visible')).toBe(false);
  });

  it('does not reopen (and refetch) Home while it is already showing', () => {
    expect(land('vertical', true).calls).not.toContain('openHome');
  });

  it('keeps the welcome page only on the horizontal strip (phones have the overview instead)', () => {
    const { calls, overlay } = land('horizontal');
    expect(calls).not.toContain('openHome');
    expect(calls).toContain('loadTunnelStatus');
    expect(overlay.classList.contains('visible')).toBe(true);
  });
});

describe('Product name', () => {
  it('shows Switchboard by default; a stored or typed "Codeman" is not a custom name', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
    vm.runInContext(i18nSource, dom.getInternalVMContext(), { filename: 'i18n.js' });
    const api = (dom.window as unknown as Record<string, any>).CodemanI18n;
    expect(api.displayName).toBe('Switchboard');
    expect(api.normalizeDisplayName('Codeman')).toBe('Switchboard');
    expect(api.normalizeDisplayName('  ')).toBe('Switchboard');
    expect(api.normalizeDisplayName('Acme Desk')).toBe('Acme Desk');
    api.configure({ language: 'en' });
    expect(api.t('Codeman')).toBe('Switchboard');
  });
});
