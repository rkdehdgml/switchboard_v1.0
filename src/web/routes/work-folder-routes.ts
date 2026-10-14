/**
 * @fileoverview Work folders API (Switchboard T6). See work-folders.ts for the model and the trust notes.
 *
 *   GET    /api/work-folders             state: default case location + roots
 *   POST   /api/work-folders/roots       add a project search root        { path }
 *   DELETE /api/work-folders/roots       remove one (never the default)   ?path=
 *   PUT    /api/work-folders/base        default location for NEW cases   { path, existingCases: link|hide }
 *   GET    /api/work-folders/scan        projects under the roots         ?gitOnly=true|false
 *
 * Registering a discovered project reuses `POST /api/cases/link`; browsing reuses `/api/filesystem/browse`.
 * In multi-user mode all of it is admin-only: roots and the default location are host-wide.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { getCasesDir, getCasesDirSource, readConfiguredCasesDir } from '../../config/cases-dir.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { dataPath, getDataDir } from '../../config/instance.js';
import { readDockerCases } from '../../docker-hosts.js';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { getAuthUser, isAdmin, parseBody } from '../route-helpers.js';
import { WorkFolderBaseSchema, WorkFolderPathSchema, WorkFolderScanQuerySchema } from '../schemas.js';
import {
  MAX_PROJECT_ROOTS,
  isSlowMount,
  readProjectRoots,
  scanProjects,
  validateWorkFolder,
  writeWorkFolderSettings,
  type WorkFolderReason,
} from '../work-folders.js';

const REASON_STATUS: Record<WorkFolderReason, number> = {
  invalid_input: 400,
  not_found: 404,
  not_directory: 400,
  too_broad: 400,
  outside_allowed: 403,
  blocked: 403,
  not_writable: 403,
  duplicate: 409,
  is_default: 400,
  limit: 409,
};

const REASON_MESSAGE: Record<WorkFolderReason, string> = {
  invalid_input: 'This is not a usable folder path',
  not_found: 'This folder was not found',
  not_directory: 'This is not a folder',
  too_broad: 'This folder is too broad: choose a work folder, not a drive, the home directory or /',
  outside_allowed: 'Work folders must be inside the home directory or inside a folder on a Windows drive',
  blocked: 'Access to this folder is blocked',
  not_writable: 'This folder is not writable',
  duplicate: 'This folder is already a work folder',
  is_default: 'The default location cannot be removed',
  limit: `At most ${MAX_PROJECT_ROOTS} work folders can be registered`,
};

/** One scan per user at a time (a second one while the first runs is refused, not queued). */
const activeScans = new Set<string>();

function refuse(reply: { code: (n: number) => unknown }, reason: WorkFolderReason, extra: object = {}) {
  reply.code(REASON_STATUS[reason]);
  return { ...createErrorResponse(ApiErrorCode.INVALID_INPUT, REASON_MESSAGE[reason]), reason, ...extra };
}

function forbidden(req: FastifyRequest, reply: { code: (n: number) => unknown }) {
  if (!isMultiUserMode() || isAdmin(req)) return null;
  reply.code(403);
  return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Realpaths of every folder that is already a case: the linked ones and the folders in the cases directory. */
async function registeredCaseRealpaths(): Promise<Set<string>> {
  const out = new Set<string>();
  const add = async (path: string) => {
    try {
      out.add(await fs.realpath(path));
    } catch {
      /* a dangling link is not registered anything */
    }
  };
  try {
    const linked = JSON.parse(await fs.readFile(dataPath('linked-cases.json'), 'utf-8')) as Record<string, unknown>;
    for (const value of Object.values(linked)) if (typeof value === 'string') await add(value);
  } catch {
    /* none linked */
  }
  try {
    for (const entry of await fs.readdir(getCasesDir(), { withFileTypes: true })) {
      if (entry.isDirectory()) await add(join(getCasesDir(), entry.name));
    }
  } catch {
    /* cases directory not created yet */
  }
  return out;
}

/** "Keep as links": register every folder in the old cases directory, leaving it where it is. */
async function linkExistingCases(previousBase: string): Promise<{ linked: number; skipped: number }> {
  const file = dataPath('linked-cases.json');
  let linked: Record<string, string> = {};
  try {
    linked = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, string>;
  } catch {
    /* none yet */
  }
  let added = 0;
  let skipped = 0;
  let entries;
  try {
    entries = await fs.readdir(previousBase, { withFileTypes: true });
  } catch {
    return { linked: 0, skipped: 0 };
  }
  for (const entry of entries) {
    // Same name rule as POST /api/cases/link; hidden folders and anything that is not a real directory are not cases.
    if (
      !entry.isDirectory() ||
      entry.name.startsWith('.') ||
      !/^[a-zA-Z0-9_-]+$/.test(entry.name) ||
      linked[entry.name]
    ) {
      skipped++;
      continue;
    }
    linked[entry.name] = join(previousBase, entry.name);
    added++;
  }
  if (added > 0) {
    await fs.mkdir(getDataDir(), { recursive: true });
    await fs.writeFile(file, JSON.stringify(linked, null, 2));
  }
  return { linked: added, skipped };
}

export function registerWorkFolderRoutes(app: FastifyInstance): void {
  app.get('/api/work-folders', async (req, reply) => {
    const denied = forbidden(req, reply);
    if (denied) return denied;
    const active = getCasesDir();
    const source = getCasesDirSource();
    const configured = readConfiguredCasesDir();
    let dockerCaseCount = 0;
    try {
      dockerCaseCount = (await readDockerCases(getDataDir())).length;
    } catch {
      /* unreadable registry: the warning is only advice */
    }
    const roots = await Promise.all(
      readProjectRoots().map(async (path) => ({ path, slowMount: isSlowMount(path), exists: await exists(path) }))
    );
    return {
      success: true,
      data: {
        caseBase: {
          path: active,
          source,
          readOnly: source === 'env',
          slowMount: isSlowMount(active),
          exists: await exists(active),
          configured,
          pendingRestart: source !== 'env' && configured !== null && configured !== active,
        },
        roots,
        dockerCaseCount,
        maxRoots: MAX_PROJECT_ROOTS,
      },
    };
  });

  app.post('/api/work-folders/roots', async (req, reply) => {
    const denied = forbidden(req, reply);
    if (denied) return denied;
    const { path } = parseBody(WorkFolderPathSchema, req.body, 'Invalid request body');
    const checked = await validateWorkFolder(path);
    if (!checked.ok) return refuse(reply, checked.reason);
    const roots = readProjectRoots();
    if (checked.path === getCasesDir() || roots.includes(checked.path)) return refuse(reply, 'duplicate');
    if (roots.length >= MAX_PROJECT_ROOTS) return refuse(reply, 'limit');
    await writeWorkFolderSettings({ projectRoots: [...roots, checked.path] });
    return { success: true, data: { path: checked.path, slowMount: checked.slowMount } };
  });

  app.delete('/api/work-folders/roots', async (req, reply) => {
    const denied = forbidden(req, reply);
    if (denied) return denied;
    const { path } = parseBody(WorkFolderPathSchema, req.query, 'Invalid request');
    if (path === getCasesDir()) return refuse(reply, 'is_default');
    const roots = readProjectRoots();
    if (!roots.includes(path)) return refuse(reply, 'not_found');
    await writeWorkFolderSettings({ projectRoots: roots.filter((root) => root !== path) });
    return { success: true, data: { path } };
  });

  app.put('/api/work-folders/base', async (req, reply) => {
    const denied = forbidden(req, reply);
    if (denied) return denied;
    if (getCasesDirSource() === 'env') {
      reply.code(409);
      return {
        ...createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'The default location is fixed by the CODEMAN_CASES_PATH environment variable'
        ),
        reason: 'env_locked',
      };
    }
    const { path, existingCases } = parseBody(WorkFolderBaseSchema, req.body, 'Invalid request body');
    const checked = await validateWorkFolder(path, { requireWritable: true });
    if (!checked.ok) return refuse(reply, checked.reason);

    // Existing cases are never moved or deleted: they are linked where they are, or just left out of the list.
    const previous = getCasesDir();
    const result = existingCases === 'link' && checked.path !== previous ? await linkExistingCases(previous) : null;
    await writeWorkFolderSettings({ caseBaseDir: checked.path });
    return {
      success: true,
      data: {
        path: checked.path,
        // Applied by the next start: getCasesDir() is read once, Docker bind mounts and running tmux sessions keep the old path.
        appliesAfterRestart: checked.path !== previous,
        existingCases,
        linked: result?.linked ?? 0,
        skipped: result?.skipped ?? 0,
      },
    };
  });

  app.get('/api/work-folders/scan', async (req, reply) => {
    const denied = forbidden(req, reply);
    if (denied) return denied;
    const { gitOnly } = parseBody(WorkFolderScanQuerySchema, req.query, 'Invalid request');
    const user = isMultiUserMode() ? getAuthUser(req).username : '@single';
    if (activeScans.has(user)) {
      reply.code(429);
      return {
        ...createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'A scan is already running'),
        reason: 'scan_in_progress',
      };
    }
    activeScans.add(user);
    const abort = new AbortController();
    // A client that goes away mid-scan must not leave it hanging on a slow mount.
    const onClose = () => {
      if (!reply.raw.writableFinished) abort.abort();
    };
    reply.raw.on('close', onClose);
    try {
      const base = getCasesDir();
      const roots = [...((await exists(base)) ? [await fs.realpath(base)] : []), ...readProjectRoots()];
      const result = await scanProjects({
        roots: [...new Set(roots)],
        gitOnly: gitOnly !== 'false',
        registered: await registeredCaseRealpaths(),
        signal: abort.signal,
      });
      return { success: true, data: result };
    } finally {
      reply.raw.off('close', onClose);
      activeScans.delete(user);
    }
  });
}
