/**
 * @fileoverview Windows folder path -> WSL path, for the native folder dialog (Switchboard T7).
 *
 * The desktop shell opens Windows' own folder dialog and posts whatever string it returns. A
 * native dialog can pick ANYTHING (`C:\Windows`, `\\server\share`, another WSL distro), so this
 * module only does the cheap, pure half of the job: reject malformed input, classify it, and turn
 * it into a POSIX path. Every authorization decision (realpath, allowed roots, blocklist) happens
 * afterwards in the route, on the converted path; nothing here grants access.
 *
 * ⚠️ `wslpath` is called with an argument ARRAY and never through a shell, and only after the
 * input has been shown to start with a drive letter, so it can never be read as an option.
 */

import { execFile } from 'node:child_process';

/** Why a selection was refused. Stable: the UI maps each to a message and a way forward. */
export type NativeFolderReason =
  | 'invalid_input'
  | 'network_path'
  | 'other_distro'
  | 'not_found'
  | 'outside_roots'
  | 'blocked'
  | 'not_directory'
  // work-folder purpose only (validateWorkFolder's zone rules, see routes/native-folder-routes.ts)
  | 'too_broad'
  | 'outside_allowed';

export const NATIVE_FOLDER_MAX_PATH = 4096;

export type ParsedWindowsFolder =
  | { ok: true; kind: 'drive'; value: string }
  | { ok: true; kind: 'wsl'; value: string }
  | { ok: false; reason: NativeFolderReason };

// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Classify a path string from the dialog. `distro` is the current WSL distribution
 * (`WSL_DISTRO_NAME`); a `\\wsl.localhost\<other>\...` path is refused when it differs.
 */
export function parseWindowsFolderInput(raw: unknown, distro: string | undefined): ParsedWindowsFolder {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_input' };
  const input = raw.trim();
  if (input === '' || input.length > NATIVE_FOLDER_MAX_PATH) return { ok: false, reason: 'invalid_input' };
  if (CONTROL_CHARS.test(input) || input.includes('\u2028') || input.includes('\u2029')) {
    return { ok: false, reason: 'invalid_input' };
  }
  // An option-looking string must never reach a subprocess, whatever follows.
  if (input.startsWith('-')) return { ok: false, reason: 'invalid_input' };

  let path = input;
  // `\\?\C:\x` (extended-length) is the same place as `C:\x`; `\\?\UNC\srv\share` is a network path.
  if (/^\\\\[?.]\\UNC\\/i.test(path)) return { ok: false, reason: 'network_path' };
  if (/^\\\\[?.]\\/.test(path)) path = path.slice(4);

  // `//server/share` is how some APIs spell a UNC path.
  const unc = /^[\\/]{2}[^\\/]/.test(path);
  if (unc) {
    const parts = path.replace(/\//g, '\\').replace(/^\\\\/, '').split('\\').filter(Boolean);
    const host = (parts[0] ?? '').toLowerCase();
    if (host === 'wsl.localhost' || host === 'wsl$') {
      const target = parts[1];
      if (!target) return { ok: false, reason: 'invalid_input' };
      if (!distro || target.toLowerCase() !== distro.toLowerCase()) return { ok: false, reason: 'other_distro' };
      return { ok: true, kind: 'wsl', value: '/' + parts.slice(2).join('/') };
    }
    return { ok: false, reason: 'network_path' };
  }

  if (/^[A-Za-z]:([\\/]|$)/.test(path)) return { ok: true, kind: 'drive', value: path };
  return { ok: false, reason: 'invalid_input' };
}

/** Runs `wslpath -u <path>`. Injected in tests. Resolves to the converted path or null. */
export type WslPathRunner = (windowsPath: string) => Promise<string | null>;

export const runWslpath: WslPathRunner = (windowsPath) =>
  new Promise((resolve) => {
    execFile(
      'wslpath',
      ['-u', windowsPath],
      { timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const out = String(stdout).replace(/\r?\n$/, '');
        // Absolute, one line: anything else is not a path we can use.
        resolve(out.startsWith('/') && !CONTROL_CHARS.test(out) ? out : null);
      }
    );
  });

/**
 * POSIX path for a parsed selection, or null when a drive path cannot be converted
 * (no `wslpath`, or it refused the string).
 */
export async function toPosixPath(
  parsed: ParsedWindowsFolder,
  convert: WslPathRunner = runWslpath
): Promise<string | null> {
  if (!parsed.ok) return null;
  if (parsed.kind === 'wsl') return parsed.value;
  return convert(parsed.value);
}

/**
 * The Windows spelling of a POSIX path, for showing next to it ("/mnt/d/dev" and "D:\dev"
 * must read as the same place). `/mnt/<drive>/...` becomes a drive path; anything else is
 * reached through the distribution's UNC share. Null when that needs a distro and there is none.
 */
export function posixToWindowsPath(posix: string, distro: string | undefined): string | null {
  const drive = /^\/mnt\/([a-z])(\/.*)?$/i.exec(posix);
  if (drive) {
    const rest = (drive[2] ?? '').replace(/\//g, '\\');
    return `${drive[1].toUpperCase()}:${rest === '' ? '\\' : rest}`;
  }
  if (!distro) return null;
  return `\\\\wsl.localhost\\${distro}${posix === '/' ? '' : posix.replace(/\//g, '\\')}`;
}
