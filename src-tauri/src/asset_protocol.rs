//! `lovaasset://` — a custom URI scheme that streams project files straight
//! from disk into the webview, replacing base64-over-IPC for large assets.
//!
//! URL shape: `http://lovaasset.localhost/<percent-encoded rel>?root=<encoded root>`
//! (WebView2/WebKitGTK) or `lovaasset://localhost/...` (WKWebView).
//! Only folders containing a `project.json` (real Lova 3D projects) are served,
//! and path traversal out of the project root is refused.
use percent_encoding::percent_decode_str;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::http::{Request, Response, StatusCode};

const SCHEME_HOSTS: [&str; 2] = ["lovaasset.localhost", "localhost"];

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("glb") => "model/gltf-binary",
        Some("gltf") => "model/gltf+json",
        Some("bin") => "application/octet-stream",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("json") => "application/json",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        _ => "application/octet-stream",
    }
}

fn etag_for(meta: &fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("\"lova-{}-{}\"", meta.len(), mtime)
}

/// Joins `rel` under `root` while refusing path traversal.
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.split(['/', '\\']).any(|part| part == "..") || rel.starts_with('~') {
        return Err(format!("illegal project path: `{rel}`"));
    }
    Ok(root.join(rel))
}

fn response(status: StatusCode, body: Vec<u8>, content_type: &str, extra: &[(&str, String)]) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-cache");
    for (k, v) in extra {
        builder = builder.header(*k, v.as_str());
    }
    builder.body(body).unwrap_or_else(|_| Response::builder().status(500).body(Vec::new()).unwrap())
}

/// Pure, unit-testable request handler.
pub fn serve_asset(uri_str: &str) -> Response<Vec<u8>> {
    // Split off the query manually; the path part stays percent-encoded.
    let (path_part, query) = match uri_str.split_once('?') {
        Some((p, q)) => (p, q),
        None => (uri_str, ""),
    };

    // Strip the scheme + host prefix (http://lovaasset.localhost/… or lovaasset://localhost/…).
    let mut rel_raw = path_part;
    if let Some(rest) = rel_raw.strip_prefix("http://") {
        rel_raw = rest;
    } else if let Some(rest) = rel_raw.strip_prefix("lovaasset://") {
        rel_raw = rest;
    }
    for host in SCHEME_HOSTS {
        if let Some(rest) = rel_raw.strip_prefix(host) {
            rel_raw = rest;
            break;
        }
    }
    let rel = match percent_decode_str(rel_raw.trim_start_matches('/')).decode_utf8() {
        Ok(v) => v.into_owned(),
        Err(_) => return response(StatusCode::BAD_REQUEST, b"invalid path encoding".to_vec(), "text/plain", &[]),
    };

    // Root must come from the query and must be a real Lova 3D project.
    let root = query.split('&').find_map(|pair| pair.strip_prefix("root=")).unwrap_or("");
    let root = match percent_decode_str(root).decode_utf8() {
        Ok(v) => v.replace('\\', "/"),
        Err(_) => return response(StatusCode::BAD_REQUEST, b"invalid root encoding".to_vec(), "text/plain", &[]),
    };
    if root.is_empty() {
        return response(StatusCode::BAD_REQUEST, b"missing root".to_vec(), "text/plain", &[]);
    }
    let root_path = PathBuf::from(&root);
    if !root_path.join("project.json").is_file() {
        return response(StatusCode::FORBIDDEN, b"not a Lova 3D project".to_vec(), "text/plain", &[]);
    }

    let target = match safe_join(&root_path, &rel) {
        Ok(p) => p,
        Err(_) => return response(StatusCode::FORBIDDEN, b"path traversal refused".to_vec(), "text/plain", &[]),
    };

    let meta = match fs::metadata(&target) {
        Ok(m) if m.is_file() => m,
        _ => return response(StatusCode::NOT_FOUND, b"asset not found".to_vec(), "text/plain", &[]),
    };

    // Conditional request support (ETag from size + mtime) lives in `handle`.
    let etag = etag_for(&meta);
    let bytes = match fs::read(&target) {
        Ok(b) => b,
        Err(_) => return response(StatusCode::INTERNAL_SERVER_ERROR, b"read failed".to_vec(), "text/plain", &[]),
    };
    response(
        StatusCode::OK,
        bytes,
        mime_for(&rel),
        &[("ETag", etag)],
    )
}

/// Tauri glue: adds If-None-Match handling that the pure handler cannot see.
pub fn handle(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri().to_string();
    let inm = request
        .headers()
        .get("if-none-match")
        .and_then(|v| v.to_str().ok())
        .map(String::from);

    // Fast path: when the client already has the current version, answer 304.
    if let Some(inm) = inm {
        if !inm.is_empty() {
            // Re-derive the etag by serving once is wasteful for big files;
            // instead compute metadata-only here.
            if let Some((root, rel)) = parse_root_rel(&uri) {
                if let Ok(target) = safe_join(&root, &rel) {
                    if let Ok(meta) = fs::metadata(&target) {
                        if etag_for(&meta) == inm {
                            return response(StatusCode::NOT_MODIFIED, Vec::new(), "text/plain", &[("ETag", inm)]);
                        }
                    }
                }
            }
        }
    }
    serve_asset(&uri)
}

fn parse_root_rel(uri_str: &str) -> Option<(PathBuf, String)> {
    let (path_part, query) = uri_str.split_once('?')?;
    let mut rel_raw = path_part;
    if let Some(rest) = rel_raw.strip_prefix("http://") {
        rel_raw = rest;
    } else if let Some(rest) = rel_raw.strip_prefix("lovaasset://") {
        rel_raw = rest;
    }
    for host in SCHEME_HOSTS {
        if let Some(rest) = rel_raw.strip_prefix(host) {
            rel_raw = rest;
            break;
        }
    }
    let rel = percent_decode_str(rel_raw.trim_start_matches('/')).decode_utf8().ok()?.into_owned();
    let root = query.split('&').find_map(|p| p.strip_prefix("root="))?;
    let root = percent_decode_str(root).decode_utf8().ok()?.replace('\\', "/");
    Some((PathBuf::from(root), rel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::StatusCode;

    fn temp_project(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("lova3d-proto-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    fn url_for(root: &Path, rel: &str) -> String {
        format!(
            "http://lovaasset.localhost/{}?root={}",
            percent_encoding::utf8_percent_encode(rel, percent_encoding::NON_ALPHANUMERIC),
            percent_encoding::utf8_percent_encode(&root.to_string_lossy(), percent_encoding::NON_ALPHANUMERIC)
        )
    }

    #[test]
    fn serves_project_files_with_mime_and_etag() {
        let root = temp_project("serve");
        fs::create_dir_all(root.join("assets/models")).unwrap();
        fs::write(root.join("project.json"), "{}").unwrap();
        fs::write(root.join("assets/models/robot.glb"), b"glb-bytes").unwrap();

        let res = serve_asset(&url_for(&root, "assets/models/robot.glb"));
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers().get("Content-Type").unwrap(), "model/gltf-binary");
        assert!(res.headers().get("ETag").is_some());
        assert_eq!(res.body(), b"glb-bytes");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_non_project_roots_and_traversal() {
        let root = temp_project("guard");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("secret.txt"), b"nope").unwrap();
        // No project.json → forbidden.
        assert_eq!(serve_asset(&url_for(&root, "secret.txt")).status(), StatusCode::FORBIDDEN);

        fs::write(root.join("project.json"), "{}").unwrap();
        // Traversal out of the root → forbidden.
        assert_eq!(serve_asset(&url_for(&root, "../secret.txt")).status(), StatusCode::FORBIDDEN);
        // Missing file → 404.
        assert_eq!(serve_asset(&url_for(&root, "assets/nope.glb")).status(), StatusCode::NOT_FOUND);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_root_param_is_a_bad_request() {
        assert_eq!(serve_asset("http://lovaasset.localhost/x.glb").status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn macos_style_scheme_also_works() {
        let root = temp_project("mac");
        fs::create_dir_all(root.join("scenes")).unwrap();
        fs::write(root.join("project.json"), "{}").unwrap();
        fs::write(root.join("scenes/main.scene.json"), b"{}").unwrap();
        let url = url_for(&root, "scenes/main.scene.json").replacen("http://", "lovaasset://", 1);
        let res = serve_asset(&url);
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers().get("Content-Type").unwrap(), "application/json");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn etag_304_short_circuit() {
        let root = temp_project("etag");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("project.json"), "{}").unwrap();
        fs::write(root.join("a.glb"), b"abc").unwrap();
        let first = serve_asset(&url_for(&root, "a.glb"));
        let etag = first.headers().get("ETag").unwrap().to_str().unwrap().to_string();

        let req = Request::builder()
            .uri(url_for(&root, "a.glb"))
            .header("if-none-match", &etag)
            .body(Vec::new())
            .unwrap();
        let res = handle(req);
        assert_eq!(res.status(), StatusCode::NOT_MODIFIED);
        assert!(res.body().is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
