/**
 * Project-system tests — Tauri paths with mocked invoke/dialog, following
 * the pattern in persistence-tauri.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, store } from "./helpers";
import { createDefaultScene } from "../src/engine/factories";
import type { ProjectInfo } from "../src/engine/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

let core: typeof import("@tauri-apps/api/core");
let dialog: typeof import("@tauri-apps/plugin-dialog");
let actions: typeof import("../src/engine/actions");
let io: typeof import("../src/engine/io");

const fakeProject = (root = "F:/Games/MyGame"): ProjectInfo => ({
  root,
  name: "MyGame",
  scenes: [{ name: "Main", file: "scenes/main.scene.json" }],
  assets: [
    { id: "a1", path: "assets/models/robot.glb", kind: "models", bytes: 1024, thumb: ".lova/thumbs/a1.png" },
  ],
});

beforeAll(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  core = await import("@tauri-apps/api/core");
  dialog = await import("@tauri-apps/plugin-dialog");
  actions = await import("../src/engine/actions");
  io = await import("../src/engine/io");
});

beforeEach(() => {
  resetStore();
  vi.mocked(core.invoke).mockReset();
  vi.mocked(dialog.open).mockReset();
  vi.mocked(dialog.save).mockReset();
  (window as { confirm: unknown }).confirm = vi.fn(() => true);
});

describe("project actions", () => {
  it("newProjectAction creates the project and resets to a fresh Main scene", async () => {
    vi.mocked(dialog.open).mockResolvedValue("F:/Games/NewGame" as never);
    vi.mocked(core.invoke).mockImplementation((cmd: string) => {
      if (cmd === "create_project") return Promise.resolve(fakeProject("F:/Games/NewGame"));
      return Promise.resolve(null);
    });

    await actions.newProjectAction();
    expect(core.invoke).toHaveBeenCalledWith("create_project", { root: "F:/Games/NewGame", name: "NewGame" });
    expect(store.project?.name).toBe("MyGame"); // mocked info echoes back
    expect(store.scene.name).toBe("Main");
    expect(store.dirty).toBe(false);
  });

  it("openProjectAction loads the project's main scene", async () => {
    const scene = createDefaultScene();
    scene.name = "Main";
    vi.mocked(dialog.open).mockResolvedValue("F:/Games/MyGame" as never);
    vi.mocked(core.invoke).mockImplementation((cmd: string) => {
      if (cmd === "open_project") return Promise.resolve(fakeProject());
      if (cmd === "read_project_file_b64") return Promise.resolve(btoa(JSON.stringify(scene)));
      return Promise.resolve(null);
    });

    await actions.openProjectAction();
    expect(store.project?.assets).toHaveLength(1);
    expect(store.scene.objects.length).toBe(scene.objects.length);
    // Asset browser data is live on the store.
    expect(store.project?.assets[0].path).toBe("assets/models/robot.glb");
  });

  it("openProjectAction rejects folders that are not projects", async () => {
    vi.mocked(dialog.open).mockResolvedValue("F:/Downloads" as never);
    vi.mocked(core.invoke).mockRejectedValue("`F:/Downloads` is not a Lova 3D project");
    const before = store.serialize();
    await actions.openProjectAction();
    expect(store.project).toBeNull();
    expect(store.serialize()).toBe(before);
    expect(store.logs.some((l) => l.kind === "error")).toBe(true);
  });

  it("Ctrl+S inside a project writes scenes/<slug>.scene.json + index, and refreshes", async () => {
    store.setProject(fakeProject());
    store.scene.name = "Level One";
    store.addMesh("box");
    vi.mocked(core.invoke).mockImplementation((cmd: string) => {
      if (cmd === "open_project") return Promise.resolve(fakeProject());
      return Promise.resolve(null);
    });

    await actions.saveSceneAction();
    expect(core.invoke).toHaveBeenCalledWith(
      "project_save_scene",
      expect.objectContaining({ file: "scenes/Level-One.scene.json", name: "Level One" })
    );
    expect(store.dirty).toBe(false);
    expect(store.currentPath).toContain("scenes/Level-One.scene.json");
  });

  it("importAssetAction copies the file and refreshes the asset list", async () => {
    store.setProject(fakeProject());
    vi.mocked(dialog.open)
      .mockResolvedValueOnce("C:/Downloads/robot.glb" as never) // pickAssetFile
      .mockResolvedValue(null as never);
    const grown = fakeProject();
    grown.assets.push({ id: "a2", path: "assets/models/robot-2.glb", kind: "models", bytes: 2048, thumb: null });
    vi.mocked(core.invoke).mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "import_asset") {
        return Promise.resolve({ id: "a2", path: "assets/models/robot-2.glb", kind: "models", bytes: 2048, thumb: null });
      }
      if (cmd === "read_project_file_b64") return Promise.resolve("Z2xi");
      if (cmd === "open_project") return Promise.resolve(grown);
      return Promise.resolve(null);
    });

    await actions.importAssetAction("models");
    expect(core.invoke).toHaveBeenCalledWith("import_asset", {
      root: "F:/Games/MyGame",
      source: "C:/Downloads/robot.glb",
      kind: "models",
    });
    expect(store.project?.assets).toHaveLength(2);
  });

  it("importAssetAction without a project only warns", async () => {
    await actions.importAssetAction("models");
    expect(store.logs.some((l) => l.kind === "warn" && l.text.length > 0)).toBe(true);
    expect(core.invoke).not.toHaveBeenCalled();
  });
});

describe("lovaasset protocol", () => {
  it("builds platform-correct URLs", () => {
    expect(io.projectAssetUrl("F:/G", "assets/models/a b.glb", "http:")).toBe(
      "http://lovaasset.localhost/assets/models/a%20b.glb?root=F%3A%2FG"
    );
    expect(io.projectAssetUrl("F:/G", "x.glb", "tauri:")).toBe(
      "lovaasset://localhost/x.glb?root=F%3A%2FG"
    );
  });

  it("readAssetBytes falls back to base64 IPC outside the webview", async () => {
    vi.mocked(core.invoke).mockResolvedValue("aGVsbG8=" as never);
    const bytes = await io.readAssetBytes("F:/G", "assets/models/x.glb");
    expect(bytes).toEqual(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]));
    expect(core.invoke).toHaveBeenCalledWith("read_project_file_b64", {
      root: "F:/G",
      file: "assets/models/x.glb",
    });
  });

  it("readAssetBytes resolves null when both paths fail", async () => {
    vi.mocked(core.invoke).mockRejectedValue(new Error("missing"));
    expect(await io.readAssetBytes("F:/G", "nope.glb")).toBeNull();
  });
});

describe("model objects", () => {
  it("addModel creates a uniquely-named model object referencing the asset path", () => {
    store.addModel("assets/models/robot.glb");
    store.addModel("assets/models/robot.glb");
    const models = store.scene.objects.filter((o) => o.mesh?.kind === "model");
    expect(models).toHaveLength(2);
    expect(models[0].name).toBe("robot");
    expect(models[1].name).toBe("robot 2");
    expect(models.every((m) => m.modelPath === "assets/models/robot.glb")).toBe(true);
  });

  it("validateScene rejects model objects without a path", () => {
    const scene = createDefaultScene();
    scene.objects[0].mesh = { kind: "model" };
    delete scene.objects[0].modelPath;
    expect(() => io.validateScene(JSON.stringify(scene))).toThrow("modelPath");
  });
});
