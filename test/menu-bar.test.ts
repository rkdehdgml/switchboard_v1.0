/**
 * @fileoverview Switchboard T2 — header menu bar: markup, WAI-ARIA menu-button keyboard
 * behaviour (real DOM via jsdom), palette registration, strings in three languages.
 *
 * Port: N/A (no server start)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const read = (p: string) => readFileSync(resolve('src/web/public', p), 'utf8');
const menuSource = read('menu-bar.js');
const i18nSource = read('i18n.js');
const indexHtml = read('index.html');
const stylesSource = read('styles.css');
const mobileSource = read('mobile.css');

type Item = {
  id: string;
  label: string | ((a: unknown) => string);
  danger?: boolean;
  separatorBefore?: boolean;
  run: unknown;
};
type Menu = { id: string; label: string; items: Item[] };

interface Harness {
  dom: JSDOM;
  app: Record<string, any>;
  menus: Menu[];
  calls: string[];
  key(el: Element, key: string, init?: KeyboardEventInit): void;
}

function harness(opts: { sessions?: number; palette?: object | null } = {}): Harness {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <nav id="headerMenu"></nav>
       <button id="headerPaletteBtn" hidden><span>Search</span><kbd></kbd></button>
       <button id="outside">outside</button>
     </body></html>`,
    { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: true }
  );
  const win = dom.window as unknown as Record<string, any>;
  const calls: string[] = [];
  class CodemanApp {}
  const sessions = new Map<string, { mode: string }>();
  for (let i = 0; i < (opts.sessions ?? 1); i++) sessions.set(`s${i}`, { mode: 'claude' });
  const record =
    (name: string) =>
    (...a: unknown[]) => {
      // A menu item must close the menu BEFORE running, so a modal remembers the trigger.
      calls.push(`${name}:menuOpen=${!!win.document.querySelector('.header-menu-list')}:args=${a.length}`);
    };
  Object.assign(CodemanApp.prototype, {
    run: record('run'),
    openSplitPicker: record('split'),
    openSessionOptions: record('respawn'),
    toggleOrchestratorPanel: record('orchestrator'),
    openCron: record('cron'),
    toggleUltracodeAgentsPanel: record('ultracode'),
    showCreateCaseModal: record('createCase'),
    switchCaseModalTab: (tab: string) => calls.push(`tab:${tab}`),
    openAppSettings: record('settings'),
    showShortcutOverlay: record('shortcuts'),
    checkForUpdate: record('checkUpdate'),
    getShortcutRegistry: () =>
      opts.palette === null
        ? []
        : [
            opts.palette ?? {
              id: 'command-palette',
              bindings: [
                { modifiers: ['ctrl'], key: 'k' },
                { modifiers: ['meta'], key: 'k' },
              ],
            },
          ],
  });
  win.CodemanApp = CodemanApp;
  win.isExternalCliRunMode = (m: string) => m === 'codex';
  win.FocusTrap = class {
    activate() {}
    deactivate() {}
  };
  vm.runInContext(i18nSource, dom.getInternalVMContext(), { filename: 'i18n.js' });
  vm.runInContext(menuSource, dom.getInternalVMContext(), { filename: 'menu-bar.js' });
  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  app.sessions = sessions;
  app.activeSessionId = sessions.size ? 's0' : null;
  win.app = app;
  app.renderMenuBar();
  return {
    dom,
    app,
    menus: win.CodemanMenus.MENUS as Menu[],
    calls,
    key(el, key, init = {}) {
      el.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    },
  };
}

const trigger = (h: Harness, id: string) =>
  h.dom.window.document.getElementById(`headerMenuBtn-${id}`) as HTMLButtonElement;
const list = (h: Harness) => h.dom.window.document.querySelector('.header-menu-list') as HTMLElement | null;
const items = (h: Harness) => [...(list(h)?.querySelectorAll('[role="menuitem"]') ?? [])] as HTMLButtonElement[];
const focused = (h: Harness) => h.dom.window.document.activeElement as HTMLElement;

describe('markup (index.html)', () => {
  it('puts the menu inside <header> and adds no new row', () => {
    const header = indexHtml.slice(indexHtml.indexOf('<header class="header">'), indexHtml.indexOf('</header>'));
    expect(header).toContain('<nav class="header-menu" id="headerMenu"');
    expect(header).toContain('id="headerPaletteBtn"');
  });

  it('moved the font stepper out of the header into Settings', () => {
    const header = indexHtml.slice(indexHtml.indexOf('<header class="header">'), indexHtml.indexOf('</header>'));
    expect(header).not.toContain('fontSizeDisplay');
    expect(indexHtml).not.toContain('header-font-controls');
    expect(indexHtml).not.toContain('appSettingsShowFontControls');
    expect(indexHtml).toMatch(/id="fontSizeDisplay"/);
    expect(stylesSource).not.toContain('.header-font-controls');
    expect(mobileSource).not.toContain('header-font-controls');
  });

  it('loads menu-bar.js after admin-ui.js and before session-ui.js', () => {
    const at = (f: string) => indexHtml.indexOf(`<script defer src="${f}"></script>`);
    expect(at('admin-ui.js')).toBeGreaterThan(0);
    expect(at('menu-bar.js')).toBeGreaterThan(at('admin-ui.js'));
    expect(at('session-ui.js')).toBeGreaterThan(at('menu-bar.js'));
  });

  it('kill-all confirmation is a real modal dialog', () => {
    const block = indexHtml.slice(indexHtml.indexOf('id="killAllModal"'), indexHtml.indexOf('<!-- Help Modal -->'));
    expect(block).toContain('role="dialog"');
    expect(block).toContain('aria-modal="true"');
    expect(block).toContain('aria-labelledby="killAllTitle"');
    expect(block).toContain('id="killAllTitle"');
  });

  it('the header is hidden on phones/tablets and the dropdown is not clipped by header paint containment', () => {
    expect(mobileSource).toMatch(
      /@media \(max-width: 768px\) \{[^@]*\.header-menu,\s*\.btn-header-palette \{\s*display: none !important/
    );
    // .header has `contain: paint`, so the list must be fixed-position and hang off <body>.
    expect(stylesSource).toMatch(/\.header-menu-list \{[^}]*position: fixed/);
    expect(menuSource).toContain('document.body.append(list)');
  });
});

describe('menu structure', () => {
  it('has the five menus in order', () => {
    expect(harness().menus.map((m) => m.id)).toEqual(['session', 'automation', 'environment', 'settings', 'help']);
  });

  it('never registers access keys or default shortcuts (the terminal owns the keyboard)', () => {
    const code = menuSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/accessKey|accesskey|altKey|ctrlKey|metaKey/);
    expect(code).not.toMatch(/\bAlt\+|Ctrl\+[A-Z]\b/);
  });

  it('puts the destructive entry below a separator', () => {
    const h = harness();
    h.key(trigger(h, 'session'), 'Enter');
    const kill = items(h).find((i) => i.classList.contains('header-menu-item--danger'))!;
    expect(kill.previousElementSibling?.getAttribute('role')).toBe('separator');
  });
});

describe('menu button keyboard (WAI-ARIA menu button)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('triggers carry aria-haspopup=menu and aria-expanded=false', () => {
    for (const m of h.menus) {
      expect(trigger(h, m.id).getAttribute('aria-haspopup')).toBe('menu');
      expect(trigger(h, m.id).getAttribute('aria-expanded')).toBe('false');
    }
  });

  it.each(['Enter', ' ', 'ArrowDown'])('%j opens the menu and focuses the first item', (k) => {
    h.key(trigger(h, 'session'), k);
    expect(list(h)?.getAttribute('role')).toBe('menu');
    expect(trigger(h, 'session').getAttribute('aria-expanded')).toBe('true');
    expect(focused(h)).toBe(items(h)[0]);
  });

  it('ArrowUp opens and focuses the last item', () => {
    h.key(trigger(h, 'session'), 'ArrowUp');
    expect(focused(h)).toBe(items(h).at(-1));
  });

  it('arrows move with wrap-around, Home/End jump', () => {
    h.key(trigger(h, 'automation'), 'Enter');
    const it = items(h);
    expect(it.length).toBeGreaterThan(2);
    h.key(focused(h), 'ArrowUp');
    expect(focused(h)).toBe(it.at(-1));
    h.key(focused(h), 'ArrowDown');
    expect(focused(h)).toBe(it[0]);
    h.key(focused(h), 'End');
    expect(focused(h)).toBe(it.at(-1));
    h.key(focused(h), 'Home');
    expect(focused(h)).toBe(it[0]);
  });

  it('ArrowLeft/ArrowRight move to the neighbouring menu (wrapping)', () => {
    h.key(trigger(h, 'session'), 'Enter');
    h.key(focused(h), 'ArrowRight');
    expect(list(h)?.id).toBe('headerMenuList-automation');
    expect(trigger(h, 'session').getAttribute('aria-expanded')).toBe('false');
    h.key(focused(h), 'ArrowLeft');
    h.key(focused(h), 'ArrowLeft');
    expect(list(h)?.id).toBe('headerMenuList-help');
    expect(h.dom.window.document.querySelectorAll('.header-menu-list')).toHaveLength(1);
  });

  it('Escape closes and returns focus to the trigger', () => {
    h.key(trigger(h, 'help'), 'Enter');
    h.key(focused(h), 'Escape');
    expect(list(h)).toBeNull();
    expect(focused(h)).toBe(trigger(h, 'help'));
    expect(trigger(h, 'help').getAttribute('aria-expanded')).toBe('false');
  });

  it('Tab closes the menu without trapping focus (focus parked on the trigger)', () => {
    h.key(trigger(h, 'help'), 'Enter');
    const ev = new h.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    focused(h).dispatchEvent(ev);
    expect(list(h)).toBeNull();
    expect(focused(h)).toBe(trigger(h, 'help'));
    expect(ev.defaultPrevented).toBe(false);
  });

  it('a click outside closes it', () => {
    h.key(trigger(h, 'help'), 'Enter');
    h.dom.window.document
      .getElementById('outside')!
      .dispatchEvent(new h.dom.window.MouseEvent('mousedown', { bubbles: true }));
    expect(list(h)).toBeNull();
  });

  it('hovering another trigger while one is open switches menus', () => {
    h.key(trigger(h, 'session'), 'Enter');
    trigger(h, 'help').dispatchEvent(new h.dom.window.MouseEvent('mouseenter'));
    expect(list(h)?.id).toBe('headerMenuList-help');
  });

  it('activating an item closes the menu first, then runs it', () => {
    h.key(trigger(h, 'settings'), 'Enter');
    items(h)[0].click();
    expect(h.calls).toEqual(['settings:menuOpen=false:args=0']);
  });

  it('Environment entries open Add Case on the right tab', () => {
    const wanted = ['case-manage', 'case-docker', 'case-remote'];
    h.key(trigger(h, 'environment'), 'Enter');
    items(h).forEach((i, n) => {
      i.click();
      if (n < wanted.length - 1) h.key(trigger(h, 'environment'), 'Enter');
    });
    expect(h.calls.filter((c) => c.startsWith('tab:'))).toEqual(wanted.map((t) => `tab:${t}`));
  });

  it('skips disabled items: kill-all and respawn with no sessions, respawn for a non-Claude session', () => {
    const empty = harness({ sessions: 0 });
    empty.key(trigger(empty, 'session'), 'ArrowUp');
    expect(
      items(empty)
        .filter((i) => !i.disabled)
        .map((i) => i.textContent)
    ).not.toContain('Kill all sessions');
    expect(items(empty).find((i) => i.textContent === 'Kill all sessions')?.disabled).toBe(true);

    // Respawn needs an active session to open Session Options for.
    empty.key(trigger(empty, 'automation'), 'Enter');
    expect(items(empty).find((i) => i.textContent === 'Respawn')?.disabled).toBe(true);
    const withSession = harness();
    withSession.key(trigger(withSession, 'automation'), 'Enter');
    expect(items(withSession).find((i) => i.textContent === 'Respawn')?.disabled).toBe(false);

    const codex = harness();
    (codex.app.sessions as Map<string, { mode: string }>).set('s0', { mode: 'codex' });
    codex.key(trigger(codex, 'automation'), 'Enter');
    expect(items(codex).find((i) => i.textContent === 'Respawn')?.disabled).toBe(true);
  });

  it('split label follows state', () => {
    h.app._splitPane = {};
    h.key(trigger(h, 'session'), 'Enter');
    expect(items(h).map((i) => i.textContent)).toContain('Close split');
  });
});

describe('command palette registration', () => {
  it('adds nothing to the idle list', () => {
    expect(harness().app.buildMenuCommandItems('')).toEqual([]);
    expect(harness().app.buildMenuCommandItems('   ')).toEqual([]);
  });

  it('finds every enabled entry by its English label and menu name', () => {
    const h = harness();
    const ids = (q: string) => h.app.buildMenuCommandItems(q).map((c: { id: string }) => c.id);
    expect(ids('settings')).toContain('command:settings:app-settings');
    expect(ids('docker')).toContain('command:environment:docker');
    expect(ids('help')).toEqual(
      expect.arrayContaining(['command:help:shortcuts', 'command:help:version', 'command:help:update'])
    );
  });

  it('is reachable by the Korean label when the UI language is Korean', () => {
    const h = harness();
    (h.dom.window as unknown as { CodemanI18n: { configure(o: object): void } }).CodemanI18n.configure({
      language: 'ko',
    });
    const hits = h.app.buildMenuCommandItems('앱 설정').map((c: { id: string }) => c.id);
    expect(hits).toContain('command:settings:app-settings');
    expect(h.app.buildMenuCommandItems('설정')[0].title).toBeTruthy();
  });

  it('omits disabled entries and runs through the same action as the menu', () => {
    const h = harness({ sessions: 0 });
    expect(h.app.buildMenuCommandItems('kill all')).toEqual([]);
    const hit = h.app.buildMenuCommandItems('shortcuts').find((c: { id: string }) => c.id === 'command:help:shortcuts');
    hit.run();
    expect(h.calls).toEqual(['shortcuts:menuOpen=false:args=0']);
  });

  it('panels-ui.js routes command items through activateCommandPaletteItem', () => {
    const panels = read('panels-ui.js');
    expect(panels).toContain('this.buildMenuCommandItems?.(query)');
    expect(panels).toMatch(/item\.type === 'command'\) \{\s*item\.run\(\);/);
  });
});

describe('palette shortcut hint', () => {
  it('shows the registry chord (Ctrl, not the Cmd alternate)', () => {
    const h = harness();
    const btn = h.dom.window.document.getElementById('headerPaletteBtn') as HTMLButtonElement;
    expect(btn.hidden).toBe(false);
    expect(btn.querySelector('kbd')!.textContent).toBe('Ctrl+K');
  });

  it('follows a rebind', () => {
    const h = harness({ palette: { id: 'command-palette', bindings: [{ modifiers: ['ctrl', 'shift'], key: 'p' }] } });
    expect(h.dom.window.document.querySelector('#headerPaletteBtn kbd')!.textContent).toBe('Ctrl+Shift+P');
  });

  it('is hidden when the palette shortcut is disabled or has no Ctrl chord', () => {
    expect(
      (
        harness({
          palette: { id: 'command-palette', disabled: true, bindings: [] },
        }).dom.window.document.getElementById('headerPaletteBtn') as HTMLButtonElement
      ).hidden
    ).toBe(true);
    expect(
      (harness({ palette: null }).dom.window.document.getElementById('headerPaletteBtn') as HTMLButtonElement).hidden
    ).toBe(true);
  });
});

describe('strings in en / zh-CN / ko', () => {
  function t(language: string) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    });
    vm.runInContext(i18nSource, dom.getInternalVMContext(), { filename: 'i18n.js' });
    const api = (dom.window as unknown as { CodemanI18n: { configure(o: object): void; t(s: string): string } })
      .CodemanI18n;
    api.configure({ language });
    return api.t;
  }
  // Proper names that stay as written in every language.
  const PROPER = new Set(['Cron', 'Ultracode']);
  const h = harness();
  const labels = h.menus.flatMap((m) => [
    m.label,
    ...m.items.map((i) => (typeof i.label === 'function' ? i.label({ _splitTree: null }) : i.label)),
  ]);
  labels.push(
    'Close split',
    'Save layout',
    'Main menu',
    'Open command palette',
    'Kill all sessions?',
    'Kill all',
    'Terminal font size'
  );

  it.each(['zh-CN', 'ko'])('%s translates every menu string', (lang) => {
    const tr = t(lang);
    for (const s of labels.filter((l) => !PROPER.has(l))) expect(tr(s), `${lang}: ${s}`).not.toBe(s);
  });

  it('the Korean labels are the ones the design names', () => {
    const tr = t('ko');
    expect(['Session', 'Automation', 'Environment', 'Settings', 'Help'].map(tr)).toEqual([
      '세션',
      '자동화',
      '환경',
      '설정',
      '도움말',
    ]);
  });

  it('English stays the source text', () => {
    expect(t('en')('Session')).toBe('Session');
  });
});
