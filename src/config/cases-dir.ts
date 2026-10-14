/**
 * @fileoverview Where case (project) folders live.
 *
 * Deliberately NOT instance-scoped, unlike `dataPath()`: `~/codeman-cases` is
 * shared by every Codeman on the machine, the same way `~/codeman-users/<u>`
 * user spaces are, so a beta instance sees the same projects as prod.
 *
 * `CODEMAN_CASES_PATH` overrides the location. Docker Compose deployments set
 * it to a host-absolute bind mount so a Docker case's workspace resolves to the
 * SAME absolute path inside Codeman and on the host daemon that mounts it.
 *
 * ⚠️ **One resolver, every caller.** This started life as three hardcoded
 * `join(homedir(), 'codeman-cases')` copies. When only the web server's copy
 * learned the override, `codeman skill install --case <name>` still looked in
 * the home default and reported "Case not found" on exactly the deployment the
 * override exists for. A new cases-dir consumer imports this; it does not
 * rebuild the path.
 *
 * (`state-store.ts` keeps its own literal on purpose: that one migrates the
 * historical `~/claudeman-cases` directory to `~/codeman-cases` by name, and is
 * about the old default location rather than the active one.)
 *
 * @module config/cases-dir
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { dataPath } from './instance.js';

/** Read the saved default case location (settings.json `caseBaseDir`); null when unset or unusable. */
export function readConfiguredCasesDir(): string | null {
  try {
    const value = (JSON.parse(readFileSync(dataPath('settings.json'), 'utf-8')) as { caseBaseDir?: unknown })
      .caseBaseDir;
    return typeof value === 'string' && isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The saved location AS IT WAS WHEN THE PROCESS STARTED (Switchboard T6). It is read once, on
 * first use, and never again: changing the default case location takes effect after a restart,
 * because Docker cases need the host bind mount at the same absolute path and running tmux
 * sessions keep their cwd. `undefined` = not read yet.
 */
let startupCasesDir: string | null | undefined;
function savedCasesDirAtStartup(): string | null {
  if (startupCasesDir === undefined) startupCasesDir = readConfiguredCasesDir();
  return startupCasesDir;
}

/** Where the active cases directory comes from: the env var wins, then the saved setting, then the default. */
export function getCasesDirSource(): 'env' | 'setting' | 'default' {
  if (process.env.CODEMAN_CASES_PATH) return 'env';
  return savedCasesDirAtStartup() ? 'setting' : 'default';
}

/** Absolute path to the shared cases directory. */
export function getCasesDir(): string {
  return process.env.CODEMAN_CASES_PATH || savedCasesDirAtStartup() || join(homedir(), 'codeman-cases');
}

/** Absolute path to one case folder inside it. */
export function casePath(name: string): string {
  return join(getCasesDir(), name);
}
