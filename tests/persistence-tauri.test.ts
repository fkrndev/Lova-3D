/**
 * Persistence tests — Tauri code paths, with the plugin APIs mocked:
 * native dialogs, invoke("save_scene"/"load_scene") and cancellation.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, store } from "./helpers";
import { createDefaultScene } from "../src/engine/factories";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

// Imported lazily AFTER __TAURI_INTERNALS__ is defined so `isTauri` is true.
let io: typeof import("../src/engine/io");
let core: typeof import("@tauri-apps/api/core");
let dialog: typeof import("@tauri-apps/plugin-dialog");

beforeAll(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  io = await import("../src/engine/io");
  core = await import("@tauri-apps/api/core");
  dialog = await import("@tauri-apps/plugin-dialog");
});

beforeEach(() => {
  resetStore();
  vi.mocked(core.invoke).mockReset();
  vi.mocked(dialog.open).mockReset();
  vi.mocked(dialog.save).mockReset();
});

describe("io — Tauri mode", () => {
  it("detects Tauri", () => {
    expect(io.isTauri).toBe(true);
  });

  it("pickSavePath opens a native save dialog with scene filters", async () => {
    vi.mocked(dialog.save).mockResolvedValue("C:/games/level1.json" as never);
    const path = await io.pickSavePath("level1.lova.json");
    expect(path).toBe("C:/games/level1.json");
    expect(dialog.save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "level1.lova.json",
        filters: [{ name: "Lova 3D Scene", extensions: ["json"] }],
      })
    );
  });

  it("writeSceneFile invokes the Rust save_scene command", async () => {
    vi.mocked(core.invoke).mockResolvedValue(undefined as never);
    await io.writeSceneFile("C:/games/level1.json", "{...}");
    expect(core.invoke).toHaveBeenCalledWith("save_scene", {
      path: "C:/games/level1.json",
      contents: "{...}",
    });
  });

  it("readSceneFile chains dialog.open → load_scene → validateScene", async () => {
    const scene = createDefaultScene();
    vi.mocked(dialog.open).mockResolvedValue("C:/games/level1.json" as never);
    vi.mocked(core.invoke).mockResolvedValue(JSON.stringify(scene) as never);

    const result = await io.readSceneFile();
    expect(dialog.open).toHaveBeenCalledWith(
      expect.objectContaining({ multiple: false, directory: false })
    );
    expect(core.invoke).toHaveBeenCalledWith("load_scene", { path: "C:/games/level1.json" });
    expect(result?.path).toBe("C:/games/level1.json");
    expect(result?.data.objects.length).toBe(scene.objects.length);
  });

  it("a cancelled dialog skips the command entirely", async () => {
    vi.mocked(dialog.save).mockResolvedValue(null as never);
    await expect(io.pickSavePath("x.json")).resolves.toBeNull();
    vi.mocked(dialog.open).mockResolvedValue(null as never);
    await expect(io.readSceneFile()).resolves.toBeNull();
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it("a corrupted file from load_scene surfaces the validation error", async () => {
    vi.mocked(dialog.open).mockResolvedValue("C:/bad.json" as never);
    vi.mocked(core.invoke).mockResolvedValue('{"version": 1, "objects": "nope"}' as never);
    await expect(io.readSceneFile()).rejects.toThrow();
  });
});
