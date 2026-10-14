/**
 * @fileoverview Switchboard T7 — the native folder dialog's browser side (native-folder.js) in jsdom:
 * the dialog call, the silent cancel, the slow-check list, every rejection screen, focus handling,
 * escaping, and Korean/Chinese coverage. The server half is in test/routes/native-folder-routes.test.ts.
 *
 * Port: N/A (no server start)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const read = (p: string) => readFileSync(resolve('src/web/public', p), 'utf8');

type Steps = Array<{ id: string; status: 'done' | 'failed' | 'pending' }>;
const STEP_IDS = ['input', 'convert', 'realpath', 'roots', 'blocklist'];
const stepsFailingAt = (id?: string): Steps => {
  const at = id ? STEP_IDS.indexOf(id) : STEP_IDS.length;
  return STEP_IDS.map((sid, i) => ({ id: sid, status: i < at ? 'done' : i === at ? 'failed' : 'pending' }));
};

interface Harness {
  window: any;
  picker: any;
  invoke: ReturnType<typeof vi.fn>;
  fetched: Array<{ url: string; init?: any }>;
  setValidate(fn: (path: string) => Promise<any> | any): void;
  setWindowsPath(fn: (path: string) => any): void;
}

function boot(opts: { bridge?: boolean; language?: string } = {}): Harness {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1:3600/',
  });
  const window = dom.window as any;
  const ctx = dom.getInternalVMContext();
  for (const f of ['i18n-ko.js', 'i18n.js']) vm.runInContext(read(f), ctx, { filename: f });
  window.CodemanI18n.configure({ language: opts.language ?? 'en' });

  const fetched: Harness['fetched'] = [];
  let validate: (path: string) => Promise<any> | any = () => ({ success: true, data: {} });
  let windowsPath: (path: string) => any = () => ({ success: true, data: { windowsPath: null } });
  window.fetch = async (url: string, init?: any) => {
    fetched.push({ url, init });
    if (url.startsWith('/api/native-folder/validate')) {
      const body = await validate(JSON.parse(init.body).path);
      return { json: async () => body };
    }
    if (url.startsWith('/api/native-folder/windows-path')) {
      const body = await windowsPath(new URL(url, 'http://x').searchParams.get('path')!);
      return { json: async () => body };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const invoke = vi.fn(async () => null);
  if (opts.bridge !== false) window.__TAURI_INTERNALS__ = { invoke };
  vm.runInContext(read('native-folder.js'), ctx, { filename: 'native-folder.js' });
  return {
    window,
    picker: window.CodemanFolderPicker,
    invoke,
    fetched,
    setValidate: (fn) => (validate = fn),
    setWindowsPath: (fn) => (windowsPath = fn),
  };
}

const ok = (wslPath: string, extra: object = {}) => ({
  success: true,
  data: {
    wslPath,
    windowsPath: 'D:\\dev\\x',
    selectedPath: 'D:\\dev\\x',
    symlinkResolved: false,
    steps: stepsFailingAt(),
    ...extra,
  },
});
const refused = (reason: string, at: string) => ({
  success: false,
  error: `server says ${reason}`,
  reason,
  steps: stepsFailingAt(at),
});
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Let queued MutationObserver callbacks (i18n) run before the jsdom window goes away. */
const dispose = async (w: { close(): void }) => {
  await tick();
  w.close();
};

let h: Harness;
beforeEach(() => {
  h = boot();
});
afterEach(async () => dispose(h.window));

describe('availability and cancel', () => {
  it('reports unavailable outside the desktop shell and never asks the server', async () => {
    const plain = boot({ bridge: false });
    expect(plain.picker.isAvailable()).toBe(false);
    expect(await plain.picker.choose()).toEqual({ status: 'unavailable' });
    expect(plain.fetched).toEqual([]);
    await dispose(plain.window);
    expect(h.picker.isAvailable()).toBe(true);
  });

  it("sends `purpose: 'work-folder'` to the server only when the caller asks for it (T6)", async () => {
    h.invoke.mockResolvedValue('D:\\dev\\x');
    h.setValidate(() => ok('/mnt/d/dev/x'));
    await h.picker.choose();
    await h.picker.choose({ purpose: 'work-folder' });
    const bodies = h.fetched.filter((f) => f.url === '/api/native-folder/validate').map((f) => JSON.parse(f.init.body));
    expect(bodies).toEqual([{ path: 'D:\\dev\\x' }, { path: 'D:\\dev\\x', purpose: 'work-folder' }]);
  });

  it('has a message (and a Korean and Chinese text) for the work-folder-only reasons', async () => {
    for (const reason of ['too_broad', 'outside_allowed']) {
      expect(h.picker.REASONS[reason], reason).toBeDefined();
      for (const language of ['ko', 'zh-CN']) {
        const t = boot({ language });
        const [title, body] = t.picker.REASONS[reason];
        expect(t.window.CodemanI18n.t(title), `${language} ${reason} title`).not.toBe(title);
        expect(t.window.CodemanI18n.t(body), `${language} ${reason} body`).not.toBe(body);
        await dispose(t.window);
      }
    }
  });

  it('a cancelled dialog is silent: no request, no overlay, no error', async () => {
    for (const answer of [null, undefined, '', 0]) {
      h.invoke.mockResolvedValueOnce(answer as any);
      expect(await h.picker.choose()).toEqual({ status: 'cancelled' });
    }
    expect(h.fetched.filter((f) => f.url.includes('validate'))).toEqual([]);
    expect(h.window.document.querySelector('.folder-pick-modal')).toBeNull();
  });

  it('reports a failing bridge as an error, not a crash', async () => {
    h.invoke.mockRejectedValueOnce(new Error('dialog denied'));
    expect(await h.picker.choose()).toEqual({ status: 'error', message: 'dialog denied' });
  });
});

describe('opening the dialog', () => {
  it('asks for one directory, with a translated title and the default path as a Windows path', async () => {
    const ko = boot({ language: 'ko' });
    ko.setWindowsPath((p) => ({
      success: true,
      data: { windowsPath: p === '/home/dev/proj' ? '\\\\wsl.localhost\\Ubuntu\\home\\dev\\proj' : null },
    }));
    await ko.picker.choose({ defaultPath: '/home/dev/proj' });
    expect(ko.invoke).toHaveBeenCalledWith('plugin:dialog|open', {
      options: {
        directory: true,
        multiple: false,
        title: '프로젝트 폴더 선택',
        defaultPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\proj',
      },
    });
    await dispose(ko.window);
  });

  it('omits defaultPath when there is none, it is not absolute, or the conversion fails', async () => {
    await h.picker.choose({ defaultPath: 'relative/dir' });
    h.setWindowsPath(() => {
      throw new Error('down');
    });
    await h.picker.choose({ defaultPath: '/home/x' });
    await h.picker.choose();
    for (const call of h.invoke.mock.calls) expect(call[1].options.defaultPath).toBeUndefined();
    expect(h.fetched.filter((f) => f.url.includes('windows-path'))).toHaveLength(1);
  });

  it('remembers the last accepted folder and offers it next time', async () => {
    h.invoke.mockResolvedValueOnce('D:\\dev\\x');
    h.setValidate(() => ok('/mnt/d/dev/x'));
    expect(await h.picker.choose()).toMatchObject({ status: 'ok', wslPath: '/mnt/d/dev/x' });
    expect(h.picker.lastChosen()).toBe('/mnt/d/dev/x');
    await h.picker.choose();
    expect(
      h.fetched.some((f) => f.url === `/api/native-folder/windows-path?path=${encodeURIComponent('/mnt/d/dev/x')}`)
    ).toBe(true);
  });

  it('does not remember a rejected folder', async () => {
    h.invoke.mockResolvedValueOnce('C:\\Windows');
    h.setValidate(() => refused('outside_roots', 'roots'));
    const pending = h.picker.choose();
    await tick();
    await tick();
    h.window.document.querySelector('.folder-pick-actions button:last-child').click();
    await pending;
    expect(h.picker.lastChosen()).toBe('');
  });
});

describe('the checking list', () => {
  it('never appears for a fast check', async () => {
    h.invoke.mockResolvedValueOnce('D:\\dev\\x');
    h.setValidate(() => ok('/mnt/d/dev/x'));
    await h.picker.choose();
    expect(h.window.document.querySelector('.folder-pick-modal')).toBeNull();
  });

  it('appears after 300 ms for a slow one, lists the five checks in words, and goes away with the answer', async () => {
    const ko = boot({ language: 'ko' });
    ko.invoke.mockResolvedValueOnce('D:\\dev\\slow');
    let release: (v: any) => void = () => {};
    ko.setValidate(() => new Promise((r) => (release = r)));
    const pending = ko.picker.choose();
    await new Promise((r) => setTimeout(r, 150));
    expect(ko.window.document.querySelector('.folder-pick-modal')).toBeNull();
    await new Promise((r) => setTimeout(r, 250));
    const box = ko.window.document.querySelector('.folder-pick-box');
    expect(box.getAttribute('role')).toBe('status');
    expect(box.querySelector('h2').textContent).toBe('폴더를 확인하는 중…');
    expect([...box.querySelectorAll('.folder-pick-step-label')].map((n: any) => n.textContent)).toEqual([
      '입력 형식',
      '경로 변환',
      '실제 경로',
      '허용된 작업 폴더',
      '보안 차단 목록',
    ]);
    expect([...box.querySelectorAll('.folder-pick-step')].every((n: any) => n.dataset.state === 'checking')).toBe(true);
    release(ok('/mnt/d/dev/slow'));
    expect(await pending).toMatchObject({ status: 'ok' });
    expect(ko.window.document.querySelector('.folder-pick-modal')).toBeNull();
    await dispose(ko.window);
  });
});

describe('rejection screens', () => {
  const reasons: Array<[string, string, string]> = [
    ['outside_roots', 'roots', '허용된 작업 폴더 밖에 있습니다'],
    ['blocked', 'blocklist', '보안상 접근이 차단된 폴더입니다'],
    ['other_distro', 'input', '다른 WSL 배포판입니다'],
    ['network_path', 'input', '네트워크 위치는 쓸 수 없습니다'],
    ['not_found', 'realpath', '폴더를 찾을 수 없습니다'],
    ['not_directory', 'blocklist', '폴더가 아닙니다'],
    ['invalid_input', 'input', '이 경로는 사용할 수 없습니다'],
    ['too_broad', 'roots', '범위가 너무 넓은 폴더입니다'],
    ['outside_allowed', 'roots', '작업 폴더로 쓸 수 없는 폴더입니다'],
  ];

  async function reject(harness: Harness, reason: string, at: string, selected = 'C:\\Windows') {
    harness.invoke.mockResolvedValueOnce(selected);
    harness.setValidate(() => refused(reason, at));
    const pending = harness.picker.choose();
    for (let i = 0; i < 4; i++) await tick();
    // wrapped: returning the promise itself would make `await reject(...)` wait for the user's click
    return { pending };
  }

  it.each(reasons)(
    '%s: says what is wrong in Korean, marks the failing check, focuses Close',
    async (reason, at, title) => {
      const ko = boot({ language: 'ko' });
      ko.invoke.mockResolvedValueOnce('C:\\Windows');
      ko.setValidate(() => refused(reason, at));
      const pending = ko.picker.choose();
      for (let i = 0; i < 4; i++) await tick();
      const doc = ko.window.document;
      const box = doc.querySelector('.folder-pick-box');
      expect(box.getAttribute('role')).toBe('alertdialog');
      expect(box.getAttribute('aria-modal')).toBe('true');
      expect(doc.getElementById(box.getAttribute('aria-labelledby')).textContent).toBe(title);
      // the rejected selection is shown, with a lock and the words, not colour alone
      expect(box.querySelector('.folder-pick-path.is-rejected code').textContent).toBe('C:\\Windows');
      expect(box.querySelector('.folder-pick-lock svg')).not.toBeNull();
      const states = [...box.querySelectorAll('.folder-pick-step')].map((n: any) => [n.dataset.state, n.textContent]);
      const failedAt = STEP_IDS.indexOf(at);
      states.forEach(([state, text], i) => {
        expect(state).toBe(i < failedAt ? 'done' : i === failedAt ? 'failed' : 'pending');
        expect(text).toContain(i < failedAt ? '완료' : i === failedAt ? '실패' : '대기');
      });
      expect(doc.activeElement.textContent).toBe('닫기');
      doc.activeElement.click();
      expect(await pending).toEqual({ status: 'rejected', reason, steps: stepsFailingAt(at), action: 'close' });
      expect(doc.querySelector('.folder-pick-modal')).toBeNull();
      await dispose(ko.window);
    }
  );

  it('covers every reason code the server can return', () => {
    expect(Object.keys(h.picker.REASONS).sort()).toEqual(reasons.map((r) => r[0]).sort());
  });

  it('falls back to the server message for an unknown reason, and to a generic one without any', async () => {
    h.invoke.mockResolvedValueOnce('X:\\y');
    h.setValidate(() => ({ success: false, error: 'Something new', reason: 'brand_new', steps: [] }));
    let pending = h.picker.choose();
    for (let i = 0; i < 4; i++) await tick();
    expect(h.window.document.querySelector('.folder-pick-title').textContent).toBe('Something new');
    h.window.document.querySelector('.folder-pick-actions button').click();
    expect(await pending).toMatchObject({ status: 'rejected', reason: 'brand_new' });

    h.invoke.mockResolvedValueOnce('X:\\y');
    h.setValidate(() => ({ success: false }));
    pending = h.picker.choose();
    for (let i = 0; i < 4; i++) await tick();
    expect(h.window.document.querySelector('.folder-pick-title').textContent).toBe('Could not check the folder');
    h.window.document.querySelector('.folder-pick-actions button').click();
    expect(await pending).toMatchObject({ status: 'rejected', reason: 'unknown' });
  });

  it('shows a server that is down as an error screen and returns status error', async () => {
    h.invoke.mockResolvedValueOnce('D:\\dev\\x');
    h.setValidate(() => {
      throw new Error('socket hang up');
    });
    const pending = h.picker.choose();
    for (let i = 0; i < 4; i++) await tick();
    expect(h.window.document.querySelector('.folder-pick-title').textContent).toBe('Could not check the folder');
    h.window.document.querySelector('.folder-pick-actions button').click();
    expect(await pending).toEqual({ status: 'error', message: 'socket hang up' });
  });

  it('offers "Open work folder settings" only when that settings section exists', async () => {
    let { pending } = await reject(h, 'outside_roots', 'roots');
    expect(h.window.document.querySelectorAll('.folder-pick-actions button')).toHaveLength(1);
    h.window.document.querySelector('.folder-pick-actions button').click();
    await pending;

    const section = h.window.document.createElement('div');
    section.id = 'settings-workfolders';
    h.window.document.body.append(section);
    ({ pending } = await reject(h, 'outside_roots', 'roots'));
    const buttons = [...h.window.document.querySelectorAll('.folder-pick-actions button')] as any[];
    expect(buttons.map((b) => b.textContent)).toEqual(['Open work folder settings', 'Close']);
    expect(h.window.document.activeElement).toBe(buttons[0]);
    buttons[1].click();
    await pending;
    // other reasons never offer it
    ({ pending } = await reject(h, 'blocked', 'blocklist'));
    expect(h.window.document.querySelectorAll('.folder-pick-actions button')).toHaveLength(1);
    h.window.document.querySelector('.folder-pick-actions button').click();
    await pending;
  });

  it('choosing the shortcut reports action "workfolders" so the caller can open that settings section', async () => {
    const section = h.window.document.createElement('div');
    section.id = 'settings-workfolders';
    h.window.document.body.append(section);
    const { pending } = await reject(h, 'outside_roots', 'roots');
    h.window.document.querySelector('.folder-pick-actions button').click();
    expect(await pending).toMatchObject({ status: 'rejected', reason: 'outside_roots', action: 'workfolders' });
  });

  it('Escape closes it, and Tab stays inside the dialog', async () => {
    const section = h.window.document.createElement('div');
    section.id = 'settings-workfolders';
    h.window.document.body.append(section);
    const { pending } = await reject(h, 'outside_roots', 'roots');
    const doc = h.window.document;
    const [first, second] = [...doc.querySelectorAll('.folder-pick-actions button')] as any[];
    const press = (key: string, shiftKey = false) => {
      const e = new h.window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
      doc.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(doc.activeElement).toBe(first);
    expect(press('Tab')).toBe(true);
    expect(doc.activeElement).toBe(second);
    press('Tab');
    expect(doc.activeElement).toBe(first);
    press('Tab', true);
    expect(doc.activeElement).toBe(second);
    press('Escape');
    expect(await pending).toMatchObject({ status: 'rejected' });
    expect(doc.querySelector('.folder-pick-modal')).toBeNull();
  });

  it('returns focus to the control that opened it', async () => {
    const opener = h.window.document.createElement('button');
    h.window.document.body.append(opener);
    opener.focus();
    const { pending } = await reject(h, 'blocked', 'blocklist');
    expect(h.window.document.activeElement).not.toBe(opener);
    h.window.document.querySelector('.folder-pick-actions button').click();
    await pending;
    expect(h.window.document.activeElement).toBe(opener);
  });

  it('shows a hostile path as text, never as markup', async () => {
    const evil = 'D:\\<img src=x onerror="window.pwned=1"><b>x</b>';
    const { pending } = await reject(h, 'invalid_input', 'input', evil);
    const doc = h.window.document;
    expect(doc.querySelector('.folder-pick-path code').textContent).toBe(evil);
    expect(doc.querySelector('.folder-pick-box img, .folder-pick-box b')).toBeNull();
    doc.querySelector('.folder-pick-actions button').click();
    await pending;
    expect(h.window.pwned).toBeUndefined();
  });

  it('never lists the block list: only the one selection and the generic example', async () => {
    const { pending } = await reject(h, 'blocked', 'blocklist', 'C:\\Users\\bob\\AppData');
    const text = h.window.document.querySelector('.folder-pick-box').textContent;
    expect(text).toContain('~/.ssh');
    for (const secret of ['.aws', '.kube', 'NTUSER', '.gnupg', 'id_rsa']) expect(text).not.toContain(secret);
    h.window.document.querySelector('.folder-pick-actions button').click();
    await pending;
  });
});

describe('path pair', () => {
  it('shows the WSL and Windows spelling side by side, with a note for a resolved link', () => {
    const box = h.window.document.getElementById('host');
    h.picker.renderPathPair(box, {
      status: 'ok',
      wslPath: '/mnt/d/dev/x',
      windowsPath: 'D:\\dev\\x',
      symlinkResolved: true,
    });
    expect(box.hidden).toBe(false);
    expect([...box.querySelectorAll('.folder-pair-row')].map((r: any) => r.textContent)).toEqual([
      'WSL path/mnt/d/dev/x',
      'Windows pathD:\\dev\\x',
    ]);
    expect(box.querySelector('.folder-pair-note').textContent).toBe('Resolved from a link');
  });

  it('skips the Windows row when unknown, hides itself for any non-ok result, and escapes values', () => {
    const box = h.window.document.getElementById('host');
    h.picker.renderPathPair(box, {
      status: 'ok',
      wslPath: '/home/<i>x</i>',
      windowsPath: null,
      symlinkResolved: false,
    });
    expect(box.querySelectorAll('.folder-pair-row')).toHaveLength(1);
    expect(box.querySelector('i')).toBeNull();
    h.picker.renderPathPair(box, { status: 'rejected' });
    expect(box.hidden).toBe(true);
    expect(box.children).toHaveLength(0);
    h.picker.renderPathPair(box, undefined);
    expect(box.hidden).toBe(true);
  });
});

describe('wiring and translations', () => {
  it('is loaded before session-ui.js and used by the Add Case Browse button, with the HTML picker as the browser fallback', () => {
    const html = read('index.html');
    expect(html.indexOf('src="native-folder.js"')).toBeGreaterThan(0);
    expect(html.indexOf('src="native-folder.js"')).toBeLessThan(html.indexOf('src="session-ui.js"'));
    expect(html).toContain('id="linkCasePathPair"');
    const ui = read('session-ui.js');
    const open = ui.slice(ui.indexOf('openLinkCasePathPicker() {'), ui.indexOf('/** HOST workspace directory'));
    expect(open).toContain('CodemanFolderPicker?.isAvailable()');
    expect(open).toContain('_chooseLinkCaseFolderNatively');
    expect(open).toContain('PathPicker.open({');
    // a rejection explains itself on screen, so the caller must not toast it a second time; the only thing it
    // may do is follow the dialog's "Open work folder settings" shortcut (T6)
    const natively = ui.slice(
      ui.indexOf('async _chooseLinkCaseFolderNatively'),
      ui.indexOf('_applyLinkCaseFolder(pathInput, path) {')
    );
    const rejectedBranch = natively.slice(natively.indexOf("status === 'rejected'"));
    expect(rejectedBranch).toContain("result.action === 'workfolders'");
    expect(rejectedBranch).not.toContain('showToast');
  });

  it('translates every string the module shows, in Korean and Chinese', async () => {
    const strings = new Set<string>([
      'Select project folder',
      'Checking the folder…',
      'Open work folder settings',
      'Close',
      'Done',
      'Waiting',
      'Failed',
      'WSL path',
      'Windows path',
      'Resolved from a link',
    ]);
    for (const [, label] of h.picker.STEPS) strings.add(label);
    for (const [title, body] of [...Object.values(h.picker.REASONS), h.picker.FALLBACK_REASON] as string[][]) {
      strings.add(title);
      strings.add(body);
    }
    for (const language of ['ko', 'zh-CN']) {
      const i = boot({ language });
      for (const s of strings) expect(i.window.CodemanI18n.t(s), `${language}: ${s}`).not.toBe(s);
      await dispose(i.window);
    }
  });
});
