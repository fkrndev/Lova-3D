mod asset_protocol;
mod error;
mod physics;
mod project;

use error::LovaError;
use std::fs;
use std::path::Path;

/// Writes a serialized Lova 3D scene to disk.
/// The path always comes from a native save dialog on the frontend,
/// so no extra filesystem scope is needed here.
#[tauri::command]
fn save_scene(path: String, contents: String) -> Result<(), LovaError> {
    fs::write(Path::new(&path), &contents)
        .map_err(|e| LovaError::io(format!("failed to write `{path}`: {e}")))
}

/// Reads a scene file chosen through a native open dialog.
#[tauri::command]
fn load_scene(path: String) -> Result<String, LovaError> {
    fs::read_to_string(Path::new(&path))
        .map_err(|e| LovaError::io(format!("failed to read `{path}`: {e}")))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("lovaasset", |_ctx, request| asset_protocol::handle(request))
        .manage(std::sync::Arc::new(std::sync::Mutex::new(physics::PhysicsState::default())))
        .invoke_handler(tauri::generate_handler![
            save_scene,
            load_scene,
            project::create_project,
            project::open_project,
            project::project_save_scene,
            project::import_asset,
            project::list_assets,
            project::set_asset_thumb,
            project::read_project_file_b64,
            project::write_project_file_b64,
            physics::physics_world_create,
            physics::physics_step,
            physics::physics_set_velocity,
            physics::physics_teleport,
            physics::physics_run,
            physics::physics_set_running,
            physics::physics_joint_add,
            physics::physics_raycast,
            physics::physics_world_destroy
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lova 3D");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("lova3d-test-{}-{}", name, std::process::id()));
        p
    }

    #[test]
    fn save_then_load_roundtrips() {
        let path = temp_path("roundtrip.json");
        let contents = r#"{"version":1,"name":"roundtrip","objects":[]}"#;
        save_scene(path.to_string_lossy().into_owned(), contents.to_string()).unwrap();
        let loaded = load_scene(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(loaded, contents);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_overwrites_existing_files() {
        let path = temp_path("overwrite.json");
        save_scene(path.to_string_lossy().into_owned(), "v1".into()).unwrap();
        save_scene(path.to_string_lossy().into_owned(), "v2-longer".into()).unwrap();
        assert_eq!(load_scene(path.to_string_lossy().into_owned()).unwrap(), "v2-longer");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_missing_file_returns_a_helpful_error() {
        let err = load_scene("Z:/definitely/missing/lova3d-scene.json".to_string()).unwrap_err();
        assert!(err.message.contains("failed to read"), "unexpected error: {err}");
        assert!(err.message.contains("missing"), "unexpected error: {err}");
        assert_eq!(err.kind, "io");
    }

    #[test]
    fn save_to_an_invalid_path_returns_an_error() {
        let err = save_scene("Z:/no/such/dir/scene.json".to_string(), "{}".to_string()).unwrap_err();
        assert!(err.message.contains("failed to write"), "unexpected error: {err}");
    }
}
