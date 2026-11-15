/**
 * Object factories: default values for new objects and new scenes.
 */
import type {
  Behavior,
  BehaviorKind,
  GameObject,
  LightKind,
  MaterialDef,
  MeshKind,
  SceneData,
  Transform,
} from "./types";

let uidCounter = 0;
export function uid(): string {
  uidCounter += 1;
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `obj-${Date.now().toString(36)}-${uidCounter}`;
}

export const defaultTransform = (): Transform => ({
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

export const defaultMaterial = (): MaterialDef => ({
  color: "#c8cdd6",
  emissive: "#000000",
  metallic: 0.1,
  roughness: 0.65,
  wireframe: false,
});

/** Friendly display names used for auto-numbering ("Box 1", "Box 2", ...). */
export const kindLabel = (kind: MeshKind | LightKind): string =>
  ({
    box: "Box",
    sphere: "Sphere",
    cylinder: "Cylinder",
    cone: "Cone",
    capsule: "Capsule",
    torus: "Torus",
    plane: "Plane",
    hemispheric: "Hemispheric Light",
    directional: "Directional Light",
    point: "Point Light",
    spot: "Spot Light",
  })[kind];

function uniqueName(objects: GameObject[], base: string): string {
  let n = objects.filter((o) => o.name === base).length;
  if (n === 0) return base;
  let name = "";
  do {
    n += 1;
    name = `${base} ${n}`;
  } while (objects.some((o) => o.name === name));
  return name;
}

export function createMeshObject(kind: MeshKind, objects: GameObject[]): GameObject {
  return {
    id: uid(),
    name: uniqueName(objects, kindLabel(kind)),
    visible: true,
    parentId: null,
    transform: defaultTransform(),
    mesh: { kind },
    material: defaultMaterial(),
    // Ground planes make sensible default colliders.
    ...(kind === "plane"
      ? { physics: { type: "static", bounce: 0.3, gravityScale: 1, velocity: { x: 0, y: 0, z: 0 } } }
      : {}),
    behaviors: [],
  };
}

const LIGHT_COLORS: Record<LightKind, string> = {
  hemispheric: "#cfe3ff",
  directional: "#fff3d6",
  point: "#ffd9a8",
  spot: "#ffe9b8",
};

export function createLightObject(kind: LightKind, objects: GameObject[]): GameObject {
  return {
    id: uid(),
    name: uniqueName(objects, kindLabel(kind)),
    visible: true,
    parentId: null,
    // Lights are placed a bit above the ground so they are immediately visible.
    transform: {
      position: { x: 0, y: kind === "hemispheric" ? 8 : 5, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
    light: {
      kind,
      intensity: kind === "hemispheric" ? 0.5 : 1,
      diffuse: LIGHT_COLORS[kind],
      angleDeg: 60,
      exponent: 2,
    },
    behaviors: [],
  };
}

export function createBehavior(kind: BehaviorKind): Behavior {
  const id = uid();
  switch (kind) {
    case "spin":
      return { id, kind, enabled: true, speed: { x: 0, y: 45, z: 0 } };
    case "bob":
      return { id, kind, enabled: true, amplitude: 0.5, speed: 2 };
    case "orbit":
      return { id, kind, enabled: true, radius: 2, speed: 60 };
  }
}

/**
 * The default scene every "New Scene" starts from — a small playable diorama
 * so the editor never opens on an empty void.
 */
export function createDefaultScene(): SceneData {
  const objects: GameObject[] = [];

  const ground = createMeshObject("plane", objects);
  ground.name = "Ground";
  ground.transform.scale = { x: 24, y: 1, z: 24 };
  ground.material!.color = "#232833";
  ground.material!.roughness = 0.9;
  ground.physics = { type: "static", bounce: 0.35, gravityScale: 1, velocity: { x: 0, y: 0, z: 0 } };
  objects.push(ground);

  const cube = createMeshObject("box", objects);
  cube.transform.position = { x: -2.5, y: 0.75, z: 0 };
  cube.transform.scale = { x: 1.5, y: 1.5, z: 1.5 };
  cube.material!.color = "#ff5c7a";
  cube.behaviors.push(createBehavior("spin"));
  objects.push(cube);

  const sphere = createMeshObject("sphere", objects);
  sphere.transform.position = { x: 0.2, y: 1.25, z: 0 };
  sphere.material!.color = "#66c0ff";
  sphere.material!.metallic = 0.7;
  sphere.material!.roughness = 0.25;
  sphere.behaviors.push(createBehavior("bob"));
  objects.push(sphere);

  const torus = createMeshObject("torus", objects);
  torus.transform.position = { x: 3, y: 1, z: 0 };
  torus.transform.rotation = { x: 0, y: 0, z: 0 };
  torus.material!.color = "#ffd166";
  torus.behaviors.push(createBehavior("orbit"));
  objects.push(torus);

  const sun = createLightObject("directional", objects);
  sun.name = "Sun";
  sun.transform.position = { x: -4, y: 8, z: 4 };
  sun.light!.intensity = 0.85;
  objects.push(sun);

  const sky = createLightObject("hemispheric", objects);
  sky.name = "Sky";
  sky.light!.intensity = 0.45;
  objects.push(sky);

  return {
    version: 1,
    name: "Untitled Scene",
    environment: { background: "#101318", ambient: 0.35 },
    objects,
  };
}
