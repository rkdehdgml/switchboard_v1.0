/**
 * @fileoverview Switchboard T6: the Work folders API. Real directories under the per-file temp HOME; the
 * contract that matters is that nothing outside the allowed zone can become a root, that the default
 * case location is never applied at runtime, and that existing cases are never moved or deleted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerWorkFolderRoutes } from '../../src/web/routes/work-folder-routes.js';
import { settingsFile } from '../../src/web/work-folders.js';

const HOME = homedir();
const mk = (...parts: string[]) => {
  const p = join(...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const settings = () => (existsSync(settingsFile()) ? JSON.parse(readFileSync(settingsFile(), 'utf-8')) : {});

let app: FastifyInstance;
const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object | undefined });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};

beforeAll(async () => {
  ({ app } = await createRouteTestHarness((a) => registerWorkFolderRoutes(a)));
  mk(HOME, 'work', 'proj1', '.git');
  mk(HOME, '.ssh', 'keys');
});
afterAll(() => app.close());
beforeEach(() => {
  rmSync(settingsFile(), { force: true });
  delete process.env.CODEMAN_CASES_PATH;
});

describe('GET /api/work-folders', () => {
  it('reports the default location, no roots and the limits on a fresh install', async () => {
    const { status, body } = await call('GET', '/api/work-folders');
    expect(status).toBe(200);
    expect(body.data.caseBase).toMatchObject({
      path: join(HOME, 'codeman-cases'),
      source: 'default',
      readOnly: false,
      pendingRestart: false,
      configured: null,
      slowMount: false,
    });
    expect(body.data.roots).toEqual([]);
    expect(body.data.maxRoots).toBe(20);
    expect(body.data.dockerCaseCount).toBe(0);
  });
});

describe('roots', () => {
  it('adds, lists and removes a root', async () => {
    const root = join(HOME, 'work');
    const add = await call('POST', '/api/work-folders/roots', { path: root });
    expect(add.status).toBe(200);
    expect(add.body.data).toMatchObject({ slowMount: false });
    expect(settings().projectRoots).toEqual([add.body.data.path]);
    expect((await call('GET', '/api/work-folders')).body.data.roots).toEqual([
      { path: add.body.data.path, slowMount: false, exists: true },
    ]);
    const del = await call('DELETE', `/api/work-folders/roots?path=${encodeURIComponent(add.body.data.path)}`);
    expect(del.status).toBe(200);
    expect(settings().projectRoots).toEqual([]);
    expect(existsSync(root)).toBe(true); // removing a root never touches the folder
  });

  it('stores the real path of a link and refuses a duplicate', async () => {
    symlinkSync(join(HOME, 'work'), join(HOME, 'work-link'));
    const first = await call('POST', '/api/work-folders/roots', { path: join(HOME, 'work-link') });
    expect(first.body.data.path).toBe(join(realpathSync(HOME), 'work'));
    const again = await call('POST', '/api/work-folders/roots', { path: join(HOME, 'work') });
    expect(again.status).toBe(409);
    expect(again.body.reason).toBe('duplicate');
    rmSync(join(HOME, 'work-link'));
  });

  it.each<[string, string | (() => string), number, string]>([
    ['the root', '/', 400, 'too_broad'],
    ['the home directory', HOME, 400, 'too_broad'],
    ['a folder outside home and drives', '/usr/lib', 403, 'outside_allowed'],
    ['~/.ssh', () => join(HOME, '.ssh'), 403, 'blocked'],
    ['a missing folder', () => join(HOME, 'missing'), 404, 'not_found'],
    ['a relative path', 'work', 400, 'invalid_input'],
  ])('refuses %s with a reason and saves nothing', async (_label, path, status, reason) => {
    const res = await call('POST', '/api/work-folders/roots', { path: typeof path === 'function' ? path() : path });
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, reason });
    expect(settings().projectRoots).toBeUndefined();
  });

  it('caps the number of roots', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await call('POST', '/api/work-folders/roots', { path: mk(HOME, 'many', `r${i}`) })).status).toBe(200);
    }
    const over = await call('POST', '/api/work-folders/roots', { path: mk(HOME, 'many', 'r20') });
    expect(over.status).toBe(409);
    expect(over.body.reason).toBe('limit');
  });

  it('cannot remove the default location, and an unknown root is not found', async () => {
    const base = (await call('GET', '/api/work-folders')).body.data.caseBase.path;
    const res = await call('DELETE', `/api/work-folders/roots?path=${encodeURIComponent(base)}`);
    expect(res).toMatchObject({ status: 400, body: { reason: 'is_default' } });
    const unknown = await call('DELETE', `/api/work-folders/roots?path=${encodeURIComponent(join(HOME, 'work'))}`);
    expect(unknown).toMatchObject({ status: 404, body: { reason: 'not_found' } });
  });

  it('refuses the default location as a second root', async () => {
    const base = mk(HOME, 'codeman-cases');
    const res = await call('POST', '/api/work-folders/roots', { path: base });
    expect(res).toMatchObject({ status: 409, body: { reason: 'duplicate' } });
  });
});

describe('PUT /api/work-folders/base', () => {
  it('saves the new location but does not apply it at runtime, and leaves old cases alone', async () => {
    const oldBase = mk(HOME, 'codeman-cases');
    mk(oldBase, 'alpha');
    mk(oldBase, 'beta_2');
    mk(oldBase, '.hidden');
    mk(oldBase, 'has space');
    writeFileSync(join(oldBase, 'file.txt'), 'x');
    const newBase = mk(HOME, 'new-cases');

    const res = await call('PUT', '/api/work-folders/base', { path: newBase, existingCases: 'link' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ appliesAfterRestart: true, existingCases: 'link', linked: 2 });
    expect(settings().caseBaseDir).toBe(join(realpathSync(HOME), 'new-cases'));
    expect(JSON.parse(readFileSync(join(HOME, '.codeman', 'linked-cases.json'), 'utf-8'))).toEqual({
      alpha: join(oldBase, 'alpha'),
      beta_2: join(oldBase, 'beta_2'),
    });
    // nothing was moved or deleted
    for (const name of ['alpha', 'beta_2', '.hidden', 'has space', 'file.txt'])
      expect(existsSync(join(oldBase, name))).toBe(true);

    const state = (await call('GET', '/api/work-folders')).body.data.caseBase;
    expect(state.path).toBe(oldBase); // the ACTIVE location is unchanged until restart
    expect(state.configured).toBe(settings().caseBaseDir);
    expect(state.pendingRestart).toBe(true);
    rmSync(join(HOME, '.codeman', 'linked-cases.json'), { force: true });
  });

  it('"hide" registers nothing', async () => {
    const oldBase = mk(HOME, 'codeman-cases');
    mk(oldBase, 'gamma');
    const res = await call('PUT', '/api/work-folders/base', { path: mk(HOME, 'new-cases'), existingCases: 'hide' });
    expect(res.body.data).toMatchObject({ existingCases: 'hide', linked: 0 });
    expect(existsSync(join(HOME, '.codeman', 'linked-cases.json'))).toBe(false);
    expect(existsSync(join(oldBase, 'gamma'))).toBe(true);
  });

  it('does not overwrite a case that is already linked under the same name', async () => {
    mkdirSync(join(HOME, '.codeman'), { recursive: true });
    writeFileSync(join(HOME, '.codeman', 'linked-cases.json'), JSON.stringify({ alpha: '/somewhere/else' }));
    mk(HOME, 'codeman-cases', 'alpha');
    await call('PUT', '/api/work-folders/base', { path: mk(HOME, 'new-cases'), existingCases: 'link' });
    expect(JSON.parse(readFileSync(join(HOME, '.codeman', 'linked-cases.json'), 'utf-8')).alpha).toBe(
      '/somewhere/else'
    );
    rmSync(join(HOME, '.codeman', 'linked-cases.json'), { force: true });
  });

  it.each<[string, string, number, string]>([
    ['the root', '/', 400, 'too_broad'],
    ['the home directory', HOME, 400, 'too_broad'],
    ['outside the allowed zone', '/usr/lib', 403, 'outside_allowed'],
    ['a missing folder', join(HOME, 'missing'), 404, 'not_found'],
  ])('refuses %s and saves nothing', async (_label, path, status, reason) => {
    const res = await call('PUT', '/api/work-folders/base', { path, existingCases: 'hide' });
    expect(res).toMatchObject({ status, body: { success: false, reason } });
    expect(settings().caseBaseDir).toBeUndefined();
  });

  it('is read-only when the environment variable fixes the location', async () => {
    process.env.CODEMAN_CASES_PATH = mk(HOME, 'fixed-cases');
    const state = (await call('GET', '/api/work-folders')).body.data.caseBase;
    expect(state).toMatchObject({ source: 'env', readOnly: true, path: process.env.CODEMAN_CASES_PATH });
    const res = await call('PUT', '/api/work-folders/base', { path: mk(HOME, 'new-cases'), existingCases: 'hide' });
    expect(res).toMatchObject({ status: 409, body: { reason: 'env_locked' } });
    expect(settings().caseBaseDir).toBeUndefined();
  });

  it('rejects a body without a valid choice for the existing cases', async () => {
    for (const payload of [
      { path: mk(HOME, 'new-cases') },
      { path: mk(HOME, 'new-cases'), existingCases: 'move' },
      { existingCases: 'link' },
    ]) {
      const res = await call('PUT', '/api/work-folders/base', payload);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(settings().caseBaseDir).toBeUndefined();
  });
});

describe('GET /api/work-folders/scan', () => {
  it('lists projects under the roots and the default location, marks the registered ones', async () => {
    mk(HOME, 'work', 'proj2', '.git');
    mk(HOME, 'codeman-cases', 'casey', '.git');
    await call('POST', '/api/work-folders/roots', { path: join(HOME, 'work') });
    mkdirSync(join(HOME, '.codeman'), { recursive: true });
    writeFileSync(join(HOME, '.codeman', 'linked-cases.json'), JSON.stringify({ p1: join(HOME, 'work', 'proj1') }));

    const { status, body } = await call('GET', '/api/work-folders/scan');
    expect(status).toBe(200);
    expect(body.data.truncated).toBe(false);
    const byName = Object.fromEntries(body.data.projects.map((p: any) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(['casey', 'proj1', 'proj2']);
    expect(byName.proj1.registered).toBe(true);
    expect(byName.proj2.registered).toBe(false);
    expect(byName.casey.registered).toBe(true); // a folder in the cases directory is a case already
    rmSync(join(HOME, '.codeman', 'linked-cases.json'), { force: true });
  });

  it('gitOnly=false also lists plain folders; a bad flag is a validation error', async () => {
    mk(HOME, 'work', 'plain-folder');
    await call('POST', '/api/work-folders/roots', { path: join(HOME, 'work') });
    const all = await call('GET', '/api/work-folders/scan?gitOnly=false');
    expect(all.body.data.projects.some((p: any) => p.name === 'plain-folder' && p.isGit === false)).toBe(true);
    const gitOnly = await call('GET', '/api/work-folders/scan?gitOnly=true');
    expect(gitOnly.body.data.projects.some((p: any) => p.name === 'plain-folder')).toBe(false);
    const bad = await call('GET', '/api/work-folders/scan?gitOnly=maybe');
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('returns an empty list with no roots and no cases directory', async () => {
    rmSync(join(HOME, 'codeman-cases'), { recursive: true, force: true });
    const { body } = await call('GET', '/api/work-folders/scan');
    expect(body).toMatchObject({ success: true, data: { projects: [], truncated: false } });
  });
});

describe('multi-user mode: admin only', () => {
  const savedMulti = process.env.CODEMAN_MULTIUSER;
  afterAll(() => {
    if (savedMulti === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMulti;
  });

  it('refuses every endpoint to a regular user and allows an admin', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const user = await createRouteTestHarness((a) => registerWorkFolderRoutes(a), {
      authUser: { username: 'bob', role: 'user' },
    });
    const admin = await createRouteTestHarness((a) => registerWorkFolderRoutes(a), {
      authUser: { username: 'root', role: 'admin' },
    });
    try {
      const requests: Array<[string, string, object?]> = [
        ['GET', '/api/work-folders'],
        ['POST', '/api/work-folders/roots', { path: join(HOME, 'work') }],
        ['DELETE', `/api/work-folders/roots?path=${encodeURIComponent(join(HOME, 'work'))}`],
        ['PUT', '/api/work-folders/base', { path: join(HOME, 'work'), existingCases: 'hide' }],
        ['GET', '/api/work-folders/scan'],
      ];
      for (const [method, url, payload] of requests) {
        const res = await user.app.inject({ method: method as 'GET', url, payload });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
      expect(settings().projectRoots).toBeUndefined();
      expect(settings().caseBaseDir).toBeUndefined();
      expect((await admin.app.inject({ method: 'GET', url: '/api/work-folders' })).statusCode).toBe(200);
    } finally {
      await user.app.close();
      await admin.app.close();
    }
  });
});
