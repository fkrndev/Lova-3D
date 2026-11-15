use std::fs;
use std::path::Path;

/// Writes a serialized LovaEngine scene to disk.
/// The path always comes from a native save dialog on the frontend,
/// so no extra filesystem scope is needed here.
#[tauri::command]
fn save_scene(path: String, contents: String) -> Result<(), String> {
    fs::write(Path::new(&path), contents).map_err(|e| format!("failed to write `{path}`: {e}"))
}

/// Reads a scene file chosen through a native open dialog.
#[tauri::command]
fn load_scene(path: String) -> Result<String, String> {
    fs::read_to_string(Path::new(&path)).map_err(|e| format!("failed to read `{path}`: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_scene, load_scene])
        .run(tauri::generate_context!())
        .expect("error while running LovaEngine");
}
