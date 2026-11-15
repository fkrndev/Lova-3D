/**
 * LovaEngine — core scene model.
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
export type MeshKind = (typeof MESH_KINDS)[number];

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
 * A scene object. Exactly one of `mesh` / `light` is set:
 * mesh objects carry `material`, light objects carry `light`.
 */
export interface GameObject {
  id: string;
  name: string;
  visible: boolean;
  transform: Transform;
  mesh?: MeshDef;
  material?: MaterialDef;
  light?: LightDef;
  behaviors: Behavior[];
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

export type LogKind = "info" | "warn" | "error" | "success";

export interface LogEntry {
  id: number;
  /** `HH:MM:SS` local time. */
  time: string;
  kind: LogKind;
  text: string;
}
