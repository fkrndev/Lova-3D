import { beforeEach, describe, expect, it } from "vitest";
import { buildExportHtml } from "../src/export/playerRuntime";
import { createDefaultScene } from "../src/engine/factories";
import { resetStore } from "./helpers";

beforeEach(resetStore);

describe("buildExportHtml", () => {
  it("produces a complete standalone document", () => {
    const html = buildExportHtml(createDefaultScene());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("inlines the scene JSON and the full player runtime", () => {
    const scene = createDefaultScene();
    scene.name = "VerifyMe";
    const html = buildExportHtml(scene);
    expect(html).toContain('"version":1');
    expect(html).toContain("VerifyMe");
    expect(html).toContain("cdn.babylonjs.com");
    // Player systems:
    expect(html).toContain("runRenderLoop");
    expect(html).toContain("applyPlayCamera");
    expect(html).toContain("aabbs");
    expect(html).toContain("groundedMap");
    expect(html).toContain('getElementById("hud")');
    // Behaviors / physics / scripts:
    expect(html).toContain("GRAVITY");
    expect(html).toContain("onUpdate");
  });

  it("escapes scene content so it cannot break out of the script tag", () => {
    const scene = createDefaultScene();
    scene.name = 'x</script><img src=x onerror=alert(1)>';
    const html = buildExportHtml(scene);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toMatch(new RegExp("</script>\\s*<img"));
  });

  it("exports the third-person demo with its scripts intact", async () => {
    const { createThirdPersonDemo } = await import("../src/engine/demoScene");
    const html = buildExportHtml(createThirdPersonDemo());
    expect(html).toContain("api.camera.follow");
    expect(html).toContain("api.grounded");
    expect(html).toContain("Koin tersisa");
    expect(html.length).toBeGreaterThan(20_000);
  });

  it("ships a dual physics backend: Rapier WASM with a TS fallback", () => {
    const html = buildExportHtml(createDefaultScene());
    // Rapier WASM via pinned CDN…
    expect(html).toContain("@dimforge/rapier3d-compat@0.21.0");
    expect(html).toContain("initPhysics");
    expect(html).toContain("stepRapier");
    expect(html).toContain("__lovaPhys");
    // …and the built-in TS simulation as a graceful offline fallback.
    expect(html).toContain('physMode = "ts"');
    expect(html).toContain("GRAVITY");
  });
});
