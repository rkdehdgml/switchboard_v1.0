# Switchboard desktop shell (Tauri v2)

A window, a server launcher and nothing else. The Codeman server keeps running **inside WSL**
(node-pty and tmux need Linux); this shell starts it, shows it in a WebView2 window and stops it
again. Fork-only: this directory is not part of the npm package and not an upstream PR target.

Status: **T9-1** (shell + local server security), **T7** (native folder dialog) and **T6** (Settings › Work folders). The installer,
first-run checks and the Linux payload are **T9-2**.

## Layout

```
desktop/
  dev.ps1                run the shell against this checkout (isolated instance), see below
  icon-src.png           source for `cargo tauri icon` (placeholder artwork)
  ui/                    the local "starting" / error page (index.html + status.js)
  wsl/bin/start|stop     run INSIDE WSL; T9-2 ships them as ~/.switchboard/bin/
  src-tauri/
    src/config.rs        %LOCALAPPDATA%\Switchboard\config.json + shell.log
    src/server.rs        wsl.exe command line, port probe, start / health / stop
    src/main.rs          window, single instance, shutdown, error screens
    capabilities/main.json   the whole IPC surface (see Security)
```

## Run it (development)

Needs the Windows toolchain once: Visual Studio Build Tools (C++ build tools + a Windows SDK),
Rust (MSVC) and `cargo install tauri-cli --version "^2" --locked`. WebView2 ships with Windows 11.

```powershell
.\desktop\dev.ps1            # build (debug) and run on port 3601
.\desktop\dev.ps1 -NoBuild   # run the last build
.\desktop\dev.ps1 -Port 3650
```

`dev.ps1` runs the server as `CODEMAN_INSTANCE=sbdev` (data `~/.codeman-sbdev`, tmux socket
`codeman-sbdev`, helper files under `~/.switchboard-dev` in WSL), so it never sees your real Codeman
sessions, and it reads `desktop\dev-config.json` instead of the real config. Close the window to stop
the server; tmux sessions of that instance stay. Build output goes to
`%LOCALAPPDATA%\Switchboard\build-target` (not into the checkout).

Tests: `cargo test` in `src-tauri` (config validation, command line building, probe, navigation
allowlist; one test runs the real WSL expander and skips itself where there is no WSL).

## How a launch works

1. Read `config.json` (missing = defaults, written out for you to edit; present but invalid = an error
   screen, never silently replaced).
2. Open the window on the local "starting" page.
3. Probe `127.0.0.1:<port>`:
   - nothing listening: go on;
   - a leftover **Switchboard** server (its 401 carries `X-Switchboard-Desktop: 1`): run `stop`, wait
     for the port, go on;
   - **anything else**: show the conflict and how to change the port. The port is never changed
     silently, because the WebView's `localStorage` is keyed by origin (port included).
4. `wsl.exe [-d <distro>] --exec bash -c <expander> <start> --host 127.0.0.1 --port <p>`, with a fresh
   64-hex token written to the child's **stdin** (never argv, which `ps` shows).
5. Poll `GET /api/status` with `Authorization: Bearer <token>` (60 s limit), then point the window at
   `http://127.0.0.1:<p>/__sb/enter?t=<token>`: that trades the token for an HttpOnly,
   SameSite=Strict cookie and moves on to `/`, so the token never stays in the address bar.
6. Closing the window runs `stop` explicitly (killing `wsl.exe` alone can leave Node running), then
   exits. **tmux sessions are not touched.** A second launch only focuses the first window.
7. If the server dies by itself the window shows an error page instead of a dead screen.

## config.json

`%LOCALAPPDATA%\Switchboard\config.json` (override the location with `SWITCHBOARD_CONFIG`):

| key | default | rule |
|---|---|---|
| `port` | `3600` | 1024 to 65535 |
| `distro` | WSL default | letters, digits, `.` `_` `-`; not starting with `-` |
| `start_command` | `~/.switchboard/bin/start` | plain path, no spaces, no `..`, no shell characters |
| `stop_command` | `~/.switchboard/bin/stop` | same |

Unknown keys are an error. The shell also appends to `shell.log` next to the config (size capped): the
only trace of what the shell did when something fails before a window exists.

Environment variables the server side honours (set them on Windows and list them in `WSLENV` to reach
WSL): `CODEMAN_INSTANCE` (own data dir + tmux socket), `SWITCHBOARD_HOME`, `SWITCHBOARD_APP_DIR`,
`SWITCHBOARD_DEV=1` (run `src/` through tsx instead of `dist/`). Without `CODEMAN_INSTANCE` the start
script uses `~/.switchboard/data` and the tmux socket `switchboard`, never `~/.codeman`.

## Security

This server runs shells. Loopback is **not** a boundary: every process on the PC and every browser tab
can reach `127.0.0.1`. Desktop mode (`codeman web --desktop`, see `docs/architecture-invariants.md`,
"Desktop mode") therefore requires the per-launch token on every request, pins `Host` and `Origin`
to `127.0.0.1:<port>` / `localhost:<port>`, never binds anything but `127.0.0.1`, sends no CORS headers
and never starts the tunnel. Shell side:

- the window may only navigate to its own pages and `http://127.0.0.1:<port>` (`is_allowed_navigation`);
- the only IPC the page gets is `core:window:allow-set-theme` (title bar colour) and `dialog:allow-open`
  (the folder dialog), granted to `http://127.0.0.1:*` in `capabilities/main.json`; no shell, fs or opener
  plugin is installed, and the Rust side runs `wsl.exe` itself, so the page can run nothing. Whatever the
  dialog returns is only a request: the server converts and validates it (`/api/native-folder/validate`);
- every config value that reaches `wsl.exe` is checked against an allowlist and travels as an argument,
  never as shell text.

## Known limits (T9-1)

- Debug build only; the NSIS installer, payload and first-run checks are T9-2.
- The folder dialog is wired to Add Case → Link Existing → Browse and to Settings › Work folders (Browse, change default
  location) and to the project chip in a split panel's header (T8), all through the same `CodemanFolderPicker.choose()`. Work folders asks the server for the work-folder rules
  (`purpose: 'work-folder'`), so a folder on any drive can be registered; every other caller is limited to the path picker's roots. The title bar sync relies on `DWMWA_USE_IMMERSIVE_DARK_MODE`, verified on this one Windows 11 PC only.
- Page branding still says "Codeman" (the rename is a separate task in the spec).
- Real keyboard / Korean IME behaviour inside WebView2 was not checked by a person yet.
