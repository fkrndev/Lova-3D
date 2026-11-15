/**
 * Lova 3D — core scene model.
 *
 * The scene model is the single source of truth for the editor.
 * It is plain serializable JSON (no classes, no engine references) so it can
 * be saved/loaded directly and snapshot for undo/redo without cloning logic.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Rotation is stored in degrees (editor friendly); converted to radians at the viewport bridge. */
export interface Transform {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

export const MESH_KINDS = ["box", "sphere", "cylinder", "cone", "capsule", "torus", "plane"] as const;
export type PrimitiveKind = (typeof MESH_KINDS)[number];
/** `"model"` = imported GLB/GLTF asset referenced by `GameObject.modelPath`. */
export type MeshKind = PrimitiveKind | "model";

export interface MeshDef {
  kind: MeshKind;
}

export interface MaterialDef {
  /** Base albedo color (hex, `#rrggbb`). */
  color: string;
  /** Self-illumination color (hex). */
  emissive: string;
  /** 0..1 — mapped to specular intensity in the viewport. */
  metallic: number;
  /** 0..1 — high roughness = matte. */
  roughness: number;
  wireframe: boolean;
}

export const LIGHT_KINDS = ["hemispheric", "directional", "point", "spot"] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];

export interface LightDef {
  kind: LightKind;
  /** 0..10 */
  intensity: number;
  /** Light color (hex). */
  diffuse: string;
  /** Spot only: cone angle in degrees (1..179). */
  angleDeg: number;
  /** Spot only: falloff exponent (0..128). */
  exponent: number;
}

export const BEHAVIOR_KINDS = ["spin", "bob", "orbit"] as const;
export type BehaviorKind = (typeof BEHAVIOR_KINDS)[number];

export interface SpinBehavior {
  id: string;
  kind: "spin";
  enabled: boolean;
  /** Degrees per second, per local axis. */
  speed: Vec3;
}

export interface BobBehavior {
  id: string;
  kind: "bob";
  enabled: boolean;
  /** Vertical amplitude in world units. */
  amplitude: number;
  /** Oscillation speed in radians/second. */
  speed: number;
}

export interface OrbitBehavior {
  id: string;
  kind: "orbit";
  enabled: boolean;
  /** Orbit radius in world units around the object's base position. */
  radius: number;
  /** Angular speed in degrees/second around the Y axis. */
  speed: number;
}

export type Behavior = SpinBehavior | BobBehavior | OrbitBehavior;

/**
 * Optional rigid-body-ish physics, simulated during Play mode.
 * Simulation runs in world space; dynamic bodies under rotated parents are
 * not fully supported in v1 (translation-only compensation on write-back).
 */
export interface PhysicsDef {
  type: "static" | "dynamic";
  /** Restitution 0..1. */
  bounce: number;
  /** Multiplier on gravity (9.8 m/s²); 0 = floating. */
  gravityScale: number;
  /** Initial world-space velocity (units/s). */
  velocity: Vec3;
}

/**
 * A scene object. Exactly one of `mesh` / `light` is set:
 * mesh objects carry `material`, light objects carry `light`.
 *
 * `transform` is LOCAL to `parentId` (root objects: local == world).
 */
export interface GameObject {
  id: string;
  name: string;
  visible: boolean;
  parentId: string | null;
  transform: Transform;
  mesh?: MeshDef;
  /** Project-relative path of the GLB/GLTF asset when `mesh.kind === "model"`. */
  modelPath?: string;
  material?: MaterialDef;
  light?: LightDef;
  physics?: PhysicsDef;
  /** JS source, run on Play: `function onStart() {}` / `function onUpdate(dt, t) {}` with `api.*`. */
  script?: string;
  /**
   * Spherical trigger volume: dynamic bodies entering/leaving the radius fire
   * `onTriggerEnter(other)` / `onTriggerLeave(other)` on this object's script.
   */
  sensor?: { radius: number };
  behaviors: Behavior[];
}

// ── project system ────────────────────────────────────────────────────────

export interface SceneRef {
  name: string;
  file: string;
}

export type AssetKind = "models" | "textures" | "audio";

export interface AssetInfo {
  id: string;
  path: string;
  kind: AssetKind;
  bytes: number;
  thumb: string | null;
}

export interface ProjectInfo {
  root: string;
  name: string;
  scenes: SceneRef[];
  assets: AssetInfo[];
}

export interface Environment {
  /** Viewport clear color (hex). */
  background: string;
  /** Ambient (editor hemispheric) light intensity, 0..2. */
  ambient: number;
}

export interface SceneData {
  version: 1;
  name: string;
  environment: Environment;
  objects: GameObject[];
}

export type GizmoMode = "position" | "rotation" | "scale";
export type PlayState = "edit" | "playing" | "paused";

// ── native physics bridge (Rapier, Rust side) ─────────────────────────────

export type PhysicsShape =
  | { kind: "ball"; radius: number }
  | { kind: "cuboid"; hx: number; hy: number; hz: number }
  | { kind: "halfspace" }
  | { kind: "cylinder"; halfHeight: number; radius: number }
  | { kind: "capsule"; halfHeight: number; radius: number };

export interface PhysicsBodyDesc {
  id: string;
  dynamic: boolean;
  shape: PhysicsShape;
  translation: [number, number, number];
  linvel?: [number, number, number];
  restitution?: number;
  friction?: number;
}

export interface PhysicsBodyState {
  id: string;
  translation: [number, number, number];
  linvel: [number, number, number];
  grounded: boolean;
}

export type LogKind = "info" | "warn" | "error" | "success";

export interface LogEntry {
  id: number;
  /** `HH:MM:SS` local time. */
  time: string;
  kind: LogKind;
  text: string;
}
