/**
 * @fileoverview Native folder dialog support (Switchboard T7).
 *
 * The desktop shell opens Windows' own folder dialog; this module is the ONLY authority on what
 * it returned. A native dialog can choose `C:\Windows`, `\\server\share` or another WSL distro,
 * so every selection goes: input form -> wslpath -> realpath -> allowed roots -> blocklist.
 * The first failure is reported as a stable reason code (never a bare 403) so the UI can say
 * what to do next. Roots and blocklist are the path picker's own (`checkPickerFolder`), so the
 * two surfaces cannot drift apart, and multi-user scoping comes with them.
 *
 * Endpoints:
 *   GET  /api/native-folder/info          -> { distro }            (to build \\wsl.localhost\<distro> paths)
 *   GET  /api/native-folder/windows-path  -> { windowsPath }       (a POSIX path as the dialog's defaultPath)
 *   POST /api/native-folder/validate      -> { wslPath, windowsPath, steps } | refusal with `reason`
 *                                            body `purpose: 'work-folder'` (T6) swaps the picker-roots step for the
 *                                            work-folder zone rules of `validateWorkFolder()` (admin-only in multi-user mode)
 *
 * @dependency routes/file-routes.ts (checkPickerFolder), native-folder.ts (pure conversion)
 */

import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import type { ConfigPort, SessionPort } from '../ports/index.js';
import { NativeFolderValidateSchema, NativeFolderWindowsPathQuerySchema } from '../schemas.js';
import { isAdmin, parseBody } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { validateWorkFolder, type WorkFolderReason } from '../work-folders.js';
import {
  parseWindowsFolderInput,
  posixToWindowsPath,
  runWslpath,
  toPosixPath,
  type NativeFolderReason,
  type WslPathRunner,
} from '../native-folder.js';
import { checkPickerFolder } from './file-routes.js';

export type NativeFolderStep = 'input' | 'convert' | 'realpath' | 'roots' | 'blocklist';
const STEP_ORDER: readonly NativeFolderStep[] = ['input', 'convert', 'realpath', 'roots', 'blocklist'];

export interface NativeFolderStepState {
  id: NativeFolderStep;
  status: 'done' | 'failed' | 'pending';
}

/** Steps as the UI shows them: everything before `failedAt` done, `failedAt` failed, the rest pending. */
export function stepStates(failedAt?: NativeFolderStep): NativeFolderStepState[] {
  const failedIndex = failedAt ? STEP_ORDER.indexOf(failedAt) : STEP_ORDER.length;
  return STEP_ORDER.map((id, index) => ({
    id,
    status: index < failedIndex ? 'done' : index === failedIndex ? 'failed' : 'pending',
  }));
}

const REASON_STATUS: Record<NativeFolderReason, number> = {
  invalid_input: 400,
  network_path: 400,
  other_distro: 400,
  not_directory: 400,
  not_found: 404,
  outside_roots: 403,
  blocked: 403,
  too_broad: 400,
  outside_allowed: 403,
};

/** One short line per reason. The UI shows its own translated text; this is for logs and API clients. */
const REASON_MESSAGE: Record<NativeFolderReason, string> = {
  invalid_input: 'This is not a usable Windows folder path',
  network_path: 'Network locations cannot be used',
  other_distro: 'This folder is in a different WSL distribution',
  not_found: 'This folder was not found',
  outside_roots: 'This folder is outside the allowed work folders',
  blocked: 'Access to this folder is blocked',
  not_directory: 'This is not a folder',
  too_broad: 'This folder is too broad: choose a work folder, not a drive, the home directory or /',
  outside_allowed: 'Work folders must be inside the home directory or inside a folder on a Windows drive',
};

/**
 * Work-folder purpose (T6): which step each `validateWorkFolder()` refusal belongs to. The zone rules
 * take the place of the picker-roots step, so the list still shows the same five checks.
 */
function workFolderRefusal(reason: WorkFolderReason): { reason: NativeFolderReason; step: NativeFolderStep } {
  switch (reason) {
    case 'not_found':
      return { reason, step: 'realpath' };
    case 'not_directory':
    case 'blocked':
      return { reason, step: 'blocklist' };
    case 'too_broad':
      return { reason, step: 'roots' };
    case 'outside_allowed':
      return { reason, step: 'roots' };
    default:
      // invalid_input and anything that cannot come from a plain validation
      return { reason: 'invalid_input', step: 'input' };
  }
}

/** The WSL distribution this server runs in; undefined outside WSL. */
function currentDistro(): string | undefined {
  const name = process.env.WSL_DISTRO_NAME?.trim();
  return name ? name : undefined;
}

export function registerNativeFolderRoutes(
  app: FastifyInstance,
  ctx: SessionPort & ConfigPort,
  convert: WslPathRunner = runWslpath
): void {
  app.get('/api/native-folder/info', async () => ({ success: true, data: { distro: currentDistro() ?? null } }));

  app.get('/api/native-folder/windows-path', async (req) => {
    const { path } = parseBody(NativeFolderWindowsPathQuerySchema, req.query);
    return { success: true, data: { windowsPath: posixToWindowsPath(resolve(path), currentDistro()) } };
  });

  app.post('/api/native-folder/validate', async (req, reply) => {
    const { path: selected, purpose } = parseBody(NativeFolderValidateSchema, req.body);
    const distro = currentDistro();

    const refuse = (reason: NativeFolderReason, failedAt: NativeFolderStep) => {
      reply.code(REASON_STATUS[reason]);
      return {
        ...createErrorResponse(ApiErrorCode.INVALID_INPUT, REASON_MESSAGE[reason]),
        reason,
        steps: stepStates(failedAt),
      };
    };

    const parsed = parseWindowsFolderInput(selected, distro);
    if (!parsed.ok) return refuse(parsed.reason, 'input');

    const posix = await toPosixPath(parsed, convert);
    if (posix === null) return refuse('not_found', 'convert');

    if (purpose === 'work-folder') {
      // Registering a work folder is host-wide (it widens the picker roots): admin-only in multi-user mode, like /api/work-folders.
      if (isMultiUserMode() && !isAdmin(req)) {
        reply.code(403);
        return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
      }
      const work = await validateWorkFolder(resolve(posix));
      if (!work.ok) {
        const refusal = workFolderRefusal(work.reason);
        return refuse(refusal.reason, refusal.step);
      }
      return {
        success: true,
        data: {
          wslPath: work.path,
          windowsPath: posixToWindowsPath(work.path, distro),
          selectedPath: selected.trim(),
          symlinkResolved: work.path !== resolve(posix),
          steps: stepStates(),
        },
      };
    }

    const checked = await checkPickerFolder(ctx, req, resolve(posix));
    if (!checked.ok) return refuse(checked.reason, checked.step);

    return {
      success: true,
      data: {
        wslPath: checked.resolvedPath,
        windowsPath: posixToWindowsPath(checked.resolvedPath, distro),
        // The dialog's own answer, so a symlinked selection can be shown as resolved.
        selectedPath: selected.trim(),
        symlinkResolved: checked.resolvedPath !== resolve(posix),
        steps: stepStates(),
      },
    };
  });
}
