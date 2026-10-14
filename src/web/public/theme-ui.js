// src/web/public/theme-ui.js

/**
 * @fileoverview Theme mode (dark | light | system) + per-tone skin choice.
 *
 * Three settings live on the SERVER (settings.json), not in localStorage:
 * `themeMode`, `darkSkin`, `lightSkin`. localStorage is per origin (port
 * included), so a desktop shell that ever moves ports would lose them.
 * The existing single `skin` is now just the RESOLVED result of those three,
 * so every consumer of html[data-skin] / applyTerminalSkin keeps working.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp), settings-ui.js (applySkin, load/saveAppSettings*)
 * @dependency terminal-ui.js (CODEMAN_XTERM_THEMES — skin swatches use each skin's OWN colors)
 * @dependency i18n.js (CodemanI18n.t)
 * @loadorder 10.5 of 16 — loaded after settings-ui.js
 */

(function (global) {
  const DARK_SKINS = ['daylight-blue', 'daylight-green', 'og'];
  const LIGHT_SKINS = ['paper-gray', 'solarized-light', 'catppuccin-latte', 'rose-pine-dawn'];
  const SKIN_LABELS = {
    'daylight-blue': 'Daylight Blue',
    'daylight-green': 'Daylight Green',
    og: 'OG Codeman',
    'paper-gray': 'Paper Gray',
    'solarized-light': 'Solarized Light',
    'catppuccin-latte': 'Catppuccin Latte',
    'rose-pine-dawn': 'Rosé Pine Dawn',
  };
  const MODES = ['dark', 'light', 'system'];
  const DEFAULTS = { themeMode: 'system', darkSkin: DARK_SKINS[0], lightSkin: LIGHT_SKINS[0] };

  const t = (s) => global.CodemanI18n?.t?.(s) ?? s;

  /** Normalize whatever is stored into three valid values (unknown → default). */
  function normalizeTheme(settings = {}) {
    return {
      themeMode: MODES.includes(settings.themeMode) ? settings.themeMode : DEFAULTS.themeMode,
      darkSkin: DARK_SKINS.includes(settings.darkSkin) ? settings.darkSkin : DEFAULTS.darkSkin,
      lightSkin: LIGHT_SKINS.includes(settings.lightSkin) ? settings.lightSkin : DEFAULTS.lightSkin,
    };
  }

  /**
   * Pre-T1 installs stored one `skin`. Map it to the equivalent three values so
   * the user keeps the exact look they had: fixed mode for its tone + that skin.
   * Returns null when `skin` is absent/unknown (nothing to migrate).
   */
  function themeFromLegacySkin(skin) {
    if (DARK_SKINS.includes(skin)) return { ...DEFAULTS, themeMode: 'dark', darkSkin: skin };
    if (LIGHT_SKINS.includes(skin)) return { ...DEFAULTS, themeMode: 'light', lightSkin: skin };
    return null;
  }

  /** The three theme values to use for `settings`, honouring a pre-T1 single `skin` until a theme is saved. */
  function effectiveTheme(settings = {}) {
    if (!settings.themeMode) {
      const legacy = themeFromLegacySkin(settings.skin);
      if (legacy) settings = { ...settings, ...legacy };
    }
    return normalizeTheme(settings);
  }

  function systemPrefersDark() {
    return !!global.matchMedia?.('(prefers-color-scheme: dark)').matches;
  }

  /** Which tone is on screen right now. */
  function resolveTone(mode) {
    return mode === 'dark' || (mode === 'system' && systemPrefersDark()) ? 'dark' : 'light';
  }

  global.CodemanTheme = Object.freeze({
    DARK_SKINS,
    LIGHT_SKINS,
    DEFAULTS,
    normalizeTheme,
    themeFromLegacySkin,
    resolveTone,
  });

  Object.assign(CodemanApp.prototype, {
    /**
     * The skin to put on <html>. Before any theme was saved, a legacy `skin`
     * from a pre-T1 settings blob wins, so an upgrade never flashes a different look.
     */
    resolveThemeSkin(settings = this.loadAppSettingsFromStorage()) {
      const theme = effectiveTheme(settings);
      return resolveTone(theme.themeMode) === 'dark' ? theme.darkSkin : theme.lightSkin;
    },

    /**
     * Desktop shell only (Switchboard T9-1): put the window's title bar in the same tone as the
     * page. A fixed mode fixes the bar too; `system` hands it back to the OS (null), so it follows
     * Windows exactly like the page does. The shell grants this one command to its own window and
     * nothing else; in a plain browser there is no `__TAURI_INTERNALS__` and this does nothing.
     * Failure is harmless: the title bar just keeps its last colour.
     */
    syncWindowTitleBar(settings = this.loadAppSettingsFromStorage()) {
      const invoke = global.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== 'function') return;
      const { themeMode } = effectiveTheme(settings);
      try {
        Promise.resolve(
          invoke('plugin:window|set_theme', { label: 'main', value: themeMode === 'system' ? null : themeMode })
        ).catch(() => {});
      } catch (_e) {
        /* a throwing bridge must never break theming */
      }
    },

    /** Re-resolve when Windows flips its app mode, but only in `system` mode. */
    _installThemeSystemListener() {
      if (this._themeSystemListenerInstalled || !global.matchMedia) return;
      this._themeSystemListenerInstalled = true;
      global.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const settings = this.loadAppSettingsFromStorage();
        if (normalizeTheme(settings).themeMode !== 'system') return;
        this.applySkin();
        this.renderThemeControls();
      });
    },

    /**
     * Fill the server's three theme keys when it has none. Call after server settings
     * were merged; `serverSettings` is what the server returned. Source, in order:
     * this device's own theme keys (server reset, or saved while it was unreachable),
     * a pre-T1 single `skin`, then the defaults. The server wins whenever it has a value.
     * @returns {object|null} the keys written, or null if nothing to do
     */
    migrateThemeToServer(serverSettings, merged) {
      if (serverSettings?.themeMode) return null;
      const theme = MODES.includes(merged.themeMode)
        ? normalizeTheme(merged)
        : themeFromLegacySkin(merged.skin) || normalizeTheme({});
      Object.assign(merged, theme);
      // Best-effort: a failed PUT leaves the local copy, and the next load retries.
      this._apiPut('/api/settings', theme).catch(() => {});
      return theme;
    },

    /** Persist + apply one change immediately (no Save button), then redraw the controls. */
    setThemePrefs(patch) {
      const settings = this.loadAppSettingsFromStorage();
      const next = normalizeTheme({ ...settings, ...patch });
      this.saveAppSettingsToStorage({ ...settings, ...next });
      this.applySkin();
      this.renderThemeControls();
      this._apiPut('/api/settings', next).catch(() => {
        this.showToast?.('Settings saved locally', 'warning');
      });
    },

    renderThemeControls() {
      const root = document.getElementById('appSettingsTheme');
      if (!root) return;
      const theme = normalizeTheme(this.loadAppSettingsFromStorage());

      root.querySelectorAll('#appSettingsThemeMode button').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.mode === theme.themeMode));
        btn.onclick = () => this.setThemePrefs({ themeMode: btn.dataset.mode });
      });

      const status = {
        dark: 'Always dark, regardless of Windows.',
        light: 'Always light, regardless of Windows.',
        system: `Follows the Windows app mode. Now: ${resolveTone('system')}`,
      }[theme.themeMode];
      const statusEl = document.getElementById('appSettingsThemeStatus');
      if (statusEl) statusEl.textContent = t(status);

      // System shows both rows (either may become active); a fixed tone shows only its own.
      const rows = [
        ['appSettingsDarkSkins', DARK_SKINS, 'darkSkin', 'dark'],
        ['appSettingsLightSkins', LIGHT_SKINS, 'lightSkin', 'light'],
      ];
      for (const [id, skins, key, tone] of rows) {
        const fieldset = document.getElementById(id);
        if (!fieldset) continue;
        fieldset.hidden = theme.themeMode !== 'system' && theme.themeMode !== tone;
        const cards = fieldset.querySelector('.theme-cards');
        cards.replaceChildren(
          ...skins.map((skin) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'theme-card';
            btn.dataset.skin = skin;
            btn.setAttribute('aria-pressed', String(theme[key] === skin));
            btn.onclick = () => this.setThemePrefs({ [key]: skin });
            btn.append(skinSwatch(skin));
            const label = document.createElement('span');
            label.className = 'theme-card-name';
            label.textContent = SKIN_LABELS[skin];
            // Skin names are proper names; keep i18n from translating them.
            label.setAttribute('data-i18n-skip', '');
            btn.append(label);
            return btn;
          })
        );
      }
    },
  });

  /**
   * Preview painted with the skin's OWN xterm colors, never CSS tokens: a token
   * follows the current theme, which would paint a dark skin's swatch white on a
   * light screen.
   */
  function skinSwatch(skin) {
    const x = global.CODEMAN_XTERM_THEMES?.[skin] || {};
    const el = document.createElement('span');
    el.className = 'theme-swatch';
    el.setAttribute('aria-hidden', 'true');
    el.style.background = x.background || '#000';
    for (const color of [x.foreground, x.green, x.blue]) {
      const bar = document.createElement('i');
      bar.style.background = color || '#888';
      el.append(bar);
    }
    return el;
  }
})(window);
