// src/web/public/work-folders.js

/**
 * @fileoverview Settings › Work folders (Switchboard T6).
 *
 * Two different settings share this screen: (1) the default location for NEW cases (one path, applied
 * after a restart) and (2) the project search roots (many paths, only a list). The server owns every
 * rule (`/api/work-folders*`, work-folders.ts); this module only draws the state, asks the server, and
 * says in words what happened. Discovered projects are registered through the existing
 * `POST /api/cases/link`, so nothing is moved or copied.
 *
 * ⚠️ Every dynamic string goes through textContent, never markup (paths and branch names come from disk).
 * ⚠️ Changing the default location never moves or deletes existing cases: the dialog only asks whether
 * they stay listed (link) or are left out (hide).
 *
 * @globals {object} CodemanWorkFolders
 * @dependency i18n.js (CodemanI18n.t), optional; native-folder.js (CodemanFolderPicker), optional;
 *   keyboard-accessory.js (PathPicker, the browser fallback); styles.css (.wf-*, .folder-pick-*)
 * @loadorder 11.95 of 16 — after native-folder.js, before session-ui.js
 */

(function (global) {
  'use strict';

  const ROOT_ID = 'workFoldersRoot';
  const t = (s) => global.CodemanI18n?.t?.(s) ?? s;
  const state = { data: null, scan: null, selected: new Set(), gitOnly: true, busy: '' };

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

  function toast(message, kind) {
    global.app?.showToast?.(message, kind);
  }

  /** The server always answers JSON, but a dead server must not leave the screen stuck. */
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

  const failure = (res) => t(res?.error || 'Something went wrong');

  function badge(text, kind) {
    return el('span', `wf-badge${kind ? ` wf-badge-${kind}` : ''}`, t(text));
  }

  const FOLDER_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

  function rootRow(path, info) {
    const row = el('li', 'wf-row');
    const icon = el('span', 'wf-row-icon');
    icon.innerHTML = FOLDER_SVG; // constant markup
    const main = el('div', 'wf-row-main');
    main.append(el('code', 'wf-path', path));
    const meta = el('div', 'wf-row-meta');
    if (info.isDefault) meta.append(badge('Default', 'default'));
    if (info.isDefault && info.source === 'env') meta.append(badge('Fixed by environment variable'));
    if (info.slowMount) meta.append(badge('Slow mount', 'wait'));
    if (info.exists === false) meta.append(badge('Folder not found', 'blocked'));
    if (meta.childNodes.length) main.append(meta);
    row.append(icon, main);
    return { row, actions: row.appendChild(el('div', 'wf-row-actions')) };
  }

  function renderRoots(root) {
    const { caseBase, roots, maxRoots } = state.data;
    const head = el('div', 'wf-head');
    head.append(el('h3', 'wf-title', t('Project search roots')));
    const add = button('Browse', 'btn-toolbar btn-sm', addRootByBrowsing);
    add.id = 'workFoldersBrowse';
    head.append(add);
    root.append(head);
    root.append(
      el('p', 'wf-note', t('Roots are only searched for projects. Nothing is moved when you add or remove one.'))
    );

    const list = el('ul', 'wf-list');
    const base = rootRow(caseBase.path, {
      isDefault: true,
      source: caseBase.source,
      slowMount: caseBase.slowMount,
      exists: caseBase.exists,
    });
    const change = button('Change default location', 'btn-toolbar btn-sm', openBaseDialog);
    change.id = 'workFoldersChangeBase';
    if (caseBase.readOnly) change.disabled = true;
    base.actions.append(change);
    list.append(base.row);
    for (const entry of roots) {
      const item = rootRow(entry.path, { slowMount: entry.slowMount, exists: entry.exists });
      const remove = button('Remove', 'btn-toolbar btn-sm', () => removeRoot(entry.path));
      remove.setAttribute('aria-label', `${t('Remove')}: ${entry.path}`);
      item.actions.append(remove);
      list.append(item.row);
    }
    root.append(list);
    if (caseBase.pendingRestart) {
      const note = el('p', 'wf-note wf-note-wait');
      note.textContent = `${t('The new default location applies after the next restart')}: ${caseBase.configured}`;
      root.append(note);
    }
    if (roots.length >= maxRoots)
      root.append(el('p', 'wf-note', t('The maximum number of work folders is registered.')));
  }

  function formatWhen(ms) {
    if (typeof ms !== 'number') return '';
    try {
      return new Date(ms).toLocaleDateString();
    } catch (_e) {
      return '';
    }
  }

  function renderScan(root) {
    const head = el('div', 'wf-head');
    head.append(el('h3', 'wf-title', t('Discovered projects')));
    const label = el('label', 'wf-check');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.id = 'workFoldersGitOnly';
    toggle.checked = state.gitOnly;
    toggle.addEventListener('change', () => {
      state.gitOnly = toggle.checked;
      scan();
    });
    label.append(toggle, el('span', '', t('Git repositories only')));
    head.append(label);
    root.append(head);

    const scanState = state.scan;
    if (state.busy === 'scan') {
      root.append(el('p', 'wf-note', t('Searching…')));
    } else if (scanState?.error) {
      root.append(el('p', 'wf-note wf-note-blocked', scanState.error));
    } else if (scanState) {
      if (scanState.truncated) {
        root.append(
          el(
            'p',
            'wf-note wf-note-wait',
            t(
              scanState.reason === 'timeout'
                ? 'The search took too long and shows what was found so far.'
                : 'There are more projects than can be shown. Showing the first ones.'
            )
          )
        );
      }
      if (scanState.projects.length === 0) {
        root.append(el('p', 'wf-note', t('No projects found under the registered folders.')));
      }
      const list = el('ul', 'wf-list wf-scan');
      for (const project of scanState.projects) {
        const row = el('li', 'wf-row');
        const box = el('input');
        box.type = 'checkbox';
        box.disabled = project.registered;
        box.checked = state.selected.has(project.path);
        box.setAttribute('aria-label', `${t('Select')}: ${project.name}`);
        box.addEventListener('change', () => {
          if (box.checked) state.selected.add(project.path);
          else state.selected.delete(project.path);
          renderFooterOnly();
        });
        const main = el('div', 'wf-row-main');
        main.append(el('span', 'wf-name', project.name), el('code', 'wf-path', project.path));
        const meta = el('div', 'wf-row-meta');
        if (project.branch) meta.append(el('span', 'wf-meta-text', project.branch));
        const when = formatWhen(project.mtimeMs);
        if (when) meta.append(el('span', 'wf-meta-text', when));
        if (project.registered) meta.append(badge('Already registered'));
        if (meta.childNodes.length) main.append(meta);
        row.append(box, main);
        list.append(row);
      }
      root.append(list);
    }

    const foot = el('div', 'wf-foot');
    foot.id = 'workFoldersFoot';
    root.append(foot);
    fillFooter(foot);
  }

  function fillFooter(foot) {
    foot.replaceChildren();
    const count = state.selected.size;
    foot.append(
      el('span', 'wf-foot-text', `${t('Selected')}: ${count} · ${t('Registering a project does not move the folder')}`)
    );
    const actions = el('div', 'wf-row-actions');
    const rescan = button('Search again', 'btn-toolbar btn-sm', scan);
    rescan.disabled = state.busy !== '';
    const addBtn = button('Add as projects', 'btn-toolbar btn-sm btn-primary', registerSelected);
    addBtn.id = 'workFoldersRegister';
    addBtn.disabled = count === 0 || state.busy !== '';
    actions.append(rescan, addBtn);
    foot.append(actions);
  }

  function renderFooterOnly() {
    const foot = global.document.getElementById('workFoldersFoot');
    if (foot) fillFooter(foot);
  }

  function render() {
    const root = global.document.getElementById(ROOT_ID);
    if (!root) return;
    root.replaceChildren();
    if (!state.data) {
      root.append(el('p', 'wf-note', t(state.busy === 'load' ? 'Loading…' : 'Could not load the work folders.')));
      return;
    }
    renderRoots(root);
    renderScan(root);
  }

  async function load() {
    state.busy = 'load';
    render();
    const res = await api('GET', '/api/work-folders');
    state.busy = '';
    if (res?.success) {
      state.data = res.data;
    } else {
      state.data = null;
      toast(failure(res), 'error');
    }
    render();
  }

  async function scan() {
    if (!state.data) return;
    state.busy = 'scan';
    state.selected.clear();
    render();
    const res = await api('GET', `/api/work-folders/scan?gitOnly=${state.gitOnly}`);
    state.busy = '';
    state.scan = res?.success ? res.data : { projects: [], truncated: false, error: failure(res) };
    render();
  }

  async function addRoot(path) {
    const res = await api('POST', '/api/work-folders/roots', { path });
    if (!res?.success) return toast(failure(res), 'error');
    toast(t('Work folder added'), 'success');
    await load();
    await scan();
  }

  async function addRootByBrowsing() {
    if (global.CodemanFolderPicker?.isAvailable()) {
      const result = await global.CodemanFolderPicker.choose({ title: 'Select work folder', purpose: 'work-folder' });
      if (result.status === 'ok') await addRoot(result.wslPath);
      else if (result.status === 'error') toast(result.message, 'error');
      return; // cancelled / rejected: the rejection already explained itself
    }
    if (global.PathPicker) {
      global.PathPicker.open({
        title: 'Select work folder',
        initialPath: '',
        directoriesOnly: true,
        onSelect: (path) => addRoot(path),
      });
    }
  }

  async function removeRoot(path) {
    const res = await api('DELETE', `/api/work-folders/roots?path=${encodeURIComponent(path)}`);
    if (!res?.success) return toast(failure(res), 'error');
    await load();
    await scan();
  }

  /** `POST /api/cases/link` takes a plain name; fold the folder name into it and avoid clashes. */
  function caseNameFor(project, taken) {
    let base = project.name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
    base = base.slice(0, 60);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    return name;
  }

  async function registerSelected() {
    if (state.busy || state.selected.size === 0 || !state.scan) return;
    state.busy = 'register';
    renderFooterOnly();
    const chosen = state.scan.projects.filter((p) => state.selected.has(p.path) && !p.registered);
    const taken = new Set();
    let ok = 0;
    const failed = [];
    for (const project of chosen) {
      let res = await api('POST', '/api/cases/link', { name: caseNameFor(project, taken), path: project.path });
      // Only a name clash is worth another try; anything else is a real refusal.
      for (let n = 2; !res?.success && /already exists/i.test(res?.error || '') && n < 6; n++) {
        res = await api('POST', '/api/cases/link', { name: caseNameFor(project, taken), path: project.path });
      }
      if (res?.success) ok++;
      else failed.push(project.name);
    }
    state.busy = '';
    if (ok) toast(`${t('Projects added')}: ${ok}`, 'success');
    if (failed.length) toast(`${t('Could not add')}: ${failed.join(', ')}`, 'error');
    global.app?.loadCases?.();
    await scan();
  }

  /** Default-location dialog: the path, what happens to existing cases, and the Docker warning. */
  function openBaseDialog() {
    if (!state.data || state.data.caseBase.readOnly) return;
    const opener = global.document.activeElement;
    const backdrop = el('div', 'folder-pick-modal');
    const box = el('div', 'folder-pick-box wf-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'wfBaseTitle');
    const title = el('h2', 'folder-pick-title', t('Change default location'));
    title.id = 'wfBaseTitle';
    box.append(title);
    box.append(
      el('p', 'folder-pick-body', t('New cases are created in this folder. Existing cases are never moved or deleted.'))
    );

    const input = el('input', 'wf-input');
    input.type = 'text';
    input.id = 'wfBasePath';
    input.value = state.data.caseBase.configured || state.data.caseBase.path;
    input.spellcheck = false;
    input.setAttribute('aria-label', t('New default location'));
    const browse = button('Browse', 'btn-toolbar btn-sm', async () => {
      if (global.CodemanFolderPicker?.isAvailable()) {
        const result = await global.CodemanFolderPicker.choose({
          title: 'Select default location',
          purpose: 'work-folder',
        });
        if (result.status === 'ok') input.value = result.wslPath;
      } else if (global.PathPicker) {
        global.PathPicker.open({
          title: 'Select default location',
          initialPath: input.value.trim(),
          directoriesOnly: true,
          onSelect: (path) => {
            input.value = path;
          },
        });
      }
    });
    const pathRow = el('div', 'wf-dialog-row');
    pathRow.append(input, browse);
    box.append(pathRow);

    const choice = el('fieldset', 'wf-choice');
    choice.append(el('legend', '', t('Existing cases in the old location')));
    const options = [
      ['link', 'Keep them in the list (linked where they are)'],
      ['hide', 'Leave them out of the list (files stay untouched)'],
    ];
    for (const [value, label] of options) {
      const line = el('label', 'wf-check');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'wfExisting';
      radio.value = value;
      radio.checked = value === 'link';
      line.append(radio, el('span', '', t(label)));
      choice.append(line);
    }
    box.append(choice);

    box.append(
      el('p', 'wf-note wf-note-wait', t('Applies after the next restart. Running sessions keep the old path.'))
    );
    if (state.data.dockerCaseCount > 0) {
      box.append(
        el(
          'p',
          'wf-note wf-note-blocked',
          `${t('Docker cases keep their old folder mounted. Recreate them to use the new location.')} (${state.data.dockerCaseCount})`
        )
      );
    }
    const message = el('p', 'wf-note wf-note-blocked');
    message.hidden = true;
    message.setAttribute('role', 'alert');
    box.append(message);

    const actions = el('div', 'folder-pick-actions');
    const save = button('Save', 'btn-toolbar btn-primary', async () => {
      save.disabled = true;
      const existingCases = box.querySelector('input[name="wfExisting"]:checked')?.value || 'link';
      const res = await api('PUT', '/api/work-folders/base', { path: input.value.trim(), existingCases });
      save.disabled = false;
      if (!res?.success) {
        message.textContent = failure(res);
        message.hidden = false;
        return;
      }
      done();
      toast(t(res.data.appliesAfterRestart ? 'Saved. Applies after the next restart.' : 'Saved'), 'success');
      await load();
      // The list was redrawn, so the opener is a new element: put focus back on it.
      global.document.getElementById('workFoldersChangeBase')?.focus();
    });
    const cancel = button('Cancel', 'btn-toolbar', () => done());
    actions.append(save, cancel);
    box.append(actions);
    backdrop.append(box);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done();
      } else if (e.key === 'Tab') {
        const items = [...box.querySelectorAll('button:not([disabled]), input:not([disabled])')];
        const at = items.indexOf(global.document.activeElement);
        const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
        e.preventDefault();
        items[next]?.focus();
      }
    };
    function done() {
      global.document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      try {
        opener?.focus?.();
      } catch (_e) {
        /* the opener may be gone */
      }
    }
    global.document.addEventListener('keydown', onKey, true);
    global.document.body.append(backdrop);
    input.focus();
  }

  global.CodemanWorkFolders = {
    /** Called each time Settings opens: fresh state, then the first search. */
    async refresh() {
      await load();
      if (state.data) await scan();
    },
    _state: state,
  };
})(window);
