/**
 * Play-mode runtime.
 *
 * On `start` it remembers a pristine snapshot of the edit-time scene plus each
 * object's base transform. Every frame it recomputes animated transforms as
 * base + behavior deltas and writes them into the store (which the viewport
 * bridge renders). On `stop` the edit-time snapshot is restored verbatim.
 */
import type { SceneStore } from "./sceneStore.svelte";
import type { SceneData, Transform } from "./types";

const DEG = Math.PI / 180;

function cloneTransform(t: Transform): Transform {
  return {
    position: { ...t.position },
    rotation: { ...t.rotation },
    scale: { ...t.scale },
  };
}

export class Runtime {
  private store: SceneStore | null = null;
  private snapshotJson = "";
  private bases = new Map<string, Transform>();
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
    const scene = JSON.parse(snapshotJson) as SceneData;
    for (const obj of scene.objects) {
      this.bases.set(obj.id, cloneTransform(obj.transform));
    }
    this.active = true;
  }

  /** Called from the viewport render loop. */
  tick(dt: number): void {
    if (!this.active || !this.store) return;
    if (this.store.playState !== "playing") return;
    this.time += Math.min(dt, 0.1); // clamp huge hiccups (tab switches etc.)
    const t = this.time;

    for (const obj of this.store.scene.objects) {
      const base = this.bases.get(obj.id);
      if (!base || obj.behaviors.length === 0) continue;

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
            position.y = base.position.y + Math.sin(t * b.speed) * b.amplitude;
            break;
          case "orbit": {
            const a = b.speed * DEG * t;
            position.x = base.position.x + Math.cos(a) * b.radius;
            position.z = base.position.z + Math.sin(a) * b.radius;
            break;
          }
        }
      }

      obj.transform.position = position;
      obj.transform.rotation = rotation;
    }
  }

  stop(): void {
    if (!this.active || !this.store) return;
    this.active = false;
    const store = this.store;
    this.store = null;
    this.bases.clear();
    // Restore the exact edit-time state captured on start.
    store.restoreSceneJson(this.snapshotJson);
  }
}

export const runtime = new Runtime();
