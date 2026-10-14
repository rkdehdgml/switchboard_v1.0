/**
 * @fileoverview Work folders (Switchboard T6): two different settings that must not be mixed up.
 *
 *  1. the default location for NEW cases (`caseBaseDir`, one value, applied after a restart), and
 *  2. the project search roots (`projectRoots`, many, applied at once): where existing folders are
 *     looked for and registered from, and, since T7, the extra places the folder dialogs may choose in.
 *
 * Both live in settings.json but are written ONLY by `routes/work-folder-routes.ts` (the generic
 * settings PUT is `.strict()` and does not declare them), because every value has to pass
 * {@link validateWorkFolder} first. ⚠️ A root widens what the file picker, the native folder dialog
 * and the project scan may read, so this is a trust boundary: `/`, the home directory itself, a
 * whole drive and anything in the credential blocklist are refused; a Windows drive is registered one
 * work folder at a time (`/mnt/d/dev`), never as `/mnt/d`.
 *
 * ⚠️ The scan is a NEW browse surface (see the last paragraph of sensitive-path.ts): it never follows
 * symlinks (`Dirent`, not `stat`), skips hidden and heavy directories, stops at a result cap or a time
 * cap and reports which, and drops every entry the blocklist would refuse.
 */

import { promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { dataPath } from '../config/instance.js';
import { isBlockedAttachmentPath, isUnderTree, loadAttachmentGuardConfig } from '../config/attachment-guard.js';
import { isSensitivePath } from './sensitive-path.js';

export type WorkFolderReason =
  | 'invalid_input'
  | 'not_found'
  | 'not_directory'
  | 'too_broad'
  | 'outside_allowed'
  | 'blocked'
  | 'not_writable'
  | 'duplicate'
  | 'is_default'
  | 'limit';

export const MAX_PROJECT_ROOTS = 20;
export const MAX_WORK_FOLDER_PATH = 4096;

export type WorkFolderCheck = { ok: true; path: string; slowMount: boolean } | { ok: false; reason: WorkFolderReason };

/** `/mnt/<drive>/...` is a Windows drive over 9P: it works, but listing it is slow. */
export function isSlowMount(path: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(path);
}

const PROBE = '__codeman_work_folder_probe__';

/** The directory itself is caught only through a child probe (the blocklist matches file-style patterns). */
async function isBlocked(resolvedPath: string): Promise<boolean> {
  if (isSensitivePath(resolvedPath) || isSensitivePath(join(resolvedPath, PROBE))) return true;
  const guard = await loadAttachmentGuardConfig();
  // A blocked tree that swallows the home directory (`/root` when running as root) must not block everything.
  const trees = guard.blockedTrees.filter((tree) => !isUnderTree(homedir(), tree));
  return isBlockedAttachmentPath(resolvedPath, trees) || isBlockedAttachmentPath(join(resolvedPath, PROBE), trees);
}

/**
 * Where a (realpath'd) folder sits relative to what may be registered. `too_broad`: `/`, a parent of the home
 * directory or the home directory itself, `/mnt` and a whole drive. `home`: below the home directory.
 * `drive_folder`: at least one folder below a Windows drive (`/mnt/d/dev`). Everything else is `outside`.
 */
export function classifyWorkFolderZone(real: string, home: string): 'too_broad' | 'home' | 'drive_folder' | 'outside' {
  const isAncestorOrSelfOfHome = home === real || home.startsWith(real.endsWith(sep) ? real : real + sep);
  if (real === '/' || isAncestorOrSelfOfHome || /^\/mnt(\/[a-z])?\/?$/i.test(real)) return 'too_broad';
  if (real.startsWith(home + sep)) return 'home';
  return /^\/mnt\/[a-z]\/[^/]+/i.test(real) ? 'drive_folder' : 'outside';
}

/**
 * Is this a folder that may become a work folder?
 * Order: form -> exists -> a directory -> not too broad -> inside the allowed zone -> blocklist -> (optionally) writable.
 * The allowed zone is the home directory plus ONE level or more below a Windows drive mount: that is the
 * "administrator registers the mount, per work folder" rule, and in single-user mode the user is the administrator.
 */
export async function validateWorkFolder(
  input: unknown,
  options: { requireWritable?: boolean } = {}
): Promise<WorkFolderCheck> {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid_input' };
  const raw = input.trim();
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (raw === '' || raw.length > MAX_WORK_FOLDER_PATH || /[\u0000-\u001f\u007f]/.test(raw) || !isAbsolute(raw)) {
    return { ok: false, reason: 'invalid_input' };
  }
  let real: string;
  try {
    real = await fs.realpath(resolve(raw));
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  try {
    if (!(await fs.stat(real)).isDirectory()) return { ok: false, reason: 'not_directory' };
  } catch {
    return { ok: false, reason: 'not_found' };
  }

  const zone = classifyWorkFolderZone(real, homedir());
  if (zone === 'too_broad') return { ok: false, reason: 'too_broad' };
  if (zone === 'outside') return { ok: false, reason: 'outside_allowed' };
  if (await isBlocked(real)) return { ok: false, reason: 'blocked' };

  if (options.requireWritable) {
    try {
      await fs.access(real, 2 /* W_OK */);
    } catch {
      return { ok: false, reason: 'not_writable' };
    }
  }
  return { ok: true, path: real, slowMount: isSlowMount(real) };
}

// ── settings.json (read-modify-write, like PUT /api/settings; unknown keys are preserved) ─────────

export function settingsFile(): string {
  return dataPath('settings.json');
}

function readSettingsSync(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Registered project roots; anything not an absolute string is dropped. Never throws. */
export function readProjectRoots(): string[] {
  const value = readSettingsSync().projectRoots;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && isAbsolute(v)).slice(0, MAX_PROJECT_ROOTS);
}

export async function writeWorkFolderSettings(patch: { caseBaseDir?: string; projectRoots?: string[] }): Promise<void> {
  const file = settingsFile();
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>;
  } catch {
    /* no file yet */
  }
  await fs.mkdir(join(file, '..'), { recursive: true });
  // tmp + rename: a crash mid-write must never leave a half-written settings.json (it holds every setting).
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ ...existing, ...patch }, null, 2));
  await fs.rename(tmp, file);
}

// ── project scan ───────────────────────────────────────────────────────────────────────────────

/** Directories a project scan never enters: dependency and build output. */
export const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  'venv',
  'target',
  'build',
  'dist',
  'out',
  'coverage',
  '__pycache__',
  'vendor',
  'bin',
  'obj',
]);

export interface DiscoveredProject {
  name: string;
  path: string;
  rootPath: string;
  isGit: boolean;
  branch: string | null;
  mtimeMs: number | null;
  registered: boolean;
}

export interface ScanResult {
  projects: DiscoveredProject[];
  truncated: boolean;
  reason?: 'limit' | 'timeout';
}

export interface ScanOptions {
  roots: string[];
  gitOnly: boolean;
  /** Realpaths that are already registered as cases. */
  registered: ReadonlySet<string>;
  signal?: AbortSignal;
  maxResults?: number;
  timeoutMs?: number;
  maxDepth?: number;
  now?: () => number;
}

/** Branch name, or a short hash for a detached HEAD; null when it cannot be read. Never follows more than one gitdir pointer. */
export async function readGitBranch(dir: string): Promise<string | null> {
  try {
    const dotGit = join(dir, '.git');
    const stat = await fs.lstat(dotGit);
    let gitDir = dotGit;
    if (stat.isFile()) {
      // worktrees and submodules: `.git` is a file holding `gitdir: <path>`
      const pointer = /^gitdir:\s*(.+)$/m.exec((await readHead(dotGit)) ?? '');
      if (!pointer) return null;
      gitDir = resolve(dir, pointer[1].trim());
    } else if (!stat.isDirectory()) {
      return null;
    }
    const head = (await readHead(join(gitDir, 'HEAD')))?.trim();
    if (!head) return null;
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}

async function readHead(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    return buffer.subarray(0, bytesRead).toString('utf-8');
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Walk each root to `maxDepth` (default 2), collecting projects. A directory with a `.git` entry (directory OR
 * file) is a project and is not descended into. Symlinks are never followed; hidden and heavy directories are
 * skipped; every result is checked against the blocklist. Stops at `maxResults` or `timeoutMs` and says which.
 */
export async function scanProjects(options: ScanOptions): Promise<ScanResult> {
  const maxResults = options.maxResults ?? 200;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxDepth = options.maxDepth ?? 2;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const projects: DiscoveredProject[] = [];
  const seen = new Set<string>();
  let reason: 'limit' | 'timeout' | undefined;

  const stop = (): boolean => {
    if (options.signal?.aborted) return true;
    if (now() > deadline) {
      reason ??= 'timeout';
      return true;
    }
    if (projects.length >= maxResults) {
      reason ??= 'limit';
      return true;
    }
    return false;
  };

  const isGitProject = async (dir: string): Promise<boolean> => {
    try {
      const st = await fs.lstat(join(dir, '.git'));
      return st.isDirectory() || st.isFile();
    } catch {
      return false;
    }
  };

  const consider = async (dir: string, rootPath: string, isGit: boolean): Promise<void> => {
    if (seen.has(dir) || (options.gitOnly && !isGit)) return;
    seen.add(dir);
    if (await isBlocked(dir)) return;
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await fs.stat(dir)).mtimeMs;
    } catch {
      /* listed anyway */
    }
    projects.push({
      name: dir.split(sep).filter(Boolean).pop() ?? dir,
      path: dir,
      rootPath,
      isGit,
      branch: isGit ? await readGitBranch(dir) : null,
      mtimeMs,
      registered: options.registered.has(dir),
    });
  };

  const walk = async (dir: string, rootPath: string, depth: number): Promise<void> => {
    if (stop()) return;
    const isGit = await isGitProject(dir);
    // The root itself counts when it is a repository; plain folders start at depth 1.
    if (depth > 0 || isGit) await consider(dir, rootPath, isGit);
    if (isGit || depth >= maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (stop()) return;
      // Dirent never follows a link: a symlinked directory is neither isDirectory() nor entered.
      if (!entry.isDirectory() || entry.name.startsWith('.') || SCAN_SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), rootPath, depth + 1);
    }
  };

  for (const root of options.roots) {
    if (stop()) break;
    await walk(root, root, 0);
  }
  return reason ? { projects, truncated: true, reason } : { projects, truncated: false };
}
