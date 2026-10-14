// src/web/public/home-dashboard.js

/**
 * @fileoverview Home pinned tab (Switchboard T4): the first row of the session rail, never
 * closable or draggable, opening a usage dashboard in place of the terminal.
 *
 * It is not a session: it reuses the web-tab mechanism (a layer beside `.terminal-wrap`,
 * `.main.home-active` hides the terminal) and the plan-limit values the header chip already
 * receives. Cost, model and tool figures come from `/api/usage/summary`, which reads Claude
 * Code's own logs. Refreshing rides the existing SSE handlers; there is no polling timer.
 *
 * Every string taken from the logs (project, model, skill and server names) is untrusted and
 * goes through escapeHtml.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js, constants.js (escapeHtml), webview-tabs.js (hides its layer), i18n.js (codemanT)
 * @loadorder 12.51 of 16, right after webview-tabs.js
 */

(function (global) {
  const T = (s, v) =>
    typeof global.codemanT === 'function'
      ? global.codemanT(s, v)
      : String(s).replace(/\{(\w+)\}/g, (_m, k) => (v && v[k]) ?? '');
  const MIN_REFRESH_MS = 10_000;

  const money = (n) => `$${Number(n || 0).toFixed(2)}`;
  const compact = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  };
  /** `claude-opus-5-5` -> `Opus 5.5`; anything unrecognised is shown as logged. */
  function modelLabel(id) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(String(id));
    return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : String(id);
  }
  /** 여유 / 주의 / 임박: words always accompany the colour, never colour alone. */
  function limitState(pct) {
    if (pct >= 85) return { cls: 'danger', icon: '▲', word: 'Critical' };
    if (pct >= 60) return { cls: 'warn', icon: '!', word: 'Watch' };
    return { cls: 'ok', icon: '✓', word: 'Plenty' };
  }
  const esc = (s) => (typeof global.escapeHtml === 'function' ? global.escapeHtml(String(s)) : String(s));

  function bars(rows, valueOf, labelOf, fmt, fixedLabel) {
    const max = Math.max(...rows.map(valueOf), 0) || 1;
    return rows
      .map((r) => {
        const v = valueOf(r);
        return `<div class="home-bar-row${fixedLabel ? ' home-bar-row--fixed' : ''}">
          <span class="home-bar-name" title="${esc(labelOf(r))}">${esc(labelOf(r))}</span>
          <span class="home-bar-track"><span class="home-bar-fill" style="width:${Math.max(2, Math.round((v / max) * 100))}%"></span></span>
          <span class="home-bar-val">${esc(fmt(v))}</span>
        </div>`;
      })
      .join('');
  }

  Object.assign(CodemanApp.prototype, {
    /** The pinned row. Emitted first by _fullRenderSessionTabs() on the vertical rail only. */
    renderHomeTab() {
      const active = !!this.homeActive;
      return `<div class="session-tab session-tab--home ${active ? 'active' : ''}" data-home="1"
          onclick="app.openHome()" tabindex="0" role="tab" aria-selected="${active ? 'true' : 'false'}"
          aria-label="Home" title="Home (Alt+0)">
          <span class="tab-home-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"/></svg></span>
          <span class="tab-info"><span class="tab-name-row"><span class="tab-name">Home</span></span></span>
          <span class="tab-home-pin" aria-hidden="true"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M14 3l7 7-3 1-3.5 3.5.5 4.5-2 2-3.5-5.5L4 21l-1-1 5-4.5L2.5 12l2-2 4.5.5L12.5 7z"/></svg></span>
        </div>`;
    },

    _updateHomeTab() {
      const tab = this.$('sessionTabs')?.querySelector('.session-tab--home');
      if (tab) {
        tab.classList.toggle('active', !!this.homeActive);
        tab.setAttribute('aria-selected', this.homeActive ? 'true' : 'false');
      }
      // Exactly one tab looks active across all three kinds.
      if (this.homeActive) {
        for (const t of this.$('sessionTabs')?.querySelectorAll('.session-tab.active:not(.session-tab--home)') || []) {
          t.classList.remove('active');
        }
      }
    },

    openHome() {
      this.homeActive = true;
      // The home tab takes the stage from any web tab, just as a session tab does.
      if (this.activeWebviewId) this._hideWebviewLayer?.();
      this.hideWelcome?.();
      document.querySelector('.main')?.classList.add('home-active');
      this._updateHomeTab();
      this.closeSessionSidebarOnHandheld?.();
      this._renderHome();
      void this.refreshHome(true);
    },

    /** Called by selectSession() and openWebview(): another tab takes the stage back. */
    _hideHome() {
      if (!this.homeActive) return;
      this.homeActive = false;
      document.querySelector('.main')?.classList.remove('home-active');
      this._updateHomeTab();
    },

    /** SSE handlers call this; it fetches at most once per MIN_REFRESH_MS and only while the tab is open. */
    _scheduleHomeRefresh() {
      if (!this.homeActive) return;
      this._renderHome(); // active-session tiles come from live state, no fetch needed
      const wait = Math.max(0, MIN_REFRESH_MS - (Date.now() - (this._homeFetchedAt || 0)));
      if (this._homeRefreshTimer) return;
      this._homeRefreshTimer = setTimeout(() => {
        this._homeRefreshTimer = null;
        void this.refreshHome();
      }, wait);
    },

    async refreshHome(force) {
      if (!force && Date.now() - (this._homeFetchedAt || 0) < MIN_REFRESH_MS) return;
      this._homeFetchedAt = Date.now();
      try {
        const res = await fetch('/api/usage/summary');
        const body = res.ok ? await res.json() : null;
        this._homeData = body?.success ? body.data : null;
        this._homeError = !this._homeData;
      } catch {
        this._homeError = true;
      }
      this._renderHome();
    },

    _homeSessionCounts() {
      let active = 0;
      let waiting = 0;
      for (const [id, s] of this.sessions || []) {
        const st = this._mobileOverviewState?.(s, this.pendingHooks?.get(id));
        if (st === 'done' || st === 'exited') continue;
        active++;
        if (st === 'needs' || st === 'waiting') waiting++;
      }
      return { active, waiting };
    },

    _renderHome() {
      const layer = this.$('homeLayer');
      if (!layer || !this.homeActive) return;
      const d = this._homeData;
      const { active, waiting } = this._homeSessionCounts();
      const stamp = d ? new Date(d.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const head = `<div class="home-head"><h2>Usage</h2><span class="home-stamp">${d ? esc(`${d.today} · ${T('updated')} ${stamp}`) : ''}</span></div>`;

      if (!d) {
        layer.innerHTML = `<div class="home-inner">${head}<p class="home-empty" role="status">${
          this._homeError ? T('Could not load usage data') : T('Loading…')
        }</p></div>`;
        return;
      }
      if (!d.hasData) {
        layer.innerHTML = `<div class="home-inner">${head}<div class="home-empty" role="status">
          <strong>${T('No records yet')}</strong><span>${T('Usage appears here once Claude Code has written a conversation log.')}</span></div></div>`;
        return;
      }

      const weekEmpty = d.models.length === 0 && d.unrecordedWeek === 0 && d.unknownCostWeek === 0;
      const dash = '—';
      const tile = (label, value, extra = '', cls = '') =>
        `<div class="home-tile"><span class="home-tile-label">${T(label)}</span><span class="home-tile-val ${cls}">${value}</span>${extra}</div>`;
      const tiles = [
        tile('Today', weekEmpty ? dash : money(d.costToday)),
        tile('This week', weekEmpty ? dash : money(d.costWeek)),
        tile(
          'Active sessions',
          String(active),
          waiting > 0
            ? `<span class="home-tile-sub home-tile-sub--warn">${esc(T('{n} waiting', { n: waiting }))}</span>`
            : ''
        ),
        tile(
          'Cache hit rate',
          d.cacheHitRate === null ? dash : `${Math.round(d.cacheHitRate * 100)}%`,
          '',
          'home-tile-val--money'
        ),
      ].join('');

      const none = `<p class="home-none">${T('No records this week yet')}</p>`;
      const models = d.models.length
        ? d.models
            .map(
              (m) => `<div class="home-model">
            <div class="home-model-top"><span>${esc(modelLabel(m.model))}</span><span class="home-mono">${esc(money(m.costUsd))}</span></div>
            <div class="home-bar-track"><span class="home-bar-fill" style="width:${Math.max(2, Math.round((m.costUsd / (d.models[0].costUsd || 1)) * 100))}%"></span></div>
            <div class="home-tokens">${esc(`in ${compact(m.input)} · out ${compact(m.output)} · cache ${compact(m.cacheRead)}`)}</div>
          </div>`
            )
            .join('')
        : none;
      const projects = d.projects.length
        ? bars(
            d.projects,
            (p) => p.costUsd,
            (p) => p.project,
            money,
            true
          )
        : none;

      const pu = this._planUsage || {};
      const limit = (label, w) => {
        if (!w || typeof w.usedPercentage !== 'number') {
          return `<div class="home-limit"><span class="home-tile-label">${label}</span><span class="home-limit-val">${dash}</span><span class="home-tokens">${T('No reading yet')}</span></div>`;
        }
        const pct = Math.round(w.usedPercentage);
        const st = limitState(pct);
        const reset = w.resetAt
          ? new Date(w.resetAt).toLocaleString([], {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : dash;
        return `<div class="home-limit">
          <span class="home-tile-label">${label}</span>
          <span class="home-limit-val">${pct}<small>%</small></span>
          <span class="home-gauge home-gauge--${st.cls}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="${esc(label)}"><span style="width:${Math.min(100, pct)}%"></span></span>
          <span class="home-limit-state home-limit-state--${st.cls}"><span aria-hidden="true">${st.icon}</span> ${T(st.word)}</span>
          <span class="home-tokens">${T('Resets')} ${esc(reset)}</span>
        </div>`;
      };

      const skills = d.tools.skills.length
        ? bars(
            d.tools.skills,
            (x) => x.count,
            (x) => x.name,
            String
          )
        : '';
      const mcp = d.tools.mcp.length
        ? bars(
            d.tools.mcp,
            (x) => x.count,
            (x) => x.name,
            String
          )
        : '';
      const toolsHtml =
        skills || mcp
          ? `${skills ? `<h4>${T('Skills')}</h4>${skills}` : ''}${mcp ? `<h4>${T('MCP servers')}</h4>${mcp}` : ''}`
          : none;

      const notes = [
        T(
          "Cost is split between days by each session's token share: totals are exact, the day split of a session that spans days is an estimate."
        ),
      ];
      if (d.unrecordedWeek > 0)
        notes.push(T('{n} sessions have no recorded cost and are not in the totals.', { n: d.unrecordedWeek }));
      if (d.unknownCostWeek > 0)
        notes.push(
          T('{n} sessions use a model with unknown pricing and are not in the totals.', { n: d.unknownCostWeek })
        );

      layer.innerHTML = `<div class="home-inner">${head}
        <div class="home-tiles">${tiles}</div>
        <div class="home-cols">
          <div class="home-col">
            <section class="home-card"><h3>${T('Cost by model')} <small>${T('Week to date')}</small></h3>${models}</section>
            <section class="home-card"><h3>${T('Top projects')} <small>${T('Week to date')}</small></h3>${projects}</section>
          </div>
          <div class="home-col">
            <section class="home-card"><h3>${T('Plan limits')}</h3><div class="home-limits">${limit(T('5-hour'), pu.fiveHour)}${limit(T('Weekly'), pu.sevenDay)}</div></section>
            <section class="home-card"><h3>${T('Skills and plugins')} <small>${T('Week to date')}</small></h3>${toolsHtml}
              <div class="home-foot"><span>${T('Tool failures')} <b class="home-mono">${d.tools.errors}</b></span><span>${T('Permission denials')} <b class="home-mono">${d.tools.denials}</b></span></div>
            </section>
          </div>
        </div>
        <p class="home-notes">${notes.map(esc).join(' ')}</p>
      </div>`;
    },
  });
})(window);
