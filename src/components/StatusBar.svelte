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

  const playColor: Record<PlayState, string> = {
    edit: "text-muted",
    playing: "text-ok",
    paused: "text-warn",
  };
</script>

<div class="flex h-7 items-center justify-between gap-4 border-t border-border bg-bg1 px-3 text-[11.5px] text-muted">
  <div class="flex min-w-0 items-center gap-2">
    <span>{store.scene.objects.length} {t("status.objects")}</span>
    <span class="text-faint">·</span>
    <span>{store.selectedIds.length} {t("status.selected")}</span>
    <span class="text-faint">·</span>
    <span class="font-semibold {playColor[store.playState]}">{t(playLabel[store.playState])}</span>
  </div>

  <div class="flex min-w-0 items-center gap-2">
    {#if store.dirty}
      <span class="size-[7px] shrink-0 rounded-full bg-accent" title={t("status.unsaved")}></span>
      <span class="text-accent">{t("status.unsaved")}</span>
      <span class="text-faint">·</span>
    {/if}
    {#if store.currentPath}
      <span class="max-w-[380px] truncate font-mono" title={store.currentPath}>{store.currentPath}</span>
      <span class="text-faint">·</span>
    {/if}
    <span>WebGL2 · Babylon.js {Engine.Version}</span>
  </div>
</div>
