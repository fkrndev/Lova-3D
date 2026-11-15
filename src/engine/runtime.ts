/**
 * Play-mode runtime.
 *
 * On `start` it remembers a pristine snapshot of the edit-time scene plus each
 * object's base local transform. Every frame it recomputes animated transforms
 * as base + behavior deltas, integrates rigid-body-ish physics in world space,
 * and runs per-object JS scripts — all written back into the store (which the
 * viewport bridge renders). On `stop` the edit-time snapshot is restored.
 */
import type { SceneStore } from "./sceneStore.svelte";
import type { GameObject, SceneData, Transform, Vec3 } from "./types";

const DEG = Math.PI / 180;
const GRAVITY = 9.8;

function cloneTransform(t: Transform): Transform {
  return {
    position: { ...t.position },
    rotation: { ...t.rotation },
    scale: { ...t.scale },
  };
}

const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

interface ScriptEntry {
  id: string;
  onStart: (() => void) | null;
  onUpdate: ((dt: number, t: number) => void) | null;
  api: ScriptApi;
}

type Vec3Like = { x: number; y: number; z: number };

/** Handle exposed to scripts: live getters/setters on the object's local transform. */
interface ScriptApi {
  readonly id: string;
  readonly name: string;
  readonly position: Vec3Like;
  readonly rotation: Vec3Like;
  readonly scale: Vec3Like;
  find(name: string): ScriptApi | null;
  key(code: string): boolean;
  log(...args: unknown[]): void;
}

export class Runtime {
  private store: SceneStore | null = null;
  private snapshotJson = "";
  private bases = new Map<string, Transform>();
  private velocities = new Map<string, Vec3>();
  private radii = new Map<string, number>();
  private scripts = new Map<string, ScriptEntry>();
  private keys = new Set<string>();
  private keyListeners: Array<() => void> = [];
  private time = 0;
  private active = false;

  get isActive(): boolean {
    return this.active;
  }

  start(store: SceneStore, snapshotJson: string): void {
    this.store = store;
    this.snapshotJson = snapshotJson;
    this.time = 0;
    this.bases.clear();
    this.velocities.clear();
    this.radii.clear();
    this.scripts.clear();

    const scene = JSON.parse(snapshotJson) as SceneData;
    for (const obj of scene.objects) {
      this.bases.set(obj.id, cloneTransform(obj.transform));
      if (obj.physics) {
        this.velocities.set(obj.id, vec3(obj.physics.velocity.x, obj.physics.velocity.y, obj.physics.velocity.z));
        const s = obj.transform.scale;
        this.radii.set(obj.id, 0.5 * Math.max(s.x, s.y, s.z));
      }
    }

    this.installKeyboard();
    this.compileScripts(scene);
    // Fire onStart hooks after everything is prepared.
    for (const entry of this.scripts.values()) {
      try {
        entry.onStart?.();
      } catch (e) {
        store.log("error", `script [${entry.api.name}]: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.active = true;
  }

  /** Called from the viewport render loop. */
  tick(dt: number): void {
    if (!this.active || !this.store) return;
    if (this.store.playState !== "playing") return;
    this.time += Math.min(dt, 0.1); // clamp huge hiccups (tab switches etc.)
    const t = this.time;

    this.applyBehaviors(t);
    this.applyPhysics(dt);
    this.runScripts(dt, t);
  }

  stop(): void {
    if (!this.active || !this.store) return;
    this.active = false;
    const store = this.store;
    this.store = null;
    this.bases.clear();
    this.velocities.clear();
    this.radii.clear();
    this.scripts.clear();
    this.keys.clear();
    for (const off of this.keyListeners) off();
    this.keyListeners = [];
    // Restore the exact edit-time state captured on start.
    store.restoreSceneJson(this.snapshotJson);
  }

  // ─────────────────────────── behaviors ────────────────────────────────

  private applyBehaviors(t: number): void {
    const store = this.store!;
    for (const obj of store.scene.objects) {
      const base = this.bases.get(obj.id);
      if (!base || obj.behaviors.length === 0) continue;
      // Dynamic physics owns the position; only spin (rotation) still applies.
      const isDynamic = obj.physics?.type === "dynamic";

      const position = { ...base.position };
      const rotation = { ...base.rotation };

      for (const b of obj.behaviors) {
        if (!b.enabled) continue;
        switch (b.kind) {
          case "spin":
            rotation.x += b.speed.x * t;
            rotation.y += b.speed.y * t;
            rotation.z += b.speed.z * t;
            break;
          case "bob":
            if (!isDynamic) position.y = base.position.y + Math.sin(t * b.speed) * b.amplitude;
            break;
          case "orbit": {
            if (isDynamic) break;
            const a = b.speed * DEG * t;
            position.x = base.position.x + Math.cos(a) * b.radius;
            position.z = base.position.z + Math.sin(a) * b.radius;
            break;
          }
        }
      }

      if (isDynamic) {
        // Physics owns the position of dynamic bodies — only rotation applies.
        obj.transform.rotation = rotation;
      } else {
        obj.transform.position = position;
        obj.transform.rotation = rotation;
      }
    }
  }

  // ─────────────────────────── physics ──────────────────────────────────

  /**
   * Arcade rigid-body step in world space: gravity, ground half-space at each
   * static plane's world height, and sphere/sphere collisions between bodies.
   * World position is accumulated then written back as local = world − parentWorld.
   */
  private applyPhysics(dt: number): void {
    const store = this.store!;
    const objects = store.scene.objects;
    const dynamics: GameObject[] = [];

    for (const obj of objects) {
      const def = obj.physics;
      if (!def || !obj.mesh) continue;
      if (def.type === "dynamic") {
        dynamics.push(obj);
        continue;
      }
      // Static colliders do not move.
    }
    if (dynamics.length === 0) return;

    // Ground half-spaces: static plane meshes at their world Y.
    const grounds: number[] = [];
    for (const obj of objects) {
      if (obj.physics?.type !== "static" || obj.mesh?.kind !== "plane") continue;
      grounds.push(store.worldPositionOf(obj).y);
    }
    if (grounds.length === 0) grounds.push(0);

    for (const obj of dynamics) {
      const def = obj.physics!;
      const vel = this.velocities.get(obj.id) ?? vec3();
      const radius = this.radii.get(obj.id) ?? 0.5;

      // Integrate.
      vel.y -= GRAVITY * def.gravityScale * dt;
      const world = store.worldPositionOf(obj);
      world.x += vel.x * dt;
      world.y += vel.y * dt;
      world.z += vel.z * dt;

      // Ground collision (lowest supporting plane below the body).
      let grounded = false;
      for (const gy of grounds) {
        const support = gy + radius;
        if (world.y < support) {
          world.y = support;
          if (vel.y < 0) vel.y = -vel.y * def.bounce;
          if (Math.abs(vel.y) < 0.9) vel.y = 0; // settle
          grounded = true;
        }
      }
      // Ground friction on the horizontal plane.
      if (grounded) {
        const damp = Math.max(0, 1 - 6 * dt);
        vel.x *= damp;
        vel.z *= damp;
      }

      this.velocities.set(obj.id, vel);
      this.writeWorldPosition(obj, world);
    }

    // Sphere/sphere collisions between bodies — planes are excluded (they are
    // already handled as ground half-spaces; a 24×24 plane must not act as a
    // radius-12 sphere).
    const bodies = objects.filter((o) => o.physics && o.mesh && o.mesh.kind !== "plane");
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i];
        const b = bodies[j];
        const pa = store.worldPositionOf(a);
        const pb = store.worldPositionOf(b);
        const ra = this.radii.get(a.id) ?? 0.5;
        const rb = this.radii.get(b.id) ?? 0.5;
        const dx = pb.x - pa.x,
          dy = pb.y - pa.y,
          dz = pb.z - pa.z;
        const dist = Math.hypot(dx, dy, dz) || 0.0001;
        const minDist = ra + rb;
        if (dist >= minDist) continue;

        const nx = dx / dist,
          ny = dy / dist,
          nz = dz / dist;
        const penetration = minDist - dist;
        const aDyn = a.physics!.type === "dynamic";
        const bDyn = b.physics!.type === "dynamic";

        // Positional correction — dynamic bodies take the push.
        if (aDyn && bDyn) {
          const half = penetration / 2;
          this.translateBy(a, -nx * half, -ny * half, -nz * half);
          this.translateBy(b, nx * half, ny * half, nz * half);
        } else if (aDyn) {
          this.translateBy(a, -nx * penetration, -ny * penetration, -nz * penetration);
        } else if (bDyn) {
          this.translateBy(b, nx * penetration, ny * penetration, nz * penetration);
        }

        // Velocity response along the contact normal.
        const va = this.velocities.get(a.id);
        const vb = this.velocities.get(b.id);
        const vax = va?.x ?? 0,
          vay = va?.y ?? 0,
          vaz = va?.z ?? 0;
        const vbx = vb?.x ?? 0,
          vby = vb?.y ?? 0,
          vbz = vb?.z ?? 0;
        const rel = (vax - vbx) * nx + (vay - vby) * ny + (vaz - vbz) * nz;
        if (rel > 0) continue; // already separating
        const restitution = Math.min(a.physics!.bounce, b.physics!.bounce);
        const impulse = -(1 + restitution) * rel;
        if (aDyn && va) {
          va.x += impulse * nx;
          va.y += impulse * ny;
          va.z += impulse * nz;
        }
        if (bDyn && vb) {
          vb.x -= impulse * nx;
          vb.y -= impulse * ny;
          vb.z -= impulse * nz;
        }
      }
    }
  }

  private translateBy(obj: GameObject, dx: number, dy: number, dz: number): void {
    const p = obj.transform.position;
    p.x += dx;
    p.y += dy;
    p.z += dz;
  }

  /** world → local: `local = (world − parentWorld) / parentWorldScale`. */
  private writeWorldPosition(obj: GameObject, world: Vec3Like): void {
    const store = this.store!;
    const pw = obj.parentId
      ? store.worldTransformOf(store.getObject(obj.parentId)!)
      : { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    obj.transform.position = {
      x: (world.x - pw.position.x) / (pw.scale.x || 1),
      y: (world.y - pw.position.y) / (pw.scale.y || 1),
      z: (world.z - pw.position.z) / (pw.scale.z || 1),
    };
  }

  // ─────────────────────────── scripts ──────────────────────────────────

  private installKeyboard(): void {
    const down = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      this.keys.add(e.code);
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.code);
    const blur = () => this.keys.clear();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    this.keyListeners.push(
      () => window.removeEventListener("keydown", down),
      () => window.removeEventListener("keyup", up),
      () => window.removeEventListener("blur", blur)
    );
  }

  private compileScripts(scene: SceneData): void {
    const store = this.store!;
    for (const obj of scene.objects) {
      if (!obj.script || obj.script.trim() === "") continue;
      try {
        const factory = new Function(
          "api",
          `"use strict";\n${obj.script}\n;return { onStart: typeof onStart === "function" ? onStart : null, onUpdate: typeof onUpdate === "function" ? onUpdate : null };`
        );
        // The api binds to the LIVE store object (not the snapshot) so edits
        // during play (paused) are reflected too.
        const api = this.makeApi(obj.id);
        const hooks = factory(api);
        this.scripts.set(obj.id, { id: obj.id, onStart: hooks.onStart, onUpdate: hooks.onUpdate, api });
      } catch (e) {
        store.log("error", `script [${obj.name}]: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private makeApi(id: string): ScriptApi {
    const store = this.store!;
    const self = this;
    const getObj = () => store.getObject(id);
    const handle = (targetId: string): ScriptApi => {
      const api: ScriptApi = {
        get id() {
          return targetId;
        },
        get name() {
          return store.getObject(targetId)?.name ?? "";
        },
        get position() {
          const p = store.getObject(targetId)?.transform.position;
          return p ? { ...p } : vec3();
        },
        set position(v: Vec3Like) {
          const o = store.getObject(targetId);
          if (o) o.transform.position = { x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 };
        },
        get rotation() {
          const r = store.getObject(targetId)?.transform.rotation;
          return r ? { ...r } : vec3();
        },
        set rotation(v: Vec3Like) {
          const o = store.getObject(targetId);
          if (o) o.transform.rotation = { x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 };
        },
        get scale() {
          const s = store.getObject(targetId)?.transform.scale;
          return s ? { ...s } : vec3(1, 1, 1);
        },
        set scale(v: Vec3Like) {
          const o = store.getObject(targetId);
          if (o) o.transform.scale = { x: v.x ?? 1, y: v.y ?? 1, z: v.z ?? 1 };
        },
        find(name: string): ScriptApi | null {
          const found = store.scene.objects.find((o) => o.name === name);
          return found ? handle(found.id) : null;
        },
        key(code: string): boolean {
          return self.keys.has(code);
        },
        log(...args: unknown[]): void {
          store.log("info", args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
        },
      };
      return api;
    };
    return handle(id);
  }

  private runScripts(dt: number, t: number): void {
    const store = this.store!;
    for (const entry of this.scripts.values()) {
      if (!entry.onUpdate) continue;
      if (!store.getObject(entry.id)) continue; // removed mid-play
      try {
        entry.onUpdate(dt, t);
      } catch (e) {
        store.log("error", `script [${entry.api.name}]: ${e instanceof Error ? e.message : String(e)}`);
        entry.onUpdate = null; // don't spam the console every frame
      }
    }
  }
}

export const runtime = new Runtime();
