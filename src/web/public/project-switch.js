// src/web/public/project-switch.js

/**
 * @fileoverview Per-session project switch (Switchboard T8): the project chip in a split panel's header.
 *
 * A running session's working folder cannot move: the agent is already running inside it, and Claude
 * Code keeps the conversation per folder. So "switching" always means starting a session in the chosen
 * folder, and this module is about saying that out loud before anything happens:
 *   - ended session   -> switch at once (nothing to lose): open in the folder, close the dead one;
 *   - live session    -> a confirmation with two choices, "New session" (recommended, the old session
 *                        and its conversation stay) or "Restart this session" (the new session is opened
 *                        FIRST and the old one is closed only after that worked). Cancel changes nothing.
 * The conversation never follows the folder (a resumed session would point at paths that no longer
 * exist), and the copy never softens that.
 *
 * ⚠️ Every dynamic string goes through textContent (paths come from the file system).
 * ⚠️ Folders come from the native dialog (server-validated), from folders that already hold a session,
 * or from this device's own recent list; the server still re-checks the folder when it is linked/started.
 * ⚠️ Only Claude sessions are handled: other CLI modes keep their own launch settings, so the chip says so
 * instead of starting something half-configured.
 *
 * @globals {object} CodemanProjectSwitch
 * @dependency i18n.js (CodemanI18n.t), optional; native-folder.js (CodemanFolderPicker), optional;
 *   app.js / session-ui.js (session helpers, closeSession); terminal-split.js (_splitAssignSession)
 * @loadorder 11.96 of 16 — after work-folders.js, before session-ui.js
 */

(function (global) {
  'use strict';

  const RECENT_KEY = 'codeman-recent-projects';
  const RECENT_STORED = 10;
  const RECENT_SHOWN = 5;
  const t = (s) => global.CodemanI18n?.t?.(s) ?? s;

  // ── pure helpers (unit-tested) ─────────────────────────────────────────────────────────────────

  const trimSlash = (p) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p);
  const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && trimSlash(a) === trimSlash(b);
  const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);
  const parentOf = (p) => {
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join('/')}` : '/';
  };

  /**
   * Is the agent still running? `pid === null` means no PTY; a dead pane (`paneExit` label) or a stopped/errored
   * state means the process is gone. ⚠️ A live-looking session whose pane state is unknown counts as LIVE:
   * asking once too often is cheap, closing a conversation silently is not.
   */
  function isSessionLive(session, state, exitLabel) {
    if (!session || session.pid === null || session.pid === undefined) return false;
    if (exitLabel) return false;
    return state !== 'done' && state !== 'error';
  }

  /** Work in progress or a prompt waiting for an answer: the restart copy mentions the interruption. */
  const isBusyState = (state) => state === 'working' || state === 'needs';

  /** Case names are `[a-zA-Z0-9_-]+`; fold the folder name into one that is not taken. */
  function caseNameFor(folder, taken) {
    const base = (
      baseName(folder)
        .replace(/[^a-zA-Z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'project'
    ).slice(0, 60);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    return name;
  }

  function readStoredRecent() {
    try {
      const raw = JSON.parse(global.localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(raw)
        ? raw.filter((e) => e && typeof e.path === 'string' && e.path.startsWith('/') && Number.isFinite(e.at))
        : [];
    } catch (_e) {
      return [];
    }
  }

  function noteRecent(folder, now = Date.now()) {
    try {
      const next = [{ path: folder, at: now }, ...readStoredRecent().filter((e) => !samePath(e.path, folder))];
      global.localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, RECENT_STORED)));
    } catch (_e) {
      /* private mode: the list is only a convenience */
    }
  }

  /**
   * Recent projects: this device's own switches plus every folder that already holds a session (its last
   * activity as the time). Newest first, the current folder left out. Per device, not synced.
   */
  function recentProjects(sessions, current, stored = readStoredRecent()) {
    const latest = new Map();
    const add = (path, at) => {
      if (typeof path !== 'string' || !path.startsWith('/') || samePath(path, current)) return;
      const key = trimSlash(path);
      if ((latest.get(key)?.at ?? -1) < at) latest.set(key, { path: key, at });
    };
    for (const e of stored) add(e.path, e.at);
    for (const session of sessions?.values?.() ?? []) {
      add(session.workingDir, Number(session.lastActivityAt || session.createdAt) || 0);
    }
    return [...latest.values()].sort((a, b) => b.at - a.at).slice(0, RECENT_SHOWN);
  }

  function relativeTime(at, now = Date.now()) {
    if (!Number.isFinite(at) || at <= 0) return '';
    try {
      const rtf = new Intl.RelativeTimeFormat(global.document?.documentElement?.lang || 'en', { numeric: 'auto' });
      const seconds = Math.round((at - now) / 1000);
      const steps = [
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
      ];
      for (const [unit, size] of steps) {
        if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
      }
      return rtf.format(0, 'second');
    } catch (_e) {
      return '';
    }
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = global.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const b = el('button', className, t(label));
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  const toast = (app, message, kind) => app?.showToast?.(message, kind);

  async function api(method, url, body) {
    try {
      const res = await global.fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return await res.json();
    } catch (_e) {
      return { success: false, error: 'The server did not answer. Try again.' };
    }
  }

  // ── starting a session in a folder ─────────────────────────────────────────────────────────────

  /** The case that points at `folder`: an existing one, or a new link (nothing is moved or copied). */
  async function ensureCase(folder) {
    const res = await api('GET', '/api/cases');
    const cases = Array.isArray(res?.data) ? res.data : [];
    const found = cases.find((c) => c && samePath(c.path, folder));
    if (found) return { name: found.name, path: found.path };
    const taken = new Set(cases.map((c) => c?.name).filter(Boolean));
    let name = caseNameFor(folder, taken);
    let linked = await api('POST', '/api/cases/link', { name, path: folder });
    // Only a name clash is worth another try; anything else is a real refusal.
    for (let n = 2; !linked?.success && /already exists/i.test(linked?.error || '') && n < 6; n++) {
      taken.add(name);
      name = caseNameFor(folder, taken);
      linked = await api('POST', '/api/cases/link', { name, path: folder });
    }
    if (!linked?.success) throw new Error(linked?.error || 'Something went wrong');
    return { name, path: folder };
  }

  /**
   * A Claude session in `folder`, started the same way as Run does for a local case (same model, effort,
   * env and Ralph settings). Resolves to the new session id. A half-started session is closed again by exact id.
   */
  async function startClaudeSession(app, folder) {
    const target = await ensureCase(folder);
    const caseName = target.name;
    const name = `w${app._nextCaseSessionStartNumber(caseName)}-${caseName}`;
    const caseSettings = app.getCaseSettings(caseName);
    const globalSettings = app.loadAppSettingsFromStorage();
    const envOverrides = app.buildEnvOverrides(caseSettings, globalSettings);
    const effort = app.getEffortSetting(globalSettings);
    const useOpus1m = caseSettings.opusContext1m || globalSettings.opusContext1mEnabled;
    const modelOverride = globalSettings.claudeModel || (useOpus1m ? 'opus[1m]' : '');

    const created = await api('POST', '/api/sessions', {
      workingDir: target.path,
      name,
      ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
      ...(effort ? { effort } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
    });
    if (!created?.success) throw new Error(created?.error || 'Something went wrong');
    const session = created.data.session;
    try {
      await app._ensureCreatedSessionVisible(session.id, session);
      const ralphEnabled = app.isRalphTrackerEnabledByDefault();
      await api('POST', `/api/sessions/${session.id}/ralph-config`, {
        enabled: ralphEnabled,
        disableAutoEnable: !ralphEnabled,
      });
      const started = await api('POST', `/api/sessions/${session.id}/interactive`);
      if (started && started.success === false) throw new Error(started.error || 'Something went wrong');
    } catch (err) {
      await api('DELETE', `/api/sessions/${encodeURIComponent(session.id)}?killMux=true`);
      throw err;
    }
    return session.id;
  }

  /** Show `sessionId` in the panel `key` (Pane A is the active session; the others live in the split tree). */
  function showInPanel(app, key, sessionId) {
    if (app._splitTree && key !== undefined && key !== null) app._splitAssignSession(key, sessionId);
    else app.selectSession?.(sessionId);
  }

  // ── the confirmation ───────────────────────────────────────────────────────────────────────────

  /** Resolves 'new', 'restart' or 'cancel'. Nothing changes until one of the first two is chosen. */
  function confirmSwitch({ fromFolder, toFolder, busy }) {
    const opener = global.document.activeElement;
    return new Promise((resolve) => {
      const backdrop = el('div', 'folder-pick-modal');
      const box = el('div', 'folder-pick-box psw-confirm');
      box.setAttribute('role', 'alertdialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'pswConfirmTitle');
      const title = el('h2', 'folder-pick-title', t('Switch project'));
      title.id = 'pswConfirmTitle';
      box.append(title);
      box.append(
        el(
          'p',
          'folder-pick-body',
          t(
            'Switching the project starts a new conversation. The current conversation is not moved to the other folder.'
          )
        )
      );
      const paths = el('div', 'psw-paths');
      for (const [label, value] of [
        ['Current folder', fromFolder],
        ['New folder', toFolder],
      ]) {
        const row = el('div', 'psw-path-row');
        row.append(el('span', 'psw-path-label', t(label)), el('code', 'psw-path', value));
        paths.append(row);
      }
      box.append(paths);

      const choose = (value) => () => done(value);
      const fresh = button('New session (recommended)', 'btn-toolbar btn-primary psw-primary', choose('new'));
      fresh.id = 'pswNewSession';
      const restart = button('Restart this session', 'btn-toolbar', choose('restart'));
      restart.id = 'pswRestart';
      const options = el('div', 'psw-options');
      const freshBox = el('div', 'psw-option');
      freshBox.append(
        fresh,
        el(
          'p',
          'psw-option-note',
          t(
            'The current session and its conversation stay as they are. You can return to it from the rail at any time.'
          )
        )
      );
      const restartBox = el('div', 'psw-option');
      restartBox.append(
        restart,
        el(
          'p',
          'psw-option-note',
          t(
            busy
              ? "Work in progress is interrupted and this session's conversation is closed on screen. The history file stays under the original project folder."
              : "This session's conversation is closed on screen. The history file stays under the original project folder."
          )
        )
      );
      options.append(freshBox, restartBox);
      box.append(options);
      const actions = el('div', 'folder-pick-actions');
      const cancel = button('Cancel', 'btn-toolbar', choose('cancel'));
      actions.append(cancel);
      box.append(actions);
      backdrop.append(box);

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          done('cancel');
        } else if (e.key === 'Tab') {
          const items = [...box.querySelectorAll('button:not([disabled])')];
          const at = items.indexOf(global.document.activeElement);
          const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
          e.preventDefault();
          items[next]?.focus();
        }
      };
      function done(value) {
        global.document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        try {
          opener?.focus?.();
        } catch (_e) {
          /* the opener may be gone */
        }
        resolve(value);
      }
      global.document.addEventListener('keydown', onKey, true);
      global.document.body.append(backdrop);
      fresh.focus();
    });
  }

  // ── the switch itself ──────────────────────────────────────────────────────────────────────────

  let inFlight = false;

  /**
   * Switch the project of the session in panel `key` to `folder`.
   * @returns {Promise<'switched'|'cancelled'|'failed'|'unchanged'|'busy'>}
   */
  async function switchProject(app, key, sessionId, folder) {
    const session = app.sessions?.get(sessionId);
    if (!session) return 'failed';
    // One switch at a time, confirmation included: a second dialog on top of the first would be a second question.
    if (inFlight) return 'busy';
    if (samePath(session.workingDir, folder)) return 'unchanged';
    inFlight = true;
    try {
      const state = app._mobileOverviewState?.(session, app.pendingHooks?.get?.(sessionId));
      const exitLabel = typeof global.paneExitLabel === 'function' ? global.paneExitLabel(session.paneExit) : '';
      const live = isSessionLive(session, state, exitLabel);

      let mode = 'restart'; // an ended session has nothing to lose: replace it
      if (live) {
        mode = await confirmSwitch({ fromFolder: session.workingDir, toFolder: folder, busy: isBusyState(state) });
        if (mode === 'cancel') return 'cancelled';
      }

      const newId = await startClaudeSession(app, folder);
      noteRecent(folder);
      showInPanel(app, key, newId);
      // The old session goes only after the new one is up, and only when the user chose to restart (or it was dead).
      if (mode === 'restart') await app.closeSession(sessionId, true);
      toast(app, t(mode === 'restart' ? 'Project switched' : 'New session started'), 'success');
      return 'switched';
    } catch (err) {
      toast(app, `${t('Could not switch the project')}: ${t(err?.message || 'Something went wrong')}`, 'error');
      return 'failed';
    } finally {
      inFlight = false;
    }
  }

  // ── the popover ────────────────────────────────────────────────────────────────────────────────

  let dismissOpen = null;

  /**
   * Open the popover under `anchor`. `ctx.app` is the app, `ctx.key` the panel, `ctx.sessionId` its session.
   * Only Claude sessions can switch; for anything else the popover shows the current folder and says why.
   */
  function open(event, anchor, ctx) {
    event?.stopPropagation?.();
    dismissOpen?.();
    const { app, key, sessionId } = ctx;
    const session = app.sessions?.get(sessionId);
    if (!session) return;
    const supported = session.mode === 'claude';
    const opener = anchor;

    const pop = el('div', 'psw-pop');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', t('Change the project of this session'));

    pop.append(el('div', 'psw-heading', t("This session's project")));
    const current = el('code', 'psw-current', session.workingDir || '');
    current.setAttribute('data-i18n-skip', '');
    pop.append(current);

    const choose = async (folder) => {
      close();
      await switchProject(app, key, sessionId, folder);
    };

    if (supported) {
      pop.append(el('div', 'psw-heading', t('Recent projects')));
      const recents = recentProjects(app.sessions, session.workingDir);
      if (recents.length === 0) pop.append(el('p', 'psw-empty', t('No recent projects')));
      for (const entry of recents) {
        const row = el('button', 'psw-recent');
        row.type = 'button';
        row.setAttribute('data-i18n-skip', '');
        row.append(el('span', 'psw-recent-name', baseName(entry.path)));
        row.append(el('span', 'psw-recent-parent', parentOf(entry.path)));
        const when = relativeTime(entry.at);
        if (when) row.append(el('span', 'psw-recent-when', when));
        row.title = entry.path;
        row.addEventListener('click', () => choose(entry.path));
        pop.append(row);
      }
      const browse = button('Browse for a folder…', 'psw-browse', async () => {
        close();
        const folder = await pickFolder(session.workingDir);
        if (folder) await switchProject(app, key, sessionId, folder);
      });
      browse.id = 'pswBrowse';
      pop.append(browse);
      pop.append(
        el(
          'p',
          'psw-warn',
          t(
            'Switching the project starts a new conversation. The current conversation is not moved to the other folder.'
          )
        )
      );
    } else {
      pop.append(el('p', 'psw-warn', t('Only Claude sessions can switch projects.')));
    }

    global.document.body.append(pop);
    const rect = anchor.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.left = `${Math.max(8, Math.min(rect.left, global.innerWidth - pop.offsetWidth - 8))}px`;

    const onOutside = (e) => {
      if (pop.contains(e.target) || e.target.closest?.('.psw-trigger')) return;
      close();
    };
    const onEscape = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
      try {
        opener?.focus?.();
      } catch (_e) {
        /* the opener may be gone */
      }
    };
    function close() {
      global.document.removeEventListener('click', onOutside);
      global.document.removeEventListener('keydown', onEscape);
      pop.remove();
      if (dismissOpen === close) dismissOpen = null;
    }
    dismissOpen = close;
    global.setTimeout(() => global.document.addEventListener('click', onOutside), 0);
    global.document.addEventListener('keydown', onEscape);
    (pop.querySelector('.psw-recent') || pop.querySelector('.psw-browse'))?.focus?.();
  }

  /** Native folder dialog in the app (server-validated), the HTML picker in a plain browser. */
  async function pickFolder(current) {
    if (global.CodemanFolderPicker?.isAvailable()) {
      const result = await global.CodemanFolderPicker.choose({
        title: 'Select project folder',
        defaultPath: typeof current === 'string' && current.startsWith('/') ? current : undefined,
      });
      if (result.status === 'ok') return result.wslPath;
      if (result.status === 'error') toast(global.app, result.message, 'error');
      return null; // cancelled / rejected: the rejection already explained itself
    }
    if (global.PathPicker) {
      return new Promise((resolve) => {
        global.PathPicker.open({
          title: 'Select Existing Project Folder',
          initialPath: current || '',
          directoriesOnly: true,
          onSelect: (path) => resolve(path),
        });
      });
    }
    return null;
  }

  global.CodemanProjectSwitch = {
    open,
    switchProject,
    // pure helpers, exported for the tests
    isSessionLive,
    isBusyState,
    caseNameFor,
    recentProjects,
    noteRecent,
    relativeTime,
    samePath,
  };
})(window);
