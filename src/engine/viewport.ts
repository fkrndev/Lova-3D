/**
 * ViewportBridge — owns the Babylon.js engine/scene and keeps it in sync with
 * the SceneStore.
 *
 * Data flow:
 *   store ──(Svelte effect calls syncScene)──▶ Babylon nodes
 *   Babylon interactions (picking, gizmo drags) ──(callbacks)──▶ store
 *
 * The store stays the single source of truth; this class never mutates scene
 * data directly, it only reports user interaction back through callbacks.
 */
import {
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  GizmoManager,
  HemisphericLight,
  HighlightLayer,
  Light,
  Mesh,
  MeshBuilder,
  PointLight,
  Scene,
  SpotLight,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { GridMaterial } from "@babylonjs/materials";
import { runtime } from "./runtime";
import type { GizmoMode, GameObject, MeshKind, PlayState, SceneData, Transform } from "./types";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const EPS = 1e-3;
const ACCENT = Color3.FromHexString("#ff5c7a");

export interface ViewportCallbacks {
  /** User clicked an object (or empty space when `id` is null). */
  onSelection: (id: string | null, additive: boolean) => void;
  /** Gizmo moved an object — live update, no history commit. */
  onTransformLive: (id: string, transform: Transform) => void;
  /** A gizmo drag finished — the store should commit one history entry. */
  onGizmoCommit: () => void;
  /** Roughly twice a second. */
  onFps: (fps: number) => void;
}

interface NodeEntry {
  root: TransformNode;
  mesh: Mesh | null;
  meshKind: MeshKind | null;
  material: StandardMaterial | null;
  light: Light | null;
  icon: Mesh | null;
  iconMat: StandardMaterial | null;
}

export class ViewportBridge {
  private engine: Engine;
  private scene: Scene;
  private camera: ArcRotateCamera;
  private highlight: HighlightLayer;
  private gizmos: GizmoManager;
  private ground: Mesh;
  private editorHemi: HemisphericLight;
  private editorSun: DirectionalLight;

  private nodes = new Map<string, NodeEntry>();
  private highlighted: Mesh[] = [];
  private selectedIds: string[] = [];
  private attachedId: string | null = null;
  private playState: PlayState = "edit";
  private lastPulledKey = "";
  private pendingGizmoChange = false;
  private fpsAccumMs = 0;
  private downX = 0;
  private downY = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private cb: ViewportCallbacks
  ) {
    this.engine = new Engine(canvas, true, { stencil: true }, true);
    this.scene = new Scene(this.engine);
    this.scene.clearColor = Color4.FromHexString("#101318ff");

    // ── camera ─────────────────────────────────────────────────────────
    this.camera = new ArcRotateCamera("camera", -Math.PI / 3, 1.15, 16, new Vector3(0, 1, 0), this.scene);
    this.camera.lowerRadiusLimit = 1.5;
    this.camera.upperRadiusLimit = 120;
    this.camera.upperBetaLimit = (Math.PI / 2) * 0.98;
    this.camera.wheelDeltaPercentage = 0.01;
    this.camera.minZ = 0.1;
    this.camera.panningSensibility = 60;
    this.camera.attachControl(canvas, true);

    // ── editor helpers (never serialized) ───────────────────────────────
    this.editorHemi = new HemisphericLight("editor-hemi", new Vector3(0, 1, 0), this.scene);
    this.editorHemi.intensity = 0.35;
    this.editorSun = new DirectionalLight("editor-sun", new Vector3(-0.5, -1, 0.4), this.scene);
    this.editorSun.intensity = 0.25;

    const grid = new GridMaterial("grid", this.scene);
    grid.mainColor = Color3.FromHexString("#14171d");
    grid.lineColor = Color3.FromHexString("#3a4150");
    grid.gridRatio = 1;
    grid.majorUnitFrequency = 5;
    grid.minorUnitVisibility = 0.35;
    grid.opacity = 0.99;
    grid.backFaceCulling = false;

    this.ground = MeshBuilder.CreateGround("editor-grid", { width: 1, height: 1, subdivisions: 1 }, this.scene);
    this.ground.material = grid;
    this.ground.scaling.set(60, 1, 60);
    this.ground.position.y = -0.005;
    this.ground.isPickable = false;

    // ── selection & gizmos ─────────────────────────────────────────────
    this.highlight = new HighlightLayer("highlight", this.scene);
    this.highlight.innerGlow = false;

    this.gizmos = new GizmoManager(this.scene);
    this.gizmos.usePointerToAttachGizmos = false;
    this.setGizmoMode("position");

    // ── input ──────────────────────────────────────────────────────────
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("contextmenu", this.onContextMenu);

    this.engine.runRenderLoop(() => {
      const dt = this.engine.getDeltaTime() / 1000;
      runtime.tick(dt);
      this.pullGizmoTransform();
      this.scene.render();
      this.reportFps(dt);
    });
  }

  // ───────────────────────────── public API ────────────────────────────

  /** Full diff-sync of the Babylon scene from the store's scene data. */
  syncScene(scene: SceneData): void {
    const seen = new Set<string>();
    for (const obj of scene.objects) {
      seen.add(obj.id);
      let entry = this.nodes.get(obj.id);
      if (!entry) {
        entry = this.createObject(obj);
        this.nodes.set(obj.id, entry);
      }
      this.updateObject(entry, obj);
    }
    for (const [id, entry] of Array.from(this.nodes)) {
      if (!seen.has(id)) {
        this.disposeEntry(entry);
        this.nodes.delete(id);
      }
    }
    this.scene.clearColor = Color4.FromHexString(padHex(scene.environment.background));
    this.editorHemi.intensity = scene.environment.ambient;
    this.applySelection();
  }

  setGizmoMode(mode: GizmoMode): void {
    this.gizmos.positionGizmoEnabled = mode === "position";
    this.gizmos.rotationGizmoEnabled = mode === "rotation";
    this.gizmos.scaleGizmoEnabled = mode === "scale";
  }

  setSelection(ids: string[]): void {
    this.applySelection(ids);
  }

  setPlayState(state: PlayState): void {
    this.playState = state;
    const editing = state === "edit";
    this.ground.setEnabled(editing);
    if (!editing) {
      this.detachGizmo();
      this.clearHighlight();
      for (const entry of this.nodes.values()) entry.icon?.setEnabled(false);
    } else {
      for (const entry of this.nodes.values()) this.updateIconVisibility(entry);
    }
  }

  /** Frame the given object ids (F key). */
  focusSelection(ids: string[]): void {
    const positions: Vector3[] = [];
    for (const id of ids) {
      const entry = this.nodes.get(id);
      if (entry) positions.push(entry.root.getAbsolutePosition());
    }
    if (positions.length === 0) return;
    const center = positions
      .reduce((acc, p) => acc.addInPlace(p), new Vector3())
      .scaleInPlace(1 / positions.length);
    let radius = 0.001;
    for (const p of positions) radius = Math.max(radius, Vector3.Distance(center, p));
    this.camera.setTarget(center);
    this.camera.radius = Math.max(4, radius * 3.2);
  }

  /** Forward to the Babylon engine (call from a ResizeObserver). */
  resize(): void {
    this.engine.resize();
  }

  dispose(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    this.engine.stopRenderLoop();
    this.scene.dispose();
    this.engine.dispose();
  }

  // ─────────────────────────── object lifecycle ────────────────────────

  private createObject(obj: GameObject): NodeEntry {
    const root = new TransformNode(obj.id, this.scene);
    root.id = obj.id;
    root.name = obj.name;

    const entry: NodeEntry = {
      root,
      mesh: null,
      meshKind: null,
      material: null,
      light: null,
      icon: null,
      iconMat: null,
    };

    if (obj.mesh) {
      entry.material = new StandardMaterial(`mat:${obj.id}`, this.scene);
      entry.mesh = this.buildMesh(obj.mesh.kind, obj.id, obj.name);
      entry.mesh.parent = root;
      entry.mesh.material = entry.material;
      entry.meshKind = obj.mesh.kind;
    }

    if (obj.light) {
      entry.light = this.buildLight(obj, root);
      entry.iconMat = new StandardMaterial(`icon-mat:${obj.id}`, this.scene);
      entry.iconMat.disableLighting = true;
      const icon = MeshBuilder.CreateSphere(`icon:${obj.id}`, { diameter: 0.4, segments: 12 }, this.scene);
      icon.material = entry.iconMat;
      icon.parent = root;
      icon.isPickable = true;
      icon.metadata = { lovaId: obj.id };
      entry.icon = icon;
    }

    return entry;
  }

  private buildMesh(kind: MeshKind, id: string, name: string): Mesh {
    let mesh: Mesh;
    switch (kind) {
      case "box":
        mesh = MeshBuilder.CreateBox(id, { size: 1 }, this.scene);
        break;
      case "sphere":
        mesh = MeshBuilder.CreateSphere(id, { diameter: 1, segments: 24 }, this.scene);
        break;
      case "cylinder":
        mesh = MeshBuilder.CreateCylinder(id, { height: 1, diameter: 1, tessellation: 28 }, this.scene);
        break;
      case "cone":
        mesh = MeshBuilder.CreateCylinder(id, { height: 1, diameterTop: 0, diameterBottom: 1, tessellation: 28 }, this.scene);
        break;
      case "capsule":
        mesh = MeshBuilder.CreateCapsule(id, { height: 1, radius: 0.375 }, this.scene);
        break;
      case "torus":
        mesh = MeshBuilder.CreateTorus(id, { diameter: 1, thickness: 0.35, tessellation: 28 }, this.scene);
        break;
      case "plane":
        mesh = MeshBuilder.CreateGround(id, { width: 1, height: 1, subdivisions: 1 }, this.scene);
        break;
    }
    mesh.name = name;
    mesh.metadata = { lovaId: id };
    mesh.isPickable = true;
    return mesh;
  }

  private buildLight(obj: GameObject, root: TransformNode): Light {
    const def = obj.light!;
    const dir = new Vector3(0, -1, 0); // local space — parent rotation applies
    let light: Light;
    switch (def.kind) {
      case "hemispheric":
        light = new HemisphericLight(`light:${obj.id}`, new Vector3(0, 1, 0), this.scene);
        break;
      case "directional":
        light = new DirectionalLight(`light:${obj.id}`, dir, this.scene);
        break;
      case "point":
        light = new PointLight(`light:${obj.id}`, Vector3.Zero(), this.scene);
        break;
      case "spot":
        light = new SpotLight(`light:${obj.id}`, Vector3.Zero(), dir, def.angleDeg * DEG, def.exponent, this.scene);
        break;
    }
    light.parent = root;
    return light;
  }

  private updateObject(entry: NodeEntry, obj: GameObject): void {
    entry.root.name = obj.name;

    // Rebuild the visual mesh if the kind changed.
    if (obj.mesh && entry.meshKind !== obj.mesh.kind) {
      entry.mesh?.dispose();
      entry.mesh = this.buildMesh(obj.mesh.kind, obj.id, obj.name);
      entry.mesh.parent = entry.root;
      entry.mesh.material = entry.material;
      entry.meshKind = obj.mesh.kind;
    } else if (entry.mesh) {
      entry.mesh.name = obj.name;
    }

    // Rebuild the light if the kind changed.
    if (obj.light && entry.light?.getClassName() !== lightClassName(obj.light.kind)) {
      entry.light?.dispose();
      entry.light = this.buildLight(obj, entry.root);
    }

    // Transform.
    const t = obj.transform;
    const pos = new Vector3(t.position.x, t.position.y, t.position.z);
    const rot = new Vector3(t.rotation.x * DEG, t.rotation.y * DEG, t.rotation.z * DEG);
    const scl = new Vector3(t.scale.x, t.scale.y, t.scale.z);

    if (!vecEq(entry.root.position, pos, EPS)) entry.root.position.copyFrom(pos);

    // Rotation: the gizmo writes a rotationQuaternion, so only override the
    // Euler rotation when it genuinely differs from the quaternion's meaning —
    // this avoids fighting an in-progress gizmo drag.
    const q = entry.root.rotationQuaternion;
    if (q) {
      const cur = q.toEulerAngles();
      if (!vecEq(cur, rot, EPS)) {
        entry.root.rotationQuaternion = null;
        entry.root.rotation.copyFrom(rot);
      }
    } else if (!vecEq(entry.root.rotation, rot, EPS)) {
      entry.root.rotation.copyFrom(rot);
    }

    if (!vecEq(entry.root.scaling, scl, EPS)) entry.root.scaling.copyFrom(scl);

    entry.root.setEnabled(obj.visible);
    this.updateIconVisibility(entry);

    // Material.
    if (obj.mesh && entry.material && obj.material) {
      const m = obj.material;
      const bm = entry.material;
      const diff = Color3.FromHexString(padHex(m.color));
      if (!bm.diffuseColor.equals(diff)) bm.diffuseColor = diff;
      const emis = Color3.FromHexString(padHex(m.emissive));
      if (!bm.emissiveColor.equals(emis)) bm.emissiveColor = emis;
      // Approximate metallic/roughness with the standard material model.
      const spec = new Color3(m.metallic, m.metallic, m.metallic);
      if (!bm.specularColor.equals(spec)) bm.specularColor = spec;
      const power = Math.pow(2, 5 + (1 - clamp01(m.roughness)) * 6);
      if (bm.specularPower !== power) bm.specularPower = power;
      if (bm.wireframe !== m.wireframe) bm.wireframe = m.wireframe;
      const cull = obj.mesh.kind !== "plane";
      if (bm.backFaceCulling !== cull) bm.backFaceCulling = cull;
    }

    // Light params.
    if (obj.light && entry.light) {
      entry.light.intensity = obj.light.intensity;
      entry.light.diffuse = Color3.FromHexString(padHex(obj.light.diffuse));
      if (entry.light instanceof SpotLight) {
        entry.light.angle = obj.light.angleDeg * DEG;
        entry.light.exponent = obj.light.exponent;
      }
    }
    if (entry.iconMat) {
      entry.iconMat.emissiveColor = Color3.FromHexString(padHex(obj.light?.diffuse ?? "#ffffff"));
    }
  }

  private updateIconVisibility(entry: NodeEntry): void {
    if (!entry.icon) return;
    entry.icon.setEnabled(this.playState === "edit");
  }

  private disposeEntry(entry: NodeEntry): void {
    entry.mesh?.dispose();
    entry.icon?.dispose();
    entry.light?.dispose();
    entry.material?.dispose();
    entry.iconMat?.dispose();
    entry.root.dispose(false, false);
  }

  // ─────────────────────────── selection / gizmo ───────────────────────

  private applySelection(ids?: string[]): void {
    if (ids !== undefined) this.selectedIds = ids;
    this.refreshHighlight(this.selectedIds);
    const primary = this.selectedIds.length > 0 ? this.selectedIds[this.selectedIds.length - 1] : null;
    if (this.playState === "edit") {
      this.attachGizmo(primary);
    }
  }

  private attachGizmo(id: string | null): void {
    if (id === this.attachedId) return;
    this.attachedId = id;
    this.lastPulledKey = "";
    const entry = id ? this.nodes.get(id) : undefined;
    this.gizmos.attachToNode(entry ? entry.root : null);
  }

  private detachGizmo(): void {
    this.attachGizmo(null);
  }

  private clearHighlight(): void {
    for (const mesh of this.highlighted) this.highlight.removeMesh(mesh);
    this.highlighted = [];
  }

  private refreshHighlight(ids: string[]): void {
    this.clearHighlight();
    for (const id of ids) {
      const entry = this.nodes.get(id);
      if (!entry) continue;
      if (entry.mesh) {
        this.highlight.addMesh(entry.mesh, ACCENT);
        this.highlighted.push(entry.mesh);
      }
      if (entry.icon) {
        this.highlight.addMesh(entry.icon, ACCENT);
        this.highlighted.push(entry.icon);
      }
    }
  }

  // ─────────────────────────── gizmo → store ───────────────────────────

  /**
   * While a gizmo drag is in progress the node is authoritative: pull its
   * transform into the store every frame (converted to degrees).
   */
  private pullGizmoTransform(): void {
    if (this.playState !== "edit" || !this.attachedId) return;
    const entry = this.nodes.get(this.attachedId);
    if (!entry) return;

    const r = entry.root;
    let rotation: Vector3;
    if (r.rotationQuaternion) {
      rotation = r.rotationQuaternion.toEulerAngles();
    } else {
      rotation = r.rotation;
    }

    const transform: Transform = {
      position: { x: r.position.x, y: r.position.y, z: r.position.z },
      rotation: { x: rotation.x * RAD, y: rotation.y * RAD, z: rotation.z * RAD },
      scale: { x: r.scaling.x, y: r.scaling.y, z: r.scaling.z },
    };

    const key = `${transform.position.x},${transform.position.y},${transform.position.z}|${transform.rotation.x},${transform.rotation.y},${transform.rotation.z}|${transform.scale.x},${transform.scale.y},${transform.scale.z}`;
    if (key !== this.lastPulledKey) {
      this.lastPulledKey = key;
      this.pendingGizmoChange = true;
      this.cb.onTransformLive(this.attachedId, transform);
    }
  }

  // ────────────────────────────── picking ──────────────────────────────

  private onPointerDown = (e: PointerEvent): void => {
    this.downX = e.clientX;
    this.downY = e.clientY;
  };

  private onPointerUp = (e: PointerEvent): void => {
    // Commit a finished gizmo drag (one history entry per drag).
    if (this.pendingGizmoChange) {
      this.pendingGizmoChange = false;
      this.cb.onGizmoCommit();
      return;
    }
    // Treat small movements as clicks, not orbit drags.
    const dx = e.clientX - this.downX;
    const dy = e.clientY - this.downY;
    if (Math.hypot(dx, dy) > 5) return;
    if (e.button !== 0 || this.playState !== "edit") return;

    const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (m) => m.isPickable && m.metadata?.lovaId !== undefined);
    const id = (pick?.hit ? (pick.pickedMesh?.metadata?.lovaId as string | undefined) : undefined) ?? null;
    this.cb.onSelection(id, e.ctrlKey || e.metaKey || e.shiftKey);
  };

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  // ─────────────────────────────── misc ────────────────────────────────

  private reportFps(dt: number): void {
    this.fpsAccumMs += dt * 1000;
    if (this.fpsAccumMs >= 500) {
      this.fpsAccumMs = 0;
      this.cb.onFps(this.engine.getFps());
    }
  }
}

// ─────────────────────────────── helpers ────────────────────────────────

function vecEq(a: Vector3, b: Vector3, eps: number): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function padHex(hex: string): string {
  return hex.length === 7 ? `${hex}ff` : hex.length === 9 ? hex : "#101318ff";
}

function lightClassName(kind: string): string {
  switch (kind) {
    case "hemispheric":
      return "HemisphericLight";
    case "directional":
      return "DirectionalLight";
    case "point":
      return "PointLight";
    case "spot":
      return "SpotLight";
    default:
      return "";
  }
}
