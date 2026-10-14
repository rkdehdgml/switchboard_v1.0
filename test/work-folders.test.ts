/**
 * @fileoverview Switchboard T6: work-folder validation, settings I/O and the project scan, on real
 * directory trees (HOME is a per-file temp dir, test/setup.ts). The scan is a new browse surface, so
 * symlink loops, hidden and heavy directories, the blocklist and both caps are all exercised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  classifyWorkFolderZone,
  isSlowMount,
  readGitBranch,
  readProjectRoots,
  scanProjects,
  settingsFile,
  validateWorkFolder,
  writeWorkFolderSettings,
} from '../src/web/work-folders.js';

const HOME = homedir();
const mk = (...parts: string[]) => {
  const p = join(...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const git = (dir: string, head = 'ref: refs/heads/main\n') => {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), head);
  return dir;
};

describe('classifyWorkFolderZone', () => {
  const home = '/home/dev';
  it.each([
    ['/', 'too_broad'],
    ['/home', 'too_broad'],
    ['/home/dev', 'too_broad'],
    ['/mnt', 'too_broad'],
    ['/mnt/d', 'too_broad'],
    ['/mnt/d/', 'too_broad'],
    ['/mnt/C', 'too_broad'],
    ['/home/dev/projects', 'home'],
    ['/home/dev/projects/a/b', 'home'],
    ['/mnt/d/dev', 'drive_folder'],
    ['/mnt/d/dev/eclipse-workspace', 'drive_folder'],
    ['/mnt/c/dev', 'drive_folder'],
    ['/home/devious', 'outside'],
    ['/usr/lib', 'outside'],
    ['/srv/app', 'outside'],
    ['/mnt/dd/x', 'outside'],
    ['/mnt/wsl/x', 'outside'],
  ])('%s is %s', (path, expected) => {
    expect(classifyWorkFolderZone(path, home)).toBe(expected);
  });

  it('knows slow mounts', () => {
    expect(isSlowMount('/mnt/d/dev')).toBe(true);
    expect(isSlowMount('/mnt/D')).toBe(true);
    expect(isSlowMount('/home/dev')).toBe(false);
    expect(isSlowMount('/mnt/dd/x')).toBe(false);
  });
});

describe('validateWorkFolder', () => {
  let outside: string;
  beforeAll(() => {
    outside = mkdtempSync(join(tmpdir(), 'sbwf-out-'));
    mk(HOME, 'proj', 'sub');
    mk(HOME, '.ssh', 'keys');
    mk(HOME, 'credentials');
    writeFileSync(join(HOME, 'a-file'), 'x');
    symlinkSync(join(HOME, 'proj'), join(HOME, 'link-in'));
    symlinkSync(outside, join(HOME, 'link-out'));
    symlinkSync(join(HOME, '.ssh'), join(HOME, 'link-ssh'));
  });
  afterAll(() => rmSync(outside, { recursive: true, force: true }));

  it('accepts a folder under home and returns its real path', async () => {
    expect(await validateWorkFolder(join(HOME, 'proj'))).toMatchObject({ ok: true, slowMount: false });
    const viaLink = await validateWorkFolder(join(HOME, 'link-in'));
    expect(viaLink).toMatchObject({ ok: true });
    expect((viaLink as { path: string }).path).toBe(join(realHome(), 'proj'));
  });

  it.each<[string, unknown, string]>([
    ['a number', 5, 'invalid_input'],
    ['null', null, 'invalid_input'],
    ['empty', '  ', 'invalid_input'],
    ['relative', 'proj', 'invalid_input'],
    ['a control character', `${HOME}/pr\noj`, 'invalid_input'],
    ['NUL', `${HOME}/pro\0j`, 'invalid_input'],
    ['too long', '/' + 'a'.repeat(5000), 'invalid_input'],
    ['missing', join(HOME, 'nope'), 'not_found'],
    ['a file', join(HOME, 'a-file'), 'not_directory'],
    ['the root', '/', 'too_broad'],
    ['the home directory itself', HOME, 'too_broad'],
    ['a parent of home', dirname(HOME), 'too_broad'],
    ['outside home and drives', '/usr/lib', 'outside_allowed'],
    ['a link out of home', join(HOME, 'link-out'), 'outside_allowed'],
    ['a folder inside ~/.ssh', join(HOME, '.ssh', 'keys'), 'blocked'],
    ['~/.ssh itself', join(HOME, '.ssh'), 'blocked'],
    ['a link to ~/.ssh', join(HOME, 'link-ssh'), 'blocked'],
    ['a folder named credentials', join(HOME, 'credentials'), 'blocked'],
  ])('refuses %s as %s', async (_label, input, reason) => {
    expect(await validateWorkFolder(input)).toEqual({ ok: false, reason });
  });

  it.runIf(existsSync('/mnt/d'))('refuses a whole Windows drive', async () => {
    expect(await validateWorkFolder('/mnt/d')).toEqual({ ok: false, reason: 'too_broad' });
    expect(await validateWorkFolder('/mnt')).toEqual({ ok: false, reason: 'too_broad' });
  });

  it.runIf(existsSync('/mnt/c/Windows'))('refuses the Windows directory', async () => {
    const result = await validateWorkFolder('/mnt/c/Windows');
    expect(result.ok).toBe(false);
  });

  it.runIf(process.getuid?.() !== 0)('can require a writable folder', async () => {
    const ro = mk(HOME, 'readonly');
    chmodSync(ro, 0o555);
    try {
      expect(await validateWorkFolder(ro, { requireWritable: true })).toEqual({ ok: false, reason: 'not_writable' });
      expect(await validateWorkFolder(ro)).toMatchObject({ ok: true });
    } finally {
      chmodSync(ro, 0o755);
    }
  });
});

function realHome(): string {
  return require('node:fs').realpathSync(HOME);
}

describe('settings.json', () => {
  it('keeps unknown keys and only returns usable roots', async () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify({ theme: 'x', projectRoots: ['/a', 5, 'rel', null, '/b'] }));
    expect(readProjectRoots()).toEqual(['/a', '/b']);
    await writeWorkFolderSettings({ projectRoots: ['/c'] });
    const saved = JSON.parse(readFileSync(settingsFile(), 'utf-8'));
    expect(saved).toEqual({ theme: 'x', projectRoots: ['/c'] });
    await writeWorkFolderSettings({ caseBaseDir: '/d' });
    expect(JSON.parse(readFileSync(settingsFile(), 'utf-8'))).toEqual({
      theme: 'x',
      projectRoots: ['/c'],
      caseBaseDir: '/d',
    });
  });

  it('survives a missing or corrupt file', async () => {
    rmSync(settingsFile(), { force: true });
    expect(readProjectRoots()).toEqual([]);
    writeFileSync(settingsFile(), '{not json');
    expect(readProjectRoots()).toEqual([]);
    await writeWorkFolderSettings({ projectRoots: ['/x'] });
    expect(readProjectRoots()).toEqual(['/x']);
    rmSync(settingsFile(), { force: true });
  });
});

describe('readGitBranch', () => {
  it('reads a branch, a detached hash, a worktree pointer, and gives up quietly otherwise', async () => {
    const root = mk(HOME, 'branches');
    expect(await readGitBranch(git(mk(root, 'a'), 'ref: refs/heads/feature/x\n'))).toBe('feature/x');
    expect(await readGitBranch(git(mk(root, 'b'), '0123456789abcdef0123456789abcdef01234567\n'))).toBe('0123456');
    // a worktree/submodule: `.git` is a FILE pointing at the real git dir
    const real = mk(root, 'real-git');
    writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/wt\n');
    const wt = mk(root, 'wt');
    writeFileSync(join(wt, '.git'), `gitdir: ${real}\n`);
    expect(await readGitBranch(wt)).toBe('wt');
    expect(await readGitBranch(mk(root, 'none'))).toBeNull();
    expect(await readGitBranch(git(mk(root, 'junk'), 'garbage'))).toBeNull();
    const dangling = mk(root, 'dangling');
    writeFileSync(join(dangling, '.git'), 'gitdir: /nonexistent/x\n');
    expect(await readGitBranch(dangling)).toBeNull();
    writeFileSync(join(mk(root, 'nopointer'), '.git'), 'hello');
    expect(await readGitBranch(join(root, 'nopointer'))).toBeNull();
  });
});

describe('scanProjects', () => {
  let root: string;
  beforeAll(() => {
    root = mk(HOME, 'scanroot');
    git(mk(root, 'a'), 'ref: refs/heads/main\n');
    // worktree-style .git FILE
    const real = mk(root, 'gitdirs', 'b');
    writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/wt\n');
    writeFileSync(join(mk(root, 'b'), '.git'), `gitdir: ${real}\n`);
    git(mk(root, 'c', 'd'));
    mk(root, 'c', 'plain-sibling');
    git(mk(root, 'e', 'f', 'g')); // depth 3: out of reach
    mk(root, 'plain');
    git(mk(root, 'node_modules', 'pkg')); // heavy
    git(mk(root, 'dist', 'x'));
    git(mk(root, '.hidden', 'h')); // hidden
    git(mk(root, 'credentials')); // folder the blocklist refuses
    git(mk(root, 'a', 'nested')); // inside a project: never entered
    symlinkSync(join(root, 'a'), join(root, 'link-to-a'));
    symlinkSync(root, join(root, 'loop'));
    symlinkSync(mk(HOME, 'outside-target'), join(root, 'link-out'));
    git(join(HOME, 'outside-target', 'secret-proj')); // reachable ONLY through a symlink
  });

  const names = (projects: { path: string }[]) => projects.map((p) => p.path.slice(root.length + 1)).sort();
  const run = (extra: object = {}) => scanProjects({ roots: [root], gitOnly: true, registered: new Set(), ...extra });

  it('finds git projects to depth 2, with .git as a directory or a file', async () => {
    const { projects, truncated } = await run();
    expect(truncated).toBe(false);
    expect(names(projects)).toEqual(['a', 'b', 'c/d']);
    const a = projects.find((p) => p.path.endsWith('/a'))!;
    expect(a).toMatchObject({ isGit: true, branch: 'main', registered: false, rootPath: root });
    expect(typeof a.mtimeMs).toBe('number');
    expect(projects.find((p) => p.path.endsWith('/b'))!.branch).toBe('wt');
  });

  it('never follows symlinks, enters projects, hidden or heavy directories, or lists blocked folders', async () => {
    const all = names((await run({ gitOnly: false })).projects);
    expect(all).toEqual(['a', 'b', 'c', 'c/d', 'c/plain-sibling', 'e', 'e/f', 'gitdirs', 'gitdirs/b', 'plain']);
    for (const bad of [
      'link-to-a',
      'loop',
      'link-out',
      'node_modules',
      'dist',
      '.hidden',
      'credentials',
      'a/nested',
      'e/f/g',
    ]) {
      expect(all).not.toContain(bad);
    }
    expect(JSON.stringify(all)).not.toContain('secret-proj');
  });

  it('marks what is already registered, by real path', async () => {
    const { projects } = await run({ registered: new Set([join(root, 'a')]) });
    expect(projects.map((p) => [p.path.slice(root.length + 1), p.registered])).toEqual([
      ['a', true],
      ['b', false],
      ['c/d', false],
    ]);
  });

  it('counts the root itself when it is a repository', async () => {
    const single = git(mk(HOME, 'single-root'));
    const { projects } = await scanProjects({ roots: [single], gitOnly: true, registered: new Set() });
    expect(projects.map((p) => p.path)).toEqual([single]);
  });

  it('stops at the result cap and says so', async () => {
    const result = await run({ gitOnly: false, maxResults: 3 });
    expect(result).toMatchObject({ truncated: true, reason: 'limit' });
    expect(result.projects).toHaveLength(3);
  });

  it('stops at the time cap and says so, keeping what it found', async () => {
    let clock = 0;
    const result = await run({ gitOnly: false, timeoutMs: 5, now: () => (clock += 3) });
    expect(result).toMatchObject({ truncated: true, reason: 'timeout' });
    expect(result.projects.length).toBeLessThan(10);
  });

  it('stops quietly when the client goes away', async () => {
    const abort = new AbortController();
    abort.abort();
    const result = await run({ signal: abort.signal });
    expect(result).toEqual({ projects: [], truncated: false });
  });

  it('survives a root that is not there', async () => {
    const result = await scanProjects({ roots: [join(HOME, 'gone')], gitOnly: true, registered: new Set() });
    expect(result).toEqual({ projects: [], truncated: false });
  });

  it('does not list the same folder twice when roots overlap', async () => {
    const { projects } = await scanProjects({ roots: [root, join(root, 'c')], gitOnly: true, registered: new Set() });
    expect(projects.filter((p) => p.path.endsWith('/c/d'))).toHaveLength(1);
  });
});
