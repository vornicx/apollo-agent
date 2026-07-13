use std::{fs, path::PathBuf, process::{Child, Command, Stdio}, sync::Mutex, time::Duration};
use tauri::Manager;

struct RuntimeProcess(Mutex<Option<Child>>);

fn start_runtime(resource_dir: PathBuf, state_dir: PathBuf) -> Result<Child, String> {
    let node = resource_dir.join("runtime").join(if cfg!(windows) { "node.exe" } else { "node" });
    let runtime = resource_dir.join("runtime").join("apollo-runtime.cjs");
    if !node.exists() || !runtime.exists() {
        return Err(format!("embedded Apollo Runtime is missing from {}", resource_dir.display()));
    }
    fs::create_dir_all(&state_dir).map_err(|error| format!("could not create Apollo state directory: {error}"))?;
    let workspace = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| state_dir.clone());
    Command::new(node)
        .arg(runtime)
        .args(["dashboard", "--port", "4317"])
        .current_dir(workspace)
        .env("APOLLO_STATE_DIR", state_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("could not start embedded Apollo Runtime: {error}"))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
            let state_dir = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
            let child = start_runtime(resource_dir, state_dir)?;
            app.manage(RuntimeProcess(Mutex::new(Some(child))));
            std::thread::sleep(Duration::from_millis(350));
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<RuntimeProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.as_mut() { let _ = child.kill(); }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Apollo Desktop");
}
