/**
 * High-level file actions shared by the toolbar and keyboard shortcuts.
 */
import { t } from "../i18n/index.svelte";
import { buildExportHtml } from "../export/playerRuntime";
import { createThirdPersonDemo } from "./demoScene";
import * as io from "./io";
import { store } from "./sceneStore.svelte";
import type { AssetKind, ProjectInfo } from "./types";

function sceneFileName(): string {
  const base = store.scene.name
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `${base || "scene"}.lova.json`;
}

function sceneSlug(): string {
  const base = store.scene.name
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return base || "main";
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── project actions ───────────────────────────────────────────────────────

export async function newProjectAction(): Promise<void> {
  if (!io.isTauri) {
    store.log("warn", t("project.desktopOnly"));
    return;
  }
  if (store.dirty && !window.confirm(t("confirm.new"))) return;
  try {
    const root = await io.pickProjectRoot();
    if (!root) return;
    const name = root.split(/[\\/]/).filter(Boolean).pop() ?? "MyGame";
    const info = await io.createProject(root, name);
    store.stop();
    store.setProject(info);
    store.newScene();
    store.scene.name = "Main";
    store.log("success", t("project.created", { name }));
  } catch (e) {
    store.log("error", t("log.loadFailed", { msg: errText(e) }));
  }
}

export async function openProjectAction(): Promise<void> {
  if (!io.isTauri) {
    store.log("warn", t("project.desktopOnly"));
    return;
  }
  if (store.dirty && !window.confirm(t("confirm.new"))) return;
  try {
    const root = await io.pickProjectRoot();
    if (!root) return;
    const info = await io.openProject(root);
    store.stop();
    store.setProject(info);
    // Load the main scene when the project already has one.
    const main = info.scenes.find((s) => s.file.endsWith("main.scene.json")) ?? info.scenes[0];
    if (main) {
      const b64 = await io.readProjectFileB64(info.root, main.file);
      const text = new TextDecoder().decode(io.b64ToBytes(b64));
      store.loadScene(io.validateScene(text), null);
    } else {
      store.newScene();
      store.scene.name = "Main";
    }
    store.log("success", t("project.opened", { name: info.name }));
  } catch (e) {
    store.log("error", t("log.loadFailed", { msg: errText(e) }));
  }
}

/** Save the current scene into the open project (scenes/<slug>.scene.json). */
export async function saveProjectSceneAction(): Promise<void> {
  const project = store.project;
  if (!project || !io.isTauri) return;
  try {
    const file = `scenes/${sceneSlug()}.scene.json`;
    await io.projectSaveScene(project.root, file, store.scene.name, store.serialize());
    // Refresh the index (scenes list) without touching the working scene.
    const info = await io.openProject(project.root);
    store.setProject(info);
    store.currentPath = `${project.root}/${file}`;
    store.dirty = false;
    store.clearAutosave();
    store.log("success", t("project.sceneSaved", { file }));
  } catch (e) {
    store.log("error", t("log.saveFailed", { msg: errText(e) }));
  }
}

/** Import an asset file into the project's assets/ folder. */
export async function importAssetAction(kind: AssetKind): Promise<void> {
  const project = store.project;
  if (!project || !io.isTauri) {
    store.log("warn", t("project.needProject"));
    return;
  }
  try {
    const source = await io.pickAssetFile(kind);
    if (!source) return;
    const asset = await io.importAsset(project.root, source, kind);
    // Models get an offscreen-rendered thumbnail for the asset browser.
    if (kind === "models") {
      try {
        const b64 = await io.readProjectFileB64(project.root, asset.path);
        const { renderModelThumbnail } = await import("../engine/thumbnail");
        const png = await renderModelThumbnail(io.b64ToBytes(b64), asset.path);
        if (png) await io.setAssetThumb(project.root, asset.id, png);
      } catch {
        store.log("warn", t("assets.thumbnailFailed"));
      }
    }
    const info = await io.openProject(project.root);
    store.setProject(info);
    store.log("success", t("assets.imported", { name: asset.path }));
  } catch (e) {
    store.log("error", t("log.saveFailed", { msg: errText(e) }));
  }
}

/** Refresh the open project's index (scenes + assets). */
export async function refreshProjectAction(): Promise<void> {
  const project = store.project;
  if (!project || !io.isTauri) return;
  try {
    store.setProject(await io.openProject(project.root));
  } catch (e) {
    store.log("error", t("log.loadFailed", { msg: errText(e) }));
  }
}

export async function newSceneAction(): Promise<void> {
  if (store.dirty && !window.confirm(t("confirm.new"))) return;
  store.newScene();
}

/** Load the built-in third-person demo ("Lova Obby"). */
export async function loadDemoAction(): Promise<void> {
  if (store.dirty && !window.confirm(t("confirm.new"))) return;
  store.stop();
  store.loadScene(createThirdPersonDemo(), null);
}

export async function openSceneAction(): Promise<void> {
  try {
    const result = await io.readSceneFile();
    if (result) store.loadScene(result.data, result.path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "invalid JSON" || msg === "missing required scene fields") {
      store.log("error", t("log.invalidScene"));
    } else {
      store.log("error", t("log.loadFailed", { msg }));
    }
  }
}

export async function saveSceneAction(): Promise<void> {
  // Inside a project, saving goes to scenes/<slug>.scene.json + the index.
  if (store.project) {
    await saveProjectSceneAction();
    return;
  }
  if (store.currentPath) {
    try {
      await io.writeSceneFile(store.currentPath, store.serialize());
      store.markSaved(store.currentPath);
      store.log("success", t("log.sceneSaved", { path: store.currentPath }));
    } catch (e) {
      store.log("error", t("log.saveFailed", { msg: errText(e) }));
    }
    return;
  }
  await saveAsSceneAction();
}

export async function saveAsSceneAction(): Promise<void> {
  try {
    const path = await io.pickSavePath(sceneFileName());
    if (!path) return;
    await io.writeSceneFile(path, store.serialize());
    store.markSaved(path);
    store.log("success", io.isTauri ? t("log.sceneSaved", { path }) : t("log.exported"));
  } catch (e) {
    store.log("error", t("log.saveFailed", { msg: e instanceof Error ? e.message : String(e) }));
  }
}

/** Export the current scene as a single playable HTML file. */
export async function exportHtmlAction(): Promise<void> {
  try {
    const base = store.scene.name
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-");
    const defaultName = `${base || "game"}.html`;

    // Embed imported models so the export stays a single self-contained file.
    const assets: Record<string, string> = {};
    const modelPaths = new Set(
      store.scene.objects.filter((o) => o.mesh?.kind === "model" && o.modelPath).map((o) => o.modelPath!)
    );
    if (modelPaths.size > 0) {
      if (store.project && io.isTauri) {
        for (const p of modelPaths) {
          assets[p] = await io.readProjectFileB64(store.project.root, p);
        }
      } else {
        store.log("warn", t("export.modelsNeedProject"));
      }
    }

    const path = await io.pickSavePath(defaultName, [{ name: "HTML", extensions: ["html"] }]);
    if (!path) return;
    const html = buildExportHtml(JSON.parse(store.serialize()) as Parameters<typeof buildExportHtml>[0], assets);
    await io.writeSceneFile(path.endsWith(".html") ? path : `${path}.html`, html);
    store.log("success", t("log.exportedHtml", { path }));
  } catch (e) {
    store.log("error", t("log.saveFailed", { msg: e instanceof Error ? e.message : String(e) }));
  }
}
