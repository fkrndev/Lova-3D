/**
 * Standalone HTML exporter.
 *
 * `buildExportHtml` inlines the scene JSON plus a self-contained player
 * (Babylon.js loaded from CDN) into a single .html file anyone can open and
 * play. The player mirrors the editor's runtime formulas (behaviors, physics,
 * scripts) — see the roadmap note about unifying the two implementations.
 */
import type { SceneData } from "../engine/types";

export function buildExportHtml(scene: SceneData): string {
  // Escape `<` so a hostile scene name can't break out of the script tag.
  const sceneJson = JSON.stringify(scene).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark" />
<title>${escapeHtml(scene.name)} — Lova 3D</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f1115; overflow: hidden; }
  canvas { width: 100%; height: 100%; display: block; outline: none; touch-action: none; }
  #badge {
    position: fixed; top: 10px; left: 10px; color: #ff5c7a; font: 600 12px/1.4 "Segoe UI", system-ui, sans-serif;
    background: rgba(15,17,21,.82); border: 1px solid #262b35; border-radius: 6px; padding: 5px 10px;
    pointer-events: none;
  }
  #hint {
    position: fixed; bottom: 8px; left: 10px; color: #5c6472; font: 11px/1.4 "Segoe UI", system-ui, sans-serif;
    background: rgba(15,17,21,.78); border-radius: 5px; padding: 3px 8px; pointer-events: none;
  }
  #hud {
    position: fixed; top: 10px; left: 50%; transform: translateX(-50%); max-width: 70%;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    color: #d7dce4; font: 600 14px/1.4 "Segoe UI", system-ui, sans-serif;
    background: rgba(15,17,21,.82); border: 1px solid #262b35; border-radius: 8px;
    padding: 6px 14px; pointer-events: none; display: none;
  }
</style>
</head>
<body>
<canvas id="stage"></canvas>
<div id="badge">&#9829; ${escapeHtml(scene.name)}</div>
<div id="hud"></div>
<div id="hint">Drag orbit &middot; Wheel zoom &middot; Right-drag pan</div>
<script src="https://cdn.babylonjs.com/babylon.js"></script>
<script>
(function () {
  "use strict";
  var DEG = Math.PI / 180, GRAVITY = 9.8;
  var SCENE = ${sceneJson};

  var canvas = document.getElementById("stage");
  var engine = new BABYLON.Engine(canvas, true, { stencil: true, preserveDrawingBuffer: true }, true);
  var scene = new BABYLON.Scene(engine);
  scene.clearColor = BABYLON.Color4.FromHexString(padHex(SCENE.environment.background));

  var camera = new BABYLON.ArcRotateCamera("camera", -Math.PI / 3, 1.15, 16, new BABYLON.Vector3(0, 1, 0), scene);
  camera.lowerRadiusLimit = 1.5;
  camera.upperRadiusLimit = 120;
  camera.upperBetaLimit = (Math.PI / 2) * 0.98;
  camera.wheelDeltaPercentage = 0.01;
  camera.minZ = 0.1;
  camera.panningSensibility = 60;
  camera.attachControl(canvas, true);
  canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  var hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0, 1, 0), scene);
  hemi.intensity = SCENE.environment.ambient;
  var sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.5, -1, 0.4), scene);
  sun.intensity = 0.25;

  function padHex(h) { return h.length === 7 ? h + "ff" : h.length === 9 ? h : "#101318ff"; }
  function col3(h) { return BABYLON.Color3.FromHexString(h.length === 9 ? h.slice(0, 7) : h); }
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }

  // ── build objects ─────────────────────────────────────────────────────
  var nodes = {}; // id -> { def, root, mesh, light }

  function buildMesh(def, id) {
    var m;
    switch (def.mesh.kind) {
      case "box": m = BABYLON.MeshBuilder.CreateBox(id, { size: 1 }, scene); break;
      case "sphere": m = BABYLON.MeshBuilder.CreateSphere(id, { diameter: 1, segments: 24 }, scene); break;
      case "cylinder": m = BABYLON.MeshBuilder.CreateCylinder(id, { height: 1, diameter: 1, tessellation: 28 }, scene); break;
      case "cone": m = BABYLON.MeshBuilder.CreateCylinder(id, { height: 1, diameterTop: 0, diameterBottom: 1, tessellation: 28 }, scene); break;
      case "capsule": m = BABYLON.MeshBuilder.CreateCapsule(id, { height: 1, radius: 0.375 }, scene); break;
      case "torus": m = BABYLON.MeshBuilder.CreateTorus(id, { diameter: 1, thickness: 0.35, tessellation: 28 }, scene); break;
      case "plane": m = BABYLON.MeshBuilder.CreateGround(id, { width: 1, height: 1, subdivisions: 1 }, scene); break;
    }
    m.name = def.name;
    return m;
  }

  SCENE.objects.forEach(function (def) {
    var root = new BABYLON.TransformNode(def.id, scene);
    root.name = def.name;
    var entry = { def: def, root: root, mesh: null, light: null };
    if (def.mesh) {
      var mat = new BABYLON.StandardMaterial("mat:" + def.id, scene);
      var m = def.material || {};
      mat.diffuseColor = col3(padHex(m.color || "#c8cdd6").slice(0, 7));
      mat.emissiveColor = col3(padHex(m.emissive || "#000000").slice(0, 7));
      var metal = clamp01(m.metallic != null ? m.metallic : 0.1);
      mat.specularColor = new BABYLON.Color3(metal, metal, metal);
      mat.specularPower = Math.pow(2, 5 + (1 - clamp01(m.roughness != null ? m.roughness : 0.65)) * 6);
      mat.wireframe = !!m.wireframe;
      mat.backFaceCulling = def.mesh.kind !== "plane";
      var mesh = buildMesh(def, def.id);
      mesh.material = mat;
      mesh.parent = root;
      entry.mesh = mesh;
    }
    if (def.light) {
      var light;
      if (def.light.kind === "hemispheric") light = new BABYLON.HemisphericLight("l:" + def.id, new BABYLON.Vector3(0, 1, 0), scene);
      else if (def.light.kind === "directional") light = new BABYLON.DirectionalLight("l:" + def.id, new BABYLON.Vector3(0, -1, 0), scene);
      else if (def.light.kind === "point") light = new BABYLON.PointLight("l:" + def.id, BABYLON.Vector3.Zero(), scene);
      else light = new BABYLON.SpotLight("l:" + def.id, BABYLON.Vector3.Zero(), new BABYLON.Vector3(0, -1, 0), (def.light.angleDeg || 60) * DEG, def.light.exponent || 2, scene);
      light.intensity = def.light.intensity != null ? def.light.intensity : 1;
      light.diffuse = col3(padHex(def.light.diffuse || "#ffffff").slice(0, 7));
      light.parent = root;
      entry.light = light;
    }
    nodes[def.id] = entry;
  });

  function applyTransform(def) {
    var root = nodes[def.id].root;
    var t = def.transform;
    root.position.set(t.position.x, t.position.y, t.position.z);
    root.rotation.set(t.rotation.x * DEG, t.rotation.y * DEG, t.rotation.z * DEG);
    root.scaling.set(t.scale.x, t.scale.y, t.scale.z);
    root.setEnabled(def.visible !== false);
  }

  SCENE.objects.forEach(function (def) {
    nodes[def.id].root.parent = def.parentId && nodes[def.parentId] ? nodes[def.parentId].root : null;
    applyTransform(def);
  });

  // ── play state: bases, velocities, scripts, keys ──────────────────────
  function cloneT(t) { return { position: { x: t.position.x, y: t.position.y, z: t.position.z }, rotation: { x: t.rotation.x, y: t.rotation.y, z: t.rotation.z }, scale: { x: t.scale.x, y: t.scale.y, z: t.scale.z } }; }
  var byId = {};
  SCENE.objects.forEach(function (o) { byId[o.id] = o; });
  var bases = {}, vel = {}, radii = {};
  SCENE.objects.forEach(function (o) {
    bases[o.id] = cloneT(o.transform);
    if (o.physics) {
      vel[o.id] = { x: o.physics.velocity.x || 0, y: o.physics.velocity.y || 0, z: o.physics.velocity.z || 0 };
      var s = o.transform.scale;
      radii[o.id] = 0.5 * Math.max(s.x, s.y, s.z);
    }
  });

  function worldPos(o) { return worldTransform(o).position; }
  function worldTransform(o) {
    var chain = [], guard = {}, pid = o.parentId;
    guard[o.id] = 1;
    while (pid && byId[pid] && !guard[pid]) {
      guard[pid] = 1;
      chain.push(byId[pid]);
      pid = byId[pid].parentId;
    }
    var px = 0, py = 0, pz = 0, sx = 1, sy = 1, sz = 1;
    for (var i = chain.length - 1; i >= 0; i--) {
      var t = chain[i].transform;
      px += sx * t.position.x; py += sy * t.position.y; pz += sz * t.position.z;
      sx *= t.scale.x; sy *= t.scale.y; sz *= t.scale.z;
    }
    return {
      position: { x: px + sx * o.transform.position.x, y: py + sy * o.transform.position.y, z: pz + sz * o.transform.position.z },
      scale: { x: sx * o.transform.scale.x, y: sy * o.transform.scale.y, z: sz * o.transform.scale.z }
    };
  }
  function writeWorld(o, w) {
    var pw = o.parentId && byId[o.parentId] ? worldTransform(byId[o.parentId]) : { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    o.transform.position = {
      x: (w.x - pw.position.x) / (pw.scale.x || 1),
      y: (w.y - pw.position.y) / (pw.scale.y || 1),
      z: (w.z - pw.position.z) / (pw.scale.z || 1)
    };
  }

  var keys = {};
  window.addEventListener("keydown", function (e) { keys[e.code] = true; });
  window.addEventListener("keyup", function (e) { keys[e.code] = false; });
  window.addEventListener("blur", function () { keys = {}; });

  // ── script play camera (third-person) ─────────────────────────────────
  var hudEl = document.getElementById("hud");
  var playCam = { active: false, targetId: null, targetPos: { x: 0, y: 1, z: 0 }, yaw: 0, pitch: 20, distance: 8 };
  var camDrag = { down: false, x: 0, y: 0 };
  canvas.addEventListener("pointerdown", function (e) {
    if (e.button === 0 && playCam.active) { camDrag.down = true; camDrag.x = e.clientX; camDrag.y = e.clientY; }
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!camDrag.down || !playCam.active) return;
    playCam.yaw += (e.clientX - camDrag.x) * 0.3;
    playCam.pitch = Math.max(-80, Math.min(85, playCam.pitch + (e.clientY - camDrag.y) * 0.3));
    camDrag.x = e.clientX; camDrag.y = e.clientY;
  });
  window.addEventListener("pointerup", function () { camDrag.down = false; });
  function applyPlayCamera() {
    if (!playCam.active) return;
    var t = playCam.targetId && nodes[playCam.targetId]
      ? nodes[playCam.targetId].root.getAbsolutePosition()
      : new BABYLON.Vector3(playCam.targetPos.x, playCam.targetPos.y, playCam.targetPos.z);
    camera.setTarget(t);
    camera.radius = Math.max(1, playCam.distance);
    camera.alpha = (270 - playCam.yaw) * DEG; // camera behind forward (sin yaw, cos yaw)
    camera.beta = Math.max(0.05, Math.min(1.52, (90 - playCam.pitch) * DEG));
  }

  var scripts = [];
  SCENE.objects.forEach(function (o) {
    if (!o.script || !o.script.trim()) return;
    try {
      var factory = new Function("api",
        '"use strict";\\n' + o.script + '\\n;return { onStart: typeof onStart === "function" ? onStart : null, onUpdate: typeof onUpdate === "function" ? onUpdate : null };');
      var api = makeApi(o.id);
      var hooks = factory(api);
      scripts.push({ id: o.id, api: api, onStart: hooks.onStart, onUpdate: hooks.onUpdate });
    } catch (e) {
      console.error("script [" + o.name + "]:", e && e.message ? e.message : e);
    }
  });

  function makeApi(id) {
    function handle(tid) {
      return {
        get id() { return tid; },
        get name() { return byId[tid] ? byId[tid].name : ""; },
        get position() { var p = byId[tid] && byId[tid].transform.position; return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 }; },
        set position(v) { if (byId[tid]) byId[tid].transform.position = { x: v.x || 0, y: v.y || 0, z: v.z || 0 }; },
        get rotation() { var r = byId[tid] && byId[tid].transform.rotation; return r ? { x: r.x, y: r.y, z: r.z } : { x: 0, y: 0, z: 0 }; },
        set rotation(v) { if (byId[tid]) byId[tid].transform.rotation = { x: v.x || 0, y: v.y || 0, z: v.z || 0 }; },
        get scale() { var s = byId[tid] && byId[tid].transform.scale; return s ? { x: s.x, y: s.y, z: s.z } : { x: 1, y: 1, z: 1 }; },
        set scale(v) { if (byId[tid]) byId[tid].transform.scale = { x: v.x || 1, y: v.y || 1, z: v.z || 1 }; },
        get velocity() { var v = vel[tid]; return v ? { x: v.x, y: v.y, z: v.z } : { x: 0, y: 0, z: 0 }; },
        set velocity(v) {
          var o = byId[tid];
          if (!o || !o.physics || o.physics.type !== "dynamic") { console.warn("velocity requires Physics → Dynamic:", o && o.name); return; }
          vel[tid] = { x: v.x || 0, y: v.y || 0, z: v.z || 0 };
        },
        get grounded() { return groundedMap[tid] === true; },
        find: function (name) { for (var i = 0; i < SCENE.objects.length; i++) if (SCENE.objects[i].name === name) return handle(SCENE.objects[i].id); return null; },
        key: function (code) { return !!keys[code]; },
        log: function () { console.log.apply(console, arguments); },
        hud: function (text) {
          hudEl.textContent = text == null ? "" : String(text);
          hudEl.style.display = text ? "block" : "none";
        },
        camera: {
          follow: function (target) { playCam.active = true; playCam.targetId = target ? target.id : null; },
          lookAt: function (pos) { playCam.active = true; playCam.targetId = null; playCam.targetPos = { x: pos.x || 0, y: pos.y || 0, z: pos.z || 0 }; },
          stop: function () { playCam.active = false; },
          get yaw() { return playCam.yaw; },
          set yaw(v) { playCam.yaw = v || 0; },
          get pitch() { return playCam.pitch; },
          set pitch(v) { playCam.pitch = Math.max(-80, Math.min(85, v || 0)); },
          get distance() { return playCam.distance; },
          set distance(v) { playCam.distance = Math.max(1, v || 8); }
        }
      };
    }
    return handle(id);
  }

  scripts.forEach(function (s) {
    try { if (s.onStart) s.onStart(); } catch (e) { console.error("script onStart:", e && e.message ? e.message : e); }
  });

  // ── per-frame simulation (mirrors the editor runtime) ─────────────────
  var time = 0;
  var aabbPrev = {}; // persists across frames for moving-platform carry deltas
  engine.runRenderLoop(function () {
    var dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
    time += dt;
    var t = time;

    // behaviors
    SCENE.objects.forEach(function (o) {
      if (!o.behaviors || !o.behaviors.length) return;
      var base = bases[o.id];
      var isDyn = o.physics && o.physics.type === "dynamic";
      var pos = { x: base.position.x, y: base.position.y, z: base.position.z };
      var rot = { x: base.rotation.x, y: base.rotation.y, z: base.rotation.z };
      o.behaviors.forEach(function (b) {
        if (b.enabled === false) return;
        if (b.kind === "spin") { rot.x += b.speed.x * t; rot.y += b.speed.y * t; rot.z += b.speed.z * t; }
        else if (b.kind === "bob" && !isDyn) { pos.y = base.position.y + Math.sin(t * b.speed) * b.amplitude; }
        else if (b.kind === "orbit" && !isDyn) {
          var a = b.speed * DEG * t;
          pos.x = base.position.x + Math.cos(a) * b.radius;
          pos.z = base.position.z + Math.sin(a) * b.radius;
        }
      });
      if (isDyn) {
        // Physics owns the position of dynamic bodies — only rotation applies.
        o.transform.rotation = rot;
      } else {
        o.transform.position = pos;
        o.transform.rotation = rot;
      }
    });

    // physics
    var groundedMap = {};
    var grounds = [];
    var aabbs = [];
    SCENE.objects.forEach(function (o) {
      if (!o.physics || !o.mesh) return;
      if (o.physics.type === "static" && o.mesh.kind === "plane") grounds.push(worldPos(o).y);
      if (o.physics.type === "static" && o.mesh.kind === "box") {
        var wt = worldTransform(o);
        var prev = aabbPrev[o.id];
        aabbs.push({
          id: o.id,
          cx: wt.position.x, cy: wt.position.y, cz: wt.position.z,
          hx: Math.max(wt.scale.x, 0.01) / 2, hy: Math.max(wt.scale.y, 0.01) / 2, hz: Math.max(wt.scale.z, 0.01) / 2,
          dx: prev ? wt.position.x - prev.x : 0, dy: prev ? wt.position.y - prev.y : 0, dz: prev ? wt.position.z - prev.z : 0
        });
      }
    });
    if (!grounds.length) grounds.push(0);
    SCENE.objects.forEach(function (o) {
      if (!o.physics || o.physics.type !== "dynamic" || !o.mesh) return;
      var v = vel[o.id], r = radii[o.id] || 0.5;
      v.y -= GRAVITY * o.physics.gravityScale * dt;
      var w = worldPos(o);
      w.x += v.x * dt; w.y += v.y * dt; w.z += v.z * dt;
      var grounded = false;
      grounds.forEach(function (gy) {
        if (w.y < gy + r) {
          w.y = gy + r;
          if (v.y < 0) v.y = -v.y * o.physics.bounce;
          if (Math.abs(v.y) < 0.9) v.y = 0;
          grounded = true;
        }
      });
      aabbs.forEach(function (b) {
        var qx = Math.min(Math.max(w.x, b.cx - b.hx), b.cx + b.hx);
        var qy = Math.min(Math.max(w.y, b.cy - b.hy), b.cy + b.hy);
        var qz = Math.min(Math.max(w.z, b.cz - b.hz), b.cz + b.hz);
        var nx = w.x - qx, ny = w.y - qy, nz = w.z - qz;
        var dist = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (dist >= r) return;
        if (dist < 1e-6) {
          var dx = b.hx + r - Math.abs(w.x - b.cx), dy = b.hy + r - Math.abs(w.y - b.cy), dz = b.hz + r - Math.abs(w.z - b.cz);
          if (dy <= dx && dy <= dz) { ny = w.y >= b.cy ? 1 : -1; nx = nz = 0; w.y = b.cy + (ny > 0 ? b.hy + r : -(b.hy + r)); }
          else if (dx <= dz) { nx = w.x >= b.cx ? 1 : -1; ny = nz = 0; w.x = b.cx + (nx > 0 ? b.hx + r : -(b.hx + r)); }
          else { nz = w.z >= b.cz ? 1 : -1; nx = ny = 0; w.z = b.cz + (nz > 0 ? b.hz + r : -(b.hz + r)); }
        } else {
          nx /= dist; ny /= dist; nz /= dist;
          w.x = qx + nx * r; w.y = qy + ny * r; w.z = qz + nz * r;
        }
        var vn = v.x * nx + v.y * ny + v.z * nz;
        if (vn < 0) {
          var e = 1 + o.physics.bounce;
          v.x -= e * vn * nx; v.y -= e * vn * ny; v.z -= e * vn * nz;
        }
        if (ny > 0.5) {
          grounded = true;
          if (Math.abs(v.y) < 0.9) v.y = 0;
          // Ride the collider: moving platforms carry their riders.
          w.x += b.dx; w.y += b.dy; w.z += b.dz;
        }
      });
      groundedMap[o.id] = grounded;
      if (grounded) { var damp = Math.max(0, 1 - 6 * dt); v.x *= damp; v.z *= damp; }
      writeWorld(o, w);
    });
    aabbs.forEach(function (b) { aabbPrev[b.id] = { x: b.cx, y: b.cy, z: b.cz }; });

    // sphere/sphere collisions (planes & static boxes excluded — half-spaces / AABBs; dynamic boxes join as spheres)
    var bodies = SCENE.objects.filter(function (o) {
      return o.physics && o.mesh && o.mesh.kind !== "plane" && (o.mesh.kind !== "box" || o.physics.type === "dynamic");
    });
    for (var i = 0; i < bodies.length; i++) {
      for (var j = i + 1; j < bodies.length; j++) {
        var a = bodies[i], b = bodies[j];
        var pa = worldPos(a), pb = worldPos(b);
        var ra = radii[a.id] || 0.5, rb = radii[b.id] || 0.5;
        var dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
        var minDist = ra + rb;
        if (dist >= minDist) continue;
        var nx = dx / dist, ny = dy / dist, nz = dz / dist, pen = minDist - dist;
        var aDyn = a.physics.type === "dynamic", bDyn = b.physics.type === "dynamic";
        function push(o, sx, sy, sz) { var p = o.transform.position; p.x += sx; p.y += sy; p.z += sz; }
        if (aDyn && bDyn) { push(a, -nx * pen / 2, -ny * pen / 2, -nz * pen / 2); push(b, nx * pen / 2, ny * pen / 2, nz * pen / 2); }
        else if (aDyn) push(a, -nx * pen, -ny * pen, -nz * pen);
        else if (bDyn) push(b, nx * pen, ny * pen, nz * pen);
        var va = vel[a.id] || { x: 0, y: 0, z: 0 }, vb = vel[b.id] || { x: 0, y: 0, z: 0 };
        var rel = (va.x - vb.x) * nx + (va.y - vb.y) * ny + (va.z - vb.z) * nz;
        if (rel <= 0) continue; // already separating
        var imp = -(1 + Math.min(a.physics.bounce, b.physics.bounce)) * rel;
        if (aDyn) { va.x += imp * nx; va.y += imp * ny; va.z += imp * nz; }
        if (bDyn) { vb.x -= imp * nx; vb.y -= imp * ny; vb.z -= imp * nz; }
      }
    }

    // scripts
    scripts.forEach(function (s) {
      if (!s.onUpdate || !byId[s.id]) return;
      try { s.onUpdate(dt, t); } catch (e) { console.error("script onUpdate:", e && e.message ? e.message : e); s.onUpdate = null; }
    });

    // push transforms to Babylon
    SCENE.objects.forEach(function (o) { applyTransform(o); });
    applyPlayCamera();
    scene.render();
  });

  window.addEventListener("resize", function () { engine.resize(); });
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
