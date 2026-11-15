/**
 * MVP acceptance flow — mirrors the 9 success criteria:
 *  1. Open the app and create a project            (newProjectAction)
 *  2. Add cube, sphere and plane                   (store.addMesh)
 *  3. Import a .glb model                          (importAssetAction + addModel)
 *  4. Move, rotate and scale objects               (updateTransform)
 *  5. Change colour and material                   (patchMaterial)
 *  6. Save the scene                               (saveSceneAction → project)
 *  7. Close and reopen the project without loss    (openProjectAction)
 *  8. Press Play to try the scene                  (play/stop + snapshot)
 *  9. Export the scene as a playable game          (exportHtmlAction + embed)
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { near, resetStore, store, tick, vec3 } from "./helpers";
import type { ProjectInfo } from "../src/engine/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

let core: typeof import("@tauri-apps/api/core");
let dialog: typeof import("@tauri-apps/plugin-dialog");
let actions: typeof import("../src/engine/actions");
let io: typeof import("../src/engine/io");

/** Minimal-but-valid GLB (12-byte header + JSON chunk) for data-flow tests. */
function minimalGlb(): Uint8Array {
  const json = JSON.stringify({ asset: { version: "2.0" }, scenes: [{ nodes: [] }], nodes: [] });
  const jsonPad = json + " ".repeat((4 - (json.length % 4)) % 4);
  const jsonBytes = new TextEncoder().encode(jsonPad);
  const binBytes = new Uint8Array(0);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const buf = new DataView(new ArrayBuffer(total));
  buf.setUint32(0, 0x46546c67, true); // "glTF"
  buf.setUint32(4, 2, true); // version
  buf.setUint32(8, total, true); // length
  let o = 12;
  buf.setUint32(o, jsonBytes.length, true);
  buf.setUint32(o + 4, 0x4e4f534a, true); // "JSON"
  new Uint8Array(buf.buffer).set(jsonBytes, o + 8);
  o += 8 + jsonBytes.length;
  buf.setUint32(o, 0, true);
  buf.setUint32(o + 4, 0x004e4942, true); // "BIN"
  return new Uint8Array(buf.buffer);
}

const glbB64 = (() => {
  const bytes = minimalGlb();
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
})();

const project: ProjectInfo = {
  root: "F:/Games/MyGame",
  name: "MyGame",
  scenes: [],
  assets: [],
};

/** The scene as persisted on disk — written by the mocked Rust commands. */
let diskScene: string | null = null;

beforeAll(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  core = await import("@tauri-apps/api/core");
  dialog = await import("@tauri-apps/plugin-dialog");
  actions = await import("../src/engine/actions");
  io = await import("../src/engine/io");
});

beforeEach(() => {
  resetStore();
  diskScene = null;
  project.scenes = [];
  project.assets = [];
  vi.mocked(core.invoke).mockReset();
  vi.mocked(dialog.open).mockReset();
  vi.mocked(dialog.save).mockReset();
  vi.mocked(dialog.save).mockResolvedValue("C:/Exports/game.html" as never);
  (window as { confirm: unknown }).confirm = vi.fn(() => true);
});

describe("MVP acceptance flow", () => {
  it("runs criteria 1–9 end to end", async () => {
    // ── 1. Create a project ────────────────────────────────────────────
    vi.mocked(dialog.open).mockResolvedValueOnce("F:/Games/MyGame" as never);
    vi.mocked(core.invoke).mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "create_project" || cmd === "open_project") return Promise.resolve({ ...project });
      return Promise.resolve(null);
    });
    await actions.newProjectAction();
    expect(store.project?.root).toBe("F:/Games/MyGame");
    expect(core.invoke).toHaveBeenCalledWith("create_project", { root: "F:/Games/MyGame", name: "MyGame" });

    // ── 2. Add cube, sphere, plane (into an empty scene) ───────────────
    store.loadScene({ version: 1, name: "Main", environment: { background: "#101318", ambient: 0.35 }, objects: [] }, null);
    store.addMesh("box");
    store.addMesh("sphere");
    store.addMesh("plane");
    expect(store.scene.objects).toHaveLength(3);
    expect(new Set(store.scene.objects.map((o) => o.mesh?.kind))).toEqual(new Set(["box", "sphere", "plane"]));

    // ── 3. Import a .glb and place it ──────────────────────────────────
    vi.mocked(dialog.open).mockResolvedValueOnce("C:/Downloads/robot.glb" as never);
    vi.mocked(core.invoke).mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "import_asset") {
        project.assets.push({ id: "a1", path: "assets/models/robot.glb", kind: "models", bytes: 42, thumb: null });
        return Promise.resolve({ id: "a1", path: "assets/models/robot.glb", kind: "models", bytes: 42, thumb: null });
      }
      if (cmd === "read_project_file_b64") {
        if (args.file === "assets/models/robot.glb") return Promise.resolve(glbB64);
        if (typeof diskScene === "string") return Promise.resolve(btoa(diskScene));
        return Promise.reject(new Error("missing"));
      }
      if (cmd === "open_project") return Promise.resolve({ ...project, assets: [...project.assets], scenes: [...project.scenes] });
      return Promise.resolve(null);
    });
    await actions.importAssetAction("models");
    expect(store.project?.assets).toHaveLength(1);
    store.addModel("assets/models/robot.glb");
    expect(store.scene.objects.some((o) => o.mesh?.kind === "model" && o.modelPath === "assets/models/robot.glb")).toBe(true);

    // ── 4. Move, rotate, scale ─────────────────────────────────────────
    const cube = store.scene.objects.find((o) => o.mesh?.kind === "box")!;
    store.updateTransform(cube.id, {
      ...cube.transform,
      position: vec3(2, 1, 3),
      rotation: vec3(0, 45, 0),
      scale: vec3(2, 2, 2),
    });
    store.commit();
    expect(near(store.getObject(cube.id)!.transform.position.x, 2)).toBe(true);

    // ── 5. Material & colour ───────────────────────────────────────────
    store.patchMaterial(cube.id, { color: "#ff5c7a", metallic: 0.6, roughness: 0.2 });
    expect(store.getObject(cube.id)!.material?.color).toBe("#ff5c7a");

    // ── 6. Save (inside the project) ───────────────────────────────────
    vi.mocked(core.invoke).mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "project_save_scene") {
        diskScene = String(args.contents);
        project.scenes.push({ name: String(args.name), file: String(args.file) });
        return Promise.resolve(null);
      }
      if (cmd === "open_project") return Promise.resolve({ ...project, assets: [...project.assets], scenes: [...project.scenes] });
      if (cmd === "read_project_file_b64") {
        if (args.file === "assets/models/robot.glb") return Promise.resolve(glbB64);
        if (typeof diskScene === "string") return Promise.resolve(btoa(diskScene));
        return Promise.reject(new Error("missing"));
      }
      return Promise.resolve(null);
    });
    await actions.saveSceneAction();
    expect(diskScene).not.toBeNull();
    expect(diskScene).toContain('"kind": "model"');
    expect(diskScene).toContain("#ff5c7a");
    expect(store.dirty).toBe(false);
    const savedJson = diskScene!;

    // ── 7. Close & reopen without data loss ────────────────────────────
    vi.mocked(dialog.open).mockResolvedValueOnce("F:/Games/MyGame" as never);
    await actions.openProjectAction();
    expect(store.scene.objects.length).toBe(JSON.parse(savedJson).objects.length);
    expect(store.serialize().replace(/\s+/g, "")).toBe(savedJson.replace(/\s+/g, ""));
    const reopened = store.scene.objects.find((o) => o.mesh?.kind === "model");
    expect(reopened?.modelPath).toBe("assets/models/robot.glb");

    // ── 8. Play → try → Stop restores the editor state ─────────────────
    const ball = store.scene.objects.find((o) => o.mesh?.kind === "sphere")!;
    ball.physics = { type: "dynamic", bounce: 0.3, gravityScale: 1, velocity: vec3() };
    store.commit();
    const before = store.serialize();
    store.play();
    tick(120);
    expect(store.playState).toBe("playing");
    store.stop();
    expect(store.serialize()).toBe(before);

    // ── 9. Export as a playable game (models embedded) ─────────────────
    let exportedHtml = "";
    vi.mocked(core.invoke).mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === "read_project_file_b64") return Promise.resolve(glbB64);
      if (cmd === "save_scene") {
        exportedHtml = String(args.contents);
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });
    await actions.exportHtmlAction();
    expect(exportedHtml).not.toBe("");
    expect(exportedHtml).toContain("loadModel");
    expect(exportedHtml).toContain("robot.glb");
    expect(exportedHtml).toContain(glbB64.slice(0, 48)); // embedded GLB bytes
    expect(store.logs.some((l) => l.kind === "success" && l.text.includes("game.html"))).toBe(true);
  });
});
