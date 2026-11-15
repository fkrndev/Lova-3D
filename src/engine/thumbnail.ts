/**
 * Offscreen model thumbnails: renders an imported GLB/GLTF once, at import
 * time, into a hidden 160×160 Babylon canvas and returns the PNG data URL.
 */
import {
  ArcRotateCamera,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Scene,
  SceneLoader,
  Vector3,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

export async function renderModelThumbnail(bytes: Uint8Array, modelPath: string): Promise<string | null> {
  let canvas: HTMLCanvasElement | null = null;
  let engine: Engine | null = null;
  try {
    canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 160;
    canvas.style.display = "none";
    document.body.appendChild(canvas);

    engine = new Engine(canvas, true, { stencil: false }, false);
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.09, 0.1, 0.13, 1);

    const ext = (/\.([a-z0-9]+)$/i.exec(modelPath)?.[1] ?? "glb").toLowerCase();
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const result = await SceneLoader.ImportMeshAsync("", url, `model.${ext}`, scene);
    URL.revokeObjectURL(url);

    const meshes = result.meshes.filter((m) => m.getTotalVertices() > 0);
    if (meshes.length === 0) return null;

    let min = new Vector3(Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE);
    let max = new Vector3(-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE);
    for (const m of meshes) {
      const bb = m.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min, bb.minimumWorld);
      max = Vector3.Maximize(max, bb.maximumWorld);
    }
    const center = max.add(min).scale(0.5);
    const diag = max.subtract(min).length() || 1;

    const camera = new ArcRotateCamera("thumbCam", -Math.PI / 3, Math.PI / 3.4, diag * 1.1, center, scene);
    camera.minZ = diag / 100;
    scene.activeCamera = camera;

    const hemi = new HemisphericLight("thumbLight", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.9;
    const sun = new DirectionalLight("thumbSun", new Vector3(-0.5, -1, 0.4), scene);
    sun.intensity = 0.6;

    engine.runRenderLoop(() => scene.render());
    await new Promise((r) => setTimeout(r, 250)); // a few frames
    engine.stopRenderLoop();
    scene.render();

    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    engine?.dispose();
    canvas?.remove();
  }
}
