/**
 * Persistence tests — browser-mode (non-Tauri) code paths:
 * download/upload fallbacks, the file actions, and their guards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as io from "../src/engine/io";
import * as actions from "../src/engine/actions";
import { resetStore, store } from "./helpers";
import { createDefaultScene } from "../src/engine/factories";
import type { GameObject } from "../src/engine/types";

/** Captured anchor downloads. */
let downloads: Array<{ name: string; url: string }> = [];
/** The most recently created <input> (file fallback). */
let lastInput: HTMLInputElement | null = null;

beforeEach(() => {
  resetStore();
  vi.restoreAllMocks();
  downloads = [];
  lastInput = null;

  // jsdom lacks URL.createObjectURL — stub it.
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:mock");
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();

  // Record anchor clicks (downloads) with their filenames.
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, url: this.href });
  };

  // Capture dynamically created <input> elements for the file-open fallback.
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const el = realCreate(tag);
    if (tag === "input") lastInput = el as HTMLInputElement;
    return el;
  }) as typeof document.createElement);

  (window as { confirm: unknown }).confirm = vi.fn(() => true);
});

const setFiles = (input: HTMLInputElement, text: string, name = "scene.json") => {
  const file = new File([text], name, { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
};

describe("io — browser mode", () => {
  it("reports non-Tauri and pickSavePath echoes the default name", async () => {
    expect(io.isTauri).toBe(false);
    expect(await io.pickSavePath("my-scene.lova.json")).toBe("my-scene.lova.json");
  });

  it("writeSceneFile triggers a download with the given filename", async () => {
    await io.writeSceneFile("game.html", "<html></html>");
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("game.html");
  });

  it("readSceneFile loads and validates through the <input type=file> fallback", async () => {
    const scene = createDefaultScene();
    const pending = io.readSceneFile();
    await vi.waitFor(() => expect(lastInput).toBeTruthy());
    setFiles(lastInput!, JSON.stringify(scene));
    lastInput!.dispatchEvent(new Event("change"));
    const result = await pending;
    expect(result?.path).toBeNull();
    expect(result?.data.version).toBe(1);
    expect(result?.data.objects.length).toBe(scene.objects.length);
  });

  it("readSceneFile resolves null when the picker is cancelled", async () => {
    const pending = io.readSceneFile();
    await vi.waitFor(() => expect(lastInput).toBeTruthy());
    lastInput!.dispatchEvent(new Event("cancel"));
    await expect(pending).resolves.toBeNull();
  });

  it("readSceneFile rejects invalid scene JSON", async () => {
    const pending = io.readSceneFile();
    await vi.waitFor(() => expect(lastInput).toBeTruthy());
    setFiles(lastInput!, '{"version": 99}');
    lastInput!.dispatchEvent(new Event("change"));
    await expect(pending).rejects.toThrow();
  });
});

describe("actions — save", () => {
  it("saveAs sanitizes the scene name into the download filename and clears dirty", async () => {
    store.scene.name = "My Scene: 3D!!";
    store.dirty = true;
    await actions.saveAsSceneAction();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("My-Scene-3D.lova.json");
    expect(store.dirty).toBe(false);
    expect(store.currentPath).toBe("My-Scene-3D.lova.json");
    expect(store.logs.some((l) => l.kind === "success" && l.text.includes("export"))).toBe(true);
  });

  it("save reuses the last path and marks it saved", async () => {
    await actions.saveAsSceneAction();
    downloads = [];
    store.rename(store.scene.objects[0].id, "Changed");
    store.commit();
    expect(store.dirty).toBe(true);
    await actions.saveSceneAction();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe(store.currentPath);
    expect(store.dirty).toBe(false);
  });

  it("falls back to Save As when there is no current path", async () => {
    expect(store.currentPath).toBeNull();
    await actions.saveSceneAction();
    expect(downloads).toHaveLength(1);
    expect(store.currentPath).not.toBeNull();
  });

  it("newSceneAction asks for confirmation when dirty", async () => {
    (window as { confirm: unknown }).confirm = vi.fn(() => false);
    store.dirty = true;
    const before = store.serialize();
    await actions.newSceneAction();
    expect(store.serialize()).toBe(before); // cancelled

    (window as { confirm: unknown }).confirm = vi.fn(() => true);
    await actions.newSceneAction();
    expect(store.serialize()).not.toBe(before);
    expect(store.dirty).toBe(false);
  });
});

describe("actions — open & demo", () => {
  it("openSceneAction loads a valid file into the store", async () => {
    const scene = createDefaultScene();
    scene.name = "LoadedFromDisk";
    const pending = actions.openSceneAction();
    await vi.waitFor(() => expect(lastInput).toBeTruthy());
    setFiles(lastInput!, JSON.stringify(scene));
    lastInput!.dispatchEvent(new Event("change"));
    await pending;
    expect(store.scene.name).toBe("LoadedFromDisk");
    expect(store.currentPath).toBeNull(); // browser fallback has no path
    expect(store.dirty).toBe(false);
    expect(store.logs.some((l) => l.kind === "success" && l.text.includes("LoadedFromDisk"))).toBe(true);
  });

  it("openSceneAction reports invalid files and keeps the current scene", async () => {
    const before = store.serialize();
    const pending = actions.openSceneAction();
    await vi.waitFor(() => expect(lastInput).toBeTruthy());
    setFiles(lastInput!, '{"version": 1, "name": 5}');
    lastInput!.dispatchEvent(new Event("change"));
    await pending;
    expect(store.serialize()).toBe(before);
    expect(store.logs.some((l) => l.kind === "error" && l.text.includes("valid Lova 3D scene"))).toBe(true);
  });

  it("loadDemoAction replaces the scene with the third-person demo", async () => {
    await actions.loadDemoAction();
    expect(store.scene.name).toContain("Third Person Demo");
    const player = store.scene.objects.find((o) => o.name === "Player") as GameObject | undefined;
    expect(player?.script).toContain("api.camera.follow");
    expect(store.scene.objects.some((o) => o.name === "ClimbWall")).toBe(true);
  });
});

describe("actions — export HTML", () => {
  it("downloads a playable .html with a sanitized name", async () => {
    store.scene.name = "Karya Bagus!";
    await actions.exportHtmlAction();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe("Karya-Bagus.html");
    expect(store.logs.some((l) => l.kind === "success" && l.text.includes(".html"))).toBe(true);
  });
});
