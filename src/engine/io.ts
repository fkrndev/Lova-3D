/**
 * Scene persistence: native Tauri dialogs + Rust file commands in the desktop
 * app, graceful browser fallbacks (download / file input) when running under
 * plain `vite dev`.
 */
import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import type { SceneData } from "./types";

export const isTauri: boolean =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const SCENE_FILTERS = [{ name: "Lova 3D Scene", extensions: ["json"] }];

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
