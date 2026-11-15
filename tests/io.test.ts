import { beforeEach, describe, expect, it } from "vitest";
import { validateScene } from "../src/engine/io";
import { createDefaultScene } from "../src/engine/factories";
import { resetStore } from "./helpers";
import type { SceneData } from "../src/engine/types";

beforeEach(resetStore);

const roundtrip = (scene: SceneData) => validateScene(JSON.stringify(scene));

describe("validateScene", () => {
  it("accepts and round-trips a default scene", () => {
    const scene = createDefaultScene();
    const parsed = roundtrip(scene);
    expect(parsed.objects.length).toBe(scene.objects.length);
  });

  it("rejects invalid JSON", () => {
    expect(() => validateScene("{not json")).toThrow("invalid JSON");
  });

  it("rejects wrong versions and shapes", () => {
    const scene = createDefaultScene();
    expect(() => roundtrip({ ...scene, version: 2 as never })).toThrow();
    expect(() => roundtrip({ ...scene, objects: "nope" as never })).toThrow();
    expect(() => roundtrip({ ...scene, name: 7 as never })).toThrow();
    const broken = structuredClone(scene);
    delete (broken.objects[0] as { mesh?: unknown }).mesh;
    expect(() => roundtrip(broken)).toThrow();
  });

  it("normalizes optional fields from older scenes", () => {
    const scene = createDefaultScene();
    const raw = JSON.parse(JSON.stringify(scene)) as SceneData;
    for (const o of raw.objects) {
      delete (o as { parentId?: unknown }).parentId;
      delete (o as { behaviors?: unknown }).behaviors;
    }
    delete raw.environment.ambient;
    const parsed = validateScene(JSON.stringify(raw));
    for (const o of parsed.objects) {
      expect(o.parentId).toBeNull();
      expect(o.behaviors).toEqual([]);
    }
    expect(parsed.environment.ambient).toBeDefined();
  });

  it("normalizes partial physics definitions", () => {
    const scene = createDefaultScene();
    const raw = JSON.parse(JSON.stringify(scene)) as SceneData;
    raw.objects[0].physics = { type: "dynamic" } as never;
    const parsed = validateScene(JSON.stringify(raw));
    const p = parsed.objects[0].physics!;
    expect(p.bounce).toBeGreaterThanOrEqual(0);
    expect(p.gravityScale).toBe(1);
    expect(p.velocity).toEqual({ x: 0, y: 0, z: 0 });
  });
});
