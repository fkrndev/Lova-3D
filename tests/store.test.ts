import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, store, SceneStore } from "./helpers";
import { createDefaultScene } from "../src/engine/factories";

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});
afterEach(() => vi.useRealTimers());

describe("sceneStore — selection", () => {
  it("selects, additive-toggles and clears", () => {
    const [a, b] = store.scene.objects;
    store.select(a.id);
    expect(store.selectedIds).toEqual([a.id]);
    store.select(b.id, true);
    expect(store.selectedIds).toHaveLength(2);
    store.select(b.id, true); // toggle off
    expect(store.selectedIds).toEqual([a.id]);
    store.select(null);
    expect(store.selectedIds).toEqual([]);
    expect(store.primarySelection).toBeNull();
  });

  it("prunes selection when objects disappear via undo", () => {
    const a = store.scene.objects[0];
    store.select(a.id);
    store.removeSelected();
    expect(store.scene.objects).not.toContainEqual(expect.objectContaining({ id: a.id }));
    store.undo();
    expect(store.selectedIds).toEqual([]);
  });
});

describe("sceneStore — history (undo/redo)", () => {
  it("tracks add / duplicate / delete with exact counts", () => {
    const base = store.scene.objects.length;
    store.addMesh("cone");
    expect(store.scene.objects.length).toBe(base + 1);
    store.duplicateSelected();
    expect(store.scene.objects.length).toBe(base + 2);
    store.undo();
    expect(store.scene.objects.length).toBe(base + 1);
    store.undo();
    expect(store.scene.objects.length).toBe(base);
    store.redo();
    expect(store.scene.objects.length).toBe(base + 1);
    expect(store.canRedo).toBe(true);
    store.redo();
    expect(store.canRedo).toBe(false);
  });

  it("restores the exact scene JSON on undo", () => {
    const before = store.serialize();
    store.addLight("point");
    store.undo();
    expect(store.serialize()).toBe(before);
  });

  it("clears the redo stack on a new commit", () => {
    store.addMesh("box");
    store.undo();
    expect(store.canRedo).toBe(true);
    store.addMesh("sphere"); // branch
    expect(store.canRedo).toBe(false);
  });

  it("commitSoon debounces rapid edits into one snapshot", () => {
    for (let i = 0; i < 3; i++) {
      store.setEnvironment({ ambient: 0.1 + i * 0.1 });
      store.commitSoon();
      vi.advanceTimersByTime(100); // below the 500ms debounce — nothing commits
    }
    expect(store.canUndo).toBe(false);
    vi.advanceTimersByTime(600); // debounce fires → one snapshot of the final value
    expect(store.canUndo).toBe(true);
    store.undo();
    // Back to the pristine default (0.35): the intermediate 0.1/0.2 were never committed.
    expect(store.scene.environment.ambient).toBeCloseTo(0.35, 5);
    expect(store.canUndo).toBe(false);
  });

  it("blocks undo/redo and mutations during play", () => {
    store.play();
    expect(store.playState).toBe("playing");
    const count = store.scene.objects.length;
    store.addMesh("box"); // no-op
    store.undo(); // no-op
    expect(store.scene.objects.length).toBe(count);
    store.stop();
    expect(store.playState).toBe("edit");
  });
});

describe("sceneStore — subtree delete & duplicate", () => {
  it("deleting a parent removes its descendants; undo restores them", () => {
    const parent = store.scene.objects.find((o) => o.name === "Box")!;
    const child = store.scene.objects.find((o) => o.name === "Sphere")!;
    store.reparent(child.id, parent.id);
    const total = store.scene.objects.length;

    store.select(parent.id);
    store.removeSelected();
    expect(store.scene.objects.length).toBe(total - 2);
    expect(store.scene.objects.some((o) => o.id === child.id)).toBe(false);

    store.undo();
    expect(store.scene.objects.length).toBe(total);
    const childBack = store.scene.objects.find((o) => o.id === child.id)!;
    expect(childBack.parentId).toBe(parent.id);
  });

  it("duplicating a parent clones the subtree with remapped ids", () => {
    const parent = store.scene.objects.find((o) => o.name === "Box")!;
    const child = store.scene.objects.find((o) => o.name === "Sphere")!;
    store.reparent(child.id, parent.id);
    const total = store.scene.objects.length;

    store.select(parent.id);
    store.duplicateSelected();
    expect(store.scene.objects.length).toBe(total + 2);

    const clone = store.scene.objects.find((o) => o.name === "Box Copy")!;
    expect(clone.id).not.toBe(parent.id);
    const cloneChild = store.scene.objects.find((o) => o.parentId === clone.id)!;
    expect(cloneChild.name).toBe("Sphere"); // descendants keep their names; only roots get " Copy"
    // Original untouched.
    expect(store.getObject(child.id)!.parentId).toBe(parent.id);
  });
});

describe("sceneStore — autosave & recovery", () => {
  it("autosaves 2s after a commit and clears on save/new/load", () => {
    store.rename(store.scene.objects[0].id, "AutosaveMarker");
    store.commit();
    vi.advanceTimersByTime(2100);
    expect(localStorage.getItem("lova.autosave")).toContain("AutosaveMarker");

    store.markSaved("C:/scene.json");
    expect(localStorage.getItem("lova.autosave")).toBeNull();
    expect(store.dirty).toBe(false);

    store.rename(store.scene.objects[0].id, "Again");
    store.commit();
    vi.advanceTimersByTime(2100);
    expect(localStorage.getItem("lova.autosave")).toBeTruthy();
    store.newScene();
    expect(localStorage.getItem("lova.autosave")).toBeNull();
  });

  it("recovers the autosaved scene on next launch", () => {
    store.rename(store.scene.objects[0].id, "CrashSurvivor");
    store.commit();
    vi.advanceTimersByTime(2100);

    const fresh = new SceneStore();
    expect(fresh.recovered).toBe(true);
    expect(fresh.dirty).toBe(true);
    expect(fresh.scene.objects.some((o) => o.name === "CrashSurvivor")).toBe(true);
  });

  it("ignores corrupt autosaves", () => {
    localStorage.setItem("lova.autosave", "{{{broken");
    const fresh = new SceneStore();
    expect(fresh.recovered).toBe(false);
    expect(fresh.scene.objects.length).toBe(createDefaultScene().objects.length);
  });
});

describe("sceneStore — serialization", () => {
  it("round-trips a loaded scene through serialize → loadScene", () => {
    const json = store.serialize();
    const parsed = JSON.parse(json);
    store.loadScene(parsed, "test.json");
    expect(store.currentPath).toBe("test.json");
    expect(store.dirty).toBe(false);
    expect(store.serialize()).toBe(json);
    // History was reset for the fresh document.
    expect(store.canUndo).toBe(false);
  });
});
