/**
 * High-level file actions shared by the toolbar and keyboard shortcuts.
 */
import { t } from "../i18n/index.svelte";
import * as io from "./io";
import { store } from "./sceneStore.svelte";

function sceneFileName(): string {
  const base = store.scene.name
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `${base || "scene"}.lova.json`;
}

export async function newSceneAction(): Promise<void> {
  if (store.dirty && !window.confirm(t("confirm.new"))) return;
  store.newScene();
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
  if (store.currentPath) {
    try {
      await io.writeSceneFile(store.currentPath, store.serialize());
      store.markSaved(store.currentPath);
      store.log("success", t("log.sceneSaved", { path: store.currentPath }));
    } catch (e) {
      store.log("error", t("log.saveFailed", { msg: e instanceof Error ? e.message : String(e) }));
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
