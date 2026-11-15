import { beforeEach, describe, expect, it } from "vitest";
import { makeObject, near, resetStore, store } from "./helpers";

beforeEach(resetStore);

describe("worldTransformOf (chain math)", () => {
  it("returns local == world for root objects", () => {
    const o = makeObject("box");
    o.transform.position = { x: 1, y: 2, z: 3 };
    store.scene.objects.push(o);
    const w = store.worldTransformOf(o);
    expect(near(w.position.x, 1)).toBe(true);
    expect(near(w.position.y, 2)).toBe(true);
  });

  it("composes parent scale: world = parentPos + parentScale × local", () => {
    const parent = makeObject("box", { name: "P" });
    parent.transform.position = { x: 2, y: 0, z: 0 };
    parent.transform.scale = { x: 1.5, y: 1.5, z: 1.5 };
    const child = makeObject("sphere", { name: "C", parentId: parent.id });
    child.transform.position = { x: -1, y: 1, z: 2 };
    store.scene.objects.push(parent, child);

    const w = store.worldTransformOf(child);
    expect(near(w.position.x, 2 + 1.5 * -1)).toBe(true); // 0.5
    expect(near(w.position.y, 1.5 * 1)).toBe(true); // 1.5
    expect(near(w.position.z, 1.5 * 2)).toBe(true); // 3
    expect(near(w.scale.x, 1.5)).toBe(true);
  });

  it("accumulates through nested scaled chains and survives cycles in data", () => {
    const a = makeObject("box", { name: "A" });
    a.transform.position = { x: 1, y: 0, z: 0 };
    const b = makeObject("box", { name: "B", parentId: a.id });
    b.transform.position = { x: 1, y: 0, z: 0 };
    b.transform.scale = { x: 2, y: 2, z: 2 };
    const c = makeObject("box", { name: "C", parentId: b.id });
    c.transform.position = { x: 1, y: 0, z: 0 };
    store.scene.objects.push(a, b, c);
    // C world = B.world + B.worldScale·C.local = (1 + 1·1) + 2·1 = 4
    expect(near(store.worldPositionOf(c).x, 4)).toBe(true);

    // Even a corrupted cyclic parentId cannot hang the walk.
    a.parentId = c.id;
    expect(() => store.worldPositionOf(c)).not.toThrow();
  });
});

describe("reparent", () => {
  it("preserves world position under a scaled parent (regression: scale ignored)", () => {
    const parent = store.scene.objects.find((o) => o.name === "Box")!; // scale 1.5
    store.updateTransform(parent.id, { ...parent.transform, position: { x: 2, y: 0, z: 0 } });
    const child = store.scene.objects.find((o) => o.name === "Sphere")!;
    const before = store.worldPositionOf(child); // (0.2, 1.25, 0)

    store.reparent(child.id, parent.id);
    const local = store.getObject(child.id)!.transform.position;
    expect(near(local.x, (0.2 - 2) / 1.5, 1e-3)).toBe(true); // −1.2
    expect(near(local.y, 1.25 / 1.5, 1e-3)).toBe(true); // 0.8333
    expect(near(store.worldPositionOf(store.getObject(child.id)!).x, before.x, 1e-3)).toBe(true);
  });

  it("detaching back to root keeps world position", () => {
    const parent = store.scene.objects.find((o) => o.name === "Box")!;
    const child = store.scene.objects.find((o) => o.name === "Sphere")!;
    store.reparent(child.id, parent.id);
    store.updateTransform(parent.id, {
      ...parent.transform,
      position: { x: 5, y: 0, z: 0 },
    });
    const world = store.worldPositionOf(store.getObject(child.id)!);

    store.reparent(child.id, null);
    const local = store.getObject(child.id)!.transform.position;
    expect(near(local.x, world.x, 1e-3)).toBe(true);
    expect(near(local.y, world.y, 1e-3)).toBe(true);
  });

  it("rejects cycles and no-op reparents", () => {
    const parent = store.scene.objects.find((o) => o.name === "Box")!;
    const child = store.scene.objects.find((o) => o.name === "Sphere")!;
    store.reparent(child.id, parent.id);
    const arrangements = store.serialize();

    store.reparent(parent.id, child.id); // would create a cycle
    expect(store.getObject(parent.id)!.parentId).toBeNull();
    store.reparent(child.id, parent.id); // no-op
    store.reparent(child.id, child.id); // self
    expect(store.serialize()).toBe(arrangements);
  });

  it("moves the subtree after the new parent in array order", () => {
    const parent = store.scene.objects.find((o) => o.name === "Box")!;
    const child = store.scene.objects.find((o) => o.name === "Sphere")!;
    const torus = store.scene.objects.find((o) => o.name === "Torus")!;
    store.reparent(child.id, parent.id);
    const ids = store.scene.objects.map((o) => o.id);
    expect(ids.indexOf(child.id)).toBeGreaterThan(ids.indexOf(parent.id));
    expect(ids).toContain(torus.id);
  });

  it("childrenOf / descendantsOf describe the tree", () => {
    const parent = store.scene.objects.find((o) => o.name === "Box")!;
    const child = store.scene.objects.find((o) => o.name === "Sphere")!;
    const grandchild = store.scene.objects.find((o) => o.name === "Torus")!;
    store.reparent(child.id, parent.id);
    store.reparent(grandchild.id, child.id);
    expect(store.childrenOf(parent.id).map((o) => o.name)).toEqual(["Sphere"]);
    expect(store.descendantsOf(parent.id).has(child.id)).toBe(true);
    expect(store.descendantsOf(parent.id).has(grandchild.id)).toBe(true);
    expect(store.childrenOf(null).map((o) => o.name)).toContain("Box");
  });
});
