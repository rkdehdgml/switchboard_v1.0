/** @fileoverview COD-358 vertical session rail orientation policy and wiring. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');
const indexHtml = read('src/web/public/index.html');
const stylesCss = read('src/web/public/styles.css');
const settingsJs = read('src/web/public/settings-ui.js');
const appJs = read('src/web/public/app.js');
const schemasTs = read('src/web/schemas.ts');

function loadPolicy() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('src/web/public/constants.js'), context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanTabOverflow: { resolveTabOrientation: (input: unknown) => string };
    }
  ).CodemanTabOverflow;
}

describe('vertical tab orientation policy', () => {
  it('always gives desktop and tablet the rail, whatever an old stored setting says, and phones the strip', () => {
    const policy = loadPolicy();
    for (const setting of ['vertical', 'horizontal', 'sideways', undefined]) {
      expect(policy.resolveTabOrientation({ deviceType: 'desktop', setting }), `desktop/${setting}`).toBe('vertical');
      expect(policy.resolveTabOrientation({ deviceType: 'tablet', setting }), `tablet/${setting}`).toBe('vertical');
      expect(policy.resolveTabOrientation({ deviceType: 'mobile', setting }), `mobile/${setting}`).toBe('horizontal');
    }
  });

  it('fails closed to horizontal when the device class is unknown', () => {
    const policy = loadPolicy();
    expect(policy.resolveTabOrientation(undefined)).toBe('horizontal');
    expect(policy.resolveTabOrientation({})).toBe('horizontal');
  });
});

describe('vertical tab rail wiring', () => {
  it('ships one rail before the terminal and no orientation setting (the arrow is the only control)', () => {
    expect(indexHtml).toContain('id="tabRail"');
    expect(indexHtml.indexOf('id="tabRail"')).toBeLessThan(indexHtml.indexOf('id="terminalContainer"'));
    expect(indexHtml).not.toContain('appSettingsTabOrientation');
    expect(indexHtml).toContain('id="tabRailToggle"');
    expect(settingsJs).not.toContain('appSettingsTabOrientation');
  });

  it('moves the existing list between the rail and its header host', () => {
    expect(settingsJs).toMatch(/applyTabOrientation\(options = \{\}\)/);
    expect(settingsJs).toContain("rail.insertBefore(tabsEl, rail.querySelector('.tab-rail-foot'))");
    expect(settingsJs).toContain('headerHost.appendChild(tabsEl)');
    expect(settingsJs).toContain("tabsEl.setAttribute('aria-orientation'");
  });

  it('applies orientation before horizontal wrapping and suppresses wrap vertically', () => {
    expect(appJs.indexOf('this.applyTabOrientation()')).toBeLessThan(appJs.indexOf('this.applyTabWrapSettings()'));
    const start = appJs.indexOf('updateTabOverflowMode() {');
    const block = appJs.slice(start, start + 3500);
    expect(block).toContain('resolveTabOrientation');
    expect(block.indexOf('resolveTabOrientation')).toBeLessThan(block.indexOf('shouldAutoWrapTabs'));
  });

  it('keeps the legacy device-scoped key valid for stored blobs and has vertical styles', () => {
    expect(settingsJs).toMatch(/tabOrientation:\s*'horizontal'/);
    const displayKeys = settingsJs.slice(settingsJs.indexOf('const displayKeys = new Set(['));
    expect(displayKeys.slice(0, 1800)).toContain("'tabOrientation'");
    expect(schemasTs).toMatch(/tabOrientation:\s*z\.enum\(\['horizontal',\s*'vertical'\]\)\.optional\(\)/);
    expect(stylesCss).toContain("html[data-tab-orientation='vertical'] .tab-rail");
  });
});
