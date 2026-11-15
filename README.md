# LovaEngine ❤

**LovaEngine** is a 3D scene editor / mini game engine for the desktop, built with
[Tauri 2](https://tauri.app) + [Svelte 5](https://svelte.dev) + [Babylon.js 8](https://www.babylonjs.com).

Edit a scene with gizmos, give objects gameplay behaviors, hit **Play** to see it
come alive, then save the whole thing as a portable JSON file.

![stack](https://img.shields.io/badge/Tauri-2-blue) ![stack](https://img.shields.io/badge/Svelte-5-ff3e00) ![stack](https://img.shields.io/badge/Babylon.js-8.x-bb4648)

## Features

- **3D viewport** — orbit/pan/zoom camera, grid ground, click picking with outline
  highlight, multi-select (Ctrl+click)
- **Gizmos** — move / rotate / scale (W / E / R), one history entry per drag
- **Hierarchy panel** — search, rename (double-click), visibility toggle, delete
- **Inspector** — transform, mesh kind, material (color, emissive, metallic,
  roughness, wireframe), light parameters
- **Lights** — hemispheric, directional, point and spot lights
- **Behaviors** — attach Spin / Bob / Orbit to any object and press Play
- **Play mode** — snapshot-based: Stop restores the edit-time scene exactly
- **Undo / Redo** — snapshot history (Ctrl+Z / Ctrl+Y), up to 64 steps
- **Save / Load** — native open/save dialogs, human-readable JSON scenes
  (Ctrl+S / Ctrl+O)
- **Bilingual UI** — English (default) & Bahasa Indonesia, persisted
- **Console panel** — timestamped editor log with severity filters

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

## Regenerating the app icon

```bash
node scripts/make-icon.mjs   # renders app-icon.png (no image deps)
npm run tauri -- icon app-icon.png
```

## Roadmap ideas

- GLB/GLTF asset import & asset browser
- Scripting (per-object JS behaviors)
- Physics behaviors (gravity, collisions)
- Parent/child hierarchy
- Resizable panels

## License

MIT
