import { beforeEach, describe, expect, it } from "vitest";
import { createBehavior, createDefaultScene, createLightObject, createMeshObject } from "../src/engine/factories";
import { makeObject, resetStore } from "./helpers";
import { MESH_KINDS, LIGHT_KINDS, BEHAVIOR_KINDS } from "../src/engine/types";

beforeEach(resetStore);

describe("factories", () => {
  it("creates mesh objects with unique auto-numbered names", () => {
    const objects = [makeObject("box", { name: "Box" })];
    const second = createMeshObject("box", objects);
    expect(second.name).toBe("Box 2");
    expect(second.parentId).toBeNull();
    expect(second.mesh?.kind).toBe("box");
    expect(second.material?.color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(second.behaviors).toEqual([]);
  });

  it("gives ground planes static physics by default", () => {
    const plane = makeObject("plane");
    expect(plane.physics?.type).toBe("static");
    const box = makeObject("box");
    expect(box.physics).toBeUndefined();
  });

  it("creates lights above the ground with sane defaults", () => {
    for (const kind of LIGHT_KINDS) {
      const light = createLightObject(kind, []);
      expect(light.light?.kind).toBe(kind);
      expect(light.transform.position.y).toBeGreaterThan(0);
      expect(light.light!.diffuse).toMatch(/^#[0-9a-f]{6}$/i);
      expect(light.mesh).toBeUndefined();
    }
  });

  it("covers every mesh kind", () => {
    for (const kind of MESH_KINDS) {
      expect(makeObject(kind).mesh?.kind).toBe(kind);
    }
  });

  it("creates enabled behaviors with sensible defaults", () => {
    expect(createBehavior("spin").speed.y).toBe(45);
    expect(createBehavior("bob").amplitude).toBe(0.5);
    expect(createBehavior("orbit").radius).toBe(2);
    for (const kind of BEHAVIOR_KINDS) expect(createBehavior(kind).enabled).toBe(true);
  });

  it("default scene is a playable diorama with a static ground", () => {
    const scene = createDefaultScene();
    expect(scene.version).toBe(1);
    expect(scene.objects.length).toBeGreaterThanOrEqual(6);
    const ground = scene.objects.find((o) => o.name === "Ground");
    expect(ground?.physics?.type).toBe("static");
    // Something spins, something bobs, something orbits.
    const kinds = new Set(scene.objects.flatMap((o) => o.behaviors.map((b) => b.kind)));
    expect(kinds).toContain("spin");
    expect(kinds).toContain("bob");
    expect(kinds).toContain("orbit");
  });
});
