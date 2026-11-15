/**
 * Shared test helpers: deterministic scenes and physics driving.
 */
import { store, SceneStore } from "../src/engine/sceneStore.svelte";
import { runtime } from "../src/engine/runtime";
import { createLightObject, createMeshObject } from "../src/engine/factories";
import type { GameObject, MeshKind, SceneData, Vec3 } from "../src/engine/types";

export { store, SceneStore, runtime };

export const DT = 1 / 30;

/** Reset the singleton store to a clean default scene between tests. */
export function resetStore(): void {
  localStorage.clear();
  store.stop();
  store.newScene();
  store.selectedIds = [];
}

/** Build a fresh plain object (mesh or light) without touching the store. */
export function makeObject(kind: MeshKind | `light:${string}`, overrides: Partial<GameObject> = {}): GameObject {
  const objects: GameObject[] = [];
  const obj = kind.startsWith("light:")
    ? createLightObject(kind.slice(6) as never, objects)
    : createMeshObject(kind as MeshKind, objects);
  return { ...obj, ...overrides };
}

/** Replace the whole scene with a minimal physics playground. */
export function loadBareScene(objects: GameObject[]): void {
  const scene: SceneData = {
    version: 1,
    name: "test",
    environment: { background: "#101318", ambient: 0.35 },
    objects,
  };
  store.loadScene(scene, null);
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

/** Drive the play-mode runtime deterministically. */
export function tick(n = 1, dt = DT): void {
  for (let i = 0; i < n; i++) runtime.tick(dt);
}

/** A dynamic sphere at a position (radius = 0.5 × max scale). */
export function dynamicBall(name: string, pos: Vec3, scale: Vec3 = vec3(1, 1, 1)): GameObject {
  const o = makeObject("sphere", { name });
  o.transform.position = { ...pos };
  o.transform.scale = { ...scale };
  o.physics = { type: "dynamic", bounce: 0, gravityScale: 1, velocity: vec3() };
  return o;
}

/** A static ground plane at y. */
export function groundPlane(y = 0): GameObject {
  const o = makeObject("plane", { name: "Ground" });
  o.transform.position = vec3(0, y, 0);
  o.transform.scale = vec3(40, 1, 40);
  o.physics = { type: "static", bounce: 0, gravityScale: 1, velocity: vec3() };
  return o;
}

/** A static AABB box collider. */
export function staticBox(name: string, pos: Vec3, scale: Vec3): GameObject {
  const o = makeObject("box", { name });
  o.transform.position = { ...pos };
  o.transform.scale = { ...scale };
  o.physics = { type: "static", bounce: 0, gravityScale: 1, velocity: vec3() };
  return o;
}

export const worldY = (o: GameObject) => store.worldPositionOf(o).y;
export const worldX = (o: GameObject) => store.worldPositionOf(o).x;
export const worldZ = (o: GameObject) => store.worldPositionOf(o).z;
export const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;
