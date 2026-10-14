/**
 * @fileoverview Two pre-existing defects found while building the T2 menu bar:
 * a Claude session lost its Respawn/Ralph tabs, and Esc did not close three modals.
 *
 * Port: N/A (no server start)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const read = (f: string) => readFileSync(resolve('src/web/public', f), 'utf8');

describe('isExternalCliRunMode (session-ui.js)', () => {
  function load(catalog: Array<{ id: string; kind: string }>) {
    class CodemanApp {}
    const ctx = vm.createContext({ window: { __codemanCliCatalog: catalog }, CodemanApp, document: {} });
    vm.runInContext(read('session-ui.js') + '\n;globalThis.__f = isExternalCliRunMode;', ctx, {
      filename: 'session-ui.js',
    });
    return (ctx as unknown as { __f(m: string): boolean }).__f;
  }
  const catalog = [
    { id: 'claude', kind: 'agent' },
    { id: 'shell', kind: 'shell' },
    { id: 'codex', kind: 'agent' },
    { id: 'my-cli', kind: 'agent' },
  ];

  it('is false for the built-in claude and shell modes, so a Claude session keeps Respawn and Ralph', () => {
    const f = load(catalog);
    expect(f('claude')).toBe(false);
    expect(f('shell')).toBe(false);
  });

  it('is true for the external CLIs, including one the user added through the registry', () => {
    const f = load(catalog);
    expect(f('codex')).toBe(true);
    expect(f('my-cli')).toBe(true);
  });

  it('is false for an unknown mode', () => {
    expect(load(catalog)('nope')).toBe(false);
  });
});

describe('global Escape (app.js)', () => {
  const app = read('app.js');
  const block = app.slice(app.indexOf("if (e.key === 'Escape') {"), app.indexOf('// Option/Alt session navigation'));

  it('closes App Settings, Session Options and Add Case when they are open', () => {
    for (const [id, close] of [
      ['appSettingsModal', 'closeAppSettings'],
      ['sessionOptionsModal', 'closeSessionOptions'],
      ['createCaseModal', 'closeCreateCaseModal'],
    ]) {
      expect(block).toContain(`'${id}', '${close}'`);
    }
    expect(block).toContain("classList.contains('active')");
  });

  it('leaves the modal open while a shortcut rebind is capturing (its own Esc cancels the capture)', () => {
    expect(block).toMatch(/if \(!this\._capturingShortcutId\)/);
  });

  it('every close method it calls exists', () => {
    expect(read('settings-ui.js')).toMatch(/^ {2}closeAppSettings\(\) \{/m);
    expect(read('respawn-ui.js')).toMatch(/^ {2}closeSessionOptions\(\) \{/m);
    expect(read('session-ui.js')).toMatch(/^ {2}closeCreateCaseModal\(\) \{/m);
  });
});
