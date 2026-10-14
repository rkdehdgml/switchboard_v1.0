// src/web/public/native-folder.js

/**
 * @fileoverview Native Windows folder dialog (Switchboard T7).
 *
 * In the desktop shell, "Browse" opens Windows' own folder dialog (Tauri `dialog` plugin) instead of an
 * HTML file tree. A native dialog can pick ANYTHING (`C:\Windows`, `\\server\share`, another WSL distro),
 * so the string it returns is only a request: the server (`/api/native-folder/validate`) converts it,
 * resolves links, checks the allowed work folders and the security blocklist, and answers with the real
 * WSL path or a stable reason code. This module owns the three pieces the user sees: the dialog call, the
 * checking list (only when the check is slow) and the rejection dialog that says what to do next.
 *
 * ⚠️ Every dynamic string goes through textContent, never markup (paths come from the file system).
 * ⚠️ A cancelled dialog is silent: no request, no toast, no error. Outside the desktop shell there is no
 * `__TAURI_INTERNALS__`; callers fall back to the HTML path picker, `choose()` just reports `unavailable`.
 *
 * @globals {object} CodemanFolderPicker
 * @dependency i18n.js (CodemanI18n.t), optional; styles.css (.folder-pick-*)
 * @loadorder 11.9 of 16 — loaded right before session-ui.js, which calls it from the Add Case "Browse" button
 */

(function (global) {
  'use strict';

  /** Checks shorter than this never flash a progress list. */
  const SLOW_MS = 300;
  const LAST_KEY = 'codeman-last-folder';
  const STEPS = [
    ['input', 'Input format'],
    ['convert', 'Path conversion'],
    ['realpath', 'Real path'],
    ['roots', 'Allowed work folder'],
    ['blocklist', 'Security block list'],
  ];
  /** Reason code -> [title, explanation, action]. The server's codes are stable API. */
  const REASONS = {
    outside_roots: [
      'This folder is outside the allowed work folders',
      'Add the root first under Settings › Work folders.',
      'workfolders',
    ],
    blocked: [
      'This folder is blocked for security',
      'Locations that hold credentials cannot be chosen. For example ~/.ssh.',
      null,
    ],
    other_distro: ['This is a different WSL distribution', 'Choose a folder inside this WSL distribution.', null],
    network_path: ['Network locations cannot be used', 'Choose a local folder instead of \\\\server\\share.', null],
    not_found: [
      'This folder was not found',
      'It may have been moved or deleted, or its drive is not available in WSL.',
      null,
    ],
    not_directory: ['This is not a folder', 'Choose a folder, not a file.', null],
    too_broad: ['This folder is too broad', 'Choose a work folder, not a drive, the home directory or /.', null],
    outside_allowed: [
      'This folder cannot be a work folder',
      'Work folders must be inside the home directory or inside a folder on a Windows drive.',
      null,
    ],
    invalid_input: [
      'This path cannot be used',
      'The dialog returned a path in a form Switchboard does not accept.',
      null,
    ],
  };
  const FALLBACK_REASON = ['Could not check the folder', 'The server did not answer. Try again.', null];

  const t = (s) => global.CodemanI18n?.t?.(s) ?? s;

  function bridge() {
    const invoke = global.__TAURI_INTERNALS__?.invoke;
    return typeof invoke === 'function' ? invoke : null;
  }

  function el(tag, className, text) {
    const node = global.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const LOCK_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

  /** One `<li>` per check. State is spelled in words as well as marks (never colour alone). */
  function stepList(steps, checking) {
    const list = el('ol', 'folder-pick-steps');
    for (const [id, label] of STEPS) {
      const state = checking ? 'checking' : (steps?.find((s) => s.id === id)?.status ?? 'pending');
      const word = { done: 'Done', failed: 'Failed', pending: 'Waiting', checking: '' }[state];
      const item = el('li', 'folder-pick-step');
      item.dataset.state = state;
      const mark = el('span', 'folder-pick-step-mark', { done: '✓', failed: '✕', pending: '○', checking: '●' }[state]);
      mark.setAttribute('aria-hidden', 'true');
      item.append(mark, el('span', 'folder-pick-step-label', label));
      if (word) item.append(el('span', 'folder-pick-step-state', word));
      list.append(item);
    }
    return list;
  }

  function overlay(role, labelledBy) {
    const backdrop = el('div', 'folder-pick-modal');
    const box = el('div', 'folder-pick-box');
    box.setAttribute('role', role);
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', labelledBy);
    backdrop.append(box);
    return { backdrop, box };
  }

  /** The "checking…" list; shown only if the server takes longer than SLOW_MS. Returns a closer. */
  function showProgress() {
    let shown = null;
    const timer = global.setTimeout(() => {
      const { backdrop, box } = overlay('status', 'folderPickProgressTitle');
      const title = el('h2', 'folder-pick-title', t('Checking the folder…'));
      title.id = 'folderPickProgressTitle';
      box.append(title, stepList(null, true));
      global.document.body.append(backdrop);
      shown = backdrop;
    }, SLOW_MS);
    return () => {
      global.clearTimeout(timer);
      shown?.remove();
    };
  }

  /** Rejection dialog. Resolves with the action taken ('close' or 'workfolders'). */
  function showRejection({ reason, steps, selected, message }) {
    const [titleText, bodyText, action] = REASONS[reason] ?? (message ? [message, '', null] : FALLBACK_REASON);
    const opener = global.document.activeElement;
    return new Promise((resolve) => {
      const { backdrop, box } = overlay('alertdialog', 'folderPickRejectTitle');
      box.classList.add('is-rejected');

      const head = el('div', 'folder-pick-head');
      const lock = el('span', 'folder-pick-lock');
      lock.innerHTML = LOCK_SVG; // constant markup, no dynamic value
      const title = el('h2', 'folder-pick-title', t(titleText));
      title.id = 'folderPickRejectTitle';
      head.append(lock, title);
      box.append(head);
      if (bodyText) box.append(el('p', 'folder-pick-body', t(bodyText)));
      if (selected) {
        const path = el('div', 'folder-pick-path is-rejected');
        path.append(el('code', '', selected));
        box.append(path);
      }
      if (steps) box.append(stepList(steps, false));

      const buttons = el('div', 'folder-pick-actions');
      let actionButton = null;
      // Offer the shortcut only where the Work folders settings section exists.
      if (action === 'workfolders' && global.document.getElementById('settings-workfolders')) {
        actionButton = el('button', 'btn btn-primary', t('Open work folder settings'));
        actionButton.type = 'button';
        actionButton.addEventListener('click', () => done('workfolders'));
        buttons.append(actionButton);
      }
      const close = el('button', 'btn', t('Close'));
      close.type = 'button';
      close.addEventListener('click', () => done('close'));
      buttons.append(close);
      box.append(buttons);

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          done('close');
        } else if (e.key === 'Tab') {
          // Two buttons at most: keep focus inside the dialog.
          const items = [...box.querySelectorAll('button')];
          const at = items.indexOf(global.document.activeElement);
          const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
          e.preventDefault();
          items[next]?.focus();
        }
      };
      function done(result) {
        global.document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        try {
          opener?.focus?.();
        } catch (_e) {
          /* the opener may be gone */
        }
        resolve(result);
      }
      global.document.addEventListener('keydown', onKey, true);
      global.document.body.append(backdrop);
      (actionButton ?? close).focus();
    });
  }

  function remember(wslPath) {
    try {
      global.localStorage.setItem(LAST_KEY, wslPath);
    } catch (_e) {
      /* private mode: only the convenience is lost */
    }
  }

  function lastChosen() {
    try {
      return global.localStorage.getItem(LAST_KEY) || '';
    } catch (_e) {
      return '';
    }
  }

  async function windowsDefault(posixPath) {
    if (typeof posixPath !== 'string' || !posixPath.startsWith('/')) return undefined;
    try {
      const res = await global.fetch(`/api/native-folder/windows-path?path=${encodeURIComponent(posixPath)}`);
      const body = await res.json();
      return body?.success ? (body.data?.windowsPath ?? undefined) : undefined;
    } catch (_e) {
      return undefined; // the dialog just opens at its own default
    }
  }

  async function validate(path, purpose) {
    const res = await global.fetch('/api/native-folder/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(purpose ? { path, purpose } : { path }),
    });
    return res.json();
  }

  const CodemanFolderPicker = {
    STEPS,
    SLOW_MS,
    REASONS,
    FALLBACK_REASON,

    /** True inside the desktop shell, where the native dialog exists. */
    isAvailable() {
      return bridge() !== null;
    },

    lastChosen,

    /**
     * Open the dialog and validate the choice.
     * @param {{title?: string, defaultPath?: string, purpose?: 'work-folder'}} [options] `defaultPath` is a WSL (POSIX) path;
     *   `purpose: 'work-folder'` (Settings › Work folders) asks the server to apply the work-folder rules instead of the picker roots
     * @returns {Promise<{status:'unavailable'}|{status:'cancelled'}|{status:'error',message:string}
     *   |{status:'rejected',reason:string,steps:object[]}
     *   |{status:'ok',wslPath:string,windowsPath:string|null,selectedPath:string,symlinkResolved:boolean}>}
     */
    async choose(options = {}) {
      const invoke = bridge();
      if (!invoke) return { status: 'unavailable' };

      const defaultPath = await windowsDefault(options.defaultPath || lastChosen());
      let selected;
      try {
        selected = await invoke('plugin:dialog|open', {
          options: {
            directory: true,
            multiple: false,
            title: t(options.title || 'Select project folder'),
            defaultPath,
          },
        });
      } catch (err) {
        return { status: 'error', message: String(err?.message ?? err) };
      }
      // Cancel is not an error: nothing happens, nothing is shown.
      if (typeof selected !== 'string' || selected === '') return { status: 'cancelled' };

      const closeProgress = showProgress();
      let body;
      try {
        body = await validate(selected, options.purpose);
      } catch (err) {
        closeProgress();
        await showRejection({ reason: 'server_unreachable', selected });
        return { status: 'error', message: String(err?.message ?? err) };
      }
      closeProgress();

      if (body?.success) {
        remember(body.data.wslPath);
        return { status: 'ok', ...body.data };
      }
      const action = await showRejection({ reason: body?.reason, steps: body?.steps, selected, message: body?.error });
      return { status: 'rejected', reason: body?.reason ?? 'unknown', steps: body?.steps ?? [], action };
    },

    /** Show the WSL and Windows spelling of one folder side by side, so it reads as one place. */
    renderPathPair(container, result) {
      container.replaceChildren();
      if (!result || result.status !== 'ok') {
        container.hidden = true;
        return;
      }
      const row = (label, value) => {
        const line = el('div', 'folder-pair-row');
        line.append(el('span', 'folder-pair-label', t(label)), el('code', 'folder-pair-path', value));
        container.append(line);
      };
      row('WSL path', result.wslPath);
      if (result.windowsPath) row('Windows path', result.windowsPath);
      if (result.symlinkResolved) container.append(el('div', 'folder-pair-note', t('Resolved from a link')));
      container.hidden = false;
    },
  };

  global.CodemanFolderPicker = CodemanFolderPicker;
})(window);
