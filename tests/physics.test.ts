import { beforeEach, describe, expect, it } from "vitest";
import { dynamicBall, groundPlane, loadBareScene, makeObject, near, resetStore, staticBox, store, tick, vec3 } from "./helpers";
import type { GameObject } from "../src/engine/types";

beforeEach(resetStore);

const play = () => store.play();
const obj = (name: string) => store.scene.objects.find((o) => o.name === name)!;

describe("physics — gravity & ground", () => {
  it("drops a ball onto the ground and settles at radius height, grounded", () => {
    const ball = dynamicBall("Ball", vec3(0, 5, 0));
    loadBareScene([groundPlane(), ball]);
    play();
    tick(150);
    expect(near(obj("Ball").transform.position.y, 0.5, 0.02)).toBe(true);
    expect(obj("Ball").physics?.type).toBe("dynamic");
    store.stop();
  });

  it("bounces with restitution then settles (trajectory sanity)", () => {
    const ball = dynamicBall("Ball", vec3(0, 5, 0));
    ball.physics!.bounce = 0.6;
    loadBareScene([groundPlane(), ball]);
    play();
    const ys: number[] = [];
    let bounced = false;
    for (let i = 0; i < 300; i++) {
      tick();
      const y = obj("Ball").transform.position.y;
      if (ys.length && y > ys[ys.length - 1] + 1e-4 && ys[ys.length - 1] < 1) bounced = true;
      if (i % 15 === 0) ys.push(y);
    }
    expect(bounced).toBe(true);
    expect(Math.min(...ys)).toBeLessThan(4.5);
    expect(obj("Ball").transform.position.y).toBeLessThan(1.2);
    store.stop();
  });

  it("gravityScale 0 leaves the body floating", () => {
    const ball = dynamicBall("Ball", vec3(0, 3, 0));
    ball.physics!.gravityScale = 0;
    loadBareScene([groundPlane(), ball]);
    play();
    tick(90);
    expect(near(obj("Ball").transform.position.y, 3, 0.01)).toBe(true);
    store.stop();
  });

  it("initial velocity is honoured", () => {
    const ball = dynamicBall("Ball", vec3(0, 5, 0));
    ball.physics!.velocity = vec3(0, 0, 3);
    ball.physics!.gravityScale = 0;
    loadBareScene([groundPlane(), ball]);
    play();
    tick(30); // 1s
    expect(near(obj("Ball").transform.position.z, 3, 0.05)).toBe(true);
    store.stop();
  });
});

describe("physics — AABB colliders", () => {
  it("lands a ball exactly on a platform top (regression: giant-sphere walls)", () => {
    const platform = staticBox("Platform", vec3(0, 0.75, -6), vec3(4, 0.5, 4));
    const ball = dynamicBall("Ball", vec3(0, 4, -6));
    loadBareScene([groundPlane(), platform, ball]);
    play();
    tick(120);
    expect(near(obj("Ball").transform.position.y, 1.5, 0.02)).toBe(true); // top 1.0 + radius 0.5
    store.stop();
  });

  it("a wide wall blocks horizontal movement instead of levitating the body (regression)", () => {
    const wall = staticBox("Wall", vec3(0, 1, -20), vec3(40, 2, 1));
    const ball = dynamicBall("Ball", vec3(0, 0.5, 0));
    ball.physics!.gravityScale = 0;
    ball.physics!.velocity = vec3(0, 0, -10);
    loadBareScene([groundPlane(), wall, ball]);
    play();
    tick(90); // 3s at 10/s — would be far past the wall if unblocked
    // Blocked against the wall's near face: z = wallZ + halfDepth + radius = −19
    expect(obj("Ball").transform.position.z).toBeGreaterThan(-19.05);
    expect(obj("Ball").transform.position.z).toBeLessThan(-18.95);
    store.stop();
  });

  it("riding a moving platform carries the passenger (v0.2.2 carry)", () => {
    const mover = staticBox("Mover", vec3(6, 2.25, -4), vec3(3, 0.5, 3));
    mover.script = "var baseX = 6;\nfunction onUpdate(dt, t) { api.position = { x: baseX + Math.sin(t * 0.8) * 2.5, y: api.position.y, z: api.position.z }; }";
    const ball = dynamicBall("Ball", vec3(6, 2.9, -4));
    loadBareScene([groundPlane(), mover, ball]);
    play();
    tick(12); // land
    const p0 = store.worldPositionOf(obj("Ball")).x;
    const m0 = store.worldPositionOf(obj("Mover")).x;
    tick(30);
    const dp = store.worldPositionOf(obj("Ball")).x - p0;
    const dm = store.worldPositionOf(obj("Mover")).x - m0;
    expect(Math.abs(dm)).toBeGreaterThan(0.4); // platform actually moved
    expect(Math.abs(dp - dm)).toBeLessThan(0.35); // passenger followed
    store.stop();
  });
});

describe("physics — dynamic vs dynamic (regression: inverted separating guard)", () => {
  it("a moving body pushes a resting one", () => {
    const a = dynamicBall("Pusher", vec3(0, 0.5, 0));
    a.physics!.gravityScale = 0;
    a.physics!.velocity = vec3(0, 0, 6);
    const b = dynamicBall("Crate", vec3(0, 0.5, 3));
    b.physics!.gravityScale = 0;
    loadBareScene([groundPlane(), a, b]);
    play();
    tick(45);
    const crate = obj("Crate");
    expect(crate.transform.position.z - 3).toBeGreaterThan(0.6); // shoved forward
    // They never interpenetrate.
    const za = obj("Pusher").transform.position.z;
    expect(za).toBeLessThan(crate.transform.position.z + 1.05);
    store.stop();
  });

  it("dynamic boxes join the sphere pass (a box player can push)", () => {
    const player = makeObject("box", { name: "Player" }) as GameObject;
    player.transform.position = vec3(-6, 0.7, 1.4);
    player.physics = { type: "dynamic", bounce: 0, gravityScale: 0, velocity: vec3(0, 0, 4.5) };
    const crate = dynamicBall("Crate", vec3(-6, 0.55, 3));
    crate.physics!.gravityScale = 0;
    loadBareScene([groundPlane(), player, crate]);
    play();
    tick(45);
    expect(obj("Crate").transform.position.z - 3).toBeGreaterThan(0.6);
    store.stop();
  });
});

describe("physics — stop restores the edit-time scene", () => {
  it("snapshots before play and restores after", () => {
    const ball = dynamicBall("Ball", vec3(1, 2, 3));
    loadBareScene([groundPlane(), ball]);
    const before = store.serialize();
    play();
    tick(120);
    expect(store.serialize()).not.toBe(before);
    store.stop();
    expect(store.serialize()).toBe(before);
  });
});
