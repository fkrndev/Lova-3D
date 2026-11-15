<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "../engine/sceneStore.svelte";
  import { runtime } from "../engine/runtime";
  import { buildExportHtml } from "../export/playerRuntime";
  import { createThirdPersonDemo } from "../engine/demoScene";
  import { ViewportBridge } from "../engine/viewport";
  import { b64ToBytes, isTauri, readProjectFileB64 } from "../engine/io";
  import { t } from "../i18n/index.svelte";
  import Icon from "./ui/Icon.svelte";
  import type { GizmoMode, PlayState } from "../engine/types";
  import type { TKey } from "../i18n/en";

  let canvas: HTMLCanvasElement;
  let container: HTMLElement;
  let bridge = $state<ViewportBridge | null>(null);

  const gizmoLabel: Record<GizmoMode, TKey> = {
    position: "toolbar.move",
    rotation: "toolbar.rotate",
    scale: "toolbar.scale",
  };

  const playLabel: Record<PlayState, TKey> = {
    edit: "status.editing",
    playing: "status.playing",
    paused: "status.paused",
  };

  onMount(() => {
    bridge = new ViewportBridge(canvas, {
      onSelection: (id, additive) => store.select(id, additive),
      onTransformLive: (id, transform) => store.updateTransform(id, transform),
      onGizmoCommit: () => store.commit(),
      onFps: (fps) => store.setFps(fps),
      fetchAsset: async (path) => {
        const project = store.project;
        if (!project || !isTauri) return null;
        try {
          const b64 = await readProjectFileB64(project.root, path);
          return b64ToBytes(b64);
        } catch {
          return null;
        }
      },
    });
    // Give the runtime's api.camera control over this bridge's play camera.
    runtime.attachCamera(bridge);
    // Debug handle for QA from devtools (stripped from any production logic paths).
    (window as unknown as Record<string, unknown>).__lova = { store, bridge, runtime, buildExportHtml, createThirdPersonDemo };
    const ro = new ResizeObserver(() => bridge?.resize());
    ro.observe(container);
    return () => {
      ro.disconnect();
      bridge?.dispose();
      bridge = null;
    };
  });

  // store ─▶ Babylon sync (runes effects; `bridge` is $state so the first sync
  // happens as soon as the bridge exists).
  $effect(() => {
    bridge?.syncScene(store.scene);
  });
  $effect(() => {
    bridge?.setSelection(store.selectedIds);
  });
  $effect(() => {
    bridge?.setGizmoMode(store.gizmoMode);
  });
  $effect(() => {
    bridge?.setPlayState(store.playState);
  });

  /** F key — frame the selection. Called from App.svelte. */
  export function focusSelection(): void {
    bridge?.focusSelection(store.selectedIds);
  }
</script>

<div class="viewport-panel" bind:this={container}>
  <canvas bind:this={canvas}></canvas>

  {#if store.playState !== "edit"}
    <div class="play-badge" class:paused={store.playState === "paused"}>
      {#if store.playState === "playing"}<Icon name="play" size={12} />{:else}<Icon name="pause" size={12} />{/if}
      {t(playLabel[store.playState])}
    </div>
    {#if store.playHud}
      <div class="play-hud">{store.playHud}</div>
    {/if}
  {/if}

  <div class="viewport-overlay">
    <span class="vp-mode">{t(gizmoLabel[store.gizmoMode])}</span>
    <span class="vp-hint">{t("viewport.hint")}</span>
  </div>
</div>
