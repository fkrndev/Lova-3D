//! Lova 3D project system: folder-based projects with a JSON manifest and a
//! SQLite index (scenes, assets, metadata) living in `.lova/index.db`.
use base64::Engine as _;
use crate::error::LovaError;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SceneRef {
    pub name: String,
    pub file: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AssetInfo {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    pub thumb: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProjectInfo {
    pub root: String,
    pub name: String,
    pub scenes: Vec<SceneRef>,
    pub assets: Vec<AssetInfo>,
}

fn subdirs() -> &'static [&'static str] {
    &[
        "scenes",
        "assets/models",
        "assets/textures",
        "assets/audio",
        "materials",
        "builds",
        ".lova/thumbs",
    ]
}

fn db_path(root: &Path) -> PathBuf {
    root.join(".lova").join("index.db")
}

fn open_db(root: &Path) -> Result<Connection, LovaError> {
    let conn = Connection::open(db_path(root)).map_err(|e| LovaError::db(format!("cannot open index.db: {e}")))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS scenes(
            name TEXT PRIMARY KEY,
            file TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assets(
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            imported_at TEXT NOT NULL,
            thumb TEXT
        );
        CREATE TABLE IF NOT EXISTS meta(
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )
    .map_err(|e| LovaError::db(format!("cannot initialize schema: {e}")))?;
    Ok(conn)
}

fn now_stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".into())
}

/// Joins `rel` under `root` while refusing path traversal.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, LovaError> {
    if rel.split(['/', '\\']).any(|part| part == "..") || rel.starts_with('~') {
        return Err(LovaError::illegal_path(format!("illegal project path: `{rel}`")));
    }
    Ok(root.join(rel))
}

fn read_info(root: &Path) -> Result<ProjectInfo, LovaError> {
    let manifest = root.join("project.json");
    let raw = fs::read_to_string(&manifest)
        .map_err(|e| LovaError::not_a_project(format!("not a Lova 3D project: {e}")))?;
    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| LovaError::io(format!("corrupt project.json: {e}")))?;
    let name = json["name"]
        .as_str()
        .ok_or_else(|| LovaError::io("corrupt project.json: missing name"))?
        .to_string();
    let conn = open_db(root)?;
    let mut scenes = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT name, file FROM scenes ORDER BY updated_at DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok(SceneRef {
                name: row.get(0)?,
                file: row.get(1)?,
            })
        })?;
        for row in rows {
            scenes.push(row?);
        }
    }
    let mut assets = Vec::new();
    {
        let mut stmt = conn.prepare("SELECT id, path, kind, bytes, thumb FROM assets ORDER BY imported_at DESC")?;
        let rows = stmt.query_map([], |row| {
            Ok(AssetInfo {
                id: row.get(0)?,
                path: row.get(1)?,
                kind: row.get(2)?,
                bytes: row.get::<_, i64>(3)? as u64,
                thumb: row.get(4)?,
            })
        })?;
        for row in rows {
            assets.push(row?);
        }
    }
    Ok(ProjectInfo {
        root: root.to_string_lossy().into_owned(),
        name,
        scenes,
        assets,
    })
}

#[tauri::command]
pub fn create_project(root: String, name: String) -> Result<ProjectInfo, LovaError> {
    let root_path = Path::new(&root);
    fs::create_dir_all(root_path).map_err(|e| LovaError::io(format!("cannot create `{root}`: {e}")))?;
    for dir in subdirs() {
        fs::create_dir_all(root_path.join(dir)).map_err(|e| LovaError::io(format!("cannot create `{dir}`: {e}")))?;
    }
    let manifest = serde_json::json!({
        "version": 1,
        "engine": "lova3d",
        "name": name,
        "mainScene": "scenes/main.scene.json",
    });
    fs::write(
        root_path.join("project.json"),
        serde_json::to_string_pretty(&manifest).map_err(|e| LovaError::io(e.to_string()))?,
    )
    .map_err(|e| LovaError::io(format!("cannot write project.json: {e}")))?;

    let conn = open_db(root_path)?;
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('name', ?1), ('created_at', ?2)",
        params![name, now_stamp()],
    )?;
    read_info(root_path)
}

#[tauri::command]
pub fn open_project(root: String) -> Result<ProjectInfo, LovaError> {
    let root_path = Path::new(&root);
    if !root_path.join("project.json").is_file() {
        return Err(LovaError::not_a_project(format!(
            "`{root}` is not a Lova 3D project (missing project.json)"
        )));
    }
    // Self-heal any missing folders/schema from older projects.
    for dir in subdirs() {
        let _ = fs::create_dir_all(root_path.join(dir));
    }
    read_info(root_path)
}

#[tauri::command]
pub fn project_save_scene(
    root: String,
    file: String,
    name: String,
    contents: String,
) -> Result<(), LovaError> {
    let root_path = Path::new(&root);
    let target = safe_join(root_path, &file)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| LovaError::io(format!("cannot create `{file}`: {e}")))?;
    }
    fs::write(&target, &contents).map_err(|e| LovaError::io(format!("cannot write `{file}`: {e}")))?;
    let conn = open_db(root_path)?;
    conn.execute(
        "INSERT INTO scenes(name, file, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(name) DO UPDATE SET file = ?2, updated_at = ?3",
        params![name, file, now_stamp()],
    )?;
    Ok(())
}

#[tauri::command]
pub fn import_asset(root: String, source: String, kind: String) -> Result<AssetInfo, LovaError> {
    let allowed = ["models", "textures", "audio"];
    let kind = if allowed.contains(&kind.as_str()) {
        kind
    } else {
        "models".to_string()
    };
    let root_path = Path::new(&root);
    let source_path = Path::new(&source);
    let original = source_path
        .file_name()
        .ok_or_else(|| LovaError::io("import source has no file name"))?
        .to_string_lossy()
        .into_owned();

    // Avoid overwriting: append a counter when the name already exists.
    let mut dest_name = original.clone();
    let mut counter = 1;
    loop {
        let dest = root_path.join("assets").join(&kind).join(&dest_name);
        if !dest.exists() {
            break;
        }
        counter += 1;
        let stem = Path::new(&original).file_stem().unwrap_or_default().to_string_lossy();
        let ext = Path::new(&original).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
        dest_name = format!("{stem}-{counter}{ext}");
    }

    let dest = root_path.join("assets").join(&kind).join(&dest_name);
    fs::copy(source_path, &dest).map_err(|e| LovaError::io(format!("cannot import `{source}`: {e}")))?;
    let bytes = fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);

    let id = format!("a{}", now_stamp());
    let rel = format!("assets/{kind}/{dest_name}");
    let conn = open_db(root_path)?;
    conn.execute(
        "INSERT INTO assets(id, path, kind, bytes, imported_at, thumb) VALUES (?1, ?2, ?3, ?4, ?5, NULL)",
        params![id, rel, kind, bytes as i64, now_stamp()],
    )?;
    Ok(AssetInfo {
        id,
        path: rel,
        kind,
        bytes,
        thumb: None,
    })
}

#[tauri::command]
pub fn list_assets(root: String) -> Result<Vec<AssetInfo>, LovaError> {
    Ok(read_info(Path::new(&root))?.assets)
}

#[tauri::command]
pub fn set_asset_thumb(root: String, id: String, png_b64: String) -> Result<(), LovaError> {
    let root_path = Path::new(&root);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_b64.trim_start_matches("data:image/png;base64,"))
        .map_err(|e| LovaError::io(format!("invalid base64 thumbnail: {e}")))?;
    let rel = format!(".lova/thumbs/{id}.png");
    let target = safe_join(root_path, &rel)?;
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&target, bytes).map_err(|e| LovaError::io(format!("cannot write thumbnail: {e}")))?;
    let conn = open_db(root_path)?;
    conn.execute("UPDATE assets SET thumb = ?1 WHERE id = ?2", params![rel, id])?;
    Ok(())
}

#[tauri::command]
pub fn read_project_file_b64(root: String, file: String) -> Result<String, LovaError> {
    let target = safe_join(Path::new(&root), &file)?;
    let bytes = fs::read(&target).map_err(|e| LovaError::io(format!("cannot read `{file}`: {e}")))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn write_project_file_b64(root: String, file: String, b64: String) -> Result<(), LovaError> {
    let target = safe_join(Path::new(&root), &file)?;
    if let Some(parent) = target.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&b64)
        .map_err(|e| LovaError::io(format!("invalid base64 payload: {e}")))?;
    fs::write(&target, bytes).map_err(|e| LovaError::io(format!("cannot write `{file}`: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("lova3d-proj-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn create_project_builds_the_full_layout() {
        let root = temp_root("create");
        let info = create_project(root.to_string_lossy().into_owned(), "MyGame".into()).unwrap();
        assert_eq!(info.name, "MyGame");
        assert!(root.join("project.json").is_file());
        for dir in subdirs() {
            assert!(root.join(dir).is_dir(), "missing {dir}");
        }
        assert!(root.join(".lova").join("index.db").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn open_project_roundtrips_and_rejects_strangers() {
        let root = temp_root("open");
        create_project(root.to_string_lossy().into_owned(), "Round".into()).unwrap();
        let info = open_project(root.to_string_lossy().into_owned()).unwrap();
        assert_eq!(info.name, "Round");

        let empty = temp_root("empty");
        fs::create_dir_all(&empty).unwrap();
        let err = open_project(empty.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(err.kind, "not_a_project");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&empty);
    }

    #[test]
    fn save_scene_writes_file_and_index() {
        let root = temp_root("save");
        let r = root.to_string_lossy().into_owned();
        create_project(r.clone(), "S".into()).unwrap();
        project_save_scene(r.clone(), "scenes/main.scene.json".into(), "Main".into(), "{}".into())
            .unwrap();
        assert!(root.join("scenes").join("main.scene.json").is_file());
        let info = open_project(r).unwrap();
        assert_eq!(info.scenes.len(), 1);
        assert_eq!(info.scenes[0].name, "Main");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_asset_copies_and_deduplicates_names() {
        let root = temp_root("import");
        let r = root.to_string_lossy().into_owned();
        create_project(r.clone(), "I".into()).unwrap();

        let src = root.join("robot.glb");
        fs::write(&src, b"glb-payload").unwrap();
        let a1 = import_asset(r.clone(), src.to_string_lossy().into_owned(), "models".into()).unwrap();
        let a2 = import_asset(r.clone(), src.to_string_lossy().into_owned(), "models".into()).unwrap();
        assert_ne!(a1.path, a2.path, "second import must not overwrite");
        assert!(a2.path.contains("robot-2.glb"));
        assert!(root.join(&a1.path).is_file());
        assert_eq!(a1.bytes, 11);

        let info = open_project(r).unwrap();
        assert_eq!(info.assets.len(), 2);
        assert_eq!(info.assets[0].kind, "models");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn thumbnail_and_b64_roundtrip() {
        let root = temp_root("b64");
        let r = root.to_string_lossy().into_owned();
        create_project(r.clone(), "B".into()).unwrap();
        write_project_file_b64(r.clone(), ".lova/thumbs/x.png".into(), "aGVsbG8=".into()).unwrap();
        assert_eq!(read_project_file_b64(r, ".lova/thumbs/x.png".into()).unwrap(), "aGVsbG8=");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_traversal_is_refused_with_typed_error() {
        let root = temp_root("traverse");
        let r = root.to_string_lossy().into_owned();
        create_project(r.clone(), "T".into()).unwrap();
        let err = read_project_file_b64(r.clone(), "../project.json".into()).unwrap_err();
        assert_eq!(err.kind, "illegal_path");
        assert!(write_project_file_b64(r, "a/../../escape.txt".into(), "aGVsbG8=".into()).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
