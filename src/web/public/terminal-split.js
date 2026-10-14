// src/web/public/terminal-split.js

/**
 * @fileoverview SplitTerminalPane — an independent live terminal pane (Pane B, C or D)
 * for split-view sessions, and the split work area around it (Switchboard T5: up to four
 * panes, side by side or stacked, pane headers, focus, saved layout). Deliberately plainer than the primary
 * pane (this.terminal/this._ws in terminal-ui.js): no local-echo overlay, no
 * CJK IME, no touch/mobile handlers, no keyboard accessory bar. Desktop-only
 * feature by nature — see docs/split-pane-sessions-plan.md.
 *
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js
 * @dependency constants.js (window.CodemanTerminalFont, DEFAULT_SCROLLBACK, TERMINAL_TAIL_SIZE, TERMINAL_CHUNK_SIZE)
 * @dependency terminal-ui.js (codemanCurrentXtermTheme, codemanCurrentSkinIsLight)
 * @loadorder 7.5 of 16 — loaded after terminal-ui.js, before respawn-ui.js
 */

(function (global) {
  /**
   * Minimal chunked write for Pane B's own xterm instance — write() in
   * TERMINAL_CHUNK_SIZE slices, yielding a frame between each, instead of one
   * giant synchronous write that blocks the main thread while parsing a long
   * scrollback. Deliberately NOT the primary pane's chunkedTerminalWrite
   * (terminal-ui.js): that one is wired into session-switch generation
   * counters and the live-output gate this simpler, independently
   * created/destroyed pane has no equivalent of.
   */
  function writeChunked(terminal, buffer, isDestroyed) {
    if (!buffer) return Promise.resolve();
    if (buffer.length <= TERMINAL_CHUNK_SIZE) {
      terminal.write(buffer);
      return Promise.resolve();
    }
    // Resolves once the LAST chunk is written (or the pane was destroyed
    // mid-replay), so _loadBuffer() below can hold its single-flight flag
    // across the whole replay rather than just the fetch that precedes it.
    return new Promise((resolve) => {
      let offset = 0;
      const writeNext = () => {
        if (isDestroyed() || !terminal) {
          resolve();
          return;
        }
        const chunk = buffer.slice(offset, offset + TERMINAL_CHUNK_SIZE);
        offset += chunk.length;
        terminal.write(chunk);
        if (offset < buffer.length) {
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(writeNext);
          else setTimeout(writeNext, 16);
        } else {
          resolve();
        }
      };
      writeNext();
    });
  }

  class SplitTerminalPane {
    constructor(sessionId, mountEl, opts = {}) {
      this.sessionId = sessionId;
      this.mountEl = mountEl;
      this.sessionMode = opts.mode;
      this.fontSettings = opts.fontSettings || {};
      // Live reference (not a snapshot) to the app's detachedSessions Set —
      // detaching this session AFTER the split is already open must still be
      // seen by _sendResize() below, or it re-creates the exact PTY-size
      // fight the split picker already refuses to open at pick time.
      this.detachedSessions = opts.detachedSessions;
      this.terminal = null;
      this.fitAddon = null;
      this.ws = null;
      this._wsReady = false;
      this._destroyed = false;
      // Single-flight state for _loadBuffer()/_refreshBuffer() below.
      this._bufferLoading = false;
      this._bufferRefreshPending = false;
    }

    async connect() {
      const savedFontSize = parseInt(localStorage.getItem('codeman-font-size'), 10);
      this.terminal = new Terminal({
        theme: { ...global.codemanCurrentXtermTheme() },
        fontFamily: global.CodemanTerminalFont.resolve(this.fontSettings.terminalFontFamily),
        ...global.CodemanTerminalFont.resolveWeights(this.fontSettings),
        fontSize: Number.isFinite(savedFontSize) ? savedFontSize : 14,
        lineHeight: 1.2,
        cursorBlink: false,
        cursorStyle: 'block',
        minimumContrastRatio: global.codemanCurrentSkinIsLight() ? 4.5 : 1,
        scrollback: DEFAULT_SCROLLBACK,
        allowTransparency: true,
        allowProposedApi: true,
      });

      this.fitAddon = new FitAddon.FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.open(this.mountEl);
      this.fitAddon.fit();

      this.terminal.onData((data) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ t: 'i', d: data }));
        }
      });

      // Pane B has no gates of its own by default, so every app-level chord
      // that the document capture-phase handler (app.js) only preventDefault()s
      // — never stopPropagation()s — reaches xterm here too and writes its raw
      // byte/escape sequence into THIS session's PTY on top of whatever the app
      // action already did to Pane A (COD-153; mirrors the primary pane's own
      // gates at terminal-ui.js's attachCustomKeyEventHandler: command palette,
      // Alt+1-9/[/] tab nav, Alt+B sidebar toggle, Ctrl+Z suspend, Shift/Ctrl+Enter
      // newline, and smart-copy Ctrl+C/Ctrl+Shift+C). Routed through the same
      // registry-aware predicates so a rebind or a disable restores plain
      // terminal behavior here too. Ctrl+V is deliberately left on xterm's own
      // default (plain-text paste): Pane B has no image-paste trap to route it
      // to, so intercepting it here would only break paste.
      this.terminal.attachCustomKeyEventHandler((ev) => {
        if (ev.isComposing || ev.key === 'Process' || ev.keyCode === 229) return true;
        if (
          ev.altKey &&
          !ev.ctrlKey &&
          !ev.shiftKey &&
          /^(Digit[1-9]|BracketLeft|BracketRight|KeyK)$/.test(ev.code || '')
        ) {
          return false;
        }
        if (ev.type === 'keydown' && global.app?.shouldOpenCommandPaletteFromShortcut?.(ev)) {
          return false;
        }
        if (ev.type === 'keydown' && global.app?.shouldToggleSessionSidebarFromShortcut?.(ev)) {
          return false;
        }
        // Ctrl+Z (SIGTSTP/job-control suspend): mirrors terminal-ui.js's own
        // swallow — in a plain shell session this is the user's own
        // job-control tool and must reach the PTY, but in every other mode
        // (claude/omp/pi/codex/...) it silently stops an unattended agent
        // loop dead. Pane B has its own PTY/session and must not send a
        // suspend into a non-shell one just because the primary pane's own
        // gate lives elsewhere.
        if (
          ev.type === 'keydown' &&
          ev.key.toLowerCase() === 'z' &&
          ev.ctrlKey &&
          !ev.altKey &&
          !ev.metaKey &&
          !ev.shiftKey &&
          this.sessionMode !== 'shell'
        ) {
          return false;
        }
        // Shift+Enter / Ctrl+Enter: insert a newline instead of submitting.
        // Mirrors terminal-ui.js's own handling — xterm sends plain \r for
        // every Enter variant, so an Ink app (Claude Code) can't tell a
        // newline from a submit. Without this gate, Pane B's onData would
        // send that bare \r straight over the WS and submit an incomplete
        // prompt instead of adding a line to it. Targets THIS pane's own
        // session (this.sessionId), never the primary pane's
        // activeSessionId, and has no local-echo overlay of its own to flush
        // first (Pane B is deliberately plainer — see the fileoverview).
        if (ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey) && ev.type === 'keydown') {
          fetch(`/api/sessions/${this.sessionId}/send-key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: ev.ctrlKey ? 'C-Enter' : 'S-Enter' }),
          }).catch(() => {
            /* Best-effort, matching this pane's tolerance elsewhere. */
          });
          return false;
        }
        // Smart copy (mirrors terminal-ui.js's Ctrl+C gate, #211): with a
        // selection, Ctrl+C copies THIS pane's own selection instead of
        // sending ^C; with none, plain Ctrl+C must fall through unchanged or
        // the interrupt key is lost. Ctrl+Shift+C is different: it is the
        // explicit, never-falls-through copy chord, and the predicate above
        // does not distinguish it from plain Ctrl+C — ev.shiftKey does, below.
        // xterm's own evaluateKeyboardEvent routes a shifted ctrl-letter into
        // a branch that assigns c.key only for a couple of special cases
        // ("_"->US, "@"->NUL), neither of which is "c", so it emits NOTHING
        // for Ctrl+Shift+C either way — this is not about an accidental
        // interrupt byte reaching the PTY (verified live: it does not).
        // Gating this whole block on hasSelection() (an earlier draft) meant
        // that with no selection Ctrl+Shift+C skipped straight to `return
        // true`, silently ceding the keystroke to the BROWSER's own handling
        // (e.g. Chrome's Inspect-Element binding) with no feedback and no
        // attempt to copy, unlike Pane A, which always intercepts it.
        // Re-implemented against this.terminal rather than reusing
        // app.copyTerminalSelection(), which reads app.terminal — Pane A's —
        // and would copy the wrong pane's selection.
        if (ev.type === 'keydown' && global.app?.shouldCopyTerminalSelectionFromShortcut?.(ev)) {
          const raw = this.terminal?.getSelection?.() || '';
          const isColumnSelection = this.terminal?._core?._selectionService?._activeSelectionMode === 3;
          // Both clean options are read for THIS pane, never the primary one:
          // the gutter width comes from this.sessionId's own run mode, and the
          // partial-first-line flag from this terminal's own selection range.
          // Passing neither left Pane B keeping a margin Pane A dropped, on the
          // same split and the same keystroke.
          const range = global.app?._normalisedSelectionRange?.(this.terminal);
          const selection = isColumnSelection
            ? raw
            : (global.CodemanCopySelection?.clean?.(raw, {
                margin: global.app?._cliGutterColumns?.(this.sessionId) ?? 0,
                firstLinePartial: !!range && range.start.x > 0,
              }) ?? raw);
          if (selection.trim()) {
            ev.preventDefault();
            void global.app._copyText?.(selection).then((ok) => {
              this.terminal?.clearSelection?.();
              global.app.showToast?.(ok ? 'Copied to clipboard' : 'Failed to copy', ok ? 'success' : 'error');
            });
            return false;
          }
          // Nothing worth copying — clear for feedback (a padding-only
          // selection cleans to '' and this press still falls through to the
          // PTY as 0x03, matching the primary pane's own rule).
          if (this.terminal?.hasSelection?.()) {
            this.terminal.clearSelection?.();
            global.app.showToast?.('Nothing to copy', 'warning');
          }
          // Ctrl+Shift+C never falls through, even with nothing to copy —
          // matches terminal-ui.js's own ev.shiftKey branch.
          if (ev.shiftKey) {
            ev.preventDefault();
            return false;
          }
        }
        return true;
      });

      // Load existing scrollback before going live. The WS below is
      // subscribe-only (ws-routes.ts sends nothing on connect, only future
      // 'terminal' events), so without this Pane B stays blank until the
      // target session happens to produce new output. It LOOKED
      // intermittent rather than always-broken because _sendResize() below
      // often nudges the shared session's real tmux window to a new size,
      // and tmux repaints its current screen on resize — that repaint was
      // getting captured and streamed here, incidentally populating the
      // pane. When Pane B's computed dimensions happened to already match
      // the session's last-known size, Session.resize() (session.ts) skips
      // the resize as a no-op, no repaint fires, and the pane stayed blank.
      // The await covers the whole chunked replay, not just the fetch, so a
      // live frame from the socket below can never land in the middle of it.
      await this._loadBuffer();
      if (this._destroyed) return;

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}${window.CodemanBase.base}/ws/sessions/${this.sessionId}/terminal`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this._wsReady = true;
        this._sendResize();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.t === 'o') {
            this.terminal.write(msg.d);
          } else if (msg.t === 'c') {
            this.terminal.clear();
          } else if (msg.t === 'r') {
            // Server-triggered refresh (SSE backpressure cleared, terminal
            // data was dropped). The primary pane routes this to
            // _onSessionNeedsRefresh (app.js:2990) — Pane B has its own
            // buffer loader for the same reason connect() does.
            this._refreshBuffer();
          }
        } catch {
          /* Malformed frame — ignore, matches primary pane's tolerance. */
        }
      };

      // Mirror app.js's onclose/onerror pattern (app.js:2905-2964): _wsReady
      // must go false on a drop or fit()/_sendResize() silently no-ops on a
      // closed socket per the WebSocket spec (no exception, no log). No
      // reconnect logic here — Pane B is deliberately plainer than the
      // primary pane (see the fileoverview above); a drop just stops
      // resizing until the parent recreates the pane. But onData already
      // silently drops keystrokes while _wsReady is false (below), so
      // without a visible marker a dropped socket left Pane B looking
      // normal while it quietly ate everything typed into it. v1 scope is
      // "say so", not reconnect — collapsing the split would lose the
      // user's place in Pane B's scrollback for a transient blip.
      this.ws.onclose = () => {
        this._wsReady = false;
        this.terminal?.write('\r\n\x1b[2m[Panel disconnected — close it and reopen the split to reconnect]\x1b[0m\r\n');
      };

      this.ws.onerror = () => {
        // onclose fires after onerror — cleanup happens there.
      };
    }

    // Fetches and writes the session's current scrollback. Used both by
    // connect() (initial load) and by the `{t:'r'}` server-refresh frame
    // (below) — the primary pane's own _onSessionNeedsRefresh (app.js) is
    // scoped to `this.activeSessionId` and clears/rewrites the primary
    // terminal, neither of which applies to this independent pane, so this is
    // a standalone equivalent rather than a call into it.
    //
    // Mirrors the primary pane's own mode check (app.js's selectSession /
    // _onSessionNeedsRefresh): a shell session can retain hundreds of
    // thousands of plain scrollback lines, so pulling `?full=1` there parses
    // an unbounded, server-capped (up to terminalBufferMaxBytes, 32MB) body
    // into a 50000-line xterm on every load. Non-shell (TUI) sessions still
    // get one full replay. `fetch` here goes through the global wrapper
    // (constants.js), which already prefixes CodemanBase — unlike the raw
    // WebSocket URL above, which does not.
    //
    // Single-flight: the flag is held across the fetch AND the chunked write
    // (writeChunked resolves after its last chunk), so two replays can never
    // interleave their chunks into one terminal. A second call while one is
    // in flight is dropped here; _refreshBuffer() is the caller that queues
    // a trailing re-run instead.
    async _loadBuffer() {
      if (this._bufferLoading) return;
      this._bufferLoading = true;
      try {
        const query = this.sessionMode === 'shell' ? `tail=${TERMINAL_TAIL_SIZE}` : 'full=1';
        const res = await fetch(`/api/sessions/${this.sessionId}/terminal?${query}`);
        const payload = (await res.json())?.data ?? {};
        if (payload.terminalBuffer && this.terminal) {
          await writeChunked(this.terminal, payload.terminalBuffer, () => this._destroyed);
        }
      } catch {
        /* Best-effort — live output still arrives once the socket connects. */
      } finally {
        this._bufferLoading = false;
      }
      if (this._bufferRefreshPending && !this._destroyed) {
        this._bufferRefreshPending = false;
        this._refreshBuffer();
      }
    }

    // The `{t:'r'}` server-refresh path: clear, then replay. Two refresh
    // frames in a row used to start two concurrent replays, each clearing
    // the terminal under the other's chunked write. A refresh that arrives
    // mid-replay is COALESCED into one trailing re-run rather than ignored:
    // the in-flight fetch may predate the drop the new frame is reporting,
    // and no further frame is coming to correct stale content.
    _refreshBuffer() {
      if (this._bufferLoading) {
        this._bufferRefreshPending = true;
        return;
      }
      this.terminal?.clear();
      void this._loadBuffer();
    }

    // Local reflow only — no PTY resize frame. Split out so a divider drag
    // can reflow both panes at the browser's paint rate (rAF) while sending
    // the actual `{t:'z'}` resize once, at drag end, matching the primary
    // pane's own convention (throttledResize in terminal-ui.js).
    localFit() {
      if (!this.fitAddon) return;
      this.fitAddon.fit();
    }

    fit() {
      this.localFit();
      this._sendResize();
    }

    _sendResize() {
      if (!this._wsReady || !this.fitAddon) return;
      // One PTY cannot hold two sizes (mirrors sendResize's own
      // detachedElsewhere yield in terminal-ui.js): the session got detached
      // to its own window AFTER this split was opened, so its own window now
      // owns the PTY's size and Pane B must stand aside.
      if (this.detachedSessions?.has(this.sessionId)) return;
      const dims = this.fitAddon.proposeDimensions();
      if (!dims) return;
      // Send the real proposed dimensions unclamped, matching the primary
      // pane's convention (terminal-ui.js's getTerminalDimensions()) — the
      // server enforces its own valid range ([1,500]/[1,200] in ws-routes.ts).
      // A 40/10 floor here misreported Pane B's real width to the PTY at the
      // divider's own reachable 20% floor position, causing real
      // output-wrapping bugs.
      this.ws.send(JSON.stringify({ t: 'z', c: dims.cols, r: dims.rows, v: 'desktop' }));
    }

    destroy() {
      this._destroyed = true;
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        // onclose fires asynchronously AFTER close(); without this it ran
        // its "disconnected" write against a pane already torn down.
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
        this.ws = null;
      }
      if (this.terminal) {
        this.terminal.dispose();
        this.terminal = null;
      }
      this.fitAddon = null;
    }
  }

  global.SplitTerminalPane = SplitTerminalPane;
})(window);

// ─────────────────────────────────────────────────────────────────────────────
// The split work area (Switchboard T5).
//
// State (all on the app, all null/empty while no split is open):
//   _splitTree         binary layout tree (constants.js CodemanSplitPane.split*), or null
//   _splitPrimaryKey   key of Pane A's leaf (always the first leaf; A is this.terminal/this._ws)
//   _splitFocusKey     key of the focused pane
//   _splitRecs         Map key → { el, header, body, pane } for every leaf; `pane` is the
//                      SplitTerminalPane of a non-primary leaf that holds a session, else null
//   _splitContainerEl  the root element (.terminal-split-container)
// A non-primary leaf's session lives in the tree (`s`); Pane A's is always activeSessionId.
// ─────────────────────────────────────────────────────────────────────────────

// English i18n keys: the pane header's state dot carries its meaning as text, not colour alone.
const SPLIT_CHEVRON_SVG =
  '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const SPLIT_FOLDER_SVG =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

const SPLIT_STATE_LABEL = {
  needs: 'Needs response',
  error: 'Error',
  waiting: 'Waiting',
  working: 'Running',
  idle: 'Idle',
  done: 'Done',
};

Object.assign(CodemanApp.prototype, {
  /**
   * Desktop-only gate, same shape as home-sessions.js's shouldShowHomeSessions
   * + matchMedia backstop: a JS width check (so openSplitPane() below can
   * refuse even if a click somehow reaches the button) plus a live listener,
   * because a window narrowed WHILE the button is showing must hide it
   * without waiting for a settings save or reload. The CSS `@media
   * (max-width: 1179px)` rule in styles.css is the backstop for the reverse
   * direction: it hides the button even if this JS never runs at all.
   */
  _applySplitButtonVisibility(enabled) {
    this._splitButtonSettingEnabled = enabled;
    const splitBtn = document.querySelector('.btn-split');
    const wide = window.innerWidth >= SPLIT_PANE_MIN_WIDTH;
    // Narrowing past the gate must not leave an open split on screen with no
    // way to reach the button that would close it — the two 240px min-widths
    // plus the divider overflow a narrow window and .main clips Pane B's edge.
    if (!wide && this._splitTree) this.closeSplitPane();
    if (!splitBtn) return;
    splitBtn.classList.toggle('btn-split--hidden', !enabled || !wide);
    if (!this._splitButtonWidthListenerInstalled && window.matchMedia) {
      this._splitButtonWidthListenerInstalled = true;
      const mq = window.matchMedia(`(min-width: ${SPLIT_PANE_MIN_WIDTH}px)`);
      mq.addEventListener('change', () => this._applySplitButtonVisibility(this._splitButtonSettingEnabled));
    }
  },

  // ── small readers ──────────────────────────────────────────────────────────

  _splitLeaves() {
    return this._splitTree ? window.CodemanSplitPane.splitLeaves(this._splitTree) : [];
  },

  /** The SplitTerminalPane objects of the non-primary panes (empty panes have none). */
  _splitTerminalPanes() {
    const out = [];
    for (const rec of this._splitRecs?.values?.() ?? []) if (rec.pane) out.push(rec.pane);
    return out;
  },

  /** Session id shown in a pane: Pane A's is the active session, the others' live in the tree. */
  _splitSessionOfLeaf(leaf) {
    return leaf.key === this._splitPrimaryKey ? this.activeSessionId : leaf.s;
  },

  /** Every session currently shown in a pane. */
  _splitShownSessionIds() {
    return new Set(
      this._splitLeaves()
        .map((leaf) => this._splitSessionOfLeaf(leaf))
        .filter(Boolean)
    );
  },

  /** 'A'..'D' for a session shown in a pane, '' for one that is not (used by the rail's badges). */
  _splitLetterForSession(sessionId) {
    const leaves = this._splitLeaves();
    for (let i = 0; i < leaves.length; i++) {
      if (this._splitSessionOfLeaf(leaves[i]) === sessionId) return window.CodemanSplitPane.splitLetter(i);
    }
    return '';
  },

  _splitNextKey() {
    this._splitKeySeq = (this._splitKeySeq || 0) + 1;
    return this._splitKeySeq;
  },

  _splitParentDirOf(key) {
    const find = (node) => {
      if (node.t === 'p') return null;
      if ((node.a.t === 'p' && node.a.key === key) || (node.b.t === 'p' && node.b.key === key)) return node.d;
      return find(node.a) || find(node.b);
    };
    return this._splitTree ? find(this._splitTree) : null;
  },

  // ── picker ─────────────────────────────────────────────────────────────────

  /**
   * opts.dir: 'row' (side by side, default) or 'col' (stacked): how the FOCUSED pane is split.
   * opts.assignKey: put the picked session into that existing pane instead of adding one.
   */
  openSplitPicker(event, anchor, opts = {}) {
    // Mirrors toggleRunModeMenu (session-ui.js): stopPropagation on the
    // OPENING click so it never reaches the outside-click listener this
    // same call is about to register — without it, a click landing on the
    // button's own inner <svg> (matched by neither `menu.contains()` nor
    // the old exact-node check below) bubbled straight through to
    // `document` and self-closed the menu it just opened.
    event?.stopPropagation();
    const assignKey = opts.assignKey ?? null;
    if (assignKey === null && this._splitTree && !window.CodemanSplitPane.splitCanAddPane(this._splitTree)) {
      this._notifySplitLimit();
      return;
    }
    // Sessions already in a pane are not offered, except the one in the pane being reassigned.
    const exclude = this._splitShownSessionIds();
    if (assignKey !== null) {
      const own = this._splitLeaves().find((leaf) => leaf.key === assignKey);
      if (own) exclude.delete(this._splitSessionOfLeaf(own));
    }
    if (assignKey === null) exclude.add(this.activeSessionId);
    const candidates = window.CodemanSplitPane.buildSplitPickerSessions(
      this.sessions,
      this.sessionOrder,
      exclude,
      this.detachedSessions
    );
    // Route a pre-existing menu through the SAME dismiss path used
    // everywhere else, instead of a raw `.remove()`: a genuinely still-open
    // menu has live document listeners (see below), and a raw removal left
    // them attached forever — only the single-slot field below got
    // overwritten, so every prior pair but the last was orphaned on
    // `document` with no way to ever find and remove it again.
    this._dismissSplitPicker();

    const menu = document.createElement('div');
    menu.id = 'splitPickerMenu';
    menu.className = 'split-picker-menu';
    if (candidates.length === 0) {
      menu.innerHTML = '<div class="split-picker-empty">No other sessions to split with</div>';
    } else {
      const dir = opts.dir === 'col' ? 'col' : 'row';
      menu.innerHTML = candidates
        .map((c) => {
          const call =
            assignKey === null
              ? `app.openSplitPane(${JSON.stringify(c.id)}, ${JSON.stringify({ dir })})`
              : `app._splitAssignSession(${JSON.stringify(assignKey)}, ${JSON.stringify(c.id)})`;
          // data-i18n-skip: the whole row's text IS a session name — i18n.js
          // does exact-string lookup over text nodes, and a session
          // literally named e.g. "Sessions" would otherwise get translated
          // on zh-CN (see the .session-name skip on the pane header below).
          return `<button type="button" class="split-picker-item" data-i18n-skip onclick="${escapeHtml(call)}; app._dismissSplitPicker();">${escapeHtml(c.label)}</button>`;
        })
        .join('');
    }
    document.body.appendChild(menu);
    // The header split button is opt-in and usually hidden (zero rect), so the other triggers pass their own element.
    const splitBtn = anchor || document.querySelector('.btn-split');
    if (splitBtn) {
      const rect = splitBtn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = `${rect.bottom + 4}px`;
      // The header button sits at the far right (grow leftwards); any other trigger sits further left.
      if (anchor) menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`;
      else menu.style.right = `${window.innerWidth - rect.right}px`;
    }

    // Dismiss on outside click or Escape — same one-shot listener pattern as
    // session-ui.js's other transient popovers (toggleCaseSettings(),
    // toggleRunModeMenu()). Deferred by a tick so the click that OPENED the
    // menu (still bubbling) doesn't immediately close it — reinforced by
    // the button's own stopPropagation() above, which is what actually
    // stops that same click reaching `document` at all. Picking an item
    // (above) calls the SAME dismiss method, so these listeners never
    // outlive the menu either way.
    //
    // Self-removing by identity: each handler removes ITSELF (and its
    // sibling) the moment it fires, rather than leaning solely on the
    // `this._splitPickerDismissHandlers` field. That field is still kept in
    // sync (so `_dismissSplitPicker()` called from elsewhere — the picker
    // item's onclick above, or a still-open menu at the top of this method
    // — can find and remove the CURRENT pair), but no path here can ever
    // again leave a pair attached to `document` with nothing referencing it.
    const closeOnOutsideClick = (e) => {
      if (menu.contains(e.target) || e.target.closest('.btn-split, .split-trigger')) return;
      document.removeEventListener('click', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      this._splitPickerDismissHandlers = null;
      menu.remove();
    };
    const closeOnEscape = (e) => {
      if (e.key !== 'Escape') return;
      document.removeEventListener('click', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      this._splitPickerDismissHandlers = null;
      menu.remove();
    };
    this._splitPickerDismissHandlers = { closeOnOutsideClick, closeOnEscape };
    setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 0);
    document.addEventListener('keydown', closeOnEscape);
  },

  _dismissSplitPicker() {
    document.getElementById('splitPickerMenu')?.remove();
    if (this._splitPickerDismissHandlers) {
      document.removeEventListener('click', this._splitPickerDismissHandlers.closeOnOutsideClick);
      document.removeEventListener('keydown', this._splitPickerDismissHandlers.closeOnEscape);
      this._splitPickerDismissHandlers = null;
    }
  },

  _notifySplitLimit() {
    this.showToast?.('A split holds at most 4 panels', 'warning');
  },

  // ── open / close ───────────────────────────────────────────────────────────

  /** Why a session cannot go into a pane, or '' when it can. Shared by openSplitPane and assign. */
  _splitRefusal(sessionId) {
    // A stale picker click (opened before switching tabs) or clicking another
    // pane's own session tab while split can otherwise land here with a
    // session that is already shown: two live WebSockets to the same
    // session, each independently claiming PTY dimensions via its own `{t:'z',...}`
    // resize frame. Refuse before creating any DOM or SplitTerminalPane.
    if (this._splitShownSessionIds().has(sessionId) || sessionId === this.activeSessionId) return 'shown';
    // The picker's own exclusions (buildSplitPickerSessions in constants.js),
    // re-applied here: the menu can sit open while a listed session's CLI
    // exits (pid → null) or gets popped out to its own window, and nothing
    // re-runs the picker filter for a row that already rendered. Same
    // outcome as the picker gives such a session (not offered, silently):
    // one with no PTY has nothing reading its pane, so the pane would show
    // nothing and drop every keystroke behind a healthy-looking socket, and
    // a detached session's own window already owns its PTY size.
    const session = this.sessions.get(sessionId);
    if (!session || session.pid === null) return 'no-pty';
    if (this.detachedSessions?.has?.(sessionId)) return 'detached';
    return '';
  },

  /**
   * Add a pane holding `sessionId` by splitting the focused pane (opts.targetKey overrides) in
   * opts.dir ('row' side by side, the default; 'col' stacked).
   */
  openSplitPane(sessionId, opts = {}) {
    // Desktop-only hard gate, independent of the button's own hidden state —
    // see _applySplitButtonVisibility's comment for why both a JS check and
    // a CSS backstop exist.
    if (window.innerWidth < SPLIT_PANE_MIN_WIDTH) return;
    // No active session means there is no `.terminal-wrap` to split against
    // (the welcome overlay is showing) — without this, a split opened from
    // the home screen still created the container and connected the pane, just
    // behind the opaque overlay with nothing visible to show for it.
    if (!this.activeSessionId) return;
    // A web tab hides `.terminal-wrap`'s container via CSS with nothing
    // gating the button itself, and `activeSessionId` survives openWebview()
    // — without this, picking a session opens a socket behind a
    // hidden container with nothing on screen to show for it.
    if (this.activeWebviewId) return;
    if (this._splitRefusal(sessionId)) return;
    // Nothing to split without the primary pane's own element; check BEFORE any state changes.
    if (!document.querySelector('.terminal-wrap')) return;
    const CS = window.CodemanSplitPane;
    if (this._splitTree && !CS.splitCanAddPane(this._splitTree)) {
      this._notifySplitLimit();
      return;
    }
    const wasClosed = !this._splitTree;
    if (wasClosed) {
      this._splitPrimaryKey = this._splitNextKey();
      this._splitTree = { t: 'p', key: this._splitPrimaryKey, s: null };
      this._splitRecs = new Map();
      this._splitFocusKey = this._splitPrimaryKey;
    }
    const target = this._splitLeaves().some((l) => l.key === opts.targetKey) ? opts.targetKey : this._splitFocusKey;
    const newKey = this._splitNextKey();
    const next = CS.splitAddPane(this._splitTree, target, opts.dir === 'col' ? 'col' : 'row', {
      t: 'p',
      key: newKey,
      s: sessionId,
    });
    if (!next) {
      if (wasClosed) this._splitResetState();
      return;
    }
    this._splitTree = next;
    this._renderSplitTree();
    this._splitStartPane(newKey);
    this._setSplitFocus(newKey, { focusTerminal: true });
    this._afterSplitLayoutChange();
  },

  /**
   * Close the pane with `options.key`, or with no key the whole split. Closing the second-to-last
   * pane collapses back to the single view. `skipPrimaryResize`: see the Pane-A-ends branch below.
   */
  closeSplitPane(options = {}) {
    if (!this._splitTree) return;
    // A split can collapse MID-DRAG (either session ending, the window
    // narrowing past the gate, a click on another pane's own tab). The drag's own
    // onUp is what normally clears `body.split-pane-resizing` (a col-resize
    // cursor plus user-select:none on EVERY element, styles.css), and it
    // relied on pointer capture routing pointerup back to a divider this
    // method detaches below, so a mid-drag collapse left the whole page
    // locked in resize mode until a reload. Tear the drag down first.
    this._splitDividerDragTeardown?.();
    this._splitDividerDragTeardown = null;
    const CS = window.CodemanSplitPane;
    const extraKeys = this._splitLeaves()
      .filter((leaf) => leaf.key !== this._splitPrimaryKey)
      .map((leaf) => leaf.key);
    const keys = options.key !== undefined ? extraKeys.filter((k) => k === options.key) : extraKeys;
    for (const key of keys) {
      const rec = this._splitRecs.get(key);
      rec?.pane?.destroy();
      rec?.el?.remove();
      this._splitRecs.delete(key);
      this._splitTree = CS.splitRemovePane(this._splitTree, key) ?? this._splitTree;
    }
    if (!this._splitLeaves().some((leaf) => leaf.key === this._splitFocusKey)) {
      this._splitFocusKey = this._splitPrimaryKey;
    }
    if (this._splitLeaves().length > 1) {
      this._renderSplitTree();
      this._afterSplitLayoutChange(options);
      return;
    }

    // Down to Pane A alone: put .terminal-wrap back where it was and drop the container.
    const container = this._splitContainerEl;
    const wrap = container?.querySelector('.terminal-wrap');
    if (container && wrap) {
      const parent = container.parentElement;
      wrap.style.flexBasis = '';
      parent.insertBefore(wrap, container);
      container.remove();
    }
    this._splitPrimaryEl?.remove();
    this._splitResetState();
    this._updateSplitButtonState(false);
    this.renderSessionTabs?.(); // drop the rail's panel badges

    if (this.fitAddon) this.fitAddon.fit();
    // The Pane-A-ends branch of the _onSessionDeleted wrapper below collapses the split
    // while activeSessionId is still the id the server just removed, so a
    // resize from here would be aimed at a session that no longer exists;
    // the promoted session gets its own resize from selectSession().
    if (!options.skipPrimaryResize) {
      this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});
    }
  },

  _splitResetState() {
    this._splitTree = null;
    this._splitPrimaryKey = null;
    this._splitFocusKey = null;
    this._splitRecs = new Map();
    this._splitContainerEl = null;
    this._splitPrimaryEl = null;
  },

  /** Repaint everything that mirrors the layout after a pane was added or removed. */
  _afterSplitLayoutChange(options = {}) {
    this._updateSplitButtonState(true);
    this._updateSplitHeaders();
    this.renderSessionTabs?.(); // the rail's panel badges
    // Every pane just changed size. Nothing has told the PTY of Pane A, or of the other panes,
    // yet — the passive ResizeObserver in terminal-ui.js debounces 300ms and would eventually
    // catch up, but relying on that left a pane showing stale-width content (existing
    // box-drawing lines, banners) until the user hit "Redraw Terminal".
    requestAnimationFrame(() => {
      this.fitAddon?.fit();
      for (const pane of this._splitTerminalPanes()) pane.fit();
      if (!options.skipPrimaryResize) {
        this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});
      }
    });
  },

  // ── DOM ────────────────────────────────────────────────────────────────────

  /** Element for a leaf: built once per leaf and reused, so a re-render never rebuilds an xterm. */
  _splitLeafEl(leaf) {
    let rec = this._splitRecs.get(leaf.key);
    if (rec) return rec.el;
    const el = document.createElement('div');
    el.className = 'split-leaf terminal-pane-b';
    el.dataset.splitKey = String(leaf.key);
    const header = this._splitBuildHeader(leaf.key);
    const body = document.createElement('div');
    body.className = 'terminal-pane-b-container';
    el.append(header.el, body);
    rec = { el, header, body, pane: null };
    this._splitRecs.set(leaf.key, rec);
    el.addEventListener('focusin', () => this._setSplitFocus(leaf.key));
    el.addEventListener('pointerdown', () => this._setSplitFocus(leaf.key));
    return el;
  },

  /** Pane A's wrapper: the pane header on top of the untouched .terminal-wrap. */
  _splitEnsurePrimaryEl() {
    if (this._splitPrimaryEl) return this._splitPrimaryEl;
    const el = document.createElement('div');
    el.className = 'split-leaf split-leaf--primary';
    el.dataset.splitKey = String(this._splitPrimaryKey);
    const header = this._splitBuildHeader(this._splitPrimaryKey);
    el.append(header.el);
    this._splitRecs.set(this._splitPrimaryKey, { el, header, body: null, pane: null });
    el.addEventListener('focusin', () => this._setSplitFocus(this._splitPrimaryKey));
    el.addEventListener('pointerdown', () => this._setSplitFocus(this._splitPrimaryKey));
    this._splitPrimaryEl = el;
    return el;
  },

  /** Header: [letter] name ●state [project ▾] ───── $cost [×]. Filled by _updateSplitHeaders(). */
  _splitBuildHeader(key) {
    const el = document.createElement('div');
    el.className = 'split-pane-header terminal-pane-b-header';
    el.setAttribute('role', 'group');
    const mk = (tag, className) => {
      const node = document.createElement(tag);
      node.className = className;
      return node;
    };
    const letter = mk('span', 'split-pane-letter');
    letter.setAttribute('data-i18n-skip', '');
    const name = mk('span', 'session-name split-pane-name');
    // data-i18n-skip: a session literally named "Sessions" must not be translated.
    name.setAttribute('data-i18n-skip', '');
    const dot = mk('span', 'split-pane-dot');
    // The session name is the button that swaps the SESSION shown in this panel (T5's picker); the project
    // chip beside it changes the session's project FOLDER (T8). Two different questions, two buttons.
    const sessionBtn = mk('button', 'split-pane-session split-trigger');
    sessionBtn.type = 'button';
    sessionBtn.setAttribute('aria-haspopup', 'menu');
    sessionBtn.setAttribute('aria-label', 'Change the session in this panel');
    sessionBtn.title = 'Change the session in this panel';
    sessionBtn.append(name);
    sessionBtn.insertAdjacentHTML('beforeend', SPLIT_CHEVRON_SVG);
    sessionBtn.addEventListener('click', (e) => this.openSplitPicker(e, sessionBtn, { assignKey: key }));
    const project = mk('button', 'split-pane-project split-trigger psw-trigger');
    project.type = 'button';
    project.setAttribute('aria-haspopup', 'dialog');
    project.setAttribute('aria-label', 'Change the project of this session');
    project.title = 'Change the project of this session';
    const projectName = mk('span', 'split-pane-project-name');
    projectName.setAttribute('data-i18n-skip', '');
    project.insertAdjacentHTML('beforeend', SPLIT_FOLDER_SVG);
    project.append(projectName);
    project.insertAdjacentHTML('beforeend', SPLIT_CHEVRON_SVG);
    project.addEventListener('click', (e) => {
      const leaf = this._splitLeaves().find((l) => l.key === key);
      const sessionId = leaf ? this._splitSessionOfLeaf(leaf) : null;
      // An empty panel has no project yet: the chip falls back to choosing a session for it.
      if (!sessionId || !window.CodemanProjectSwitch) this.openSplitPicker(e, project, { assignKey: key });
      else window.CodemanProjectSwitch.open(e, project, { app: this, key, sessionId });
    });
    const spacer = mk('span', 'split-pane-spacer');
    const cost = mk('span', 'split-pane-cost');
    cost.setAttribute('data-i18n-skip', '');
    el.append(letter, sessionBtn, dot, project, spacer, cost);
    let close = null;
    if (key !== this._splitPrimaryKey) {
      close = mk('button', 'terminal-pane-b-close');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close panel');
      close.title = 'Close panel';
      close.innerHTML = '&times;';
      close.addEventListener('click', () => this.closeSplitPane({ key }));
      el.append(close);
    }
    return { el, letter, name, sessionBtn, dot, project, projectName, cost, close };
  },

  /** Rebuild the nested containers from the tree, reparenting the (persistent) leaf elements. */
  _renderSplitTree() {
    const tree = this._splitTree;
    if (!tree) return;
    const wrap = document.querySelector('.terminal-wrap');
    if (!wrap) return;
    let marker = null;
    if (!this._splitContainerEl) {
      // First split: remember where .terminal-wrap sits before it moves into Pane A's wrapper.
      marker = document.createComment('split');
      wrap.parentElement.insertBefore(marker, wrap);
      this._splitEnsurePrimaryEl().append(wrap);
    }
    const build = (node) => {
      if (node.t === 'p') {
        return node.key === this._splitPrimaryKey ? this._splitPrimaryEl : this._splitLeafEl(node);
      }
      const el = document.createElement('div');
      el.className = `split-node split-node--${node.d}`;
      el.dataset.splitNode = String(node.key);
      const a = build(node.a);
      const b = build(node.b);
      a.style.flexBasis = `${node.r}%`;
      b.style.flexBasis = `${100 - node.r}%`;
      const divider = document.createElement('div');
      divider.className = `split-divider split-divider--${node.d}`;
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-orientation', node.d === 'row' ? 'vertical' : 'horizontal');
      divider.setAttribute('aria-label', 'Resize panels');
      divider.setAttribute('aria-valuemin', '20');
      divider.setAttribute('aria-valuemax', '80');
      divider.setAttribute('aria-valuenow', String(Math.round(node.r)));
      divider.tabIndex = 0;
      divider.dataset.splitNode = String(node.key);
      el.append(a, divider, b);
      this._installSplitDividerDrag(divider, node.key, node.d);
      return el;
    };
    const root = build(tree);
    root.classList.add('terminal-split-container');
    if (marker) marker.replaceWith(root);
    else this._splitContainerEl.replaceWith(root);
    this._splitContainerEl = root;
    this._updateSplitFocusClass();
  },

  /** Start the xterm + socket for a leaf that holds a session, or show the empty-pane prompt. */
  _splitStartPane(key) {
    const leaf = this._splitLeaves().find((l) => l.key === key);
    const rec = this._splitRecs.get(key);
    if (!leaf || !rec || rec.pane) return;
    rec.body.textContent = '';
    const session = leaf.s ? this.sessions.get(leaf.s) : null;
    if (!session) {
      const empty = document.createElement('button');
      empty.type = 'button';
      empty.className = 'split-empty split-trigger';
      empty.textContent = 'Choose a session';
      empty.addEventListener('click', (e) => this.openSplitPicker(e, empty, { assignKey: key }));
      rec.body.append(empty);
      return;
    }
    rec.pane = new window.SplitTerminalPane(leaf.s, rec.body, {
      mode: session.mode,
      fontSettings: this.loadAppSettingsFromStorage?.() || {},
      detachedSessions: this.detachedSessions,
    });
    rec.pane.connect().catch(() => {
      /* Best-effort, matching the primary pane's own tolerance for a failed
         initial load — live output still arrives once/if the socket connects. */
    });
  },

  /** Put another session into an existing pane (header ▾ and the empty-pane button). */
  _splitAssignSession(key, sessionId) {
    if (!this._splitTree || this._splitRefusal(sessionId)) return;
    if (key === this._splitPrimaryKey) {
      this.selectSession(sessionId);
      return;
    }
    const rec = this._splitRecs.get(key);
    if (!rec) return;
    rec.pane?.destroy();
    rec.pane = null;
    this._splitTree = window.CodemanSplitPane.splitSetSession(this._splitTree, key, sessionId);
    this._splitStartPane(key);
    this._updateSplitHeaders();
    this.renderSessionTabs?.();
    requestAnimationFrame(() => rec.pane?.fit());
  },

  /** Names, state dots and costs in the pane headers; cheap (four at most), so called on every refresh. */
  _updateSplitHeaders() {
    if (!this._splitTree) return;
    const leaves = this._splitLeaves();
    leaves.forEach((leaf, index) => {
      const rec = this._splitRecs.get(leaf.key);
      if (!rec) return;
      const h = rec.header;
      const letter = window.CodemanSplitPane.splitLetter(index);
      const sessionId = this._splitSessionOfLeaf(leaf);
      const session = sessionId ? this.sessions.get(sessionId) : null;
      const name = session ? this.getSessionName?.(session) || session.name || 'Session' : 'Empty';
      h.letter.textContent = letter;
      h.name.textContent = name;
      h.el.setAttribute('aria-label', `Panel ${letter}: ${name}`);
      const state = session ? this._mobileOverviewState?.(session, this.pendingHooks?.get?.(sessionId)) : 'idle';
      h.dot.className = `split-pane-dot split-pane-dot--${state || 'idle'}`;
      const stateLabel = SPLIT_STATE_LABEL[state] || '';
      h.dot.title = stateLabel;
      h.dot.setAttribute('role', 'img');
      h.dot.setAttribute('aria-label', stateLabel);
      const folder = session?.workingDir ? String(session.workingDir).split(/[\\/]/).filter(Boolean).pop() : '';
      h.projectName.textContent = folder || 'Choose a session';
      const cost = Number(session?.totalCost);
      h.cost.textContent = Number.isFinite(cost) && cost > 0 ? `$${cost.toFixed(2)}` : '';
      rec.el.classList.toggle('split-leaf--empty', !session);
    });
  },

  // ── focus ──────────────────────────────────────────────────────────────────

  _setSplitFocus(key, opts = {}) {
    if (!this._splitTree || !this._splitLeaves().some((l) => l.key === key)) return;
    const changed = this._splitFocusKey !== key;
    this._splitFocusKey = key;
    if (changed) {
      this._updateSplitFocusClass();
      this._updateSplitButtonState(true);
    }
    if (opts.focusTerminal) {
      if (key === this._splitPrimaryKey) this.terminal?.focus?.();
      else this._splitRecs.get(key)?.pane?.terminal?.focus?.();
    }
  },

  _updateSplitFocusClass() {
    for (const [key, rec] of this._splitRecs ?? []) {
      rec.el.classList.toggle('split-leaf--focused', key === this._splitFocusKey);
    }
  },

  // ── buttons ────────────────────────────────────────────────────────────────

  // The header .btn-split gets `.split-open` + aria-pressed (the same active-state language as the
  // codebase's other toggle buttons: keyboard-accessory's Ctrl key, the voice-input mic). The two
  // rail buttons show the direction the focused pane is split in, and go aria-disabled at four panes.
  _updateSplitButtonState(open) {
    const full = !!this._splitTree && !window.CodemanSplitPane.splitCanAddPane(this._splitTree);
    const btn = document.querySelector('.btn-split');
    if (btn) {
      btn.classList.toggle('split-open', open);
      btn.setAttribute('aria-pressed', open ? 'true' : 'false');
      const title = full
        ? 'A split holds at most 4 panels'
        : open
          ? 'Split: add another panel'
          : 'Split: open a second session beside this one';
      btn.title = title;
      btn.setAttribute('aria-label', title);
    }
    const current = this._splitTree ? this._splitParentDirOf(this._splitFocusKey) : null;
    for (const railBtn of document.querySelectorAll('.tab-rail-split-btn')) {
      const dir = railBtn.dataset.dir;
      const title = full
        ? 'A split holds at most 4 panels'
        : dir === 'row'
          ? 'Split side by side'
          : 'Split top and bottom';
      railBtn.classList.toggle('is-current', current === dir);
      railBtn.setAttribute('aria-pressed', current === dir ? 'true' : 'false');
      railBtn.setAttribute('aria-disabled', full ? 'true' : 'false');
      railBtn.title = title;
      railBtn.setAttribute('aria-label', title);
    }
  },

  /** The rail's two split buttons: open the picker to split the focused panel. */
  onSplitButton(event, dir) {
    event?.stopPropagation?.();
    if (this._splitTree && !window.CodemanSplitPane.splitCanAddPane(this._splitTree)) {
      this._notifySplitLimit();
      return;
    }
    this.openSplitPicker(event, event?.currentTarget, { dir });
  },

  // ── divider drag ───────────────────────────────────────────────────────────

  /** Local reflow of every pane (no PTY resize frame): the cheap half of a resize. */
  _splitLocalFitAll() {
    this.fitAddon?.fit();
    for (const pane of this._splitTerminalPanes()) pane.localFit();
  },

  /** Apply `percent` to one branch: its two children's basis, the tree, and the ARIA value. */
  _splitApplyRatio(nodeEl, nodeKey, percent) {
    const children = [...nodeEl.children];
    if (children.length !== 3) return;
    children[0].style.flexBasis = `${percent}%`;
    children[2].style.flexBasis = `${100 - percent}%`;
    children[1].setAttribute('aria-valuenow', String(Math.round(percent)));
    this._splitTree = window.CodemanSplitPane.splitSetRatio(this._splitTree, nodeKey, percent);
  },

  /** The one PTY resize per gesture, after a drag or a run of arrow keys. */
  _splitCommitResize() {
    this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});
    for (const pane of this._splitTerminalPanes()) pane.fit();
  },

  _installSplitDividerDrag(divider, nodeKey, dir) {
    let dragging = false;
    let dragRaf = null;
    let pendingPoint = null;
    let capturedPointerId = null;
    let lastPercent = null;

    // Local-only reflow (flexBasis + every pane's xterm fit, no PTY resize
    // frame). Coalesced to one call per animation frame below — a raw
    // mousemove stream fires far faster than the browser repaints, and
    // without the rAF gate each event did a full xterm reflow on every
    // pane AND sent each a `{t:'z'}` resize frame (SplitTerminalPane
    // has no client-side "dims unchanged" skip), which fanned out into a
    // `tmux resize-window` child plus a SIGWINCH per frame.
    const applyDragPercent = (point) => {
      const nodeEl = divider.parentElement;
      // The split can auto-collapse mid-drag (a pane's session ending, or its
      // close button) — closeSplitPane() removes the container from the DOM,
      // which detaches `divider` too, so `parentElement` is null on the very
      // next frame and every drag threw here until mouseup finally removed the listener.
      if (!nodeEl) return;
      const rect = nodeEl.getBoundingClientRect();
      const size = dir === 'row' ? rect.width : rect.height;
      if (!size) return;
      const raw = dir === 'row' ? ((point.x - rect.left) / size) * 100 : ((point.y - rect.top) / size) * 100;
      lastPercent = window.CodemanSplitPane.clampDividerPercent(raw);
      this._splitApplyRatio(nodeEl, nodeKey, lastPercent);
      this._splitLocalFitAll();
    };

    const onMove = (e) => {
      if (!dragging) return;
      pendingPoint = { x: e.clientX, y: e.clientY };
      if (dragRaf) return;
      dragRaf = requestAnimationFrame(() => {
        dragRaf = null;
        applyDragPercent(pendingPoint);
      });
    };

    // Everything pointerdown ARMS, undone in one place: the body-level
    // cursor/selection lock, the divider's dragging class, pointer capture,
    // the move/up/cancel listeners and a queued reflow frame. Shared by onUp
    // (a normal drag end) and by closeSplitPane(), via the teardown handle
    // stored below, for a split that collapses mid-drag: the pointerup that
    // would have run onUp is routed by pointer capture to a divider
    // closeSplitPane() has detached, so it never arrives. Idempotent, since
    // the teardown runs whether or not a drag is in progress.
    const endDrag = () => {
      dragging = false;
      divider.classList.remove('dragging');
      document.body.classList.remove('split-pane-resizing', 'split-pane-resizing--col');
      if (capturedPointerId !== null) {
        try {
          divider.releasePointerCapture(capturedPointerId);
        } catch {
          /* Already released (pointercancel/lostpointercapture beat us here). */
        }
        capturedPointerId = null;
      }
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
      divider.removeEventListener('pointercancel', onUp);
      if (dragRaf) {
        cancelAnimationFrame(dragRaf);
        dragRaf = null;
      }
    };

    const onUp = () => {
      // A reflow frame still queued at release carries the final pointer
      // position; apply it once, synchronously, so the panes end where the
      // pointer did rather than one frame short.
      const hadQueuedFrame = dragRaf !== null;
      endDrag();
      if (hadQueuedFrame && pendingPoint) applyDragPercent(pendingPoint);
      // Send the real PTY resize exactly once here, at drag end, for EVERY
      // pane — never per-move (matching the codebase's established
      // trailing-edge debounce convention, see throttledResize in
      // terminal-ui.js) so a fast drag doesn't flood dozens of intermediate
      // SIGWINCH/reflow states into scrollback or spawn a `tmux
      // resize-window` child per frame.
      if (lastPercent !== null) this._splitCommitResize();
    };

    // Pointer events + setPointerCapture (mirrors tab-rail-resize.js) instead
    // of mousedown/document-level mousemove: a plain mousedown drag selects
    // the text under the cursor as it crosses the terminals, and pointer
    // capture routes move/up straight to `divider` regardless of what's under
    // the cursor mid-drag, so no document-level listener leak is possible if
    // the pointer is released off-window. `body.split-pane-resizing` (mirrors
    // `body.tab-rail-resizing`) locks the cursor/selection for the drag.
    divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      lastPercent = null;
      divider.classList.add('dragging');
      document.body.classList.add('split-pane-resizing');
      document.body.classList.toggle('split-pane-resizing--col', dir === 'col');
      try {
        divider.setPointerCapture(e.pointerId);
        capturedPointerId = e.pointerId;
      } catch {
        /* Capture failed — the drag still works via the listeners below. */
      }
      divider.addEventListener('pointermove', onMove);
      divider.addEventListener('pointerup', onUp);
      divider.addEventListener('pointercancel', onUp);
      this._splitDividerDragTeardown = endDrag;
    });

    // Keyboard: arrows move the seam 2% (a separator that can only be dragged is mouse-only), and
    // the PTY resize waits for a quiet moment instead of firing per key repeat.
    divider.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -2, ArrowUp: -2, ArrowRight: 2, ArrowDown: 2 }[e.key];
      if (step === undefined || (dir === 'row') !== (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
      e.preventDefault();
      const nodeEl = divider.parentElement;
      if (!nodeEl) return;
      const current = Number(divider.getAttribute('aria-valuenow')) || 50;
      this._splitApplyRatio(nodeEl, nodeKey, window.CodemanSplitPane.clampDividerPercent(current + step));
      this._splitLocalFitAll();
      clearTimeout(this._splitKeyResizeTimer);
      this._splitKeyResizeTimer = setTimeout(() => this._splitCommitResize(), 300);
    });
  },

  // ── saved layout (rides the owner tab layout: GET/PUT /api/tab-layout) ─────

  async _splitFetchLayout() {
    const res = await fetch('/api/tab-layout');
    const body = await res.json();
    if (!res.ok || !body?.success) throw new Error(body?.error || 'Could not read the saved layout');
    return body.data.layout;
  },

  /**
   * Save the open split (sessions, direction, ratios, focus), or with no split open clear the
   * saved one. One read + one write; a version conflict is retried once against the layout the
   * server answered with.
   */
  async saveSplitLayout() {
    let split = null;
    if (this._splitTree) {
      const CS = window.CodemanSplitPane;
      // Pane A's leaf records the active session, which is what a restore selects first.
      const tree = CS.splitSetSession(this._splitTree, this._splitPrimaryKey, this.activeSessionId);
      split = CS.splitSerialize(tree, this._splitFocusKey);
    }
    try {
      let layout = await this._splitFetchLayout();
      for (let attempt = 0; attempt < 2; attempt++) {
        const { split: _old, ...rest } = layout;
        const res = await fetch('/api/tab-layout', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseVersion: layout.version, layout: split ? { ...rest, split } : rest }),
        });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.success) {
          this._savedSplit = body.data.layout.split || null;
          this.showToast?.(split ? 'Layout saved' : 'Saved layout cleared', 'success');
          return true;
        }
        if (res.status === 409 && body?.data?.layout) {
          layout = body.data.layout;
          continue;
        }
        throw new Error(body?.error || `HTTP ${res.status}`);
      }
      throw new Error('The layout changed elsewhere; try again');
    } catch (err) {
      this.showToast?.(`Could not save the layout: ${err?.message || err}`, 'error');
      return false;
    }
  },

  /**
   * Rebuild the saved split once per page load. A pane whose session is gone (or has no PTY, or is
   * popped out, or is already on screen) is left EMPTY with a chooser, never failing the rest.
   */
  async _restoreSplitLayout() {
    if (this._splitRestoreTried) return;
    this._splitRestoreTried = true;
    if (this.isSoloWindow || window.innerWidth < SPLIT_PANE_MIN_WIDTH || this._splitTree) return;
    let layout;
    try {
      layout = await this._splitFetchLayout();
    } catch {
      return; // best effort: no saved layout is the normal state
    }
    this._savedSplit = layout?.split || null;
    const CS = window.CodemanSplitPane;
    const parsed = CS.splitDeserialize(this._savedSplit, () => this._splitNextKey());
    if (!parsed || this._splitTree) return;
    const leaves = CS.splitLeaves(parsed.root);
    const primaryId = leaves[0].s;
    const primarySession = primaryId ? this.sessions.get(primaryId) : null;
    if (primarySession && primarySession.pid !== null && primaryId !== this.activeSessionId) {
      if (!this.detachedSessions?.has?.(primaryId)) await this.selectSession(primaryId, { auto: true });
    }
    if (!this.activeSessionId || this._splitTree) return;
    this._splitPrimaryKey = leaves[0].key;
    this._splitRecs = new Map();
    this._splitFocusKey = parsed.focusKey;
    let tree = CS.splitSetSession(parsed.root, this._splitPrimaryKey, null);
    const taken = new Set([this.activeSessionId]);
    for (const leaf of leaves.slice(1)) {
      const id = leaf.s;
      const ok = id && !taken.has(id) && this.sessions.get(id)?.pid != null && !this.detachedSessions?.has?.(id);
      if (ok) taken.add(id);
      else tree = CS.splitSetSession(tree, leaf.key, null);
    }
    this._splitTree = tree;
    this._renderSplitTree();
    for (const leaf of leaves.slice(1)) this._splitStartPane(leaf.key);
    this._afterSplitLayoutChange();
  },
});

// Pane headers follow the session list: a rename, a state change or a cost update all end in a
// tab-strip render, so this one hook keeps the headers current without a second subscription.
const _originalRenderSessionTabs = CodemanApp.prototype.renderSessionTabs;
if (typeof _originalRenderSessionTabs === 'function') {
  CodemanApp.prototype.renderSessionTabs = function (...args) {
    const result = _originalRenderSessionTabs.apply(this, args);
    this._updateSplitHeaders?.();
    return result;
  };
}

const _originalHandleInit = CodemanApp.prototype.handleInit;
if (typeof _originalHandleInit === 'function') {
  CodemanApp.prototype.handleInit = function (...args) {
    const result = _originalHandleInit.apply(this, args);
    void this._restoreSplitLayout?.();
    return result;
  };
}

const _originalOnSessionDeleted = CodemanApp.prototype._onSessionDeleted;
CodemanApp.prototype._onSessionDeleted = function (data) {
  const leaves = this._splitLeaves?.() ?? [];
  const gone = leaves.find((l) => l.key !== this._splitPrimaryKey && l.s === data.id);
  if (gone) {
    // A non-primary pane's session ended: that pane closes, the rest stay.
    this.closeSplitPane({ key: gone.key });
  } else if (this._splitTree && this.activeSessionId === data.id) {
    // Pane A's session ended: promote the next pane that holds a session. It becomes the single
    // primary session (its pane closes), and any other panes keep their place. This is an
    // app-driven selection, not the user clicking a tab, so it must not
    // spend the promoted session's idle alert (see the Approvals Inbox
    // acknowledgement rule in CLAUDE.md — only a human opening a session
    // acknowledges it).
    const next = leaves.find((l) => l.key !== this._splitPrimaryKey && l.s);
    const promoted = next?.s ?? null;
    // activeSessionId is still data.id here (the original handler below is
    // what retires it), so the closing resize would be aimed
    // at the session the server just removed. Skip it; selectSession() sizes
    // the promoted session itself.
    if (next) this.closeSplitPane({ key: next.key, skipPrimaryResize: true });
    else this.closeSplitPane({ skipPrimaryResize: true });
    // Closing Pane A's own tab (closeSession(), app.js) adds data.id to
    // _closingSessions BEFORE awaiting the delete, then owns the follow-up
    // selection itself once the delete lands — same race _onSessionDeleted's
    // own active-session handoff guards against (see its comment). Selecting
    // here too would fight it for which tab wins.
    if (promoted && !this._closingSessions.has(data.id)) {
      this.selectSession(promoted, { auto: true });
    }
  }
  return _originalOnSessionDeleted.call(this, data);
};

// I2: closes the pane that shows a session BEFORE the primary pane rebinds to it (clicking
// another pane's own session tab while split, or any other selectSession() call that targets a
// session a pane is showing). Without this, Pane A rebinds to a session that another pane's
// independent WebSocket is still attached to — two live WebSockets to one session, each
// claiming PTY dimensions via its own `{t:'z',...}` resize frame.
const _originalSelectSession = CodemanApp.prototype.selectSession;
CodemanApp.prototype.selectSession = function (sessionId, ...args) {
  const holder = (this._splitLeaves?.() ?? []).find((l) => l.key !== this._splitPrimaryKey && l.s === sessionId);
  if (holder) this.closeSplitPane({ key: holder.key });
  return _originalSelectSession.call(this, sessionId, ...args);
};

// ── drag a session from the rail/tab strip onto the work area (Switchboard T3 residual) ──────────
// The drop splits the pane under the pointer. The tree only ever adds a pane as a branch's SECOND
// child (Pane A stays first), so the new pane always lands right of / below its target: the
// preview shows exactly that half, whichever edge the pointer is nearest.
Object.assign(CodemanApp.prototype, {
  /** Why the dragged session cannot be dropped now, '' when it can. */
  _splitDropRefusal(sessionId) {
    if (window.innerWidth < SPLIT_PANE_MIN_WIDTH) return 'narrow';
    if (!this.activeSessionId || this.activeWebviewId) return 'no-active';
    if (this._splitTree && !window.CodemanSplitPane.splitCanAddPane(this._splitTree)) return 'limit';
    return this._splitRefusal(sessionId);
  },

  /** { el, key, dir } for the pane under the pointer; dir = the nearer edge's axis. */
  _splitDropTarget(x, y) {
    const hit = document.elementFromPoint(x, y);
    // The work area is .terminal-wrap, or the split container that took its place.
    const area = hit?.closest?.('.terminal-split-container, .terminal-wrap');
    if (!area) return null;
    const leaf = hit.closest('.split-leaf');
    const el = leaf || area;
    const key = leaf ? Number(leaf.dataset.splitKey) : null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const dx = Math.min(x - r.left, r.right - x) / r.width;
    const dy = Math.min(y - r.top, r.bottom - y) / r.height;
    return { rect: r, key: key ?? this._splitPrimaryKey ?? null, dir: dx < dy ? 'row' : 'col' };
  },

  _splitDropOverlay() {
    if (this._splitDropEl) return this._splitDropEl;
    const el = document.createElement('div');
    el.className = 'split-drop-overlay';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<div class="split-drop-preview"></div><div class="split-drop-label"></div>';
    document.body.appendChild(el);
    this._splitDropEl = el;
    return el;
  },

  _hideSplitDrop() {
    this._splitDropEl?.classList.remove('is-on', 'is-refused');
    this._splitDropPlan = null;
  },

  _onSplitDragStart(e) {
    const tab = e.target?.closest?.('.session-tab[data-id]');
    if (!tab) return;
    this._splitDragId = tab.dataset.id;
    try {
      e.dataTransfer.setData('text/plain', tab.dataset.id);
      if (e.dataTransfer.effectAllowed === 'uninitialized') e.dataTransfer.effectAllowed = 'move';
    } catch {
      /* some embedders freeze dataTransfer; the drag id above is what the drop reads */
    }
  },

  _onSplitDragOver(e) {
    const id = this._splitDragId;
    if (!id) return;
    const target = this._splitDropTarget(e.clientX, e.clientY);
    if (!target) {
      this._hideSplitDrop();
      return;
    }
    const refusal = this._splitDropRefusal(id);
    const overlay = this._splitDropOverlay();
    const { rect, dir } = target;
    overlay.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
    const preview = overlay.firstElementChild;
    preview.style.cssText =
      dir === 'row' ? 'left:50%;top:0;width:50%;height:100%' : 'left:0;top:50%;width:100%;height:50%';
    const label = overlay.lastElementChild;
    const labels = {
      narrow: 'Splitting needs a wider window',
      'no-active': 'Open a session first',
      limit: 'A split holds at most 4 panels',
      shown: 'Already shown in a panel',
      'no-pty': 'This session is not running',
      detached: 'This session is in its own window',
    };
    const text = refusal
      ? labels[refusal] || 'Cannot split here'
      : dir === 'row'
        ? 'Drop to split side by side'
        : 'Drop to split top and bottom';
    label.textContent = text; // translated by the i18n DOM observer, like every other label
    overlay.classList.toggle('is-refused', !!refusal);
    overlay.classList.add('is-on');
    this._splitDropPlan = refusal ? null : { id, key: target.key, dir };
    if (!refusal) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  },

  _onSplitDrop(e) {
    const plan = this._splitDropPlan;
    this._hideSplitDrop();
    if (!plan) return;
    e.preventDefault();
    // Re-check at drop time: the dragged session can have exited or been shown meanwhile.
    if (this._splitDropRefusal(plan.id)) return;
    this.openSplitPane(plan.id, { dir: plan.dir, targetKey: plan.key });
  },

  _installSplitDropListeners() {
    if (this._splitDropInstalled) return;
    this._splitDropInstalled = true;
    document.addEventListener('dragstart', (e) => this._onSplitDragStart(e));
    document.addEventListener('dragover', (e) => this._onSplitDragOver(e));
    // Leaving the window (relatedTarget null) or ending the drag anywhere clears the overlay.
    document.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) this._hideSplitDrop();
    });
    document.addEventListener('drop', (e) => this._onSplitDrop(e));
    document.addEventListener('dragend', () => {
      this._splitDragId = null;
      this._hideSplitDrop();
    });
  },
});

// app.js creates `window.app` in its own DOMContentLoaded handler, registered before this deferred
// script runs, so by the time this one fires the instance exists. (Unit-test fakes lack the API.)
if (typeof window.addEventListener === 'function') {
  window.addEventListener('DOMContentLoaded', () => window.app?._installSplitDropListeners?.());
}
