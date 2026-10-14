/**
 * @fileoverview Switchboard T6: the default case location. Precedence is env > saved setting > ~/codeman-cases,
 * and the saved setting is read ONCE (changing it applies after a restart, never at runtime).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const SETTINGS = () => join(homedir(), '.codeman', 'settings.json');
const save = (value: unknown) => {
  mkdirSync(dirname(SETTINGS()), { recursive: true });
  writeFileSync(SETTINGS(), typeof value === 'string' ? value : JSON.stringify(value));
};
const load = async () => {
  vi.resetModules();
  return import('../src/config/cases-dir.js');
};
const savedEnv = process.env.CODEMAN_CASES_PATH;

beforeEach(() => {
  delete process.env.CODEMAN_CASES_PATH;
  save({});
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CODEMAN_CASES_PATH;
  else process.env.CODEMAN_CASES_PATH = savedEnv;
});

describe('getCasesDir', () => {
  it('defaults to ~/codeman-cases', async () => {
    const m = await load();
    expect(m.getCasesDir()).toBe(join(homedir(), 'codeman-cases'));
    expect(m.getCasesDirSource()).toBe('default');
    expect(m.casePath('x')).toBe(join(homedir(), 'codeman-cases', 'x'));
  });

  it('uses the saved setting', async () => {
    save({ caseBaseDir: '/srv/cases' });
    const m = await load();
    expect(m.getCasesDir()).toBe('/srv/cases');
    expect(m.getCasesDirSource()).toBe('setting');
  });

  it('lets the environment variable win, and keeps reading it live', async () => {
    save({ caseBaseDir: '/srv/cases' });
    process.env.CODEMAN_CASES_PATH = '/env/cases';
    const m = await load();
    expect(m.getCasesDir()).toBe('/env/cases');
    expect(m.getCasesDirSource()).toBe('env');
    process.env.CODEMAN_CASES_PATH = '/env/other';
    expect(m.getCasesDir()).toBe('/env/other');
    delete process.env.CODEMAN_CASES_PATH;
    expect(m.getCasesDir()).toBe('/srv/cases');
  });

  it('reads the setting once: a later change applies only after a restart', async () => {
    save({ caseBaseDir: '/srv/first' });
    const m = await load();
    expect(m.getCasesDir()).toBe('/srv/first');
    save({ caseBaseDir: '/srv/second' });
    expect(m.getCasesDir()).toBe('/srv/first');
    expect(m.readConfiguredCasesDir()).toBe('/srv/second');
    expect((await load()).getCasesDir()).toBe('/srv/second');
  });

  it.each([
    ['a relative path', { caseBaseDir: 'cases' }],
    ['a non-string', { caseBaseDir: 5 }],
    ['an empty string', { caseBaseDir: '' }],
    ['corrupt json', '{nope'],
    ['no key', {}],
  ])('ignores %s', async (_label, content) => {
    save(content);
    const m = await load();
    expect(m.getCasesDir()).toBe(join(homedir(), 'codeman-cases'));
    expect(m.getCasesDirSource()).toBe('default');
    expect(m.readConfiguredCasesDir()).toBeNull();
  });
});
