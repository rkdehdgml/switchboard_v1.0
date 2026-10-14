// src/web/public/menu-bar.js

/**
 * @fileoverview Header menu bar (Switchboard T2): Session / Automation / Environment /
 * Settings / Help dropdowns, built from ONE data table that also feeds the command
 * palette, so a menu entry and its palette entry can never drift apart.
 *
 * Keyboard follows the WAI-ARIA menu-button pattern. No access keys (Alt+letter):
 * the terminal owns the keyboard, so the palette is the keyboard route to every item.
 * Dropdowns are NOT focus-trapped (a trap is for modals); Tab closes the menu.
 *
 * The dropdown is appended to <body> and positioned `fixed`: `.header` carries
 * `contain: layout style paint`, which would clip an absolutely positioned child.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp), panels-ui.js (palette), session-ui.js / settings-ui.js (actions)
 * @dependency keyboard-accessory.js (FocusTrap, for the kill-all confirm modal)
 * @loadorder 11.8 of 16 — loaded after admin-ui.js
 */

(function (global) {
  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
    'split-stacked': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
    kill: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    respawn: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
    orchestrator:
      '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5M12 12l-6 5M12 12l6 5"/>',
    cron: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    ultracode:
      '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M8.2 7.2 15.6 11M8.2 16.8 15.6 13"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    box: '<path d="M3 12h18v4a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM6 12V8h4v4M10 12V6h4v6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    keyboard:
      '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    update: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  };

  const activeSession = (app) => app.sessions?.get?.(app.activeSessionId) || null;

  /** A pane can be added while there is a session to split and fewer than the cap are open. */
  const canAddPane = (app) =>
    !!app.activeSessionId && (!app._splitTree || !!global.CodemanSplitPane?.splitCanAddPane?.(app._splitTree));

  /** Modal tabs of Add Case that double as the Environment menu's destinations. */
  const openCaseTab = (app, tab) => {
    app.showCreateCaseModal();
    app.switchCaseModalTab(tab);
  };

  /**
   * label may be a function (dynamic); enabled() defaults to true. English strings are
   * the i18n source keys (i18n.js translates the inserted DOM), never translated here.
   */
  const MENUS = [
    {
      id: 'session',
      label: 'Session',
      items: [
        { id: 'new-session', label: 'New session', icon: 'plus', run: (app) => app.run() },
        {
          id: 'split',
          label: 'Split side by side',
          icon: 'split',
          enabled: (app) => canAddPane(app),
          run: (app, trigger) => app.openSplitPicker(undefined, trigger, { dir: 'row' }),
        },
        {
          id: 'split-stacked',
          label: 'Split top and bottom',
          icon: 'split-stacked',
          enabled: (app) => canAddPane(app),
          run: (app, trigger) => app.openSplitPicker(undefined, trigger, { dir: 'col' }),
        },
        {
          id: 'split-close',
          label: 'Close split',
          icon: 'close',
          enabled: (app) => !!app._splitTree,
          run: (app) => app.closeSplitPane(),
        },
        {
          id: 'save-layout',
          // With a split open this saves it; with none open it clears the saved one.
          label: (app) => (app._splitTree ? 'Save layout' : 'Clear saved layout'),
          icon: 'layout',
          enabled: (app) => !!app._splitTree || !!app._savedSplit,
          run: (app) => app.saveSplitLayout(),
        },
        {
          id: 'kill-all',
          label: 'Kill all sessions',
          icon: 'kill',
          danger: true,
          separatorBefore: true,
          enabled: (app) => (app.sessions?.size || 0) > 0,
          run: (app) => app.openKillAllConfirm(),
        },
      ],
    },
    {
      id: 'automation',
      label: 'Automation',
      items: [
        {
          id: 'respawn',
          label: 'Respawn',
          icon: 'respawn',
          // Respawn/Ralph are Claude-only: Session Options hides those tabs for external CLIs.
          enabled: (app) => {
            const s = activeSession(app);
            return !!s && !global.isExternalCliRunMode?.(s.mode);
          },
          run: (app) => app.openSessionOptions(app.activeSessionId),
        },
        {
          id: 'orchestrator',
          label: 'Orchestrator',
          icon: 'orchestrator',
          run: (app) => app.toggleOrchestratorPanel(),
        },
        { id: 'cron', label: 'Cron', icon: 'cron', run: (app) => app.openCron() },
        { id: 'ultracode', label: 'Ultracode', icon: 'ultracode', run: (app) => app.toggleUltracodeAgentsPanel() },
      ],
    },
    {
      id: 'environment',
      label: 'Environment',
      items: [
        { id: 'cases', label: 'Manage cases', icon: 'folder', run: (app) => openCaseTab(app, 'case-manage') },
        { id: 'docker', label: 'Docker isolation', icon: 'box', run: (app) => openCaseTab(app, 'case-docker') },
        { id: 'remote', label: 'Remote SSH hosts', icon: 'globe', run: (app) => openCaseTab(app, 'case-remote') },
      ],
    },
    {
      id: 'settings',
      label: 'Settings',
      items: [{ id: 'app-settings', label: 'Open app settings', icon: 'gear', run: (app) => app.openAppSettings() }],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', run: (app) => app.showShortcutOverlay() },
        // Settings opens on its Updates section: the running version and the check live there.
        { id: 'version', label: 'Version', icon: 'info', run: (app) => app.openAppSettings() },
        {
          id: 'update',
          label: 'Check for updates',
          icon: 'update',
          run: (app) => {
            app.openAppSettings();
            app.checkForUpdate?.();
          },
        },
      ],
    },
  ];

  const labelOf = (item, app) => (typeof item.label === 'function' ? item.label(app) : item.label);
  const isEnabled = (item, app) => (item.enabled ? !!item.enabled(app) : true);
  const t = (s) => global.CodemanI18n?.t?.(s) ?? s;

  function svgIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    // Static literals from ICONS above, never user data.
    svg.innerHTML = ICONS[name] || '';
    return svg;
  }

  global.CodemanMenus = Object.freeze({ MENUS, labelOf, isEnabled });

  Object.assign(CodemanApp.prototype, {
    /** Build the five trigger buttons once. Dropdowns are built per open (labels/enabled are live). */
    renderMenuBar() {
      const bar = document.getElementById('headerMenu');
      if (!bar || bar.childElementCount) return;
      for (const menu of MENUS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'header-menu-btn';
        btn.id = `headerMenuBtn-${menu.id}`;
        btn.dataset.menu = menu.id;
        btn.setAttribute('aria-haspopup', 'menu');
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = menu.label;
        btn.addEventListener('click', () =>
          this._openMenuId === menu.id ? this.closeHeaderMenu() : this.openHeaderMenu(menu.id)
        );
        btn.addEventListener('mouseenter', () => {
          // Menu-bar convention: once one is open, hovering another switches to it.
          if (this._openMenuId && this._openMenuId !== menu.id) this.openHeaderMenu(menu.id);
        });
        btn.addEventListener('keydown', (e) => this._onMenuTriggerKeydown(e, menu.id));
        bar.append(btn);
      }
      this.renderPaletteHint();
    },

    /** Header-right hint showing the palette's REAL chord, read from the shortcut registry. */
    renderPaletteHint() {
      const btn = document.getElementById('headerPaletteBtn');
      if (!btn) return;
      const palette = this.getShortcutRegistry?.().find((s) => s.id === 'command-palette');
      // Windows + WSL: show Ctrl, not the Cmd/Alt alternates registered beside it.
      const b = palette && !palette.disabled && (palette.bindings || []).find((x) => x.modifiers?.includes('ctrl'));
      btn.hidden = !b;
      if (!b) return;
      const chord = [
        ...b.modifiers.filter((m) => m !== 'shift').map((m) => m[0].toUpperCase() + m.slice(1)),
        b.key.toUpperCase(),
      ];
      if (b.modifiers.includes('shift')) chord.splice(1, 0, 'Shift');
      btn.querySelector('kbd').textContent = chord.join('+');
    },

    openHeaderMenu(menuId, focus = 'none') {
      const menu = MENUS.find((m) => m.id === menuId);
      const trigger = document.getElementById(`headerMenuBtn-${menuId}`);
      if (!menu || !trigger) return;
      this.closeHeaderMenu({ restoreFocus: false });

      const list = document.createElement('div');
      list.className = 'header-menu-list';
      list.id = `headerMenuList-${menuId}`;
      list.setAttribute('role', 'menu');
      list.setAttribute('aria-labelledby', trigger.id);
      for (const item of menu.items) {
        if (item.separatorBefore) {
          const sep = document.createElement('div');
          sep.className = 'header-menu-sep';
          sep.setAttribute('role', 'separator');
          list.append(sep);
        }
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'header-menu-item' + (item.danger ? ' header-menu-item--danger' : '');
        row.setAttribute('role', 'menuitem');
        row.tabIndex = -1;
        row.disabled = !isEnabled(item, this);
        row.append(svgIcon(item.icon));
        const text = document.createElement('span');
        text.textContent = labelOf(item, this);
        row.append(text);
        row.addEventListener('click', () => {
          // Close and hand focus back first: a modal this opens remembers
          // document.activeElement and returns focus to it on close.
          this.closeHeaderMenu({ restoreFocus: true });
          item.run(this, trigger);
        });
        list.append(row);
      }
      list.addEventListener('keydown', (e) => this._onMenuListKeydown(e, menuId));
      document.body.append(list);

      const rect = trigger.getBoundingClientRect();
      list.style.top = `${rect.bottom + 4}px`;
      list.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - list.offsetWidth - 8))}px`;

      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-controls', list.id);
      this._openMenuId = menuId;

      const items = this._menuItems(list);
      if (focus === 'first') items[0]?.focus();
      else if (focus === 'last') items[items.length - 1]?.focus();

      if (!this._menuDismiss) {
        this._menuDismiss = (e) => {
          if (e.target.closest?.('.header-menu-list, .header-menu-btn')) return;
          this.closeHeaderMenu({ restoreFocus: false });
        };
        document.addEventListener('mousedown', this._menuDismiss, true);
        window.addEventListener('blur', this._menuDismiss);
        window.addEventListener('resize', this._menuDismiss);
      }
    },

    closeHeaderMenu({ restoreFocus = false } = {}) {
      const id = this._openMenuId;
      if (!id) return;
      this._openMenuId = null;
      document.getElementById(`headerMenuList-${id}`)?.remove();
      const trigger = document.getElementById(`headerMenuBtn-${id}`);
      trigger?.setAttribute('aria-expanded', 'false');
      trigger?.removeAttribute('aria-controls');
      if (restoreFocus) trigger?.focus();
      if (this._menuDismiss) {
        document.removeEventListener('mousedown', this._menuDismiss, true);
        window.removeEventListener('blur', this._menuDismiss);
        window.removeEventListener('resize', this._menuDismiss);
        this._menuDismiss = null;
      }
    },

    _menuItems(list) {
      return [...list.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    },

    _onMenuTriggerKeydown(e, menuId) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.openHeaderMenu(menuId, 'first');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.openHeaderMenu(menuId, 'last');
      } else if (e.key === 'Escape' && this._openMenuId) {
        e.preventDefault();
        this.closeHeaderMenu({ restoreFocus: true });
      }
    },

    _onMenuListKeydown(e, menuId) {
      const list = e.currentTarget;
      const items = this._menuItems(list);
      const i = items.indexOf(document.activeElement);
      const move = (n) => {
        e.preventDefault();
        items[(n + items.length) % items.length]?.focus();
      };
      switch (e.key) {
        case 'ArrowDown':
          return move(i + 1);
        case 'ArrowUp':
          return move(i < 0 ? items.length - 1 : i - 1);
        case 'Home':
          return move(0);
        case 'End':
          return move(items.length - 1);
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const at = MENUS.findIndex((m) => m.id === menuId);
          const step = e.key === 'ArrowRight' ? 1 : -1;
          const next = MENUS[(at + step + MENUS.length) % MENUS.length];
          this.openHeaderMenu(next.id, 'first');
          return;
        }
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          this.closeHeaderMenu({ restoreFocus: true });
          return;
        case 'Tab':
          // No focus trap: close, park focus on the trigger, and let the default Tab move on from there.
          this.closeHeaderMenu({ restoreFocus: true });
          return;
        default:
      }
    },

    /** Palette entries (only when searching): every enabled menu item, matched in English and the UI language. */
    buildMenuCommandItems(query = '') {
      const needle = query.trim().toLowerCase();
      if (!needle) return [];
      const out = [];
      for (const menu of MENUS) {
        for (const item of menu.items) {
          if (!isEnabled(item, this)) continue;
          const label = labelOf(item, this);
          const hay = [label, t(label), menu.label, t(menu.label)].join(' ').toLowerCase();
          if (!hay.includes(needle)) continue;
          out.push({
            id: `command:${menu.id}:${item.id}`,
            type: 'command',
            title: t(label),
            subtitle: t(menu.label),
            run: () => item.run(this, document.getElementById(`headerMenuBtn-${menu.id}`)),
          });
        }
      }
      return out;
    },

    /** Kill-all confirmation: a modal, not window.confirm (which blocks the whole page). */
    openKillAllConfirm() {
      const modal = document.getElementById('killAllModal');
      if (!modal) return;
      const count = this.sessions?.size || 0;
      document.getElementById('killAllCount').textContent = String(count);
      modal.classList.add('active');
      this._killAllTrap = new FocusTrap(modal);
      this._killAllTrap.activate();
      // Destructive confirm: land on Cancel, not on the first control (the close X).
      // The trap focuses the first control on the next frame, so wait one.
      requestAnimationFrame(() => document.getElementById('killAllCancel')?.focus());
      if (!this._killAllEscWired) {
        this._killAllEscWired = true;
        modal.addEventListener('keydown', (e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          this.closeKillAllConfirm();
        });
      }
    },

    closeKillAllConfirm() {
      document.getElementById('killAllModal')?.classList.remove('active');
      this._killAllTrap?.deactivate();
      this._killAllTrap = null;
    },

    async confirmKillAll() {
      this.closeKillAllConfirm();
      await this.killAllSessions(true);
    },
  });

  document.addEventListener('DOMContentLoaded', () => global.app?.renderMenuBar?.());
})(window);
