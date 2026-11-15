/**
 * Native Rapier bridge tests — Tauri paths with mocked invoke/dialog.
 * Verifies: world creation payloads, ordered steps applying states to the
 * store, script velocity → set_velocity, respawn teleport detection, and
 * stop() destroying the world.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhysicsBodyDesc, PhysicsBodyState } from "../src/engine/types";
import type { SceneData } from "../src/engine/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

/** Controllable event-listener registry for the physics stream. */
type PhysListener = (payload: { world: number; states: unknown[] }) => void;
const physListeners = new Set<PhysListener>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: PhysListener) => {
    physListeners.add(cb);
    return () => physListeners.delete(cb);
  }),
}));

function emitPhysics(world: number, states: unknown[]): void {
  // io.onPhysicsStates registers (e) => cb(e.payload) — mimic the event shape.
  for (const cb of physListeners) cb({ event: "lova://physics-states", id: 0, payload: { world, states } });
}

let core: typeof import("@tauri-apps/api/core");
let storeMod: typeof import("../src/engine/sceneStore.svelte");
let runtimeMod: typeof import("../src/engine/runtime");

beforeAll(async () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  core = await import("@tauri-apps/api/core");
  storeMod = await import("../src/engine/sceneStore.svelte");
  runtimeMod = await import("../src/engine/runtime");
});

beforeEach(() => {
  localStorage.clear();
  physListeners.clear();
  const store = storeMod.store;
  store.stop();
  store.newScene();
  store.selectedIds = [];
  store.setProject(null);
  vi.mocked(core.invoke).mockReset();
});

const calls = (name: string) =>
  vi.mocked(core.invoke).mock.calls.filter(([cmd]) => cmd === name).map(([, args]) => args);

describe("native Rapier bridge", () => {
  it("creates a world with shape-mapped descriptors and steps it in order", async () => {
    const store = storeMod.store;
    const runtime = runtimeMod.runtime;
    const scene: SceneData = {
      version: 1,
      name: "t",
      environment: { background: "#101318", ambient: 0.35 },
      objects: [],
    };
    const ground = {
      id: "ground", name: "Ground", visible: true, parentId: null,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 40, y: 1, z: 40 } },
      mesh: { kind: "plane" as const },
      physics: { type: "static" as const, bounce: 0, gravityScale: 1, velocity: { x: 0, y: 0, z: 0 } },
      behaviors: [],
    };
    const ball = {
      id: "ball", name: "Ball", visible: true, parentId: null,
      transform: { position: { x: 0, y: 5, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      mesh: { kind: "sphere" as const },
      physics: { type: "dynamic" as const, bounce: 0.3, gravityScale: 1, velocity: { x: 0, y: 0, z: 2 } },
      behaviors: [],
    };
    scene.objects = [ground, ball];
    store.loadScene(scene, null);
    await new Promise((r) => setTimeout(r, 100));

    vi.mocked(core.invoke).mockImplementation((cmd: string) => {
      if (cmd === "physics_world_create") return Promise.resolve(7);
      if (cmd === "physics_run") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    store.play();
    await new Promise((r) => setTimeout(r, 60)); // world + listener + run resolve

    // The Rust loop would stream this event; simulate it arriving.
    emitPhysics(7, [{ id: "ball", translation: [0, 4.9, 0.06], linvel: [0, -0.16, 2], grounded: false } as PhysicsBodyState]);

    const createArgs = calls("physics_world_create")[0] as { bodies: PhysicsBodyDesc[] };
    expect(createArgs.bodies).toHaveLength(2);
    const shapes = Object.fromEntries(createArgs.bodies.map((b) => [b.id, b.shape.kind]));
    expect(shapes.ground).toBe("halfspace");
    expect(shapes.ball).toBe("ball");
    const ballDesc = createArgs.bodies.find((b) => b.id === "ball")!;
    expect(ballDesc.dynamic).toBe(true);
    expect(ballDesc.restitution).toBeCloseTo(0.3, 5);
    expect(ballDesc.linvel).toEqual([0, 0, 2]);

    expect(calls("physics_run")[0]).toEqual({ world: 7, hz: 60 });
    // State applied to the live store:
    const ballObj = store.scene.objects.find((o) => o.id === "ball")!;
    expect(ballObj.transform.position.y).toBeCloseTo(4.9, 3);
    expect(runtime.velocities.get("ball")?.z).toBeCloseTo(2, 3);
    expect(runtime.groundedMap.get("ball")).toBe(false);

    store.stop();
    await new Promise((r) => setTimeout(r, 60)); // async destroy resolves
    expect(calls("physics_world_destroy")[0]).toEqual({ world: 7 });
    // Stop restored the edit-time scene:
    expect(store.scene.objects.find((o) => o.id === "ball")!.transform.position.y).toBe(5);
  });

  it("routes script velocity writes to physics_set_velocity", async () => {
    const store = storeMod.store;
    const runtime = runtimeMod.runtime;
    store.loadScene(
      {
        version: 1,
        name: "t",
        environment: { background: "#101318", ambient: 0.35 },
        objects: [
          {
            id: "ball", name: "Ball", visible: true, parentId: null,
            transform: { position: { x: 0, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
            mesh: { kind: "sphere" },
            physics: { type: "dynamic", bounce: 0, gravityScale: 1, velocity: { x: 0, y: 0, z: 0 } },
            script: "function onUpdate() { api.velocity = { x: 0, y: 7, z: 0 }; }",
            behaviors: [],
          },
        ],
      },
      null
    );
    await new Promise((r) => setTimeout(r, 100));
    vi.mocked(core.invoke).mockImplementation((cmd: string) => {
      if (cmd === "physics_world_create") return Promise.resolve(3);
      if (cmd === "physics_run") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    store.play();
    await new Promise((r) => setTimeout(r, 60));
    runtime.tick(1 / 30); // runs the script → setter fires
    await new Promise((r) => setTimeout(r, 60));

    const setCalls = calls("physics_set_velocity");
    expect(setCalls.length).toBeGreaterThanOrEqual(1);
    expect(setCalls[0]).toEqual({ world: 3, id: "ball", linvel: [0, 7, 0] });
    store.stop();
  });

  it("detects respawn-sized jumps and teleports the body", async () => {
    const store = storeMod.store;
    const runtime = runtimeMod.runtime;
    store.loadScene(
      {
        version: 1,
        name: "t",
        environment: { background: "#101318", ambient: 0.35 },
        objects: [
          {
            id: "ball", name: "Ball", visible: true, parentId: null,
            transform: { position: { x: 0, y: 0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
            mesh: { kind: "sphere" },
            physics: { type: "dynamic", bounce: 0, gravityScale: 1, velocity: { x: 0, y: 0, z: 0 } },
            behaviors: [],
          },
        ],
      },
      null
    );
    await new Promise((r) => setTimeout(r, 100));
    vi.mocked(core.invoke).mockImplementation((cmd: string) => {
      if (cmd === "physics_world_create") return Promise.resolve(9);
      if (cmd === "physics_run") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    store.play();
    await new Promise((r) => setTimeout(r, 60));
    // Stream a resting state so teleport detection has a baseline.
    emitPhysics(9, [{ id: "ball", translation: [0, 0.5, 0], linvel: [0, 0, 0], grounded: true } as PhysicsBodyState]);
    await new Promise((r) => setTimeout(r, 30));
    // A script-style respawn moves it far; the next streamed event detects it.
    store.updateTransform("ball", {
      ...store.scene.objects[0].transform,
      position: { x: 0, y: 8, z: 0 },
    });
    emitPhysics(9, [{ id: "ball", translation: [0, 0.5, 0], linvel: [0, 0, 0], grounded: true } as PhysicsBodyState]);
    await new Promise((r) => setTimeout(r, 30));

    const teleports = calls("physics_teleport");
    expect(teleports).toHaveLength(1);
    expect(teleports[0]).toEqual({ world: 9, id: "ball", translation: [0, 8, 0] });
    store.stop();
  });

  it("pauses and resumes the Rust loop with the editor", async () => {
    const store = storeMod.store;
    store.loadScene(
      {
        version: 1,
        name: "t",
        environment: { background: "#101318", ambient: 0.35 },
        objects: [
          {
            id: "ball", name: "Ball", visible: true, parentId: null,
            transform: { position: { x: 0, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
            mesh: { kind: "sphere" },
            physics: { type: "dynamic", bounce: 0, gravityScale: 1, velocity: { x: 0, y: 0, z: 0 } },
            behaviors: [],
          },
        ],
      },
      null
    );
    await new Promise((r) => setTimeout(r, 100));
    vi.mocked(core.invoke).mockImplementation((cmd: string) => {
      if (cmd === "physics_world_create") return Promise.resolve(11);
      if (cmd === "physics_run") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    store.play();
    await new Promise((r) => setTimeout(r, 60));
    store.pause(); // editor pause → park the loop
    await new Promise((r) => setTimeout(r, 60));
    expect(calls("physics_set_running")).toEqual([{ world: 11, running: false }]);

    store.play(); // resume → tick re-arms the loop
    const runtime = runtimeMod.runtime;
    runtime.tick(1 / 30);
    await new Promise((r) => setTimeout(r, 60));
    const running = calls("physics_set_running");
    expect(running[running.length - 1]).toEqual({ world: 11, running: true });
    store.stop();
  });
});
