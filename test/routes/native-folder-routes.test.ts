/**
 * @fileoverview Switchboard T7: the server is the ONLY gate behind the native folder dialog.
 * A real dialog can pick C:\Windows, \\server\share, another distro, a symlink to ~/.ssh ...
 * so every refusal reason and the symlink cases run against a real directory tree.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerNativeFolderRoutes } from '../../src/web/routes/native-folder-routes.js';

const DISTRO = 'Ubuntu';
const HOME = homedir();
const winUnc = (posix: string) => `\\\\wsl.localhost\\${DISTRO}${posix.replace(/\//g, '\\')}`;

let app: FastifyInstance;
let converted: string[];
let drivePath: string | null;
let outsideDir: string;
const savedDistro = process.env.WSL_DISTRO_NAME;

beforeAll(async () => {
  process.env.WSL_DISTRO_NAME = DISTRO;
  ({ app } = await createRouteTestHarness((a, ctx) =>
    registerNativeFolderRoutes(a, ctx, async (p) => (converted.push(p), drivePath))
  ));
  // HOME is a per-file temp dir (test/setup.ts), so it is the Home browse root.
  mkdirSync(join(HOME, 'proj', 'sub'), { recursive: true });
  mkdirSync(join(HOME, '.ssh', 'keys'), { recursive: true });
  mkdirSync(join(HOME, '.config', 'gcloud'), { recursive: true });
  writeFileSync(join(HOME, 'a-file.txt'), 'x');
  outsideDir = mkdtempSync(join(tmpdir(), 'sb-outside-'));
  symlinkSync(join(HOME, '.ssh'), join(HOME, 'innocent-link'));
  symlinkSync(outsideDir, join(HOME, 'link-out'));
  symlinkSync(join(HOME, 'proj'), join(HOME, 'link-in'));
});

afterAll(async () => {
  await app.close();
  rmSync(outsideDir, { recursive: true, force: true });
  if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
  else process.env.WSL_DISTRO_NAME = savedDistro;
});

beforeEach(() => {
  converted = [];
  drivePath = null;
});

async function validate(path: unknown) {
  const res = await app.inject({ method: 'POST', url: '/api/native-folder/validate', payload: { path } });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
}

describe('POST /api/native-folder/validate', () => {
  it('accepts a drive path, returns the real WSL path next to its Windows spelling', async () => {
    drivePath = join(HOME, 'proj');
    const { status, body } = await validate('D:\\dev\\proj');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.wslPath).toBe(realpathSync(join(HOME, 'proj')));
    expect(body.data.windowsPath).toBe(winUnc(realpathSync(join(HOME, 'proj'))));
    expect(body.data.selectedPath).toBe('D:\\dev\\proj');
    expect(body.data.symlinkResolved).toBe(false);
    expect(body.data.steps.map((s: any) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(body.data.steps.map((s: any) => s.id)).toEqual(['input', 'convert', 'realpath', 'roots', 'blocklist']);
    expect(converted).toEqual(['D:\\dev\\proj']);
  });

  it('accepts a \\\\wsl.localhost share of this distro without asking wslpath', async () => {
    const { status, body } = await validate(winUnc(join(HOME, 'proj', 'sub')));
    expect(status).toBe(200);
    expect(body.data.wslPath).toBe(realpathSync(join(HOME, 'proj', 'sub')));
    expect(converted).toEqual([]);
  });

  it('resolves a symlink into an allowed folder and says so', async () => {
    const { status, body } = await validate(winUnc(join(HOME, 'link-in')));
    expect(status).toBe(200);
    expect(body.data.wslPath).toBe(realpathSync(join(HOME, 'proj')));
    expect(body.data.symlinkResolved).toBe(true);
  });

  const refusals: Array<[string, unknown, number, string, string]> = [
    // label, input, http status, reason, step that failed
    ['empty', '   ', 400, 'invalid_input', 'input'],
    ['option-looking', '-rf', 400, 'invalid_input', 'input'],
    ['newline', 'D:\\a\nb', 400, 'invalid_input', 'input'],
    ['relative', 'proj\\x', 400, 'invalid_input', 'input'],
    ['UNC share', '\\\\server\\share', 400, 'network_path', 'input'],
    ['UNC via extended prefix', '\\\\?\\UNC\\server\\share', 400, 'network_path', 'input'],
    ['another distro', '\\\\wsl.localhost\\Debian\\home\\x', 400, 'other_distro', 'input'],
    ['missing folder', winUnc(join(HOME, 'does-not-exist')), 404, 'not_found', 'realpath'],
    ['outside every root', winUnc('/usr'), 403, 'outside_roots', 'roots'],
    ['~/.ssh itself', winUnc(join(HOME, '.ssh')), 403, 'blocked', 'blocklist'],
    ['~/.config/gcloud itself', winUnc(join(HOME, '.config', 'gcloud')), 403, 'blocked', 'blocklist'],
    ['a folder inside ~/.ssh', winUnc(join(HOME, '.ssh', 'keys')), 403, 'blocked', 'blocklist'],
    ['a file, not a folder', winUnc(join(HOME, 'a-file.txt')), 400, 'not_directory', 'blocklist'],
    ['a symlink to ~/.ssh', winUnc(join(HOME, 'innocent-link')), 403, 'blocked', 'blocklist'],
    ['a symlink out of the roots', winUnc(join(HOME, 'link-out')), 403, 'outside_roots', 'roots'],
    ['dot-dot back out of the roots', winUnc(join(HOME, 'proj', '..', '..', '..')), 403, 'outside_roots', 'roots'],
  ];

  it.each(refusals)('refuses %s with a reason code and the failing step', async (_l, input, status, reason, step) => {
    const res = await validate(input);
    expect(res.status).toBe(status);
    expect(res.body.success).toBe(false);
    expect(res.body.reason).toBe(reason);
    const steps = res.body.steps as Array<{ id: string; status: string }>;
    const failed = steps.findIndex((s) => s.status === 'failed');
    expect(steps[failed].id).toBe(step);
    expect(steps.slice(0, failed).every((s) => s.status === 'done')).toBe(true);
    expect(steps.slice(failed + 1).every((s) => s.status === 'pending')).toBe(true);
    // a refusal never carries a path, converted or real
    expect(JSON.stringify(res.body)).not.toContain(HOME);
    expect(res.body.data).toBeUndefined();
  });

  it('a drive path whose conversion fails is not_found at the convert step', async () => {
    drivePath = null;
    const res = await validate('Z:\\gone');
    expect(res.status).toBe(404);
    expect(res.body.reason).toBe('not_found');
    expect(res.body.steps.find((s: any) => s.status === 'failed').id).toBe('convert');
  });

  it('refuses C:\\Windows-style drive paths that land outside the roots', async () => {
    drivePath = '/usr/lib';
    const res = await validate('C:\\Windows');
    expect(res.body.reason).toBe('outside_roots');
  });

  it('rejects a non-string or missing body with a validation error, not a crash', async () => {
    for (const payload of [{}, { path: 5 }, { path: '' }, { path: 'x'.repeat(5000) }]) {
      const res = await app.inject({ method: 'POST', url: '/api/native-folder/validate', payload });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
  });
});

describe('info and default path', () => {
  it('reports the distro', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/native-folder/info' });
    expect(res.json()).toEqual({ success: true, data: { distro: DISTRO } });
  });

  it('spells a POSIX path for the dialog defaultPath', async () => {
    const get = async (path: string) =>
      (
        await app.inject({ method: 'GET', url: `/api/native-folder/windows-path?path=${encodeURIComponent(path)}` })
      ).json();
    expect((await get('/mnt/d/dev/x')).data.windowsPath).toBe('D:\\dev\\x');
    expect((await get('/home/dhkang/x')).data.windowsPath).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dhkang\\x');
    const bad = await app.inject({ method: 'GET', url: '/api/native-folder/windows-path?path=relative' });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  });
});

/**
 * Switchboard T6: `purpose: 'work-folder'` swaps the picker-roots step for the work-folder rules
 * (`validateWorkFolder`), so a folder on a drive that is not a picker root can be registered while the
 * dangerous places stay refused. The default purpose is unchanged (tests above).
 */
describe("purpose: 'work-folder'", () => {
  async function validateWork(path: unknown, fromDrive?: string) {
    drivePath = fromDrive ?? null;
    const res = await app.inject({
      method: 'POST',
      url: '/api/native-folder/validate',
      payload: { path, purpose: 'work-folder' },
    });
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  }

  it('accepts a folder below home exactly like the default purpose', async () => {
    const { status, body } = await validateWork(winUnc(join(HOME, 'proj')));
    expect(status).toBe(200);
    expect(body.data.wslPath).toBe(realpathSync(join(HOME, 'proj')));
    expect(body.data.steps.map((s: any) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('uses the work-folder rules, not the picker roots: the home directory itself is too broad', async () => {
    // the default purpose accepts it (Home is a picker root) ...
    expect((await validate(winUnc(HOME))).status).toBe(200);
    // ... a work folder may not be the whole home directory
    const { status, body } = await validateWork(winUnc(HOME));
    expect(status).toBe(400);
    expect(body.reason).toBe('too_broad');
    expect(body.steps.find((s: any) => s.status === 'failed').id).toBe('roots');
    expect(body.wslPath).toBeUndefined();
  });

  it('a folder outside home and outside any drive is outside_allowed (not outside_roots)', async () => {
    const { status, body } = await validateWork(winUnc(outsideDir));
    expect(status).toBe(403);
    expect(body.reason).toBe('outside_allowed');
    expect(body.steps.find((s: any) => s.status === 'failed').id).toBe('roots');
  });

  it('a symlink is resolved first: a link to an outside folder is outside_allowed, one to ~/.ssh is blocked', async () => {
    expect((await validateWork(winUnc(join(HOME, 'link-out')))).body.reason).toBe('outside_allowed');
    const blocked = await validateWork(winUnc(join(HOME, 'innocent-link')));
    expect(blocked.status).toBe(403);
    expect(blocked.body.reason).toBe('blocked');
    expect(blocked.body.steps.find((s: any) => s.status === 'failed').id).toBe('blocklist');
  });

  it('still refuses credential folders, files, missing paths, network paths and bad input', async () => {
    expect((await validateWork(winUnc(join(HOME, '.ssh')))).body.reason).toBe('blocked');
    expect((await validateWork(winUnc(join(HOME, '.config', 'gcloud')))).body.reason).toBe('blocked');
    expect((await validateWork(winUnc(join(HOME, 'a-file.txt')))).body.reason).toBe('not_directory');
    expect((await validateWork(winUnc(join(HOME, 'does-not-exist')))).body.reason).toBe('not_found');
    expect((await validateWork('\\\\server\\share\\x')).body.reason).toBe('network_path');
    expect((await validateWork('not a path')).body.reason).toBe('invalid_input');
    expect((await validateWork('-rf')).body.reason).toBe('invalid_input');
  });

  it('a drive folder on a drive that is not a picker root passes work-folder rules but not the default ones', async () => {
    // Needs a real /mnt/<letter>/<folder> that is not on D: (D: is itself a picker root); skipped where there is none.
    const drive = existsSync('/mnt')
      ? readdirSync('/mnt')
          .filter((d) => /^[a-ce-z]$/i.test(d))
          .flatMap((d) => {
            try {
              return readdirSync(`/mnt/${d}`, { withFileTypes: true })
                .filter(
                  (e) => e.isDirectory() && /^[A-Za-z0-9_-]+$/.test(e.name) && !/^(windows|program|\$)/i.test(e.name)
                )
                .slice(0, 1)
                .map((e) => `/mnt/${d}/${e.name}`);
            } catch {
              return [];
            }
          })[0]
      : undefined;
    if (!drive) return;
    drivePath = drive;
    const asDefault = await validate('E:\\x');
    expect(asDefault.body.reason).toBe('outside_roots');
    const asWork = await validateWork('E:\\x', drive);
    // allowed unless that particular folder is on the blocklist or unreadable on this PC
    expect(['outside_roots', 'outside_allowed', 'too_broad']).not.toContain(asWork.body.reason);
  });
});

describe("purpose: 'work-folder' in multi-user mode", () => {
  const savedMulti = process.env.CODEMAN_MULTIUSER;
  afterAll(() => {
    if (savedMulti === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMulti;
  });

  it('is admin-only; the default purpose is not affected', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const user = await createRouteTestHarness((a, ctx) => registerNativeFolderRoutes(a, ctx), {
      authUser: { username: 'bob', role: 'user' },
    });
    const admin = await createRouteTestHarness((a, ctx) => registerNativeFolderRoutes(a, ctx), {
      authUser: { username: 'root', role: 'admin' },
    });
    try {
      const payload = { path: winUnc(join(HOME, 'proj')), purpose: 'work-folder' };
      const denied = await user.app.inject({ method: 'POST', url: '/api/native-folder/validate', payload });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().wslPath ?? denied.json().data).toBeUndefined();
      const allowed = await admin.app.inject({ method: 'POST', url: '/api/native-folder/validate', payload });
      expect(allowed.statusCode).toBe(200);
    } finally {
      await user.app.close();
      await admin.app.close();
    }
  });
});
