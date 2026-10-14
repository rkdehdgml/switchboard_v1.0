/**
 * @fileoverview Switchboard T1 — design tokens, theme resolution, server-side
 * pre-paint attributes, and readable ANSI colors on the light terminals.
 *
 * Port: N/A (no server start)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { WebServer } from '../src/web/server.js';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const stylesSource = readFileSync(resolve('src/web/public/styles.css'), 'utf8');
const terminalSource = readFileSync(resolve('src/web/public/terminal-ui.js'), 'utf8');
const themeSource = readFileSync(resolve('src/web/public/theme-ui.js'), 'utf8');
const i18nSource = readFileSync(resolve('src/web/public/i18n.js'), 'utf8');

const DARK_SKINS = ['daylight-blue', 'daylight-green', 'og'];
const LIGHT_SKINS = ['paper-gray', 'solarized-light', 'catppuccin-latte', 'rose-pine-dawn'];
const ANSI = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The xterm palettes, evaluated out of terminal-ui.js the way skin-themes.test.ts does. */
function xtermThemes(): Record<string, Record<string, string>> {
  const match = terminalSource.match(/const CODEMAN_XTERM_THEMES = (\{[\s\S]*?\n {2}\});/);
  if (!match) throw new Error('CODEMAN_XTERM_THEMES not found');
  return vm.runInNewContext(`(${match[1]})`);
}

/** Text of the first `selector { ... }` block in styles.css. */
function cssBlock(selector: string): string {
  const start = stylesSource.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block for ${selector}`);
  return stylesSource.slice(start, stylesSource.indexOf('\n}', start));
}

describe('design tokens (styles.css head)', () => {
  const root = cssBlock(':root');
  // The block aligns values with extra spaces; compare without them.
  const squeezed = root.replace(/ {2,}/g, ' ');

  it('defines the dark token set on the first :root, before any existing rule', () => {
    expect(stylesSource.indexOf(':root {')).toBeLessThan(stylesSource.indexOf('@font-face'));
    for (const [name, value] of Object.entries({
      '--surface-terminal': '#0C0D10',
      '--surface-base': '#101114',
      '--surface-chrome': '#17191E',
      '--text-1': '#E6E8EC',
      '--text-3': '#8B929E',
      '--status-blocked': '#F87171',
      '--data-bar': '#8FA0FF',
    })) {
      expect(squeezed, name).toContain(`${name}: ${value};`);
    }
  });

  it('does not redefine names the file already owns (a second definition would be dead)', () => {
    expect(root).not.toMatch(/^\s*--(border|accent|font-mono):/m);
    expect(root).toContain('--border-base:');
    expect(root).toContain('--accent-base:');
  });

  it('defines the light base for exactly the four light skins', () => {
    const light = cssBlock(
      'html:is([data-skin="paper-gray"], [data-skin="solarized-light"], [data-skin="catppuccin-latte"], [data-skin="rose-pine-dawn"])'
    );
    const flat = light.replace(/ {2,}/g, ' ');
    expect(flat).toContain('--surface-terminal: #FFFFFF;');
    expect(flat).toContain('--text-3: #5A616C;');
    expect(flat).toContain('--shadow-pop: 0 16px 40px rgba(16, 24, 40, 0.16);');
  });

  it("keeps the terminal surface equal to the skin's xterm background (no padding band)", () => {
    expect(cssBlock('html[data-skin]')).toContain('--surface-terminal: var(--term-bg);');
    const themes = xtermThemes();
    for (const skin of [...DARK_SKINS, ...LIGHT_SKINS]) {
      const block = cssBlock(`html[data-skin="${skin}"]`);
      const termBg = block.match(/--term-bg:\s*(#[0-9a-fA-F]{6})/)?.[1];
      expect(termBg?.toLowerCase(), skin).toBe(themes[skin].background.toLowerCase());
    }
  });
});

describe('token contrast (WCAG 2.x), both themes, against every surface token', () => {
  const SURFACES = [
    'surface-terminal',
    'surface-base',
    'surface-chrome',
    'surface-raised',
    'surface-panel-hd',
    'surface-hover',
    'surface-active',
  ];
  /** `--name: #hex` pairs of one block; the light set falls back to the dark value where it does not override. */
  function hexTokens(selector: string): Record<string, string> {
    return Object.fromEntries(
      [...cssBlock(selector).matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]])
    );
  }
  const dark = hexTokens(':root');
  const light = {
    ...dark,
    ...hexTokens(
      'html:is([data-skin="paper-gray"], [data-skin="solarized-light"], [data-skin="catppuccin-latte"], [data-skin="rose-pine-dawn"])'
    ),
  };
  const worst = (tokens: Record<string, string>, fg: string) =>
    Math.min(...SURFACES.map((s) => contrast(tokens[fg], tokens[s])));

  for (const [name, tokens] of [
    ['dark', dark],
    ['light', light],
  ] as const) {
    it(`${name}: text that carries information is >= 4.5:1 on every surface (text-3 is the floor)`, () => {
      for (const fg of ['text-1', 'text-2', 'text-3', 'accent-text', 'text-warn']) {
        expect(worst(tokens, fg), fg).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${name}: status dots and chart bars are >= 3:1 where they are drawn`, () => {
      // Dots sit on the rail (surface-chrome); the bar sits on its own track.
      for (const dot of ['status-run', 'status-wait', 'status-blocked', 'status-idle']) {
        expect(contrast(tokens[dot], tokens['surface-chrome']), dot).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(tokens['data-bar'], tokens['data-track'])).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: text-4 (disabled only) stays below text-3, so it can never pass as information`, () => {
      expect(worst(tokens, 'text-4')).toBeLessThan(worst(tokens, 'text-3'));
    });
  }

  it('pins the numbers the design quotes', () => {
    expect(worst(dark, 'text-3')).toBeCloseTo(4.59, 2);
    expect(worst(light, 'text-3')).toBeCloseTo(4.72, 2);
    expect(contrast(dark['status-idle'], dark['surface-chrome'])).toBeCloseTo(3.64, 2);
    expect(contrast(light['status-idle'], light['surface-chrome'])).toBeCloseTo(3.79, 2);
  });
});

describe("terminal is the extreme of lightness on each tone's default skin", () => {
  // Every other skin keeps its own identity (Solarized stays cream), so only the two defaults carry the rule.
  const SURFACES = [
    'surface-base',
    'surface-chrome',
    'surface-raised',
    'surface-panel-hd',
    'surface-hover',
    'surface-active',
  ];
  const tokens = (selector: string) =>
    Object.fromEntries(
      [...cssBlock(selector).matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]])
    );
  const dark = tokens(':root');
  const light = {
    ...dark,
    ...tokens(
      'html:is([data-skin="paper-gray"], [data-skin="solarized-light"], [data-skin="catppuccin-latte"], [data-skin="rose-pine-dawn"])'
    ),
  };
  const termBg = (skin: string) =>
    cssBlock(`html[data-skin="${skin}"]`)
      .match(/--term-bg:\s*(#[0-9a-fA-F]{6})/)![1]
      .toLowerCase();

  it("daylight-blue: terminal is the design's darkest surface, darker than every chrome surface", () => {
    expect(termBg('daylight-blue')).toBe(dark['surface-terminal'].toLowerCase());
    expect(xtermThemes()['daylight-blue'].background.toLowerCase()).toBe(termBg('daylight-blue'));
    for (const s of SURFACES) expect(luminance(termBg('daylight-blue')), s).toBeLessThan(luminance(dark[s]));
  });

  it("paper-gray: terminal is the design's lightest surface, lighter than every chrome surface", () => {
    expect(termBg('paper-gray')).toBe(light['surface-terminal'].toLowerCase());
    expect(xtermThemes()['paper-gray'].background.toLowerCase()).toBe(termBg('paper-gray'));
    for (const s of SURFACES.filter((n) => n !== 'surface-raised')) {
      expect(luminance(termBg('paper-gray')), s).toBeGreaterThan(luminance(light[s]));
    }
  });
});

describe('light terminals: ANSI colors are readable (WCAG 4.5:1 on the skin background)', () => {
  const themes = xtermThemes();
  for (const skin of LIGHT_SKINS) {
    it(`${skin}: all 16 ANSI colors and the foreground`, () => {
      const theme = themes[skin];
      const failing = [...ANSI, 'foreground']
        .map((name) => ({ name, ratio: contrast(theme[name], theme.background) }))
        .filter(({ ratio }) => ratio < 4.5)
        .map(({ name, ratio }) => `${name} ${theme[name]} ${ratio.toFixed(2)}`);
      expect(failing).toEqual([]);
    });
  }
});

describe('theme resolution (theme-ui.js)', () => {
  function load(prefersDark: boolean) {
    class CodemanApp {}
    const win: Record<string, unknown> = {
      matchMedia: () => ({ matches: prefersDark, addEventListener: () => {} }),
    };
    vm.runInNewContext(themeSource, { window: win, CodemanApp, document: {} }, { filename: 'theme-ui.js' });
    return {
      theme: win.CodemanTheme as {
        normalizeTheme(s: object): Record<string, string>;
        themeFromLegacySkin(s: unknown): Record<string, string> | null;
        resolveTone(m: string): string;
      },
      app: new (CodemanApp as unknown as new () => { resolveThemeSkin(s: object): string })(),
    };
  }

  describe('window title bar (desktop shell)', () => {
    function loadWithBridge(prefersDark: boolean, invoke: unknown) {
      class CodemanApp {}
      const win: Record<string, unknown> = {
        matchMedia: () => ({ matches: prefersDark, addEventListener: () => {} }),
        __TAURI_INTERNALS__: invoke === undefined ? undefined : { invoke },
      };
      vm.runInNewContext(themeSource, { window: win, CodemanApp, document: {}, Promise }, { filename: 'theme-ui.js' });
      return new (CodemanApp as unknown as new () => { syncWindowTitleBar(s: object): void })();
    }

    it('fixes the title bar for dark/light and releases it to the OS for system', () => {
      const calls: unknown[][] = [];
      const app = loadWithBridge(true, (...args: unknown[]) => (calls.push(args), Promise.resolve()));
      app.syncWindowTitleBar({ themeMode: 'dark' });
      app.syncWindowTitleBar({ themeMode: 'light' });
      app.syncWindowTitleBar({ themeMode: 'system' });
      expect(calls).toEqual([
        ['plugin:window|set_theme', { label: 'main', value: 'dark' }],
        ['plugin:window|set_theme', { label: 'main', value: 'light' }],
        ['plugin:window|set_theme', { label: 'main', value: null }],
      ]);
    });

    it('follows a pre-T1 single skin until a theme is saved, and falls back to system when unknown', () => {
      const values: unknown[] = [];
      const app = loadWithBridge(
        false,
        (_c: string, a: { value: unknown }) => (values.push(a.value), Promise.resolve())
      );
      app.syncWindowTitleBar({ skin: 'paper-gray' });
      app.syncWindowTitleBar({ skin: 'og' });
      app.syncWindowTitleBar({});
      app.syncWindowTitleBar({ themeMode: 'neon' });
      expect(values).toEqual(['light', 'dark', null, null]);
    });

    it('does nothing in a plain browser and never throws when the bridge fails', async () => {
      expect(() => loadWithBridge(true, undefined).syncWindowTitleBar({ themeMode: 'dark' })).not.toThrow();
      const rejecting = loadWithBridge(true, () => Promise.reject(new Error('denied')));
      expect(() => rejecting.syncWindowTitleBar({ themeMode: 'dark' })).not.toThrow();
      const throwing = loadWithBridge(true, () => {
        throw new Error('bridge gone');
      });
      expect(() => throwing.syncWindowTitleBar({ themeMode: 'dark' })).not.toThrow();
      await Promise.resolve();
    });
  });

  it('defaults to system mode with the first skin of each tone', () => {
    const { theme } = load(true);
    expect(theme.normalizeTheme({})).toEqual({
      themeMode: 'system',
      darkSkin: 'daylight-blue',
      lightSkin: 'paper-gray',
    });
  });

  it('replaces unknown values with defaults', () => {
    const { theme } = load(true);
    expect(theme.normalizeTheme({ themeMode: 'neon', darkSkin: 'paper-gray', lightSkin: 'og' })).toEqual({
      themeMode: 'system',
      darkSkin: 'daylight-blue',
      lightSkin: 'paper-gray',
    });
  });

  it('system follows the OS; fixed modes ignore it', () => {
    const settings = { themeMode: 'system', darkSkin: 'og', lightSkin: 'solarized-light' };
    expect(load(true).app.resolveThemeSkin(settings)).toBe('og');
    expect(load(false).app.resolveThemeSkin(settings)).toBe('solarized-light');
    expect(load(false).app.resolveThemeSkin({ ...settings, themeMode: 'dark' })).toBe('og');
    expect(load(true).app.resolveThemeSkin({ ...settings, themeMode: 'light' })).toBe('solarized-light');
  });

  it("keeps the other tone's skin when the mode flips back and forth", () => {
    const { app } = load(false);
    const saved = { themeMode: 'dark', darkSkin: 'daylight-green', lightSkin: 'rose-pine-dawn' };
    expect(app.resolveThemeSkin(saved)).toBe('daylight-green');
    expect(app.resolveThemeSkin({ ...saved, themeMode: 'light' })).toBe('rose-pine-dawn');
  });

  describe('migrateThemeToServer (fills the server only when it has no theme)', () => {
    function appWithPut() {
      const { app } = load(true);
      const puts: object[] = [];
      Object.assign(app, { _apiPut: (_path: string, body: object) => (puts.push(body), Promise.resolve()) });
      return {
        puts,
        migrate: (server: object, merged: Record<string, unknown>) =>
          (app as unknown as { migrateThemeToServer(s: object, m: object): object | null }).migrateThemeToServer(
            server,
            merged
          ),
      };
    }

    it('does nothing when the server already has a theme (server wins)', () => {
      const { puts, migrate } = appWithPut();
      const merged = { skin: 'og', themeMode: 'light' };
      expect(migrate({ themeMode: 'dark' }, merged)).toBeNull();
      expect(puts).toEqual([]);
      expect(merged).toEqual({ skin: 'og', themeMode: 'light' });
    });

    it("pushes this device's own theme to a server that has none, instead of resetting it", () => {
      const { puts, migrate } = appWithPut();
      const merged: Record<string, unknown> = {
        themeMode: 'light',
        darkSkin: 'og',
        lightSkin: 'rose-pine-dawn',
        skin: 'paper-gray',
      };
      migrate({}, merged);
      const expected = { themeMode: 'light', darkSkin: 'og', lightSkin: 'rose-pine-dawn' };
      expect(puts).toEqual([expected]);
      expect(merged).toMatchObject(expected);
    });

    it('moves a pre-T1 single skin to the server as fixed mode + that skin', () => {
      const { puts, migrate } = appWithPut();
      const merged: Record<string, unknown> = { skin: 'rose-pine-dawn' };
      migrate({}, merged);
      expect(puts).toEqual([{ themeMode: 'light', darkSkin: 'daylight-blue', lightSkin: 'rose-pine-dawn' }]);
      expect(merged.themeMode).toBe('light');
    });

    it('falls back to the system defaults on a fresh install', () => {
      const { puts, migrate } = appWithPut();
      migrate({}, {});
      expect(puts).toEqual([{ themeMode: 'system', darkSkin: 'daylight-blue', lightSkin: 'paper-gray' }]);
    });
  });

  it('maps a pre-T1 single skin to the same look (fixed mode + that skin)', () => {
    const { theme, app } = load(true);
    expect(theme.themeFromLegacySkin('catppuccin-latte')).toMatchObject({
      themeMode: 'light',
      lightSkin: 'catppuccin-latte',
    });
    expect(theme.themeFromLegacySkin('og')).toMatchObject({ themeMode: 'dark', darkSkin: 'og' });
    expect(theme.themeFromLegacySkin('nope')).toBeNull();
    // Before any theme is saved a legacy skin wins, even against the OS mode (no flash on upgrade).
    expect(app.resolveThemeSkin({ skin: 'paper-gray' })).toBe('paper-gray');
  });
});

describe('server: theme attributes on <html> and settings schema', () => {
  const prev = process.env.CODEMAN_DATA_DIR;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'codeman-theme-test-'));
    process.env.CODEMAN_DATA_DIR = dir;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = prev;
  });

  async function htmlTag(settings?: object): Promise<string> {
    if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
    const server = new WebServer(0, false, true, '127.0.0.1', 'host');
    const html = await (server as unknown as { renderIndexHtml: () => Promise<string> }).renderIndexHtml();
    return html.match(/<html[^>]*>/)![0];
  }

  it('writes the system defaults, without the "stored" marker, when nothing was saved', async () => {
    const tag = await htmlTag({});
    expect(tag).toContain('data-theme-mode="system"');
    expect(tag).toContain('data-dark-skin="daylight-blue"');
    expect(tag).toContain('data-light-skin="paper-gray"');
    expect(tag).not.toContain('data-theme-stored');
  });

  it('writes the saved theme and marks it stored', async () => {
    const tag = await htmlTag({ themeMode: 'light', darkSkin: 'og', lightSkin: 'solarized-light' });
    expect(tag).toContain('data-theme-mode="light"');
    expect(tag).toContain('data-dark-skin="og"');
    expect(tag).toContain('data-light-skin="solarized-light"');
    expect(tag).toContain('data-theme-stored="1"');
  });

  it('never writes an unlisted value into the markup', async () => {
    const tag = await htmlTag({ themeMode: '"><script>x</script>', darkSkin: 'x" onload="y', lightSkin: 42 });
    expect(tag).toContain('data-theme-mode="system"');
    expect(tag).toContain('data-dark-skin="daylight-blue"');
    expect(tag).toContain('data-light-skin="paper-gray"');
    expect(tag).not.toContain('script');
    expect(tag).not.toContain('onload');
  });

  it('accepts the three keys and rejects a value outside the lists', () => {
    expect(
      SettingsUpdateSchema.safeParse({ themeMode: 'system', darkSkin: 'og', lightSkin: 'paper-gray' }).success
    ).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ themeMode: 'neon' }).success).toBe(false);
    expect(SettingsUpdateSchema.safeParse({ darkSkin: 'paper-gray' }).success).toBe(false);
    expect(SettingsUpdateSchema.safeParse({ lightSkin: 'og' }).success).toBe(false);
  });
});

describe('theme strings in en / zh-CN / ko', () => {
  function i18n(language: string, displayName?: string) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    });
    vm.runInContext(i18nSource, dom.getInternalVMContext(), { filename: 'i18n.js' });
    const api = (dom.window as unknown as { CodemanI18n: { configure(o: object): void; t(s: string): string } })
      .CodemanI18n;
    api.configure({ language, displayName });
    return api;
  }
  // Every string theme-ui.js / the settings markup shows, in the form it is written in the source.
  const SOURCES = [
    'Theme',
    'Dark',
    'Light',
    'System',
    'Skin when dark',
    'Skin when light',
    'Terminal colors follow the skin.',
    'Follows the Windows app mode. Now: dark',
    'Follows the Windows app mode. Now: light',
    'Always dark, regardless of Windows.',
    'Always light, regardless of Windows.',
    "Changes apply immediately and are saved in this PC's Codeman settings.",
  ];

  it('translates every theme string in zh-CN and ko, and the two differ from English', () => {
    for (const source of SOURCES) {
      expect(i18n('zh-CN').t(source), `zh-CN: ${source}`).not.toBe(source);
      expect(i18n('ko').t(source), `ko: ${source}`).not.toBe(source);
    }
  });

  it('gives the dynamic OS-state sentence the spec wording in Korean', () => {
    expect(i18n('ko').t('Follows the Windows app mode. Now: dark')).toBe(
      'Windows 「기본 앱 모드」를 따릅니다 · 지금은 다크'
    );
    expect(i18n('ko').t('Always dark, regardless of Windows.')).not.toContain('Switchboard');
  });

  it('writes the app name through the display name, never a literal', () => {
    const footer = SOURCES[SOURCES.length - 1];
    expect(i18n('ko', 'Switchboard').t(footer)).toContain('Switchboard');
    // The fork's default name is Switchboard; "Codeman" stays only as the source token.
    expect(i18n('ko').t(footer)).toContain('Switchboard');
    expect(i18n('ko', 'Codeman').t(footer)).toContain('Switchboard');
    expect(i18n('en', 'Switchboard').t(footer)).toBe(
      "Changes apply immediately and are saved in this PC's Switchboard settings."
    );
    expect(i18nSource).not.toMatch(/(['"])[^'"\n]*Switchboard settings/);
  });

  it('falls back to Korean (the default) for a language it does not know; English stays English', () => {
    expect(i18n('fr').t('Theme')).toBe('테마');
    expect(i18n('en').t('Theme')).toBe('Theme');
  });
});

describe('bundled UI fonts (IBM Plex Sans + IBM Plex Sans KR)', () => {
  const dir = resolve('src/web/public/fonts');
  const FILES = [400, 500, 600].flatMap((_, i) => {
    const name = ['Regular', 'Medium', 'SemiBold'][i];
    return [`ibm-plex-sans-latin-${name}.woff2`, `ibm-plex-sans-kr-ksx1001-${name}.woff2`];
  });

  it('ships six real woff2 files, in a size that shows they are subsets', () => {
    for (const file of FILES) {
      const path = join(dir, file);
      expect(existsSync(path), file).toBe(true);
      // woff2 magic number: the file is not an HTML error page saved under a font name.
      expect(readFileSync(path).subarray(0, 4).toString('latin1'), file).toBe('wOF2');
      // The full Plex Sans KR is ~1 MB per weight as OTF; the KS X 1001 subset must stay far below that.
      expect(statSync(path).size, file).toBeLessThan(file.includes('-kr-') ? 200_000 : 40_000);
    }
  });

  it('carries the OFL license next to the fonts', () => {
    const license = readFileSync(join(dir, 'LICENSE-ibm-plex-OFL.txt'), 'utf8');
    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(license).toContain('IBM Corp.');
  });

  it('declares each family at 400/500/600 with font-display: swap and never loads from a CDN', () => {
    const faces = [...stylesSource.matchAll(/@font-face \{[^}]*font-family: '(IBM Plex Sans(?: KR)?)'[^}]*\}/g)];
    expect(faces).toHaveLength(6);
    for (const [face, family] of faces) {
      expect(face, family).toContain('font-display: swap;');
      expect(face, family).toMatch(/src: url\('fonts\/ibm-plex-sans-[A-Za-z0-9-]+\.woff2'\) format\('woff2'\);/);
      expect(face, family).not.toMatch(/https?:/);
    }
    const weights = (family: string) =>
      faces
        .filter((f) => f[1] === family)
        .map((f) => Number(f[0].match(/font-weight: (\d+)/)![1]))
        .sort();
    expect(weights('IBM Plex Sans')).toEqual([400, 500, 600]);
    expect(weights('IBM Plex Sans KR')).toEqual([400, 500, 600]);
  });

  it('puts Plex Sans KR right after Plex Sans in --font-ui (Plex Sans has no Hangul)', () => {
    const family = cssBlock(':root').match(/--font-ui:\s*([^;]+);/)![1];
    expect(family.indexOf("'IBM Plex Sans'")).toBeGreaterThanOrEqual(0);
    expect(family.indexOf("'IBM Plex Sans KR'")).toBeGreaterThan(family.indexOf("'IBM Plex Sans'"));
    expect(family.indexOf('system-ui')).toBeGreaterThan(family.indexOf("'IBM Plex Sans KR'"));
  });
});
