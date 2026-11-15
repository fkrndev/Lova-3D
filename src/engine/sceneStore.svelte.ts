/**
 * SceneStore — the single source of truth for editor state.
 *
 * Implemented as a Svelte 5 runes class (hence the `.svelte.ts` extension):
 * UI panels read it reactively, the viewport bridge syncs Babylon.js from it,
 * and undo/redo is a plain list of JSON snapshots of `scene`.
 */
import { t } from "../i18n/index.svelte";
import { runtime } from "./runtime";
import {
  createBehavior,
  createDefaultScene,
  createLightObject,
  createMeshObject,
  createModelObject,
  uid,
} from "./factories";
import type {
  Behavior,
  BehaviorKind,
  GizmoMode,
  GameObject,
  LightDef,
  LightKind,
  LogEntry,
  LogKind,
  MaterialDef,
  MeshDef,
  MeshKind,
  PlayState,
  ProjectInfo,
  SceneData,
  Transform,
} from "./types";

const HISTORY_LIMIT = 64;
const COMMIT_DEBOUNCE_MS = 500;
const LOG_LIMIT = 200;
const AUTOSAVE_KEY = "lova.autosave";
const AUTOSAVE_DEBOUNCE_MS = 2000;

const round4 = (v: number) => Number(v.toFixed(4));

export class SceneStore {
  scene = $state<SceneData>(createDefaultScene());
  selectedIds = $state<string[]>([]);
  gizmoMode = $state<GizmoMode>("position");
  playState = $state<PlayState>("edit");
  logs = $state<LogEntry[]>([]);
  dirty = $state(false);
  /** True when the session started from a recovered autosave. */
  recovered = $state(false);
  /** HUD text set by game scripts during play. */
  playHud = $state("");
  /** Open project (folder + SQLite index), or null for standalone scene files. */
  project = $state<ProjectInfo | null>(null);
  currentPath = $state<string | null>(null);
  fps = $state(0);

  private history = $state<{ snaps: string[]; index: number }>({ snaps: [], index: -1 });
  private logSeq = 0;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.recoverAutosave();
    this.pushSnapshot();
  }

  // ────────────────────────────── getters ──────────────────────────────

  get canUndo(): boolean {
    return this.history.index > 0;
  }

  get canRedo(): boolean {
    return this.history.index < this.history.snaps.length - 1;
  }

  /** Last selected id — the object the gizmo attaches to. */
  get primarySelection(): string | null {
    return this.selectedIds.length > 0 ? this.selectedIds[this.selectedIds.length - 1] : null;
  }

  getObject(id: string): GameObject | undefined {
    return this.scene.objects.find((o) => o.id === id);
  }

  childrenOf(id: string | null): GameObject[] {
    return this.scene.objects.filter((o) => o.parentId === id);
  }

  /** All descendant ids of `id` (not including itself). */
  descendantsOf(id: string): Set<string> {
    const out = new Set<string>();
    const walk = (pid: string) => {
      for (const o of this.scene.objects) {
        if (o.parentId === pid && !out.has(o.id)) {
          out.add(o.id);
          walk(o.id);
        }
      }
    };
    walk(id);
    return out;
  }

  /**
   * The object's OWN world translation & accumulated scale
   * (rotation ignored — v1 chain math, exact for unrotated ancestors):
   * `world = parentWorld + parentWorldScale × local`.
   */
  worldTransformOf(obj: GameObject): { position: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } } {
    const chain: GameObject[] = [];
    const guard = new Set<string>([obj.id]);
    let pid = obj.parentId;
    while (pid) {
      const p = this.getObject(pid);
      if (!p || guard.has(p.id)) break;
      guard.add(p.id);
      chain.push(p);
      pid = p.parentId;
    }
    // chain is child→parent; accumulate from the topmost ancestor downwards,
    // then apply the object's own local transform.
    let px = 0,
      py = 0,
      pz = 0,
      sx = 1,
      sy = 1,
      sz = 1;
    for (let i = chain.length - 1; i >= 0; i--) {
      const t = chain[i].transform;
      px += sx * t.position.x;
      py += sy * t.position.y;
      pz += sz * t.position.z;
      sx *= t.scale.x;
      sy *= t.scale.y;
      sz *= t.scale.z;
    }
    const t = obj.transform;
    return {
      position: { x: px + sx * t.position.x, y: py + sy * t.position.y, z: pz + sz * t.position.z },
      scale: { x: sx * t.scale.x, y: sy * t.scale.y, z: sz * t.scale.z },
    };
  }

  worldPositionOf(obj: GameObject): { x: number; y: number; z: number } {
    return this.worldTransformOf(obj).position;
  }

  // ───────────────────────────── selection ─────────────────────────────

  select(id: string | null, additive = false): void {
    if (id === null) {
      if (!additive) this.selectedIds = [];
      return;
    }
    if (additive) {
      this.selectedIds = this.selectedIds.includes(id)
        ? this.selectedIds.filter((s) => s !== id)
        : [...this.selectedIds, id];
    } else {
      this.selectedIds = [id];
    }
  }

  setSelection(ids: string[]): void {
    this.selectedIds = ids;
  }

  isSelected(id: string): boolean {
    return this.selectedIds.includes(id);
  }

  private pruneSelection(): void {
    const ids = new Set(this.scene.objects.map((o) => o.id));
    this.selectedIds = this.selectedIds.filter((id) => ids.has(id));
  }

  // ─────────────────────────────── history ─────────────────────────────

  private pushSnapshot(): void {
    const snaps = this.history.snaps.slice(0, this.history.index + 1);
    snaps.push(JSON.stringify(this.scene));
    while (snaps.length > HISTORY_LIMIT) snaps.shift();
    this.history = { snaps, index: snaps.length - 1 };
  }

  /** Commit an action to history (call after a discrete mutation). */
  commit(): void {
    if (this.playState !== "edit") return;
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    this.pushSnapshot();
    this.dirty = true;
    this.scheduleAutosave();
  }

  /** Debounced commit — for continuous edits (number fields, sliders, colors). */
  commitSoon(): void {
    if (this.playState !== "edit") return;
    if (this.commitTimer !== null) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.commit();
    }, COMMIT_DEBOUNCE_MS);
  }

  undo(): void {
    if (!this.canUndo || this.playState !== "edit") return;
    this.history = { ...this.history, index: this.history.index - 1 };
    this.restoreSceneJson(this.history.snaps[this.history.index]);
    this.dirty = true;
    this.log("info", t("log.undo"));
  }

  redo(): void {
    if (!this.canRedo || this.playState !== "edit") return;
    this.history = { ...this.history, index: this.history.index + 1 };
    this.restoreSceneJson(this.history.snaps[this.history.index]);
    this.dirty = true;
    this.log("info", t("log.redo"));
  }

  /** Replaces the whole scene from JSON without touching history. */
  restoreSceneJson(json: string): void {
    this.scene = JSON.parse(json) as SceneData;
    this.pruneSelection();
  }

  // ───────────────────────────── object ops ────────────────────────────

  addMesh(kind: MeshKind): void {
    if (this.playState !== "edit") return;
    const obj = createMeshObject(kind, this.scene.objects);
    this.scene.objects.push(obj);
    this.commit();
    this.select(obj.id);
    this.log("info", t("log.addObj", { name: obj.name }));
  }

  addLight(kind: LightKind): void {
    if (this.playState !== "edit") return;
    const obj = createLightObject(kind, this.scene.objects);
    this.scene.objects.push(obj);
    this.commit();
    this.select(obj.id);
    this.log("info", t("log.addObj", { name: obj.name }));
  }

  /** Add an imported GLB/GLTF asset instance to the scene. */
  addModel(modelPath: string): void {
    if (this.playState !== "edit") return;
    const obj = createModelObject(modelPath, this.scene.objects);
    this.scene.objects.push(obj);
    this.commit();
    this.select(obj.id);
    this.log("info", t("log.addObj", { name: obj.name }));
  }

  setProject(project: ProjectInfo | null): void {
    this.project = project;
  }

  removeSelected(): void {
    if (this.playState !== "edit" || this.selectedIds.length === 0) return;
    // Delete whole subtrees.
    const doomed = new Set<string>();
    for (const id of this.selectedIds) {
      doomed.add(id);
      for (const d of this.descendantsOf(id)) doomed.add(d);
    }
    const count = doomed.size;
    this.scene.objects = this.scene.objects.filter((o) => !doomed.has(o.id));
    this.selectedIds = [];
    this.commit();
    this.log("info", t("log.removeObjs", { count }));
  }

  duplicateSelected(): void {
    if (this.playState !== "edit" || this.selectedIds.length === 0) return;
    // Only duplicate top-most selected objects (skip ones whose ancestor is selected).
    const selected = new Set(this.selectedIds);
    const roots = this.selectedIds.filter((id) => {
      let pid = this.getObject(id)?.parentId ?? null;
      while (pid) {
        if (selected.has(pid)) return false;
        pid = this.getObject(pid)?.parentId ?? null;
      }
      return true;
    });

    const clones: GameObject[] = [];
    const newRootIds: string[] = [];
    let count = 0;
    for (const rootId of roots) {
      const subtreeIds = new Set<string>([rootId, ...this.descendantsOf(rootId)]);
      const idMap = new Map<string, string>();
      for (const oldId of subtreeIds) idMap.set(oldId, uid());
      for (const oldId of subtreeIds) {
        const src = this.getObject(oldId);
        if (!src) continue;
        const clone: GameObject = JSON.parse(JSON.stringify(src));
        clone.id = idMap.get(oldId)!;
        clone.behaviors = clone.behaviors.map((b) => ({ ...b, id: uid() }));
        // Reparent inside the subtree; parents outside keep pointing at the original.
        clone.parentId = src.parentId && subtreeIds.has(src.parentId) ? idMap.get(src.parentId)! : src.parentId;
        // Nudge top-level clones sideways so they are immediately visible.
        if (oldId === rootId) {
          clone.name = `${src.name} Copy`;
          clone.transform = {
            ...clone.transform,
            position: { ...clone.transform.position, x: clone.transform.position.x + 0.75 },
          };
          newRootIds.push(clone.id);
        }
        clones.push(clone);
        count += 1;
      }
    }
    if (clones.length === 0) return;
    this.scene.objects.push(...clones);
    this.commit();
    this.setSelection(newRootIds);
    this.log("info", t("log.duplicate", { count }));
  }

  /**
   * Re-parent an object, keeping its world position (translation-compensated,
   * exact for unrotated parents) and preventing cycles.
   */
  reparent(id: string, parentId: string | null): void {
    if (this.playState !== "edit") return;
    const obj = this.getObject(id);
    if (!obj) return;
    if (parentId === obj.parentId) return;
    if (parentId === id) return;
    if (parentId) {
      const parent = this.getObject(parentId);
      if (!parent) return;
      // Would create a cycle if the new parent is a descendant of the object.
      if (this.descendantsOf(id).has(parentId)) return;
    }

    const world = this.worldPositionOf(obj);
    if (parentId) {
      const pw = this.worldTransformOf(this.getObject(parentId)!);
      obj.parentId = parentId;
      obj.transform = {
        ...obj.transform,
        position: {
          x: round4((world.x - pw.position.x) / (pw.scale.x || 1)),
          y: round4((world.y - pw.position.y) / (pw.scale.y || 1)),
          z: round4((world.z - pw.position.z) / (pw.scale.z || 1)),
        },
      };
    } else {
      obj.parentId = null;
      obj.transform = {
        ...obj.transform,
        position: { x: round4(world.x), y: round4(world.y), z: round4(world.z) },
      };
    }

    // Move the object (and its subtree) after the new parent in array order for readability.
    const subtree = new Set<string>([id, ...this.descendantsOf(id)]);
    const ordered = this.scene.objects.filter((o) => !subtree.has(o.id));
    const moving = this.scene.objects.filter((o) => subtree.has(o.id));
    let insertAt = ordered.length;
    if (parentId) {
      const idx = ordered.findIndex((o) => o.id === parentId);
      if (idx >= 0) insertAt = idx + 1;
    }
    ordered.splice(insertAt, 0, ...moving);
    this.scene.objects = ordered;

    this.commit();
  }

  rename(id: string, name: string): void {
    const obj = this.getObject(id);
    if (!obj || this.playState !== "edit") return;
    obj.name = name.trim() === "" ? obj.name : name.trim();
    this.commit();
  }

  setVisible(id: string, visible: boolean): void {
    const obj = this.getObject(id);
    if (!obj || this.playState !== "edit") return;
    obj.visible = visible;
    this.commit();
  }

  /** Live transform update — no history commit (gizmo drag / inspector scrubbing). */
  updateTransform(id: string, transform: Transform): void {
    const obj = this.getObject(id);
    if (!obj) return;
    obj.transform = transform;
  }

  patchMesh(id: string, patch: Partial<MeshDef>): void {
    const obj = this.getObject(id);
    if (!obj?.mesh || this.playState !== "edit") return;
    Object.assign(obj.mesh, patch);
    this.commit();
  }

  patchMaterial(id: string, patch: Partial<MaterialDef>): void {
    const obj = this.getObject(id);
    if (!obj?.material || this.playState !== "edit") return;
    Object.assign(obj.material, patch);
    this.commitSoon();
  }

  patchLight(id: string, patch: Partial<LightDef>): void {
    const obj = this.getObject(id);
    if (!obj?.light || this.playState !== "edit") return;
    Object.assign(obj.light, patch);
    this.commitSoon();
  }

  setEnvironment(patch: Partial<SceneData["environment"]>): void {
    if (this.playState !== "edit") return;
    Object.assign(this.scene.environment, patch);
    this.commitSoon();
  }

  setSceneName(name: string): void {
    if (this.playState !== "edit") return;
    this.scene.name = name;
    this.commitSoon();
  }

  // ───────────────────────────── behaviors ─────────────────────────────

  addBehavior(objectId: string, kind: BehaviorKind): void {
    const obj = this.getObject(objectId);
    if (!obj || this.playState !== "edit") return;
    obj.behaviors.push(createBehavior(kind));
    this.commit();
  }

  removeBehavior(objectId: string, behaviorId: string): void {
    const obj = this.getObject(objectId);
    if (!obj || this.playState !== "edit") return;
    obj.behaviors = obj.behaviors.filter((b) => b.id !== behaviorId);
    this.commit();
  }

  patchBehavior(objectId: string, behaviorId: string, patch: Partial<Behavior>): void {
    const obj = this.getObject(objectId);
    if (!obj || this.playState !== "edit") return;
    const b = obj.behaviors.find((x) => x.id === behaviorId) as Behavior | undefined;
    if (!b) return;
    Object.assign(b, patch);
    this.commitSoon();
  }

  // ─────────────────────────── physics / script ─────────────────────────

  setPhysics(objectId: string, type: "static" | "dynamic"): void {
    const obj = this.getObject(objectId);
    if (!obj || this.playState !== "edit") return;
    obj.physics = {
      type,
      bounce: type === "dynamic" ? 0.4 : 0.3,
      gravityScale: 1,
      velocity: { x: 0, y: 0, z: 0 },
    };
    this.commit();
  }

  removePhysics(objectId: string): void {
    const obj = this.getObject(objectId);
    if (!obj || this.playState !== "edit") return;
    obj.physics = undefined;
    this.commit();
  }

  patchPhysics(objectId: string, patch: Partial<NonNullable<GameObject["physics"]>>): void {
    const obj = this.getObject(objectId);
    if (!obj?.physics || this.playState !== "edit") return;
    Object.assign(obj.physics, patch);
    this.commitSoon();
  }

  setScript(objectId: string, source: string): void {
    const obj = this.getObject(objectId);
    if (!obj || this.playState !== "edit") return;
    const trimmed = source.trim() === "" ? undefined : source;
    if (trimmed === undefined) delete obj.script;
    else obj.script = source;
    this.commitSoon();
  }

  // ────────────────────────────── scenes ───────────────────────────────

  newScene(): void {
    this.stop();
    this.scene = createDefaultScene();
    this.selectedIds = [];
    this.currentPath = null;
    this.dirty = false;
    this.history = { snaps: [], index: -1 };
    this.pushSnapshot();
    this.clearAutosave();
    this.log("info", t("log.sceneNew"));
  }

  loadScene(data: SceneData, path: string | null): void {
    this.stop();
    this.scene = data;
    this.selectedIds = [];
    this.currentPath = path;
    this.dirty = false;
    this.history = { snaps: [], index: -1 };
    this.pushSnapshot();
    this.clearAutosave();
    this.log("success", t("log.sceneLoaded", { name: data.name, count: data.objects.length }));
  }

  markSaved(path: string): void {
    this.currentPath = path;
    this.dirty = false;
    this.clearAutosave();
  }

  serialize(): string {
    return JSON.stringify(this.scene, null, 2);
  }

  // ──────────────────────────── play mode ──────────────────────────────

  play(): void {
    if (this.playState === "edit") {
      if (this.commitTimer !== null) {
        clearTimeout(this.commitTimer);
        this.commitTimer = null;
        this.pushSnapshot();
      }
      runtime.start(this, this.serialize());
      this.selectedIds = [];
      this.playState = "playing";
      this.log("info", t("log.playStarted"));
    } else {
      this.playState = "playing";
      this.log("info", t("log.playStarted"));
    }
  }

  pause(): void {
    if (this.playState !== "playing") return;
    this.playState = "paused";
    this.log("info", t("log.playPaused"));
  }

  stop(): void {
    if (this.playState === "edit") return;
    runtime.stop();
    this.playState = "edit";
    this.playHud = "";
    this.log("info", t("log.playStopped"));
  }

  // ────────────────────────────── logging ──────────────────────────────

  log(kind: LogKind, text: string): void {
    const entry: LogEntry = {
      id: this.logSeq++,
      time: new Date().toTimeString().slice(0, 8),
      kind,
      text,
    };
    this.logs = [...this.logs.slice(-(LOG_LIMIT - 1)), entry];
    const fn = kind === "error" ? console.error : kind === "warn" ? console.warn : console.log;
    fn(`[lova:${kind}] ${text}`);
  }

  clearLogs(): void {
    this.logs = [];
  }

  setFps(fps: number): void {
    this.fps = Math.round(fps);
  }

  // ─────────────────────── autosave & recovery ──────────────────────────

  private scheduleAutosave(): void {
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.scene));
      } catch {
        /* storage full/unavailable — autosave is best-effort */
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /** Remove any pending autosave (called after an explicit save). */
  clearAutosave(): void {
    if (this.autosaveTimer !== null) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      /* ignore */
    }
  }

  /** VS Code-like crash recovery: restore the last autosaved edit state. */
  private recoverAutosave(): void {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return;
      const scene = JSON.parse(raw) as SceneData;
      if (!scene || scene.version !== 1 || !Array.isArray(scene.objects) || scene.objects.length === 0) return;
      this.scene = scene;
      this.dirty = true;
      this.recovered = true;
      // Log after the panel mounts — the constructor runs before mount, so defer.
      setTimeout(() => this.log("warn", t("log.recovered")), 0);
    } catch {
      /* corrupt autosave — start fresh */
    }
  }
}

export const store = new SceneStore();
