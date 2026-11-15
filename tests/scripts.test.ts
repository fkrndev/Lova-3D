import { beforeEach, describe, expect, it } from "vitest";
import { groundPlane, dynamicBall, loadBareScene, makeObject, near, resetStore, runtime, store, tick, vec3 } from "./helpers";
import type { PlayCameraBridge } from "../src/engine/runtime";

beforeEach(resetStore);

const obj = (name: string) => store.scene.objects.find((o) => o.name === name)!;

/** A recording stub the runtime can drive api.camera against. */
function cameraStub(): PlayCameraBridge & { state: { active: boolean; targetId: string | null; yaw: number; pitch: number; distance: number } } {
  const state = { active: false, targetId: null as string | null, targetPos: vec3(), yaw: 0, pitch: 20, distance: 8 };
  return {
    state,
    getPlayCam: () => ({ ...state, targetPos: { ...state.targetPos } }),
    patchPlayCam: (p) => Object.assign(state, p),
  };
}

describe("scripts — lifecycle", () => {
  it("runs onStart then onUpdate every tick", () => {
    const o = makeObject("box", { name: "S" });
    o.script = [
      "var hits = 0;",
      "function onStart() { api.log('started'); }",
      "function onUpdate(dt, t) { hits++; api.position = { x: t, y: 0, z: 0 }; }",
    ].join("\n");
    loadBareScene([o]);
    store.play();
    expect(store.logs.some((l) => l.text === "started")).toBe(true);
    tick(5);
    expect(near(obj("S").transform.position.x, 5 / 30, 1e-6)).toBe(true);
    store.stop();
  });

  it("syntax errors are reported to the console, not thrown", () => {
    const o = makeObject("box", { name: "Bad" });
    o.script = "function broken( {";
    loadBareScene([o]);
    expect(() => store.play()).not.toThrow();
    expect(store.logs.some((l) => l.kind === "error" && l.text.includes("Bad"))).toBe(true);
    store.stop();
  });

  it("runtime errors disable that onUpdate instead of spamming", () => {
    const o = makeObject("box", { name: "Err" });
    o.script = "function onUpdate(dt, t) { throw new Error('boom'); }";
    loadBareScene([o]);
    store.play();
    tick(3);
    tick(3);
    const errCount = store.logs.filter((l) => l.kind === "error" && l.text.includes("boom")).length;
    expect(errCount).toBe(1);
    store.stop();
  });

  it("Stop restores the edit-time transform written before play", () => {
    const o = makeObject("box", { name: "S" });
    o.transform.position = vec3(9, 0, 0);
    o.script = "function onUpdate() { api.position = { x: 1, y: 1, z: 1 }; }";
    loadBareScene([o]);
    store.play();
    tick(5);
    expect(near(obj("S").transform.position.x, 1, 1e-9)).toBe(true);
    store.stop();
    expect(near(obj("S").transform.position.x, 9, 1e-9)).toBe(true);
  });
});

describe("scripts — api", () => {
  it("key() reads real keyboard events", () => {
    const o = makeObject("box", { name: "K" });
    o.script = "function onUpdate() { api.position = { x: api.key('KeyW') ? 7 : 0, y: 0, z: 0 }; }";
    loadBareScene([o]);
    store.play();
    tick(1);
    expect(near(obj("K").transform.position.x, 0, 1e-9)).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    tick(1);
    expect(near(obj("K").transform.position.x, 7, 1e-9)).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
    tick(1);
    expect(near(obj("K").transform.position.x, 0, 1e-9)).toBe(true);
    store.stop();
  });

  it("velocity requires dynamic physics and warns once", () => {
    const plain = makeObject("box", { name: "Plain" });
    const dyn = dynamicBall("Dyn", vec3(0, 5, 0));
    dyn.physics!.gravityScale = 0;
    dyn.script = "function onUpdate() { api.velocity = { x: 0, y: 2, z: 0 }; }";
    plain.script = "function onUpdate() { api.velocity = { x: 1, y: 1, z: 1 }; }";
    loadBareScene([plain, dyn]);
    store.play();
    tick(15);
    // Dynamic one rises at ~2/s (the script's velocity applies from tick 2 on).
    expect(obj("Dyn").transform.position.y).toBeGreaterThan(5.85);
    expect(obj("Dyn").transform.position.y).toBeLessThan(6.01);
    // Non-dynamic one warned exactly once and did nothing.
    const warns = store.logs.filter((l) => l.kind === "warn" && l.text.includes("velocity requires"));
    expect(warns.length).toBe(1);
    expect(near(obj("Plain").transform.position.x, 0, 1e-9)).toBe(true);
    store.stop();
  });

  it("grounded is true while resting and hud text lands in the store", () => {
    const ball = dynamicBall("Ball", vec3(0, 2, 0));
    ball.script = "function onUpdate() { api.hud(api.grounded ? 'down' : 'up'); }";
    loadBareScene([groundPlane(), ball]);
    store.play();
    tick(1);
    const early = store.playHud;
    tick(90);
    expect(store.playHud).toBe("down");
    expect(early).toBe("up");
    store.stop();
    expect(store.playHud).toBe(""); // cleared on stop
  });

  it("find() returns a live handle to another object", () => {
    const target = makeObject("sphere", { name: "Target" });
    target.transform.position = vec3(4, 0, 0);
    const seeker = makeObject("box", { name: "Seeker" });
    seeker.script = "var t = api.find('Target');\nfunction onUpdate() { t.position = { x: 8, y: 0, z: 0 }; }";
    loadBareScene([target, seeker]);
    store.play();
    tick(1);
    expect(near(obj("Target").transform.position.x, 8, 1e-9)).toBe(true);
    store.stop();
  });

  it("camera api drives the attached bridge and clamps pitch", () => {
    const o = makeObject("box", { name: "Cam" });
    o.script = [
      "function onStart() {",
      "  api.camera.follow(api);",
      "  api.camera.distance = 7.5;",
      "  api.camera.pitch = 999;", // clamped to 85
      "}",
    ].join("\n");
    loadBareScene([o]);
    const cam = cameraStub();
    runtime.attachCamera(cam);
    store.play();
    expect(cam.state.active).toBe(true);
    expect(cam.state.targetId).toBe(o.id);
    expect(cam.state.distance).toBe(7.5);
    expect(cam.state.pitch).toBe(85);
    expect(cam.state.yaw).toBe(0);
    store.stop();
  });
});

describe("scripts — play-mode scenario (jump)", () => {
  it("Space + grounded sets an upward velocity that gravity then eats", () => {
    const ball = dynamicBall("Ball", vec3(0, 0.5, 0));
    ball.script = "function onUpdate() { if (api.key('Space') && api.grounded) api.velocity = { x: 0, y: 7, z: 0 }; }";
    loadBareScene([groundPlane(), ball]);
    store.play();
    tick(30); // settle
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    tick(1); // script sets vy = 7
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    tick(5); // velocity now lifts the body
    const apex = obj("Ball").transform.position.y;
    tick(10);
    // Rose after the jump…
    expect(apex).toBeGreaterThan(0.7);
    // …and gravity brings it back down.
    tick(60);
    expect(obj("Ball").transform.position.y).toBeLessThan(0.7);
    store.stop();
  });
});
