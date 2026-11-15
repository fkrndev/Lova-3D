import { beforeEach, describe, expect, it } from "vitest";
import { createBehavior } from "../src/engine/factories";
import { groundPlane, loadBareScene, makeObject, near, resetStore, store, tick, vec3 } from "./helpers";

beforeEach(resetStore);

const obj = (name: string) => store.scene.objects.find((o) => o.name === name)!;

describe("behaviors — exact math (dt clamped to 0.1s)", () => {
  it("spin rotates at degrees/sec", () => {
    const o = makeObject("box", { name: "S" });
    o.behaviors.push(createBehavior("spin")); // 45°/s on Y
    loadBareScene([o]);
    store.play();
    tick(1, 1); // clamped to 0.1s
    tick(1, 1); // t = 0.2s
    expect(near(obj("S").transform.rotation.y, 9, 1e-6)).toBe(true); // 45 × 0.2
    store.stop();
  });

  it("bob oscillates around the base height", () => {
    const o = makeObject("sphere", { name: "B" });
    o.transform.position = vec3(0, 2, 0);
    o.behaviors.push(createBehavior("bob")); // amp 0.5, speed 2
    loadBareScene([o]);
    store.play();
    tick(1, 1);
    tick(1, 1); // t = 0.2 → y = 2 + sin(0.4)·0.5
    expect(near(obj("B").transform.position.y, 2 + Math.sin(0.4) * 0.5, 1e-6)).toBe(true);
    store.stop();
  });

  it("orbit circles the base position", () => {
    const o = makeObject("torus", { name: "O" });
    o.transform.position = vec3(3, 1, 0);
    o.behaviors.push(createBehavior("orbit")); // r=2, 60°/s
    loadBareScene([o]);
    store.play();
    tick(1, 1);
    tick(1, 1); // t = 0.2 → θ = 12°
    const a = (60 * 0.2 * Math.PI) / 180;
    expect(near(obj("O").transform.position.x, 3 + Math.cos(a) * 2, 1e-6)).toBe(true);
    expect(near(obj("O").transform.position.z, Math.sin(a) * 2, 1e-6)).toBe(true);
    store.stop();
  });

  it("disabled behaviors are skipped", () => {
    const o = makeObject("box", { name: "S" });
    const b = createBehavior("spin");
    b.enabled = false;
    o.behaviors.push(b);
    loadBareScene([o]);
    store.play();
    tick(30);
    expect(near(obj("S").transform.rotation.y, 0, 1e-9)).toBe(true);
    store.stop();
  });

  it("dynamic bodies keep physics-owned position; spin still rotates (regression)", () => {
    const o = makeObject("sphere", { name: "D" });
    o.transform.position = vec3(0, 5, 0);
    o.behaviors.push(createBehavior("bob"));
    o.behaviors.push(createBehavior("spin"));
    o.physics = { type: "dynamic", bounce: 0, gravityScale: 1, velocity: vec3() };
    loadBareScene([groundPlane(), o]);
    store.play();
    tick(30);
    // Fell under gravity (bob did NOT reset the position each tick).
    expect(obj("D").transform.position.y).toBeLessThan(4.5);
    // Spin still applies.
    expect(obj("D").transform.rotation.y).toBeGreaterThan(1);
    store.stop();
  });
});
