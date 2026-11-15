/**
 * Trigger-volume (sensor) tests — the store-level system runs identically on
 * every physics backend, so these cover the editor path directly.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createThirdPersonDemo } from "../src/engine/demoScene";
import { dynamicBall, groundPlane, loadBareScene, makeObject, resetStore, store, tick, vec3 } from "./helpers";
import type { GameObject } from "../src/engine/types";

beforeEach(resetStore);

const obj = (name: string) => store.scene.objects.find((o) => o.name === name)!;

function sensorZone(name: string, pos: { x: number; y: number; z: number }, radius: number, events: string[]): GameObject {
  const o = makeObject("sphere", { name });
  o.transform.position = { ...pos };
  o.sensor = { radius };
  o.script = [
    "function onTriggerEnter(other) { __sensorEvents.push('enter:' + other.name + '@' + other.position.y.toFixed(1)); }",
    "function onTriggerLeave(other) { __sensorEvents.push('leave:' + other.name); }",
  ].join("\n");
  (globalThis as Record<string, unknown>).__sensorEvents = events;
  return o;
}

describe("sensors", () => {
  it("fires enter when a dynamic body enters the radius, leave when it exits", () => {
    const events: string[] = [];
    const ball = dynamicBall("Ball", vec3(0, 5, 0)); // drops through the zone
    ball.physics!.gravityScale = 0; // manual control instead
    const zone = sensorZone("Zone", vec3(0, 1, 0), 1.5, events);
    loadBareScene([groundPlane(), zone, ball]);

    store.play();
    tick(1);
    expect(events).toEqual([]); // ball at y=5, far away

    // Move into the zone (0..: y 1.0 ± 1.5 + bodyRadius 0.5 → ≤ 3.0).
    store.updateTransform(ball.id, { ...ball.transform, position: vec3(0, 2.5, 0) });
    tick(1);
    expect(events).toEqual([`enter:Ball@2.5`]);

    // Staying inside does not re-fire.
    store.updateTransform(ball.id, { ...ball.transform, position: vec3(0.2, 2.0, 0) });
    tick(1);
    expect(events).toHaveLength(1);

    // Leave.
    store.updateTransform(ball.id, { ...ball.transform, position: vec3(10, 2, 0) });
    tick(1);
    expect(events).toEqual([`enter:Ball@2.5`, "leave:Ball"]);
    store.stop();
  });

  it("moving sensors carry the zone with them", () => {
    const events: string[] = [];
    const ball = dynamicBall("Ball", vec3(0, 0.5, 0));
    ball.physics!.gravityScale = 0;
    const zone = sensorZone("Zone", vec3(50, 0.5, 0), 1.2, events);
    loadBareScene([groundPlane(), zone, ball]);

    store.play();
    tick(1);
    expect(events).toEqual([]);

    // Bring the zone to the ball.
    store.updateTransform(zone.id, { ...zone.transform, position: vec3(0.5, 0.5, 0) });
    tick(1);
    expect(events).toEqual(["enter:Ball@0.5"]);
    store.stop();
  });

  it("errors in hooks disable that hook instead of spamming", () => {
    const events: string[] = [];
    const ball = dynamicBall("Ball", vec3(0, 0.5, 0));
    ball.physics!.gravityScale = 0;
    const zone = makeObject("sphere", { name: "Zone" }) as GameObject;
    zone.transform.position = vec3(0, 0.5, 0);
    zone.sensor = { radius: 2 };
    zone.script = "function onTriggerEnter(other) { throw new Error('boom'); }";
    loadBareScene([groundPlane(), zone, ball]);

    store.play();
    tick(1);
    tick(1);
    const errors = store.logs.filter((l) => l.kind === "error" && l.text.includes("boom"));
    expect(errors).toHaveLength(1);
    void events;
    store.stop();
  });

  it("demo coins are sensor-driven and the lava zone respawns", () => {
    store.loadScene(createThirdPersonDemo(), null);
    const coin = obj("Coin1");
    expect(coin.sensor?.radius).toBeGreaterThan(0);
    expect(coin.script).toContain("onTriggerEnter");
    const lava = obj("Lava");
    expect(lava.sensor?.radius).toBeGreaterThan(0);
    expect(lava.script).toContain("other.position");
  });
});
