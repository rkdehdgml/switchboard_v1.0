//! Switchboard desktop shell: one window, the WSL server launcher, and nothing else.
//!
//! Startup: open the window on a local "starting" page, start the server in the background, then
//! point the window at `http://127.0.0.1:<port>/__sb/enter?t=<token>`. Closing the window stops the
//! server explicitly (tmux sessions keep running). A second launch only focuses the first window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod server;

use config::Config;
use server::Running;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const WINDOW: &str = "main";

struct AppState {
    /// `None` when config.json was unusable (the window then shows that error and nothing starts).
    config: Option<Config>,
    server: Mutex<Option<Running>>,
    shutting_down: AtomicBool,
}

/// Point the window at `target` (an app page or the server). Quoted through JSON, so no value can
/// break out of the string.
fn navigate(app: &AppHandle, target: &str) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        if let Ok(quoted) = serde_json::to_string(target) {
            let _ = window.eval(format!("window.location.replace({quoted})"));
        }
    }
}

fn show_error(app: &AppHandle, code: &str, detail: &str, port: u16) {
    navigate(app, &server::error_page(code, detail, port));
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Stop the server, then exit. Runs once; later calls are ignored.
fn shutdown(app: &AppHandle) {
    let state = app.state::<AppState>();
    if state.shutting_down.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    config::log("close requested: stopping the server");
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let running = state.server.lock().ok().and_then(|mut s| s.take());
        match (running, &state.config) {
            (Some(running), Some(config)) => running.stop(config),
            // Startup may still be in flight: the stop script only signals a verified Switchboard pid.
            (None, Some(config)) => server::run_stop(config),
            _ => {}
        }
        config::log("server stopped, exiting");
        app.exit(0);
    });
}

/// Start the server off the UI thread, then hand the window over to it.
fn launch_server(app: AppHandle, config: Config) {
    std::thread::spawn(move || {
        let token = server::new_token();
        match server::start(&config, &token) {
            Ok(running) => {
                let state = app.state::<AppState>();
                if state.shutting_down.load(Ordering::SeqCst) {
                    running.stop(&config);
                    return;
                }
                if let Ok(mut slot) = state.server.lock() {
                    *slot = Some(running);
                }
                config::log(&format!("server is up on port {}", config.port));
                navigate(&app, &server::enter_url(config.port, &token));
                watch_server(app, config.port);
            }
            Err(error) => {
                config::log(&format!("start failed: {} {}", error.code(), error.detail()));
                show_error(&app, error.code(), &error.detail(), config.port)
            }
        }
    });
}

/// If the server dies on its own (not because we are shutting down), say so instead of leaving a
/// dead page in the window.
fn watch_server(app: AppHandle, port: u16) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let state = app.state::<AppState>();
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let exited = match state.server.lock() {
            Ok(mut slot) => match slot.as_mut().map(|r| r.child.try_wait()) {
                Some(Ok(Some(status))) => {
                    slot.take();
                    Some(status.code())
                }
                _ => None,
            },
            Err(_) => return,
        };
        if let Some(code) = exited {
            let detail = code.map(|c| c.to_string()).unwrap_or_default();
            show_error(&app, "server_exited", &detail, port);
            return;
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| focus_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (config, config_error) = match config::load() {
                Ok(config) => (Some(config), None),
                Err(message) => (None, Some(message)),
            };
            let port = config.as_ref().map(|c| c.port).unwrap_or(config::DEFAULT_PORT);

            app.manage(AppState { config: config.clone(), server: Mutex::new(None), shutting_down: AtomicBool::new(false) });

            let window = WebviewWindowBuilder::new(app, WINDOW, WebviewUrl::App("index.html?state=starting".into()))
                .title("Switchboard")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(move |url| server::is_allowed_navigation(url, port))
                .build()?;

            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    config::log("CloseRequested received");
                    api.prevent_close();
                    shutdown(&handle);
                }
            });

            match (config, config_error) {
                (Some(config), _) => launch_server(app.handle().clone(), config),
                (None, message) => {
                    show_error(app.handle(), "config_invalid", &message.unwrap_or_default(), port);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Switchboard desktop shell");
}
