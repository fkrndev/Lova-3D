<script lang="ts">
  import { Engine } from "@babylonjs/core";
  import { store } from "../engine/sceneStore.svelte";
  import { t } from "../i18n/index.svelte";
  import type { PlayState } from "../engine/types";
  import type { TKey } from "../i18n/en";

  const playLabel: Record<PlayState, TKey> = {
    edit: "status.editing",
    playing: "status.playing",
    paused: "status.paused",
  };
</script>

<div class="statusbar">
  <div class="sb-group">
    <span>{store.scene.objects.length} {t("status.objects")}</span>
    <span class="sep">·</span>
    <span>{store.selectedIds.length} {t("status.selected")}</span>
    <span class="sep">·</span>
    <span class="play-state {store.playState}">{t(playLabel[store.playState])}</span>
  </div>

  <div class="sb-group">
    {#if store.dirty}
      <span class="dirty-dot" title={t("status.unsaved")}></span>
      <span class="dirty">{t("status.unsaved")}</span>
      <span class="sep">·</span>
    {/if}
    {#if store.currentPath}
      <span class="path" title={store.currentPath}>{store.currentPath}</span>
      <span class="sep">·</span>
    {/if}
    <span>WebGL2 · Babylon.js {Engine.Version}</span>
  </div>
</div>
