/**
 * Play-mode runtime.
 *
 * On `start` it remembers a pristine snapshot of the edit-time scene plus each
 * object's base local transform. Every frame it recomputes animated transforms
 * as base + behavior deltas, integrates rigid-body-ish physics in world space,
 * and runs per-object JS scripts — all written back into the store (which the
 * viewport bridge renders). On `stop` the edit-time snapshot is restored.
 */
import type { PhysicsBodyDesc, PhysicsBodyState } from "./types";
import type { SceneStore } from "./sceneStore.svelte";
import type { GameObject, SceneData, Transform, Vec3 } from "./types";

// io.ts is imported lazily so that the module graph (sceneStore → runtime)
// does not evaluate `isTauri` before the test harness sets up Tauri internals.
type IoModule = typeof import("./io");
let ioModule: Promise<IoModule> | null = null;
const loadIo = (): Promise<IoModule> => (ioModule ??= import("./io"));

// Synchronous native decision (same check io.ts uses) — evaluated at module
// load, which is safe for every test file's import ordering.
const looksLikeTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEG = Math.PI / 180;
const GRAVITY = 9.8;
/** Position deltas above this are treated as teleports (respawns), not physics. */
const TELEPORT_THRESHOLD = 0.75;

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
  onTriggerEnter: ((other: ScriptApi) => void) | null;
  onTriggerLeave: ((other: ScriptApi) => void) | null;
  api: ScriptApi;
}

type Vec3Like = { x: number; y: number; z: number };

/** Structural interface the ViewportBridge satisfies for the play camera. */
export interface PlayCameraBridge {
  getPlayCam(): { active: boolean; targetId: string | null; targetPos: Vec3Like; yaw: number; pitch: number; distance: number };
  patchPlayCam(patch: { active?: boolean; targetId?: string | null; targetPos?: Vec3Like; yaw?: number; pitch?: number; distance?: number }): void;
}

/** Handle exposed to scripts: live getters/setters on the object's local transform. */
interface ScriptApi {
  readonly id: string;
  readonly name: string;
  readonly position: Vec3Like;
  readonly rotation: Vec3Like;
  readonly scale: Vec3Like;
  /** World-space physics velocity (dynamic bodies only). */
  readonly velocity: Vec3Like;
  /** True while resting on ground/box tops — pair with a jump velocity. */
  readonly grounded: boolean;
  find(name: string): ScriptApi | null;
  key(code: string): boolean;
  log(...args: unknown[]): void;
  hud(text: string): void;
  /** Attach a joint between this object and another ("fixed"|"spherical"|"rope"|"spring"). */
  joint(other: ScriptApi, kind: "fixed" | "spherical" | "rope" | "spring", options?: { ropeMax?: number; springRest?: number; springStiffness?: number; springDamping?: number }): void;
  /**
   * Raycast into the physics scene. Sync in exported games; in the desktop
   * editor preview it currently resolves asynchronously-unsupported and
   * warns once (full support lands with the Rust script runtime).
   */
  raycast(origin: Vec3Like, dir: Vec3Like, maxDist: number): { id: string; distance: number; point: Vec3Like; normal: Vec3Like } | null;
  readonly camera: {
    follow(target: ScriptApi | null): void;
    lookAt(pos: Vec3Like): void;
    stop(): void;
    yaw: number;
    pitch: number;
    distance: number;
  };
}

type TriggerHook = "onTriggerEnter" | "onTriggerLeave";

export class Runtime {
  private store: SceneStore | null = null;
  private snapshotJson = "";
  private bases = new Map<string, Transform>();
  private velocities = new Map<string, Vec3>();
  private radii = new Map<string, number>();
  private scripts = new Map<string, ScriptEntry>();
  private keys = new Set<string>();
  private keyListeners: Array<() => void> = [];
  /** Sensor state: object id → set of dynamic ids currently inside. */
  private sensorInside = new Map<string, Set<string>>();
  private groundedMap = new Map<string, boolean>();
  private velocityWarned = new Set<string>();
  /** Previous-frame centers of static AABB colliders (moving-platform carry). */
  private aabbPrev = new Map<string, { x: number; y: number; z: number }>();
  private cameraBridge: PlayCameraBridge | null = null;
  private time = 0;
  private active = false;

  // ── native Rapier physics (desktop) ─────────────────────────────────
  private physWorld: number | null = null;
  private physChain: Promise<void> = Promise.resolve();
  private jointWarned = false;
  private raycastWarned = false;
  private lastRapierPos = new Map<string, Vec3>();
  /** True when world creation failed — fall back to the TS simulation. */
  private rapierGaveUp = false;
  /** Native decision made (io loaded, isTauri known)? */
  private nativeDecided = false;
  private useNative = false;
  /** Event-stream health (watchdog) + pause sync for the Rust loop. */
  private eventsHealthy = false;
  private eventsArmedAt = 0;
  private unlistenPhysics: (() => void) | null = null;
  /** True while the Rust loop is paused (resume once when playing again). */
  private rustPaused = false;

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Analytic raycast against the physics approximation (balls + ground
   * half-spaces). Used by api.raycast where no native query pipeline is
   * reachable from the UI thread (editor preview, TS fallback).
   */
  private tsRaycast(
    store: SceneStore,
    origin: Vec3Like,
    dir: Vec3Like,
    maxDist: number
  ): { id: string; distance: number; point: Vec3Like; normal: Vec3Like } | null {
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const d = { x: dir.x / len, y: dir.y / len, z: dir.z / len };
    let best: { id: string; distance: number; point: Vec3Like; normal: Vec3Like } | null = null;

    for (const obj of store.scene.objects) {
      if (!obj.mesh || obj.physics?.type !== "static") continue;
      const s = obj.transform.scale;
      if (obj.mesh.kind === "plane") {
        // Ground half-space at world Y: ray·plane when dy < 0.
        const gy = store.worldPositionOf(obj).y;
        if (d.y < -1e-6 && origin.y > gy) {
          const t = (gy - origin.y) / d.y;
          if (t >= 0 && t <= maxDist && (!best || t < best.distance)) {
            best = { id: obj.id, distance: t, point: { x: origin.x + d.x * t, y: gy, z: origin.z + d.z * t }, normal: { x: 0, y: 1, z: 0 } };
          }
        }
      } else if (obj.mesh.kind === "sphere" || obj.mesh.kind === "box") {
        // Sphere approximation around the world center.
        const c = store.worldPositionOf(obj);
        const r = 0.5 * Math.max(s.x, s.y, s.z);
        const ox = origin.x - c.x, oy = origin.y - c.y, oz = origin.z - c.z;
        const b = ox * d.x + oy * d.y + oz * d.z;
        const disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
        if (disc >= 0) {
          const t = -b - Math.sqrt(disc);
          if (t >= 0 && t <= maxDist && (!best || t < best.distance)) {
            const px = origin.x + d.x * t, py = origin.y + d.y * t, pz = origin.z + d.z * t;
            const nl = Math.hypot(px - c.x, py - c.y, pz - c.z) || 1;
            best = { id: obj.id, distance: t, point: { x: px, y: py, z: pz }, normal: { x: (px - c.x) / nl, y: (py - c.y) / nl, z: (pz - c.z) / nl } };
          }
        }
      }
    }
    return best;
  }

  /** Editor pause → park the Rust loop (thread stays alive, no stepping). */
  notifyPaused(): void {
    if (this.physWorld === null || this.rustPaused) return;
    this.rustPaused = true;
    const world = this.physWorld;
    void loadIo().then((io) => io.physicsSetRunning(world, false).catch(() => undefined));
  }

  /** Called by the viewport panel so api.camera can drive the play camera. */
  attachCamera(bridge: PlayCameraBridge): void {
    this.cameraBridge = bridge;
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
    this.initRapier(scene);
  }

  /** Build a native Rapier world for the scene (desktop only). */
  private initRapier(scene: SceneData): void {
    this.nativeDecided = true;
    this.useNative = looksLikeTauri;
    if (!looksLikeTauri) return;
    const store = this.store;
    if (!store) return;
    void loadIo()
      .then(async (io) => {
        if (!this.active || !this.store) return;
        const bodies = this.buildBodyDescs(scene);
        if (!bodies.some((b) => b.dynamic)) {
          this.useNative = false; // nothing to simulate natively
          return;
        }
        const world = await io.physicsWorldCreate(bodies);
        if (!this.active) {
          void io.physicsWorldDestroy(world).catch(() => undefined);
          return;
        }
        this.physWorld = world;
        // Event-driven streaming: the Rust loop steps at a fixed timestep on
        // its own thread and pushes states to us — no per-frame IPC.
        this.eventsArmedAt = performance.now();
        this.eventsHealthy = false;
        this.unlistenPhysics = await io.onPhysicsStates((event) => {
          if (!this.active || event.world !== this.physWorld) return;
          this.eventsHealthy = true;
          this.detectTeleports(io);
          this.applyRapierStates(event.states, this.store!);
        });
        await io.physicsRun(world, 60);
      })
      .catch((e) => {
        this.rapierGaveUp = true;
        this.useNative = false;
        if (this.physWorld !== null) {
          // Half-initialised (e.g. the event channel failed) — tear down cleanly
          // so the TS simulation can take over.
          const world = this.physWorld;
          this.physWorld = null;
          this.unlistenPhysics?.();
          this.unlistenPhysics = null;
          void loadIo().then((m) => m.physicsWorldDestroy(world).catch(() => undefined));
        }
        this.store?.log("warn", `native physics unavailable (${String(e)}) — using the TS simulation`);
      });
  }

  /** Compare store positions with the last streamed state → teleports. */
  private detectTeleports(io: IoModule): void {
    const world = this.physWorld;
    const store = this.store;
    if (world === null || !store) return;
    for (const [id, last] of this.lastRapierPos) {
      const o = store.getObject(id);
      if (!o) continue;
      const w = store.worldPositionOf(o);
      if (Math.hypot(w.x - last.x, w.y - last.y, w.z - last.z) > TELEPORT_THRESHOLD) {
        void io.physicsTeleport(world, id, [w.x, w.y, w.z]);
      }
    }
  }

  private buildBodyDescs(scene: SceneData): PhysicsBodyDesc[] {
    const store = this.store!;
    const bodies: PhysicsBodyDesc[] = [];
    for (const obj of scene.objects) {
      if (!obj.physics || !obj.mesh) continue;
      const wt = store.worldTransformOf(obj);
      const s = wt.scale;
      const shape: PhysicsBodyDesc["shape"] = (() => {
        switch (obj.mesh.kind) {
          case "plane":
            return { kind: "halfspace" };
          case "box":
            return { kind: "cuboid", hx: Math.max(s.x, 0.02) / 2, hy: Math.max(s.y, 0.02) / 2, hz: Math.max(s.z, 0.02) / 2 };
          case "sphere":
            return { kind: "ball", radius: (0.5 * s.x + 0.5 * s.y + 0.5 * s.z) / 3 };
          case "cylinder":
            return { kind: "cylinder", halfHeight: s.y / 2, radius: Math.min(s.x, s.z) / 2 };
          case "capsule":
            return { kind: "capsule", halfHeight: s.y / 2, radius: Math.min(s.x, s.z) / 2 };
          default:
            // cone / torus / imported models approximate as spheres.
            return { kind: "ball", radius: 0.5 * Math.max(s.x, s.y, s.z) || 0.1 };
        }
      })();
      bodies.push({
        id: obj.id,
        dynamic: obj.physics.type === "dynamic",
        shape,
        translation: [wt.position.x, wt.position.y, wt.position.z],
        linvel: [obj.physics.velocity.x, obj.physics.velocity.y, obj.physics.velocity.z],
        restitution: obj.physics.bounce,
        friction: 0.6,
      });
    }
    return bodies;
  }

  /** One ordered async Rapier step; results are applied to the live store. */
  private enqueueRapierStep(dt: number): void {
    const world = this.physWorld;
    const store = this.store;
    if (world === null || !store) return;
    this.physChain = this.physChain.then(() => this.rapierStep(world, dt, store));
  }

  private async rapierStep(world: number, dt: number, store: SceneStore): Promise<void> {
    if (!this.active || this.physWorld !== world || store.playState !== "playing") return;
    try {
      const io = await loadIo();
      // Detect teleports (respawns / scripted jumps in position) before stepping.
      for (const [id, last] of this.lastRapierPos) {
        const o = store.getObject(id);
        if (!o) continue;
        const w = store.worldPositionOf(o);
        if (Math.hypot(w.x - last.x, w.y - last.y, w.z - last.z) > TELEPORT_THRESHOLD) {
          await io.physicsTeleport(world, id, [w.x, w.y, w.z]);
        }
      }
      const states = await io.physicsStep(world, dt);
      this.applyRapierStates(states, store);
    } catch {
      // World destroyed mid-flight (stop) — ignore.
    }
  }

  private applyRapierStates(states: PhysicsBodyState[], store: SceneStore): void {
    for (const st of states) {
      const obj = store.getObject(st.id);
      if (!obj) continue;
      this.velocities.set(st.id, { x: st.linvel[0], y: st.linvel[1], z: st.linvel[2] });
      this.groundedMap.set(st.id, st.grounded);
      this.lastRapierPos.set(st.id, { x: st.translation[0], y: st.translation[1], z: st.translation[2] });
      this.writeWorldPosition(obj, { x: st.translation[0], y: st.translation[1], z: st.translation[2] });
    }
  }

  /** Called from the viewport render loop. */
  tick(dt: number): void {
    if (!this.active || !this.store) return;
    if (this.store.playState !== "playing") return;
    this.time += Math.min(dt, 0.1); // clamp huge hiccups (tab switches etc.)
    const t = this.time;

    // Resume the Rust loop once after an editor pause.
    if (this.physWorld !== null && this.rustPaused) {
      this.rustPaused = false;
      const world = this.physWorld;
      void loadIo().then((io) => io.physicsSetRunning(world, true).catch(() => undefined));
    }

    this.applyBehaviors(t);
    if (this.physWorld !== null) {
      // Native path: the Rust loop streams states via events. Watchdog — if
      // no event arrived shortly after arming, fall back to per-frame steps
      // so the editor never freezes on a broken event channel.
      if (!this.eventsHealthy && performance.now() - this.eventsArmedAt > 700) {
        this.enqueueRapierStep(dt);
      }
    } else if (this.nativeDecided && !this.useNative) {
      this.applyPhysics(dt);
    }
    this.runScripts(dt, t);
    this.updateSensors();
  }

  /**
   * Trigger volumes — pure store-level system, identical across the native,
   * WASM and TS backends: spherical overlap between `sensor` objects and
   * dynamic bodies, diffed per frame into enter/leave script hooks.
   */
  private updateSensors(): void {
    const store = this.store;
    if (!store) return;
    for (const obj of store.scene.objects) {
      if (!obj.sensor) continue;
      const entry = this.scripts.get(obj.id);
      if (!entry || (!entry.onTriggerEnter && !entry.onTriggerLeave)) continue;

      const center = store.worldPositionOf(obj);
      const radius = Math.max(0.05, obj.sensor.radius);
      const inside = new Set<string>();
      for (const body of store.scene.objects) {
        if (body.id === obj.id || body.physics?.type !== "dynamic") continue;
        const p = store.worldPositionOf(body);
        const bodyRadius = this.radii.get(body.id) ?? 0.5;
        if (Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z) <= radius + bodyRadius) {
          inside.add(body.id);
        }
      }

      const prev = this.sensorInside.get(obj.id) ?? new Set<string>();
      for (const id of inside) {
        if (!prev.has(id)) this.fireTrigger(entry, "onTriggerEnter", id);
      }
      for (const id of prev) {
        if (!inside.has(id)) this.fireTrigger(entry, "onTriggerLeave", id);
      }
      this.sensorInside.set(obj.id, inside);
    }
  }

  private fireTrigger(entry: ScriptEntry, hook: TriggerHook, otherId: string): void {
    const store = this.store;
    if (!store) return;
    const fn = entry[hook];
    if (!fn) return;
    if (!store.getObject(otherId)) return; // removed mid-play
    try {
      fn(this.makeApi(otherId));
    } catch (e) {
      store.log("error", `script [${entry.api.name}].${hook}: ${e instanceof Error ? e.message : String(e)}`);
      entry[hook] = null; // don't spam every frame
    }
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
    this.groundedMap.clear();
    this.sensorInside.clear();
    this.velocityWarned.clear();
    this.aabbPrev.clear();
    this.keys.clear();
    store.playHud = "";
    for (const off of this.keyListeners) off();
    this.keyListeners = [];
    // Tear down the native world (if any) — fire and forget.
    if (this.physWorld !== null) {
      const world = this.physWorld;
      this.physWorld = null;
      this.unlistenPhysics?.();
      this.unlistenPhysics = null;
      void loadIo().then((io) => io.physicsWorldDestroy(world).catch(() => undefined));
    }
    this.lastRapierPos.clear();
    this.rapierGaveUp = false;
    this.jointWarned = false;
    this.raycastWarned = false;
    this.nativeDecided = false;
    this.useNative = false;
    this.physChain = Promise.resolve();
    this.eventsHealthy = false;
    this.rustPaused = false;
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
   * static plane's world height, sphere-vs-AABB for static box meshes, and
   * sphere/sphere collisions between bodies. Also maintains the grounded flags
   * used by scripts for jumping.
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

    // Static box meshes act as axis-aligned colliders (world half extents).
    // Their per-tick delta makes moving platforms carry riders.
    const aabbs: Array<{ obj: GameObject; cx: number; cy: number; cz: number; hx: number; hy: number; hz: number; dx: number; dy: number; dz: number }> = [];
    for (const obj of objects) {
      if (obj.physics?.type !== "static" || obj.mesh?.kind !== "box") continue;
      const wt = store.worldTransformOf(obj);
      const prev = this.aabbPrev.get(obj.id);
      aabbs.push({
        obj,
        cx: wt.position.x,
        cy: wt.position.y,
        cz: wt.position.z,
        hx: Math.max(wt.scale.x, 0.01) / 2,
        hy: Math.max(wt.scale.y, 0.01) / 2,
        hz: Math.max(wt.scale.z, 0.01) / 2,
        dx: prev ? wt.position.x - prev.x : 0,
        dy: prev ? wt.position.y - prev.y : 0,
        dz: prev ? wt.position.z - prev.z : 0,
      });
    }

    for (const obj of dynamics) {
      const def = obj.physics!;
      const vel = this.velocities.get(obj.id) ?? vec3();
      const radius = this.radii.get(obj.id) ?? 0.5;
      let grounded = false;

      // Integrate.
      vel.y -= GRAVITY * def.gravityScale * dt;
      const world = store.worldPositionOf(obj);
      world.x += vel.x * dt;
      world.y += vel.y * dt;
      world.z += vel.z * dt;

      // Ground collision (lowest supporting plane below the body).
      for (const gy of grounds) {
        const support = gy + radius;
        if (world.y < support) {
          world.y = support;
          if (vel.y < 0) vel.y = -vel.y * def.bounce;
          if (Math.abs(vel.y) < 0.9) vel.y = 0; // settle
          grounded = true;
        }
      }

      // Sphere vs static AABB (walls, platforms).
      for (const box of aabbs) {
        // Skip boxes whose top is far below the body (can't be standing on it).
        const qx = Math.min(Math.max(world.x, box.cx - box.hx), box.cx + box.hx);
        const qy = Math.min(Math.max(world.y, box.cy - box.hy), box.cy + box.hy);
        const qz = Math.min(Math.max(world.z, box.cz - box.hz), box.cz + box.hz);
        let nx = world.x - qx,
          ny = world.y - qy,
          nz = world.z - qz;
        let dist = Math.hypot(nx, ny, nz);
        if (dist >= radius) continue;
        if (dist < 1e-6) {
          // Center inside the box — push out along the shallowest axis.
          const dx = box.hx + radius - Math.abs(world.x - box.cx);
          const dy = box.hy + radius - Math.abs(world.y - box.cy);
          const dz = box.hz + radius - Math.abs(world.z - box.cz);
          if (dy <= dx && dy <= dz) {
            ny = world.y >= box.cy ? 1 : -1;
            nx = nz = 0;
            dist = 0.0001;
            world.y = box.cy + (ny > 0 ? box.hy + radius : -(box.hy + radius));
          } else if (dx <= dz) {
            nx = world.x >= box.cx ? 1 : -1;
            ny = nz = 0;
            dist = 0.0001;
            world.x = box.cx + (nx > 0 ? box.hx + radius : -(box.hx + radius));
          } else {
            nz = world.z >= box.cz ? 1 : -1;
            nx = ny = 0;
            dist = 0.0001;
            world.z = box.cz + (nz > 0 ? box.hz + radius : -(box.hz + radius));
          }
        } else {
          nx /= dist;
          ny /= dist;
          nz /= dist;
          world.x = qx + nx * radius;
          world.y = qy + ny * radius;
          world.z = qz + nz * radius;
        }
        const vn = vel.x * nx + vel.y * ny + vel.z * nz;
        if (vn < 0) {
          const restitution = def.bounce;
          vel.x -= (1 + restitution) * vn * nx;
          vel.y -= (1 + restitution) * vn * ny;
          vel.z -= (1 + restitution) * vn * nz;
        }
        if (ny > 0.5) {
          grounded = true;
          if (Math.abs(vel.y) < 0.9) vel.y = 0;
          // Ride the collider: moving platforms/elevators carry their riders.
          world.x += box.dx;
          world.y += box.dy;
          world.z += box.dz;
        }
      }

      // Ground friction on the horizontal plane.
      if (grounded) {
        const damp = Math.max(0, 1 - 6 * dt);
        vel.x *= damp;
        vel.z *= damp;
      }

      this.velocities.set(obj.id, vel);
      this.groundedMap.set(obj.id, grounded);
      this.writeWorldPosition(obj, world);
    }

    // Remember collider centers for next tick's carry delta.
    for (const b of aabbs) this.aabbPrev.set(b.obj.id, { x: b.cx, y: b.cy, z: b.cz });

    // Sphere/sphere collisions between dynamic-approximated bodies — planes
    // (ground half-spaces) and STATIC boxes (AABB colliders) are excluded: a
    // 40×2 wall must not act as a radius-20 sphere. Dynamic boxes join as
    // spheres, matching their physics radius.
    const bodies = objects.filter(
      (o) =>
        o.physics &&
        o.mesh &&
        o.mesh.kind !== "plane" &&
        (o.mesh.kind !== "box" || o.physics.type === "dynamic")
    );
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
        if (rel <= 0) continue; // already separating (rel > 0 = closing along a→b)
        const restitution = Math.min(a.physics!.bounce, b.physics!.bounce);
        const impulse = -(1 + restitution) * rel; // negative along n → separates the pair
        if (aDyn && va) {
          va.x += impulse * nx;
          va.y += impulse * ny;
          va.z += impulse * nz;
          if (ny < -0.5) this.groundedMap.set(a.id, true); // a rests on top of b
        }
        if (bDyn && vb) {
          vb.x -= impulse * nx;
          vb.y -= impulse * ny;
          vb.z -= impulse * nz;
          if (ny > 0.5) this.groundedMap.set(b.id, true); // b rests on top of a
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
          `"use strict";\n${obj.script}\n;return { onStart: typeof onStart === "function" ? onStart : null, onUpdate: typeof onUpdate === "function" ? onUpdate : null, onTriggerEnter: typeof onTriggerEnter === "function" ? onTriggerEnter : null, onTriggerLeave: typeof onTriggerLeave === "function" ? onTriggerLeave : null };`
        );
        // The api binds to the LIVE store object (not the snapshot) so edits
        // during play (paused) are reflected too.
        const api = this.makeApi(obj.id);
        const hooks = factory(api);
        this.scripts.set(obj.id, {
          id: obj.id,
          onStart: hooks.onStart,
          onUpdate: hooks.onUpdate,
          onTriggerEnter: hooks.onTriggerEnter ?? null,
          onTriggerLeave: hooks.onTriggerLeave ?? null,
          api,
        });
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
        get velocity() {
          const v = self.velocities.get(targetId);
          return v ? { ...v } : vec3();
        },
        set velocity(v: Vec3Like) {
          const o = store.getObject(targetId);
          if (!o?.physics || o.physics.type !== "dynamic") {
            if (!self.velocityWarned.has(targetId)) {
              self.velocityWarned.add(targetId);
              store.log("warn", `script [${o?.name ?? targetId}]: velocity requires Physics → Dynamic`);
            }
            return;
          }
          const vel = { x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 };
          self.velocities.set(targetId, vel);
          if (self.physWorld !== null) {
            const world = self.physWorld;
            void loadIo().then((io) => io.physicsSetVelocity(world, targetId, [vel.x, vel.y, vel.z]).catch(() => undefined));
          }
        },
        get grounded() {
          return self.groundedMap.get(targetId) === true;
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
        hud(text: string): void {
          store.playHud = String(text ?? "");
        },
        joint(other: ScriptApi, kind: "fixed" | "spherical" | "rope" | "spring", options?: { ropeMax?: number; springRest?: number; springStiffness?: number; springDamping?: number }): void {
          const world = self.physWorld;
          if (world === null) {
            if (!self.jointWarned) {
              self.jointWarned = true;
              store.log("warn", "api.joint requires the native physics backend (desktop build)");
            }
            return;
          }
          void loadIo().then((io) =>
            io
              .physicsJointAdd(world, {
                a: targetId,
                b: other.id,
                kind,
                anchorA: [0, 0, 0],
                anchorB: [0, 0, 0],
                ropeMax: options?.ropeMax,
                springRest: options?.springRest,
                springStiffness: options?.springStiffness,
                springDamping: options?.springDamping,
              })
              .catch((e) => store.log("error", `api.joint: ${String(e)}`))
          );
        },
        raycast(origin: Vec3Like, dir: Vec3Like, maxDist: number) {
          if (!self.raycastWarned) {
            self.raycastWarned = true;
            store.log("warn", "api.raycast in the editor preview is approximate; exported games use real physics rays");
          }
          return self.tsRaycast(store, origin, dir, maxDist);
        },
        camera: {
          follow(target: ScriptApi | null): void {
            self.cameraBridge?.patchPlayCam({ active: true, targetId: target ? target.id : null });
          },
          lookAt(pos: Vec3Like): void {
            self.cameraBridge?.patchPlayCam({
              active: true,
              targetId: null,
              targetPos: { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0 },
            });
          },
          stop(): void {
            self.cameraBridge?.patchPlayCam({ active: false });
          },
          get yaw() {
            return self.cameraBridge?.getPlayCam().yaw ?? 0;
          },
          set yaw(v: number) {
            self.cameraBridge?.patchPlayCam({ yaw: Number(v) || 0 });
          },
          get pitch() {
            return self.cameraBridge?.getPlayCam().pitch ?? 20;
          },
          set pitch(v: number) {
            self.cameraBridge?.patchPlayCam({ pitch: Math.max(-80, Math.min(85, Number(v) || 0)) });
          },
          get distance() {
            return self.cameraBridge?.getPlayCam().distance ?? 8;
          },
          set distance(v: number) {
            self.cameraBridge?.patchPlayCam({ distance: Math.max(1, Number(v) || 8) });
          },
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
