/**
 * @fileoverview Switchboard T3 — session rail: markup, group/stripe/second-line/path logic,
 * panel badges, header counts under a search, contrast of the new token.
 *
 * Port: N/A (no server start)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const read = (f: string) => readFileSync(resolve('src/web/public', f), 'utf8');
const appSource = read('app.js');
const indexHtml = read('index.html');
const styles = read('styles.css');

/** Pull class methods out of app.js by name and bind them to a fake `this`. */
function methods(names: string[], self: Record<string, unknown>) {
  const out: Record<string, (...a: unknown[]) => any> = {};
  for (const name of names) {
    const start = appSource.indexOf(`\n  ${name}(`);
    if (start < 0) throw new Error(`method not found: ${name}`);
    const end = appSource.indexOf('\n  }\n', start);
    const body = appSource.slice(start, end + 4);
    const escapeHtml = (s: unknown) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    // eslint-disable-next-line no-new-func
    const holder = new Function('escapeHtml', `return ({${body.trim()}})`)(escapeHtml) as Record<
      string,
      (...a: unknown[]) => any
    >;
    out[name] = holder[name].bind(self);
    self[name] = out[name]; // extracted methods call each other through `this`
  }
  return out;
}

const fake = {
  _sidebarRichStampText: (ts: number, fmt: string) => (ts ? `${fmt}:${ts}` : '—'),
  formatTokens: (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)),
} as Record<string, unknown>;

describe('rail markup (index.html)', () => {
  it('pins the search above and "New session" below the list', () => {
    const rail = indexHtml.slice(indexHtml.indexOf('<aside class="tab-rail"'), indexHtml.indexOf('</aside>'));
    const order = [
      'tabRailResizeHandle',
      'class="tab-rail-search"',
      'id="tabRailFilter"',
      'class="tab-rail-foot"',
      'class="tab-rail-new"',
    ].map((s) => rail.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rail).toContain('aria-label="Search sessions"');
    expect(rail).toContain('onclick="app.run()"');
  });

  it('moves #sessionTabs between the search and the footer, never after the footer', () => {
    expect(appSource).toContain("rail.querySelector('.tab-rail-foot')");
    expect(appSource).toMatch(/host\.insertBefore\(tabsEl, railFoot\)/);
  });
});

describe('group mapping', () => {
  const m = methods(['_railGroupOf'], fake);
  it.each([
    ['needs', 'attention'],
    ['error', 'attention'],
    ['waiting', 'attention'],
    ['working', 'running'],
    ['idle', 'quiet'],
    ['done', 'quiet'],
  ])('%s -> %s', (state, group) => expect(m._railGroupOf(state)).toBe(group));
});

describe('group headers', () => {
  const m = methods(['_railGroupHeadsHTML'], fake);
  const sorted = new Map([
    ['a', 0],
    ['b', 1],
    ['c', 2],
    ['d', 3],
  ]);
  const groups = new Map([
    ['a', 'attention'],
    ['b', 'attention'],
    ['c', 'running'],
    ['d', 'quiet'],
  ]);

  it('one header per non-empty group, in sort order, each with the order of its first row', () => {
    const html = m._railGroupHeadsHTML(sorted, groups) as string;
    expect([...html.matchAll(/data-group="(\w+)" style="order:(\d+)"/g)].map((x) => [x[1], x[2]])).toEqual([
      ['attention', '0'],
      ['running', '2'],
      ['quiet', '3'],
    ]);
    expect(html).toContain('Needs response');
    expect(html).toContain('role="presentation"');
  });

  it('omits an empty group', () => {
    const g = new Map([...groups].filter(([, v]) => v !== 'running'));
    expect(m._railGroupHeadsHTML(sorted, g)).not.toContain('data-group="running"');
  });

  it('is empty when the rail is not sorted/grouped', () => {
    expect(m._railGroupHeadsHTML(null, groups)).toBe('');
    expect(m._railGroupHeadsHTML(sorted, null)).toBe('');
  });
});

describe('path tail', () => {
  const m = methods(['_railPathHTML'], fake);
  const text = (dir: string) =>
    new JSDOM(m._railPathHTML({ workingDir: dir }) as string).window.document.body.textContent;

  it('shows the last folder behind an ellipsis', () => {
    expect(text('/home/me/projects/billing-service-v3')).toBe('…/billing-service-v3');
  });
  it('understands Windows separators and trailing slashes', () => {
    expect(text('C:\\dev\\switchboard\\')).toBe('…/switchboard');
  });
  it('a single segment has nothing to elide', () => {
    expect(text('/tmp')).toBe('/tmp');
  });
  it('is empty without a directory', () => {
    expect(m._railPathHTML({ workingDir: '' })).toBe('');
    expect(m._railPathHTML({})).toBe('');
  });
  it('escapes the path in the tooltip and the text', () => {
    const html = m._railPathHTML({ workingDir: '/x/"><img src=x onerror=1>' }) as string;
    expect(html).not.toContain('<img');
    expect(html).toContain('title="/x/&quot;&gt;&lt;img');
  });
});

describe('second line', () => {
  const m = methods(['_railSubHTML'], fake);
  const text = (row: object, session: object) =>
    new JSDOM(m._railSubHTML(row, session) as string).window.document.body.textContent;

  it('running: model · tokens · cost', () => {
    expect(
      text({ state: 'working' }, { cliModel: 'Opus 5', inputTokens: 120000, outputTokens: 30000, totalCost: 1.234 })
    ).toBe('Opus 5 · 150k · $1.23');
  });
  it('running: leaves out what is unknown, falls back when nothing is known', () => {
    expect(text({ state: 'working' }, { cliModel: 'Opus 5' })).toBe('Opus 5');
    expect(text({ state: 'working', since: { key: 'working', at: 5 } }, {})).toBe('working for:5');
  });
  it('quiet: last activity', () => {
    expect(text({ state: 'idle' }, { lastActivityAt: 7 })).toBe('ago:7');
    expect(text({ state: 'done', since: { key: 'done', at: 9 } }, { lastActivityAt: 7 })).toBe('ago:7');
  });
  it('waiting on the user: how long, with the state word', () => {
    expect(text({ state: 'needs', since: { key: 'waiting', at: 3 } }, { lastActivityAt: 7 })).toBe('waiting for:3');
  });
  it('escapes a hostile model string', () => {
    const html = m._railSubHTML({ state: 'working' }, { cliModel: '<img src=x onerror=1>' }) as string;
    expect(html).not.toContain('<img');
  });
  it('keeps the stamps tickable by the rich clock', () => {
    expect(m._railSubHTML({ state: 'idle' }, { lastActivityAt: 7 })).toContain('data-tab-ts="7" data-tab-fmt="ago"');
  });
});

describe('state label', () => {
  const m = methods(['_railLabelHTML'], fake);
  it('uses the exited word over the state, and adds watching beside it', () => {
    const html = m._railLabelHTML({ state: 'idle', exited: true, pill: 'exited', watching: '1 monitor' }) as string;
    expect(html).toContain('tab-state-label--exited');
    expect(html).toContain('tab-state-label--watching');
    expect(html).toContain('title="Still running in the background: 1 monitor"');
  });
  it('escapes the pane-derived watching text', () => {
    const html = m._railLabelHTML({ state: 'idle', pill: 'idle', watching: '"><b>' }) as string;
    expect(html).not.toContain('<b>');
  });
});

describe('panel badges', () => {
  it('shows the letter the split gives a session, and nothing for a session in no pane', () => {
    // The letters come from the split itself (terminal-split.js, depth-first pane order).
    const letters: Record<string, string> = { a: 'A', b: 'B', c: 'C', d: 'D' };
    const self: Record<string, unknown> = { _splitLetterForSession: (id: string) => letters[id] ?? '' };
    const m = methods(['_railPanelLetter', '_railPanelBadgeHTML'], self);
    expect(['a', 'b', 'c', 'd', 'x'].map((id) => m._railPanelLetter(id))).toEqual(['A', 'B', 'C', 'D', '']);
    expect(m._railPanelBadgeHTML('x')).toBe('');
    expect(m._railPanelBadgeHTML('c')).toContain('data-panel="C"');
    expect(m._railPanelBadgeHTML('d')).toContain('data-panel="D"');
  });

  it('is empty before terminal-split.js has loaded, instead of throwing', () => {
    const m = methods(['_railPanelLetter'], {});
    expect(m._railPanelLetter('a')).toBe('');
  });

  it('every change of the layout refreshes the rail', () => {
    const split = read('terminal-split.js');
    expect(split.match(/this\.renderSessionTabs\?\.\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('header counts follow the search', () => {
  it('counts only visible rows and hides an empty group', () => {
    const dom = new JSDOM(`<div id="sessionTabs">
      <div class="tab-group-head" data-group="attention"><span class="tab-group-count"></span></div>
      <div class="tab-group-head" data-group="running"><span class="tab-group-count"></span></div>
      <div class="session-tab" data-tab-group="attention"></div>
      <div class="session-tab tab-filtered-out" data-tab-group="attention"></div>
      <div class="session-tab tab-filtered-out" data-tab-group="running"></div></div>`);
    const doc = dom.window.document;
    const m = methods(['_updateRailGroupHeads'], { $: (id: string) => doc.getElementById(id) });
    m._updateRailGroupHeads();
    const heads = [...doc.querySelectorAll('.tab-group-head')] as HTMLElement[];
    expect(heads.map((h) => [h.dataset.group, h.querySelector('.tab-group-count')!.textContent, h.hidden])).toEqual([
      ['attention', '1', false],
      ['running', '0', true],
    ]);
  });

  it('applySidebarFilter treats the rail search as reachable and refreshes the headers', () => {
    expect(appSource).toMatch(/this\._railFilterReachable\(\);/);
    expect(appSource).toMatch(/this\.updateSidebarCount\(\);\s*this\._updateRailGroupHeads\(\);/);
  });
});

describe('render hand-off', () => {
  it('a session crossing groups goes through the full rebuild (headers are written there only)', () => {
    expect(appSource).toMatch(
      /\(tab\.dataset\.tabGroup \|\| ''\) !== \(railGroups\?\.get\(id\) \|\| ''\)\) \{\s*this\._fullRenderSessionTabs\(\);\s*return;/
    );
  });
  it('the sidebar and header strip keep their markup (rail parts only when the rail is rich)', () => {
    expect(appSource).toContain('const railRich = this.isTabRailRich();');
    expect(appSource).toContain('${railRow ? \'<span class="tab-stripe" aria-hidden="true"></span>\' : \'\'}');
  });
});

describe('styles', () => {
  const t3 = styles.slice(styles.indexOf('/* ===== Session rail (Switchboard T3)'));

  it('uses design tokens, not hex colors', () => {
    expect(t3).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('outranks the older card rules by doubling .tab-rail, and beats the !important selected row with !important', () => {
    expect(t3).toContain('.tab-rail.tab-rail .session-tab {');
    expect(t3).toMatch(
      /\.tab-rail\.tab-rail \.session-tab\.active \{[^}]*background: var\(--accent-bg\) !important;[^}]*box-shadow: inset 0 0 0 1px var\(--accent-ring\) !important/
    );
  });

  it('paints the stripe on a real element (the alert rules own ::before)', () => {
    expect(t3).toMatch(/\.tab-stripe \{[^}]*width: 2px/);
    expect(t3).toContain('tab-state-needs .tab-stripe');
  });

  it('keeps search and footer out of anything but a vertical, non-compact rail', () => {
    expect(t3).toMatch(/\.tab-rail-search,\s*\.tab-rail-foot \{\s*display: none;/);
    expect(t3).toContain("html[data-tab-orientation='vertical']:not(.tab-rail-compact) .tab-rail .tab-rail-search");
  });

  it('a hidden group header really hides', () => {
    expect(t3).toMatch(/\.tab-group-head\[hidden\] \{\s*display: none;/);
  });
});

describe('--status-run-text contrast', () => {
  const lum = (hex: string) => {
    const v = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  // Source order: the dark :root block first, then the light base block.
  const [dark, light] = [...styles.matchAll(/--status-run-text: (#[0-9A-Fa-f]{6})/g)].map((x) => x[1]);

  it('is declared for both tones', () => {
    expect(styles.match(/--status-run-text:/g)?.length).toBe(2);
  });
  it('reads at 4.5:1 on the lightest/darkest rail backgrounds it can sit on', () => {
    expect(ratio(dark, '#262A32')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(light, '#E3E8F8')).toBeGreaterThanOrEqual(4.5);
    expect(ratio(light, '#F6F7F9')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('rail collapse (arrow is the only control)', () => {
  const resize = read('tab-rail-resize.js');

  /** Extract methods from tab-rail-resize.js and run them against a jsdom page. */
  function railPage(initial: 'expanded' | 'collapsed' = 'expanded', focusInRail = false) {
    const dom = new JSDOM(
      `<html data-tab-orientation="vertical" data-tab-rail="${initial}"><body>
        <button id="tabRailToggle" aria-expanded="true"></button>
        <aside id="tabRail"><input id="inRail"></aside></body></html>`,
      { url: 'http://localhost/' }
    );
    const doc = dom.window.document;
    const calls: string[] = [];
    const self: Record<string, any> = {
      _getCurrentTabRailWidth: () => 300,
      _claimTabRailResize: () => calls.push('claim'),
      _scheduleTabRailSettle: (w: number) => calls.push(`settle:${w}`),
      _updateConnectionLinesImmediate: () => calls.push('lines'),
    };
    for (const name of ['isTabRailCollapsed', '_syncTabRailToggle', 'setTabRailCollapsed', 'toggleTabRail']) {
      const start = resize.indexOf(`\n  ${name}(`);
      const end = resize.indexOf('\n  },\n', start);
      const body = resize.slice(start, end + 5).replace(/,\s*$/, '');
      // eslint-disable-next-line no-new-func
      const holder = new Function('document', 'localStorage', `return ({${body.trim()}})`)(
        doc,
        dom.window.localStorage
      );
      self[name] = holder[name].bind(self);
    }
    if (focusInRail) (doc.getElementById('inRail') as HTMLElement).focus();
    return { doc, self, calls, store: dom.window.localStorage };
  }

  it('collapsing sets the attribute, remembers it per device, and updates the arrow for assistive tech', () => {
    const { doc, self, store } = railPage();
    self.setTabRailCollapsed(true);
    expect(doc.documentElement.dataset.tabRail).toBe('collapsed');
    expect(store.getItem('codeman-tab-rail-collapsed')).toBe('1');
    const btn = doc.getElementById('tabRailToggle')!;
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Expand session list');
    self.setTabRailCollapsed(false);
    expect(store.getItem('codeman-tab-rail-collapsed')).toBe('0');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Collapse session list');
  });

  it('toggle flips, and a no-op change does not resize the terminal', () => {
    const { doc, self, calls } = railPage();
    self.toggleTabRail();
    expect(doc.documentElement.dataset.tabRail).toBe('collapsed');
    const before = calls.length;
    self.setTabRailCollapsed(true);
    expect(calls.length).toBe(before);
    self.toggleTabRail();
    expect(doc.documentElement.dataset.tabRail).toBe('expanded');
  });

  it('collapsing resizes the terminal once, through the same settle path a drag uses', () => {
    const { self, calls } = railPage();
    self.setTabRailCollapsed(true);
    expect(calls).toEqual(['claim', 'settle:300', 'lines']);
  });

  it('hands focus to the arrow when the focused element was inside the rail that just hid', () => {
    const { doc, self } = railPage('expanded', true);
    expect(doc.activeElement?.id).toBe('inRail');
    self.setTabRailCollapsed(true);
    expect(doc.activeElement?.id).toBe('tabRailToggle');
  });

  it('dragging the edge past the snap point folds the rail; the last real width is kept', () => {
    expect(resize).toMatch(/const TAB_RAIL_COLLAPSE_SNAP = 150;/);
    expect(resize).toMatch(/const fold = Number\.isFinite\(raw\) && raw < TAB_RAIL_COLLAPSE_SNAP;/);
    expect(resize).toMatch(/if \(fold\) this\.setTabRailCollapsed\(true\);/);
    // ...and it restores the width the drag started at, not the minimum the pointer passed through.
    expect(resize).toContain('this._setTabRailWidth(this._tabRailDragStartWidth)');
  });

  it('the arrow sits in .main before the rail and is wired to the app', () => {
    const main = indexHtml.slice(indexHtml.indexOf('<main class="main">'));
    expect(main.indexOf('id="tabRailToggle"')).toBeGreaterThan(0);
    expect(main.indexOf('id="tabRailToggle"')).toBeLessThan(main.indexOf('<aside class="tab-rail"'));
    expect(main).toContain('onclick="app.toggleTabRail()"');
    expect(main).toContain('aria-controls="tabRail"');
    expect(main).toContain('aria-expanded="true"');
  });

  it('first paint: the pre-paint script reads the saved state (default open at 1024px and up)', () => {
    expect(indexHtml).toContain("localStorage.getItem('codeman-tab-rail-collapsed')");
    expect(indexHtml).toContain(
      "document.documentElement.dataset.tabRail=(R===null?window.innerWidth<1024:R==='1')?'collapsed':'expanded'"
    );
    // The rail itself is no longer a stored preference.
    expect(indexHtml).toContain('var V=!S&&!solo&&window.innerWidth>=768;');
  });

  it('collapsed leaves only the arrow: rail width 0 and hidden, arrow on the window edge, no icon strip', () => {
    const css = styles.slice(styles.indexOf('/* ===== Session rail collapse (Switchboard)'));
    expect(css).toMatch(
      /\[data-tab-rail='collapsed'\] \.tab-rail \{[^}]*flex-basis: 0;[^}]*width: 0;[^}]*visibility: hidden;/
    );
    expect(css).toMatch(/\[data-tab-rail='collapsed'\] \.tab-rail-toggle \{[^}]*left: 0;/);
    expect(css).toMatch(/\.tab-rail-toggle \{\s*display: none;/);
    expect(css).not.toMatch(/\b44px\b/);
  });

  it('the Alt+B chord folds the rail when the rail is the session list', () => {
    expect(appSource).toMatch(
      /!this\.isSessionSidebarActive\(\) && this\._tabOrientation\(\) === 'vertical'\) \{\s*this\.toggleTabRail\(\);/
    );
    expect(appSource).toMatch(
      /!this\.isSessionSidebarActive\(\) && this\._tabOrientation\(\) !== 'vertical'\) return false;/
    );
  });
});
