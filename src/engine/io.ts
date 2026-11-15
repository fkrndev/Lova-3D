/**
 * Scene persistence: native Tauri dialogs + Rust file commands in the desktop
 * app, graceful browser fallbacks (download / file input) when running under
 * plain `vite dev`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import type { AssetInfo, AssetKind, PhysicsBodyDesc, PhysicsBodyState, ProjectInfo, SceneData } from "./types";

export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const SCENE_FILTERS = [{ name: "Lova 3D Scene", extensions: ["json"] }];

// ── native physics (Rapier, Tauri-only) ───────────────────────────────────

export async function physicsWorldCreate(bodies: PhysicsBodyDesc[]): Promise<number> {
  return await invoke<number>("physics_world_create", { bodies });
}

export async function physicsStep(world: number, dt: number): Promise<PhysicsBodyState[]> {
  return await invoke<PhysicsBodyState[]>("physics_step", { world, dt });
}

export async function physicsSetVelocity(world: number, id: string, linvel: [number, number, number]): Promise<void> {
  await invoke("physics_set_velocity", { world, id, linvel });
}

export async function physicsTeleport(world: number, id: string, translation: [number, number, number]): Promise<void> {
  await invoke("physics_teleport", { world, id, translation });
}

export async function physicsWorldDestroy(world: number): Promise<void> {
  await invoke("physics_world_destroy", { world });
}

export async function physicsJointAdd(
  world: number,
  joint: import("./types").PhysicsJointDesc
): Promise<void> {
  await invoke("physics_joint_add", { world, joint });
}

/** Returns the first hit along the normalized ray, or null. */
export async function physicsRaycast(
  world: number,
  origin: [number, number, number],
  dir: [number, number, number],
  maxToi: number
): Promise<import("./types").PhysicsRayHit | null> {
  return await invoke<import("./types").PhysicsRayHit | null>("physics_raycast", { world, origin, dir, maxToi });
}

/** Start the Rust-driven simulation loop (fixed timestep, event streaming). */
export async function physicsRun(world: number, hz = 60): Promise<void> {
  await invoke("physics_run", { world, hz });
}

/** Pause/resume the Rust loop without killing its thread. */
export async function physicsSetRunning(world: number, running: boolean): Promise<void> {
  await invoke("physics_set_running", { world, running });
}

export interface PhysicsStreamEvent {
  world: number;
  states: PhysicsBodyState[];
}

/** Subscribe to streamed simulation states; resolves an unlisten fn. */
export async function onPhysicsStates(cb: (event: PhysicsStreamEvent) => void): Promise<() => void> {
  const unlisten = await listen<PhysicsStreamEvent>("lova://physics-states", (e) => cb(e.payload));
  return unlisten;
}

// ── project system (Tauri-only) ───────────────────────────────────────────

export async function createProject(root: string, name: string): Promise<ProjectInfo> {
  return await invoke("create_project", { root, name });
}

export async function openProject(root: string): Promise<ProjectInfo> {
  return await invoke("open_project", { root });
}

export async function projectSaveScene(root: string, file: string, name: string, contents: string): Promise<void> {
  await invoke("project_save_scene", { root, file, name, contents });
}

export async function importAsset(root: string, source: string, kind: AssetKind): Promise<AssetInfo> {
  return await invoke("import_asset", { root, source, kind });
}

export async function readProjectFileB64(root: string, file: string): Promise<string> {
  return await invoke("read_project_file_b64", { root, file });
}

export async function setAssetThumb(root: string, id: string, pngB64: string): Promise<void> {
  await invoke("set_asset_thumb", { root, id, pngB64 });
}

/** Pick a folder (for creating/opening projects). */
export async function pickProjectRoot(): Promise<string | null> {
  const picked = await dialogOpen({ directory: true, multiple: false });
  if (!picked || Array.isArray(picked)) return null;
  return picked;
}

/** Pick asset files of a given kind to import. */
export async function pickAssetFile(kind: AssetKind): Promise<string | null> {
  const filters = {
    models: [{ name: "3D Model", extensions: ["glb", "gltf"] }],
    textures: [{ name: "Texture", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
    audio: [{ name: "Audio", extensions: ["mp3", "wav", "ogg"] }],
  }[kind];
  const picked = await dialogOpen({ filters, multiple: false, directory: false });
  if (!picked || Array.isArray(picked)) return null;
  return picked;
}

/** base64 → bytes for feeding Babylon loaders. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── lovaasset:// streaming protocol ───────────────────────────────────────

/**
 * URL for the custom `lovaasset` protocol that streams project files
 * straight from disk (no IPC, no base64). WebView2/WebKitGTK serve custom
 * schemes over `http://<scheme>.localhost`; WKWebView uses `<scheme>://`.
 */
export function projectAssetUrl(root: string, rel: string, proto: string = window.location.protocol): string {
  const base = proto === "tauri:" ? "lovaasset://localhost/" : "http://lovaasset.localhost/";
  const relEnc = rel.split(/[\\/]/).map(encodeURIComponent).join("/");
  return `${base}${relEnc}?root=${encodeURIComponent(root)}`;
}

/** True when the page origin is the Tauri webview (where the protocol lives). */
function inTauriWebview(): boolean {
  return window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost";
}

/**
 * Read project asset bytes: streamed via the `lovaasset` protocol when
 * available, falling back to base64-over-IPC (browser tests, older builds).
 */
export async function readAssetBytes(root: string, rel: string): Promise<Uint8Array | null> {
  if (isTauri && inTauriWebview()) {
    try {
      const res = await fetch(projectAssetUrl(root, rel));
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch {
      /* fall through to the IPC path */
    }
  }
  try {
    const b64 = await readProjectFileB64(root, rel);
    return b64ToBytes(b64);
  } catch {
    return null;
  }
}

export interface LoadedScene {
  path: string | null;
  data: SceneData;
}

/** Basic structural validation of a parsed Lova 3D scene file. Throws on invalid input. */
export function validateScene(text: string): SceneData {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("invalid JSON");
  }
  const scene = parsed as SceneData;
  if (
    scene === null ||
    typeof scene !== "object" ||
    scene.version !== 1 ||
    !Array.isArray(scene.objects) ||
    typeof scene.name !== "string" ||
    !scene.environment ||
    scene.objects.some(
      (o) =>
        !o ||
        typeof o.id !== "string" ||
        typeof o.name !== "string" ||
        !o.transform?.position ||
        !o.transform?.rotation ||
        !o.transform?.scale ||
        !o.mesh &&
        !o.light
    )
  ) {
    throw new Error("missing required scene fields");
  }
  // Normalize optional fields so downstream code can rely on them.
  for (const o of scene.objects) {
    o.behaviors ??= [];
    o.visible ??= true;
    o.parentId ??= null;
    if (o.mesh?.kind === "model" && typeof o.modelPath !== "string") {
      throw new Error("model object missing modelPath");
    }
    if (o.sensor) {
      o.sensor.radius ??= 1;
    }
    if (o.physics) {
      o.physics.bounce ??= 0.4;
      o.physics.gravityScale ??= 1;
      o.physics.velocity ??= { x: 0, y: 0, z: 0 };
    }
  }
  scene.environment.background ??= "#101318";
  scene.environment.ambient ??= 0.35;
  return scene;
}

/** Ask the user where to save; resolves `null` when cancelled. */
export async function pickSavePath(
  defaultName = "scene.lova.json",
  filters: Array<{ name: string; extensions: string[] }> = SCENE_FILTERS
): Promise<string | null> {
  if (isTauri) {
    return await dialogSave({ filters, defaultPath: defaultName });
  }
  // Browser fallback: the filename is used for the download.
  return defaultName;
}

/** Write text to `path` (native) or trigger a download (browser). */
export async function writeSceneFile(path: string, contents: string): Promise<void> {
  if (isTauri) {
    await invoke("save_scene", { path, contents });
    return;
  }
  const blob = new Blob([contents], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path;
  a.click();
  URL.revokeObjectURL(url);
}

/** Ask the user for a scene file and read it. Resolves `null` when cancelled. */
export async function readSceneFile(): Promise<LoadedScene | null> {
  if (isTauri) {
    const path = await dialogOpen({
      filters: SCENE_FILTERS,
      multiple: false,
      directory: false,
    });
    if (!path || Array.isArray(path)) return null;
    const text = await invoke<string>("load_scene", { path });
    return { path, data: validateScene(text) };
  }

  // Browser fallback via hidden <input type="file">.
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // Note: no reliable cancel event; resolve null on window focus heuristic is
    // flaky, so a cancelled dialog simply never resolves until another pick.
    input.oncancel = () => resolve(null);
    input.click();
  });
  if (!file) return null;
  const text = await file.text();
  return { path: null, data: validateScene(text) };
}
