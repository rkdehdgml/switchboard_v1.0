/**
 * @fileoverview Switchboard T6 — the Work folders settings screen (work-folders.js) in jsdom: what it draws
 * from the server state, the add/remove/register calls it makes, the default-location dialog, escaping and
 * Korean/Chinese coverage. The server half is in test/routes/work-folder-routes.test.ts.
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
  for (let i = 0; i < 6; i++) await tick();
};

interface Call {
  method: string;
  url: string;
  body?: any;
}

const baseState = (over: Record<string, any> = {}) => ({
  success: true,
  data: {
    caseBase: {
      path: '/home/u/codeman-cases',
      source: 'default',
      readOnly: false,
      slowMount: false,
      exists: true,
      configured: null,
      pendingRestart: false,
    },
    roots: [{ path: '/mnt/d/dev', slowMount: true, exists: true }],
    dockerCaseCount: 0,
    maxRoots: 20,
    ...over,
  },
});

const project = (name: string, over: Record<string, any> = {}) => ({
  name,
  path: `/mnt/d/dev/${name}`,
  rootPath: '/mnt/d/dev',
  isGit: true,
  branch: 'main',
  mtimeMs: 1_700_000_000_000,
  registered: false,
  ...over,
});

interface Setup {
  state?: any;
  scan?: any;
  language?: string;
  respond?: (call: Call) => any;
}

function boot(setup: Setup = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="workFoldersRoot"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1:3600/',
  });
  const window = dom.window as any;
  const ctx = dom.getInternalVMContext();
  for (const f of ['i18n-ko.js', 'i18n.js']) vm.runInContext(read(f), ctx, { filename: f });
  window.CodemanI18n.configure({ language: setup.language ?? 'en' });

  const calls: Call[] = [];
  const toasts: Array<[string, string]> = [];
  window.app = { showToast: (m: string, k: string) => toasts.push([m, k]), loadCases: vi.fn() };
  window.fetch = async (url: string, init: any = {}) => {
    const call: Call = { method: init.method || 'GET', url, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const custom = setup.respond?.(call);
    if (custom) return { json: async () => custom };
    if (url === '/api/work-folders') return { json: async () => setup.state ?? baseState() };
    if (url.startsWith('/api/work-folders/scan')) {
      return { json: async () => setup.scan ?? { success: true, data: { projects: [], truncated: false } } };
    }
    return { json: async () => ({ success: true, data: {} }) };
  };
  vm.runInContext(read('work-folders.js'), ctx, { filename: 'work-folders.js' });
  const doc = window.document as Document;
  return { window, doc, calls, toasts, wf: window.CodemanWorkFolders };
}

let current: ReturnType<typeof boot> | null = null;
const start = async (setup: Setup = {}) => {
  current = boot(setup);
  await current.wf.refresh();
  await settle();
  return current;
};
afterEach(async () => {
  if (!current) return;
  await tick();
  current.window.close();
  current = null;
});

const text = (el: Element | null) => el?.textContent ?? '';

describe('state drawing', () => {
  it('lists the default location first with its badge, then the roots with a slow-mount badge', async () => {
    const { doc } = await start();
    const rows = [...doc.querySelectorAll('.wf-list:not(.wf-scan) .wf-row')];
    expect(rows).toHaveLength(2);
    expect(text(rows[0])).toContain('/home/u/codeman-cases');
    expect(text(rows[0])).toContain('Default');
    // the default row has no remove button, only the change button
    expect(rows[0].querySelector('#workFoldersChangeBase')).not.toBeNull();
    expect([...rows[0].querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Change default location']);
    expect(text(rows[1])).toContain('/mnt/d/dev');
    expect(text(rows[1])).toContain('Slow mount');
    expect([...rows[1].querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Remove']);
  });

  it('shows the environment lock and disables the change button', async () => {
    const state = baseState();
    state.data.caseBase.source = 'env';
    state.data.caseBase.readOnly = true;
    const { doc } = await start({ state });
    expect(text(doc.querySelector('.wf-list'))).toContain('Fixed by environment variable');
    expect((doc.getElementById('workFoldersChangeBase') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says a configured default applies after the next restart', async () => {
    const state = baseState();
    state.data.caseBase.pendingRestart = true;
    state.data.caseBase.configured = '/home/u/new';
    const { doc } = await start({ state });
    expect(text(doc.getElementById('workFoldersRoot'))).toContain('applies after the next restart: /home/u/new');
  });

  it('marks a missing folder in words', async () => {
    const { doc } = await start({
      state: baseState({ roots: [{ path: '/mnt/d/gone', slowMount: true, exists: false }] }),
    });
    expect(text(doc.getElementById('workFoldersRoot'))).toContain('Folder not found');
  });

  it('writes every path as text, never as markup', async () => {
    const evil = '/home/u/<img src=x onerror=alert(1)>';
    const { doc } = await start({
      state: baseState({ roots: [{ path: evil, slowMount: false, exists: true }] }),
      scan: { success: true, data: { projects: [project('<b>x</b>', { branch: '<i>b</i>' })], truncated: false } },
    });
    expect(doc.querySelector('#workFoldersRoot img')).toBeNull();
    expect(doc.querySelector('#workFoldersRoot b')).toBeNull();
    expect(doc.querySelector('#workFoldersRoot i')).toBeNull();
    expect(text(doc.getElementById('workFoldersRoot'))).toContain(evil);
  });

  it('reports a failed load instead of an empty screen', async () => {
    const { doc, toasts } = await start({ state: { success: false, error: 'Admin only in multi-user mode' } });
    expect(text(doc.getElementById('workFoldersRoot'))).toContain('Could not load the work folders.');
    expect(toasts[0]).toEqual(['Admin only in multi-user mode', 'error']);
  });
});

describe('discovered projects', () => {
  const scan = {
    success: true,
    data: {
      projects: [project('alpha'), project('beta', { registered: true, branch: null }), project('gamma')],
      truncated: false,
    },
  };

  it('disables a registered project and badges it; the register button follows the selection', async () => {
    const { doc } = await start({ scan });
    const boxes = [...doc.querySelectorAll<HTMLInputElement>('.wf-scan input[type=checkbox]')];
    expect(boxes.map((b) => b.disabled)).toEqual([false, true, false]);
    expect(text(doc.querySelector('.wf-scan'))).toContain('Already registered');
    const register = () => doc.getElementById('workFoldersRegister') as HTMLButtonElement; // the footer is redrawn
    expect(register().disabled).toBe(true);
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new (doc.defaultView as any).Event('change'));
    expect(register().disabled).toBe(false);
    expect(text(doc.getElementById('workFoldersFoot'))).toContain('Selected: 1');
  });

  it('the git toggle re-scans with gitOnly=false', async () => {
    const { doc, calls } = await start({ scan });
    const toggle = doc.getElementById('workFoldersGitOnly') as HTMLInputElement;
    expect(calls.filter((c) => c.url.startsWith('/api/work-folders/scan')).at(-1)?.url).toContain('gitOnly=true');
    toggle.checked = false;
    toggle.dispatchEvent(new (doc.defaultView as any).Event('change'));
    await settle();
    expect(calls.filter((c) => c.url.startsWith('/api/work-folders/scan')).at(-1)?.url).toContain('gitOnly=false');
  });

  it('says so when the scan was cut short, and when nothing was found', async () => {
    const cut = await start({ scan: { success: true, data: { projects: [], truncated: true, reason: 'timeout' } } });
    expect(text(cut.doc.getElementById('workFoldersRoot'))).toContain('took too long');
    expect(text(cut.doc.getElementById('workFoldersRoot'))).toContain('No projects found');
  });

  it('shows the server reason when the scan is refused', async () => {
    const { doc } = await start({ scan: { success: false, error: 'A scan is already running' } });
    expect(text(doc.getElementById('workFoldersRoot'))).toContain('A scan is already running');
  });

  it('registers the selection through /api/cases/link with safe, unique names', async () => {
    const linked: any[] = [];
    const { doc, calls, toasts, window } = await start({
      scan: {
        success: true,
        data: {
          projects: [project('my app'), project('my-app'), project('한글')],
          truncated: false,
        },
      },
      respond: (call) => {
        if (call.url === '/api/cases/link') {
          linked.push(call.body);
          return { success: true, data: {} };
        }
        return null;
      },
    });
    doc.querySelectorAll<HTMLInputElement>('.wf-scan input[type=checkbox]').forEach((b) => {
      b.checked = true;
      b.dispatchEvent(new window.Event('change'));
    });
    (doc.getElementById('workFoldersRegister') as HTMLButtonElement).click();
    await settle();
    expect(linked.map((l) => l.name)).toEqual(['my-app', 'my-app-2', 'project']);
    expect(linked.map((l) => l.path)).toEqual(['/mnt/d/dev/my app', '/mnt/d/dev/my-app', '/mnt/d/dev/한글']);
    expect(toasts.at(-1)).toEqual(['Projects added: 3', 'success']);
    expect(window.app.loadCases).toHaveBeenCalled();
    // and it re-scans afterwards
    expect(calls.filter((c) => c.url.startsWith('/api/work-folders/scan')).length).toBeGreaterThan(1);
  });

  it('retries a name clash with a new name and reports a real refusal by folder name', async () => {
    const tries: string[] = [];
    const { doc, toasts, window } = await start({
      scan: { success: true, data: { projects: [project('alpha'), project('gamma')], truncated: false } },
      respond: (call) => {
        if (call.url !== '/api/cases/link') return null;
        tries.push(call.body.name);
        if (call.body.path.endsWith('gamma')) return { success: false, error: 'Folder not found: x' };
        return call.body.name === 'alpha'
          ? { success: false, error: 'A case with this name already exists in codeman-cases.' }
          : { success: true, data: {} };
      },
    });
    doc.querySelectorAll<HTMLInputElement>('.wf-scan input[type=checkbox]').forEach((b) => {
      b.checked = true;
      b.dispatchEvent(new window.Event('change'));
    });
    (doc.getElementById('workFoldersRegister') as HTMLButtonElement).click();
    await settle();
    expect(tries).toEqual(['alpha', 'alpha-2', 'gamma']);
    expect(toasts.map((t) => t[0])).toEqual(['Projects added: 1', 'Could not add: gamma']);
  });
});

describe('roots', () => {
  it('removing a root sends the encoded path and reloads', async () => {
    const { doc, calls } = await start({
      state: baseState({ roots: [{ path: '/mnt/d/my dev&x', slowMount: true, exists: true }] }),
    });
    (doc.querySelector('.wf-list .wf-row:nth-child(2) button') as HTMLButtonElement).click();
    await settle();
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe(`/api/work-folders/roots?path=${encodeURIComponent('/mnt/d/my dev&x')}`);
    expect(calls.filter((c) => c.url === '/api/work-folders').length).toBeGreaterThan(1);
  });

  it('a refused removal is toasted with the server message', async () => {
    const { doc, toasts } = await start({
      respond: (call) => (call.method === 'DELETE' ? { success: false, error: 'This folder was not found' } : null),
    });
    (doc.querySelector('.wf-list .wf-row:nth-child(2) button') as HTMLButtonElement).click();
    await settle();
    expect(toasts.at(-1)).toEqual(['This folder was not found', 'error']);
  });

  it('adds a root from the native dialog result', async () => {
    const { window, doc, calls } = await start();
    const asked: unknown[] = [];
    window.CodemanFolderPicker = {
      isAvailable: () => true,
      choose: async (options: unknown) => (asked.push(options), { status: 'ok', wslPath: '/home/u/work' }),
    };
    (doc.getElementById('workFoldersBrowse') as HTMLButtonElement).click();
    await settle();
    // the work-folder rules apply, not the picker roots (a folder on another drive must be addable)
    expect(asked).toEqual([{ title: 'Select work folder', purpose: 'work-folder' }]);
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/work-folders/roots')?.body).toEqual({
      path: '/home/u/work',
    });
  });

  it('a cancelled or rejected dialog adds nothing', async () => {
    const { window, doc, calls } = await start();
    for (const status of ['cancelled', 'rejected']) {
      window.CodemanFolderPicker = { isAvailable: () => true, choose: async () => ({ status }) };
      (doc.getElementById('workFoldersBrowse') as HTMLButtonElement).click();
      await settle();
    }
    expect(calls.some((c) => c.url === '/api/work-folders/roots')).toBe(false);
  });
});

describe('default location dialog', () => {
  const open = async (setup: Setup = {}) => {
    const t = await start(setup);
    const button = t.doc.getElementById('workFoldersChangeBase') as HTMLButtonElement;
    button.focus(); // a real click focuses the button; the dialog returns focus to it
    button.click();
    return t;
  };

  it('opens as a labelled dialog, focuses the path and warns about Docker cases', async () => {
    const state = baseState({ dockerCaseCount: 2 });
    const { doc } = await open({ state });
    const box = doc.querySelector('.wf-dialog')!;
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-modal')).toBe('true');
    expect(doc.getElementById(box.getAttribute('aria-labelledby')!)?.textContent).toBe('Change default location');
    expect(doc.activeElement?.id).toBe('wfBasePath');
    expect(text(box)).toContain('Docker cases keep their old folder mounted');
    expect(text(box)).toContain('(2)');
    expect(text(box)).toContain('Applies after the next restart');
  });

  it('no Docker warning when there are no Docker cases', async () => {
    const { doc } = await open();
    expect(text(doc.querySelector('.wf-dialog'))).not.toContain('Docker cases');
  });

  it('saves the path and the choice for existing cases, then closes and reloads', async () => {
    const { doc, calls, toasts, window } = await open({
      respond: (call) =>
        call.method === 'PUT'
          ? { success: true, data: { path: '/home/u/new', appliesAfterRestart: true, existingCases: 'hide' } }
          : null,
    });
    const input = doc.getElementById('wfBasePath') as HTMLInputElement;
    input.value = '  /home/u/new  ';
    (doc.querySelector('input[name=wfExisting][value=hide]') as HTMLInputElement).checked = true;
    const save = [...doc.querySelectorAll('.wf-dialog button')].find(
      (b) => b.textContent === 'Save'
    ) as HTMLButtonElement;
    save.click();
    await settle();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/api/work-folders/base',
      body: { path: '/home/u/new', existingCases: 'hide' },
    });
    expect(doc.querySelector('.wf-dialog')).toBeNull();
    expect(toasts.at(-1)).toEqual(['Saved. Applies after the next restart.', 'success']);
    expect(window.document.activeElement?.id).toBe('workFoldersChangeBase');
  });

  it('keeps the dialog open and shows the server reason when the path is refused', async () => {
    const { doc } = await open({
      respond: (call) =>
        call.method === 'PUT' ? { success: false, error: 'This folder is not writable', reason: 'not_writable' } : null,
    });
    const save = [...doc.querySelectorAll('.wf-dialog button')].find(
      (b) => b.textContent === 'Save'
    ) as HTMLButtonElement;
    save.click();
    await settle();
    expect(doc.querySelector('.wf-dialog')).not.toBeNull();
    const alert = doc.querySelector('.wf-dialog [role=alert]') as HTMLElement;
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toBe('This folder is not writable');
    expect(save.disabled).toBe(false);
  });

  it('Escape closes it without a request; Tab stays inside', async () => {
    const { doc, calls, window } = await open();
    const before = calls.length;
    const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    const last = [...doc.querySelectorAll<HTMLElement>('.wf-dialog button, .wf-dialog input')].at(-1)!;
    last.focus();
    doc.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(doc.querySelector('.wf-dialog')!.contains(doc.activeElement)).toBe(true);
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(doc.querySelector('.wf-dialog')).toBeNull();
    expect(calls.length).toBe(before);
  });

  it('its Browse button uses the native dialog with the work-folder rules and fills the path', async () => {
    const { window, doc } = await open();
    const asked: unknown[] = [];
    window.CodemanFolderPicker = {
      isAvailable: () => true,
      choose: async (options: unknown) => (asked.push(options), { status: 'ok', wslPath: '/mnt/e/projects' }),
    };
    const browse = [...doc.querySelectorAll('.wf-dialog button')].find(
      (b) => b.textContent === 'Browse'
    ) as HTMLButtonElement;
    browse.click();
    await settle();
    expect(asked).toEqual([{ title: 'Select default location', purpose: 'work-folder' }]);
    expect((doc.getElementById('wfBasePath') as HTMLInputElement).value).toBe('/mnt/e/projects');
  });

  it('is not available while the environment fixes the location', async () => {
    const state = baseState();
    state.data.caseBase.readOnly = true;
    state.data.caseBase.source = 'env';
    const { doc } = await start({ state });
    (doc.getElementById('workFoldersChangeBase') as HTMLButtonElement).click();
    expect(doc.querySelector('.wf-dialog')).toBeNull();
  });
});

describe('wiring and translation', () => {
  it('is wired: section, rail item and script before session-ui.js, refreshed when Settings opens', () => {
    const html = read('index.html');
    expect(html).toContain('id="settings-workfolders"');
    expect(html).toContain('data-section="settings-workfolders"');
    expect(html).toContain('id="workFoldersRoot"');
    expect(html.indexOf('src="work-folders.js"')).toBeGreaterThan(html.indexOf('src="native-folder.js"'));
    expect(html.indexOf('src="work-folders.js"')).toBeLessThan(html.indexOf('src="session-ui.js"'));
    // after Appearance, before Models (spec: "외관 다음")
    const at = (s: string) => html.indexOf(s);
    expect(at('id="settings-appearance"')).toBeLessThan(at('id="settings-workfolders"'));
    expect(at('id="settings-workfolders"')).toBeLessThan(at('id="settings-models"'));
    expect(read('settings-ui.js')).toContain('CodemanWorkFolders?.refresh?.()');
  });

  it('every string the module shows has a Korean and a Chinese translation', async () => {
    const source = read('work-folders.js');
    const keys = new Set<string>();
    for (const m of source.matchAll(/\bt\('((?:[^'\\]|\\.)*)'\)/g)) keys.add(m[1].replace(/\\'/g, "'"));
    for (const m of source.matchAll(/button\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    for (const m of source.matchAll(/badge\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    for (const m of source.matchAll(/^\s+\[?'((?:[^'\\]|\\.)*)'\]?,?\s*$/gm)) {
      if (/[a-z]/.test(m[1]) && m[1].includes(' ') && !m[1].startsWith('wf-')) keys.add(m[1].replace(/\\'/g, "'"));
    }
    keys.add('Work folders');
    expect(keys.size).toBeGreaterThan(30);
    for (const language of ['ko', 'zh-CN']) {
      const t = boot({ language });
      const missing = [...keys].filter((k) => t.window.CodemanI18n.t(k) === k);
      await tick();
      t.window.close();
      expect(missing, `${language} missing`).toEqual([]);
    }
  });

  it('the server messages it can show are translated too', async () => {
    const route = read('../../../src/web/routes/work-folder-routes.ts');
    const block = route.slice(route.indexOf('const REASON_MESSAGE'), route.indexOf('/** One scan per user'));
    const messages = [...block.matchAll(/^\s+\w+: '((?:[^'\\]|\\.)*)',?$/gm)].map((m) => m[1]);
    messages.push('At most 20 work folders can be registered');
    for (const m of route.matchAll(/createErrorResponse\(\s*ApiErrorCode\.\w+,\s*'((?:[^'\\]|\\.)*)'/g)) {
      if (!m[1].startsWith('Admin only')) messages.push(m[1]);
    }
    expect(messages.length).toBeGreaterThanOrEqual(10);
    for (const language of ['ko', 'zh-CN']) {
      const t = boot({ language });
      const missing = [...new Set(messages)].filter((k) => t.window.CodemanI18n.t(k) === k);
      await tick();
      t.window.close();
      expect(missing, `${language} missing`).toEqual([]);
    }
  });
});
