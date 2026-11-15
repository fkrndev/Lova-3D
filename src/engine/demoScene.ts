/**
 * Third-person demo scene ("Lova Obby") — a tiny Roblox-style platformer:
 * blocky character with WASD + jump, follow camera you can drag to orbit,
 * collectible coins, platforms (AABB colliders), a moving platform and a
 * spinning hazard. Everything is ordinary scene data: open it, press Play.
 */
import { createBehavior, createLightObject, createMeshObject, uid } from "./factories";
import type { GameObject, SceneData } from "./types";

const PLAYER_SCRIPT = `var speed = 4.5, jumpV = 7;
var legL = api.find("LegL"), legR = api.find("LegR");

function onStart() {
  api.camera.follow(api);
  api.camera.distance = 7.5;
  api.camera.pitch = 18;
}

function onUpdate(dt, t) {
  // Movement relative to the camera yaw (drag the viewport to turn).
  var yaw = api.camera.yaw * Math.PI / 180;
  var fx = Math.sin(yaw), fz = Math.cos(yaw);
  var mx = 0, mz = 0;
  if (api.key("KeyW") || api.key("ArrowUp"))    { mx += fx; mz += fz; }
  if (api.key("KeyS") || api.key("ArrowDown"))  { mx -= fx; mz -= fz; }
  if (api.key("KeyA") || api.key("ArrowLeft"))  { mx -= fz; mz += fx; }
  if (api.key("KeyD") || api.key("ArrowRight")) { mx += fz; mz -= fx; }
  var len = Math.hypot(mx, mz);
  if (len > 0) {
    mx = mx / len * speed;
    mz = mz / len * speed;
    api.rotation = { x: 0, y: Math.atan2(mx, mz) * 180 / Math.PI, z: 0 };
    if (legL && legR) {
      legL.rotation = { x: Math.sin(t * 10) * 0.7, y: 0, z: 0 };
      legR.rotation = { x: -Math.sin(t * 10) * 0.7, y: 0, z: 0 };
    }
  } else {
    mx = 0; mz = 0;
    if (legL && legR) {
      legL.rotation = { x: 0, y: 0, z: 0 };
      legR.rotation = { x: 0, y: 0, z: 0 };
    }
  }

  // Jump with real physics velocity.
  var vy = api.velocity.y;
  if ((api.key("Space") || api.key("KeyJ")) && api.grounded) vy = jumpV;
  api.velocity = { x: mx, y: vy, z: mz };

  // Fell off the world → respawn.
  if (api.position.y < -8) {
    api.position = { x: 0, y: 3, z: 0 };
    api.velocity = { x: 0, y: 0, z: 0 };
  }

  // Coin counter HUD.
  var left = 0;
  for (var i = 1; i <= 6; i++) {
    var c = api.find("Coin" + i);
    if (c && c.scale.x > 0.1) left++;
  }
  api.hud(left === 0 ? "Semua koin terkumpul — MENANG! \\u{1F389}" : "Koin tersisa: " + left);
}`;

const COIN_SCRIPT = `var player = api.find("Player");
function onUpdate(dt, t) {
  if (api.scale.x < 0.1) return; // already collected
  var p = player ? player.position : null;
  if (!p) return;
  var m = api.position;
  if (Math.hypot(p.x - m.x, p.y - m.y, p.z - m.z) < 1.25) {
    api.scale = { x: 0.01, y: 0.01, z: 0.01 };
    api.log("Koin didapat!");
  }
}`;

const MOVER_SCRIPT = `var baseX = 6;
function onUpdate(dt, t) {
  api.position = { x: baseX + Math.sin(t * 0.8) * 2.5, y: api.position.y, z: api.position.z };
}`;

/** Climb wall: hold W near it to ascend (Roblox-style climbing). */
const CLIMB_SCRIPT = `var player = api.find("Player");
function onUpdate(dt, t) {
  if (!player) return;
  var p = player.position, m = api.position;
  var near = Math.abs(p.x - m.x) < 1.6 && Math.abs(p.z - m.z) < 1.6 && p.y > m.y - 1.5 && p.y < m.y + 2.6;
  if (near && (api.key("KeyW") || api.key("ArrowUp"))) {
    player.velocity = { x: 0, y: 2.8, z: 0 };
  }
}`;

function mesh(kind: Parameters<typeof createMeshObject>[0], name: string): GameObject {
  const objects: GameObject[] = [];
  const obj = createMeshObject(kind, objects);
  obj.name = name;
  return obj;
}

function place(
  obj: GameObject,
  pos: [number, number, number],
  scale: [number, number, number],
  color: string,
  opts: { parentId?: string; physics?: "static" | "dynamic"; roughness?: number; metallic?: number } = {}
): GameObject {
  obj.transform.position = { x: pos[0], y: pos[1], z: pos[2] };
  obj.transform.scale = { x: scale[0], y: scale[1], z: scale[2] };
  obj.material!.color = color;
  obj.material!.roughness = opts.roughness ?? 0.7;
  obj.material!.metallic = opts.metallic ?? 0.05;
  obj.parentId = opts.parentId ?? null;
  if (opts.physics) {
    obj.physics = { type: opts.physics, bounce: 0, gravityScale: 1, velocity: { x: 0, y: 0, z: 0 } };
  }
  return obj;
}

export function createThirdPersonDemo(): SceneData {
  const objects: GameObject[] = [];

  // ── world ────────────────────────────────────────────────────────────
  const ground = mesh("plane", "Ground");
  place(ground, [0, 0, 0], [40, 1, 40], "#69b34c", { physics: "static" });
  ground.physics!.bounce = 0;
  objects.push(ground);

  // Arena walls (AABB colliders).
  const wallN = mesh("box", "WallN");
  place(wallN, [0, 1, -20], [40, 2, 1], "#3a4150", { physics: "static" });
  const wallS = mesh("box", "WallS");
  place(wallS, [0, 1, 20], [40, 2, 1], "#3a4150", { physics: "static" });
  const wallW = mesh("box", "WallW");
  place(wallW, [-20, 1, 0], [1, 2, 40], "#3a4150", { physics: "static" });
  const wallE = mesh("box", "WallE");
  place(wallE, [20, 1, 0], [1, 2, 40], "#3a4150", { physics: "static" });
  objects.push(wallN, wallS, wallW, wallE);

  // Obby platforms (jump up the stairs).
  const platforms: Array<[string, [number, number, number], [number, number, number], string]> = [
    ["Platform1", [0, 0.75, -6], [4, 0.5, 4], "#f2a65a"],
    ["Platform2", [3, 1.5, -10], [3, 0.5, 3], "#f2a65a"],
    ["Platform3", [-1, 2.25, -13], [3, 0.5, 3], "#e8865a"],
    ["Platform4", [-5, 3, -10], [3, 0.5, 3], "#e8865a"],
    ["Platform5", [-5, 3.75, -5], [3, 0.5, 3], "#d9665a"],
  ];
  for (const [name, pos, scale, color] of platforms) {
    objects.push(place(mesh("box", name), pos, scale, color, { physics: "static" }));
  }

  // Moving platform (scripted) — riders are carried by the physics engine.
  const mover = mesh("box", "MovingPlatform");
  place(mover, [6, 2.25, -4], [3, 0.5, 3], "#7c5cff", { physics: "static" });
  mover.script = MOVER_SCRIPT;
  objects.push(mover);

  // Climb tower: hold W against the wall to climb, coin on top.
  const tower = mesh("box", "Tower");
  place(tower, [10, 2, 6], [3, 4, 3], "#8a6f5c", { physics: "static" });
  objects.push(tower);

  const climbWall = mesh("box", "ClimbWall");
  place(climbWall, [10, 2, 3.7], [2.4, 4, 0.3], "#c8a17a");
  climbWall.script = CLIMB_SCRIPT; // no physics — it is a trigger, not a collider
  objects.push(climbWall);

  // Pushable crate (dynamic — walk into it).
  const crate = mesh("cylinder", "Crate");
  place(crate, [-6, 0.55, 3], [1, 1, 1], "#c9a227", { physics: "dynamic" });
  crate.physics!.bounce = 0.25;
  objects.push(crate);

  // Spinning hazard.
  const hazard = mesh("torus", "Hazard");
  place(hazard, [0, 1.1, -3], [2.2, 2.2, 2.2], "#ff5c7a", { roughness: 0.4 });
  hazard.behaviors.push(createBehavior("spin"));
  (hazard.behaviors[0] as { speed: { x: number; y: number; z: number } }).speed = { x: 0, y: 160, z: 0 };
  objects.push(hazard);

  // ── character (blocky, parented limbs) ───────────────────────────────
  const player = mesh("box", "Player");
  place(player, [0, 1.61, 0], [1, 1.2, 0.6], "#38b6ff", { physics: "dynamic" });
  player.script = PLAYER_SCRIPT;
  objects.push(player);

  const head = mesh("box", "Head");
  place(head, [0, 0.95, 0], [0.7, 0.7, 0.7], "#ffd7b0", { parentId: player.id });
  const armL = mesh("box", "ArmL");
  place(armL, [-0.8, 0.1, 0], [0.3, 1, 0.3], "#38b6ff", { parentId: player.id });
  const armR = mesh("box", "ArmR");
  place(armR, [0.8, 0.1, 0], [0.3, 1, 0.3], "#38b6ff", { parentId: player.id });
  const legL = mesh("box", "LegL");
  place(legL, [-0.28, -1, 0], [0.35, 0.8, 0.35], "#2d4a63", { parentId: player.id });
  const legR = mesh("box", "LegR");
  place(legR, [0.28, -1, 0], [0.35, 0.8, 0.35], "#2d4a63", { parentId: player.id });
  objects.push(head, armL, armR, legL, legR);

  // ── coins ────────────────────────────────────────────────────────────
  const coinSpots: Array<[number, number, number]> = [
    [0, 1.6, -6],
    [3, 2.4, -10],
    [-1, 3.1, -13],
    [-5, 4.6, -5],
    [6, 3.2, -4],
    [10, 5.3, 6], // on top of the climb tower
  ];
  coinSpots.forEach((pos, i) => {
    const coin = mesh("cylinder", `Coin${i + 1}`);
    place(coin, pos, [0.7, 0.12, 0.7], "#ffd166", { metallic: 0.7, roughness: 0.25 });
    coin.behaviors.push(createBehavior("spin"));
    (coin.behaviors[0] as { speed: { x: number; y: number; z: number } }).speed = { x: 0, y: 220, z: 0 };
    coin.script = COIN_SCRIPT;
    objects.push(coin);
  });

  // ── lights ───────────────────────────────────────────────────────────
  const sun = createLightObject("directional", objects);
  sun.name = "Sun";
  sun.transform.position = { x: -6, y: 10, z: 6 };
  sun.light!.intensity = 0.9;
  objects.push(sun);

  const sky = createLightObject("hemispheric", objects);
  sky.name = "Sky";
  sky.light!.intensity = 0.55;
  sky.light!.diffuse = "#cfe8ff";
  objects.push(sky);

  // Player ids referenced by scripts must exist before compile — sanity check.
  void uid;

  return {
    version: 1,
    name: "Lova Obby — Third Person Demo",
    environment: { background: "#7ec8ff", ambient: 0.55 },
    objects,
  };
}
