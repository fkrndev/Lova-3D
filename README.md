# Lova 3D ❤

**Lova 3D** is a 3D scene editor / mini game engine for the desktop, built with
[Tauri 2](https://tauri.app) + [Svelte 5](https://svelte.dev) + [Babylon.js 8](https://www.babylonjs.com)
+ [Tailwind CSS 4](https://tailwindcss.com).

Edit a scene with gizmos, give objects gameplay behaviors, hit **Play** to see it
come alive, then save the whole thing as a portable JSON file.

![stack](https://img.shields.io/badge/Tauri-2-blue) ![stack](https://img.shields.io/badge/Svelte-5-ff3e00) ![stack](https://img.shields.io/badge/Babylon.js-8.x-bb4648) ![stack](https://img.shields.io/badge/Tailwind-4.x-38bdf8)

## Features

- **3D viewport** — orbit/pan/zoom camera, grid ground, click picking with outline
  highlight, multi-select (Ctrl+click)
- **Gizmos** — move / rotate / scale (W / E / R), one history entry per drag
- **Hierarchy panel** — parent/child tree with drag-drop reparenting (world
  position preserved), expand/collapse, search, rename, visibility, delete
- **Physics (v0.2)** — static & dynamic bodies: gravity, bounce restitution,
  initial velocity, ground half-spaces, sphere-vs-box (AABB) and sphere-vs-sphere
  collisions — simulated during Play
- **Scripting (v0.2)** — per-object JavaScript with `onStart()` / `onUpdate(dt, t)`
  hooks and an `api`: `position/rotation/scale`, `velocity` (write to jump),
  `grounded`, `find(name)`, `key(code)`, `log()`, `hud(text)` and a
  **third-person camera** (`api.camera.follow(api)`, drag the viewport to orbit)
  — runs during Play, in the editor and in exported games
- **Export playable HTML (v0.2)** — one click writes a single self-contained
  `.html` (Babylon.js via CDN + inlined scene) that anyone can open and play
- **Stability (v0.2)** — autosave with crash recovery on next launch, and a
  native close guard when there are unsaved changes
- **Inspector** — transform, mesh kind, material (color, emissive, metallic,
  roughness, wireframe), light parameters
- **Lights** — hemispheric, directional, point and spot lights
- **Behaviors** — attach Spin / Bob / Orbit to any object and press Play
- **Play mode** — snapshot-based: Stop restores the edit-time scene exactly
- **Undo / Redo** — snapshot history (Ctrl+Z / Ctrl+Y), up to 64 steps — agent
  and physics edits included
- **Save / Load** — native open/save dialogs, human-readable JSON scenes
  (Ctrl+S / Ctrl+O)
- **Bilingual UI** — English (default) & Bahasa Indonesia, persisted
- **Console panel** — timestamped editor log with severity filters

## Third-person demo ("Lova Obby")

Click the **Demo** button in the toolbar for a ready-made Roblox-style mini game:
a blocky character (parented limbs that swing while walking), WASD/arrow
movement relative to the camera, Space to jump, a draggable third-person camera,
collectible coins with an HUD counter, AABB platforms, a moving platform that
**carries riders**, a climbable tower (hold W against the wall), a pushable
crate and a spinning hazard. Then press **Export HTML** to get the same game as
a single playable file. The demo is ordinary scene data — every mechanic is a
script you can read and edit in the Inspector.

## Getting started

Prerequisites: [Node.js 20+](https://nodejs.org) and a
[Rust toolchain](https://www.rust-lang.org/tools/install) (MSVC on Windows).

```bash
npm install
npm run tauri dev     # run the desktop app in dev mode
npm run tauri build   # produce installers / executables
```

`npm run dev` also works for a plain browser session (scene save/load falls back
to browser download / file picker in that mode).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `W` / `E` / `R` | Move / Rotate / Scale gizmo |
| `F` | Frame selection |
| `Ctrl`+click | Multi-select |
| `Ctrl+D` | Duplicate selection |
| `Delete` | Delete selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+S` / `Ctrl+Shift+S` | Save / Save As |
| `Ctrl+O` | Open scene |
| `Esc` | Clear selection |

**Viewport camera:** left-drag orbit · wheel zoom · right-drag pan.

## Scene file format

Scenes are plain JSON (`.json`), versioned for forward compatibility:

```jsonc
{
  "version": 1,
  "name": "Untitled Scene",
  "environment": { "background": "#101318", "ambient": 0.35 },
  "objects": [
    {
      "id": "…",
      "name": "Box 1",
      "visible": true,
      "transform": {
        "position": { "x": 0, "y": 0.75, "z": 0 },
        "rotation": { "x": 0, "y": 0, "z": 0 },   // degrees
        "scale":    { "x": 1, "y": 1, "z": 1 }
      },
      "mesh": { "kind": "box" },
      "material": {
        "color": "#ff5c7a", "emissive": "#000000",
        "metallic": 0.1, "roughness": 0.65, "wireframe": false
      },
      "behaviors": [
        { "id": "…", "kind": "spin", "enabled": true, "speed": { "x": 0, "y": 45, "z": 0 } }
      ]
    }
  ]
}
```

## Architecture

```
src/
  engine/
    types.ts             scene model (plain serializable JSON)
    factories.ts         defaults for objects / scenes
    sceneStore.svelte.ts single source of truth (Svelte 5 runes) + undo/redo
    viewport.ts          ViewportBridge: Babylon.js engine, sync, gizmos, picking
    runtime.ts           play-mode behavior animation + snapshot restore
    io.ts                Tauri dialogs & Rust commands (browser fallback)
    actions.ts           file actions shared by toolbar & shortcuts
  components/            editor UI (toolbar, hierarchy, inspector, console…)
  i18n/                  en / id dictionaries
src-tauri/
  src/lib.rs            save_scene / load_scene commands + dialog plugin
```

The **store is the single source of truth**: UI panels bind to it, the viewport
bridge diffs it into Babylon nodes every change, and user interactions (picking,
gizmo drags) write back into it. Undo/redo and Play/Stop are JSON snapshots of
the store, which keeps the whole system simple and predictable.

## Styling

[Tailwind CSS 4](https://tailwindcss.com) is wired through the official
`@tailwindcss/vite` plugin (CSS-first — no `tailwind.config.js`). The editor
palette lives in a single `@theme` block in `src/app.css`, which both generates
utilities (`bg-bg1`, `text-accent`, `border-border`, `font-mono`, …) and feeds
the legacy `--bg1`-style aliases used by the hand-written component CSS — one
source of truth for both systems. New components should prefer Tailwind
utilities (see `src/components/StatusBar.svelte` for the pattern).

## Testing

The engine's logic (store, hierarchy math, physics, scripting api, behaviors,
persistence, i18n, HTML export) is covered by a deterministic [Vitest](https://vitest.dev)
suite — no GPU needed, physics driven by manual ticks:

```bash
npm test          # run the whole suite (~4s)
npm run test:watch
```

Highlights: exact reparent compensation under scaled parents, ball-drop settle
and bounce trajectories, AABB platform landing, moving-platform carry,
push-regression (separating-velocity guard), jump-with-grounded, undo/redo
snapshot counts, autosave & crash recovery, EN/ID dictionary parity, and
`</script>` escaping in the HTML exporter. CI runs the suite plus
`svelte-check`, `vite build` and `cargo check` on every push.

## Regenerating the app icon

```bash
node scripts/make-icon.mjs   # renders app-icon.png (no image deps)
npm run tauri -- icon app-icon.png
```

## Roadmap ideas

- MCP agent mode (AI agents building games through the editor)
- GLB/GLTF asset import & asset browser
- Multi-scene projects, prefabs/templates
- Physics: rotated-parent support, box colliders, joints
- Inline-Babylon export (offline single file)
- Resizable panels

## License

MIT
