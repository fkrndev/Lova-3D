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
  SceneData,
  Transform,
} from "./types";

const HISTORY_LIMIT = 64;
const COMMIT_DEBOUNCE_MS = 500;
const LOG_LIMIT = 200;

export class SceneStore {
  scene = $state<SceneData>(createDefaultScene());
  selectedIds = $state<string[]>([]);
  gizmoMode = $state<GizmoMode>("position");
  playState = $state<PlayState>("edit");
  logs = $state<LogEntry[]>([]);
  dirty = $state(false);
  currentPath = $state<string | null>(null);
  fps = $state(0);

  private history = $state<{ snaps: string[]; index: number }>({ snaps: [], index: -1 });
  private logSeq = 0;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
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

  removeSelected(): void {
    if (this.playState !== "edit" || this.selectedIds.length === 0) return;
    const doomed = new Set(this.selectedIds);
    const count = doomed.size;
    this.scene.objects = this.scene.objects.filter((o) => !doomed.has(o.id));
    this.selectedIds = [];
    this.commit();
    this.log("info", t("log.removeObjs", { count }));
  }

  duplicateSelected(): void {
    if (this.playState !== "edit" || this.selectedIds.length === 0) return;
    const clones: GameObject[] = [];
    for (const id of this.selectedIds) {
      const src = this.getObject(id);
      if (!src) continue;
      const clone: GameObject = JSON.parse(JSON.stringify(src));
      clone.id = uid();
      clone.name = `${src.name} Copy`;
      clone.behaviors = clone.behaviors.map((b) => ({ ...b, id: uid() }));
      // Nudge copies sideways so they are immediately visible.
      clone.transform = {
        ...clone.transform,
        position: { ...clone.transform.position, x: clone.transform.position.x + 0.75 },
      };
      clones.push(clone);
    }
    if (clones.length === 0) return;
    this.scene.objects.push(...clones);
    this.commit();
    this.setSelection(clones.map((c) => c.id));
    this.log("info", t("log.duplicate", { count: clones.length }));
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

  // ────────────────────────────── scenes ───────────────────────────────

  newScene(): void {
    this.stop();
    this.scene = createDefaultScene();
    this.selectedIds = [];
    this.currentPath = null;
    this.dirty = false;
    this.history = { snaps: [], index: -1 };
    this.pushSnapshot();
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
    this.log("success", t("log.sceneLoaded", { name: data.name, count: data.objects.length }));
  }

  markSaved(path: string): void {
    this.currentPath = path;
    this.dirty = false;
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
}

export const store = new SceneStore();
