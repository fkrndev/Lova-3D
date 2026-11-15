<script lang="ts">
  import Icon from "./ui/Icon.svelte";
  import { store } from "../engine/sceneStore.svelte";
  import { importAssetAction, newProjectAction, openProjectAction, refreshProjectAction } from "../engine/actions";
  import { isTauri, readProjectFileB64 } from "../engine/io";
  import { t } from "../i18n/index.svelte";
  import type { AssetInfo } from "../engine/types";

  /** Lazy thumbnail cache: asset id → data URL. */
  const thumbs = new Map<string, string>();

  async function thumbOf(asset: AssetInfo): Promise<string | null> {
    if (!asset.thumb) return null;
    const cached = thumbs.get(asset.id);
    if (cached) return cached;
    if (!isTauri || !store.project) return null;
    try {
      const b64 = await readProjectFileB64(store.project.root, asset.thumb);
      const url = `data:image/png;base64,${b64}`;
      thumbs.set(asset.id, url);
      return url;
    } catch {
      return null;
    }
  }

  const usedPaths = $derived(new Set(store.scene.objects.map((o) => o.modelPath).filter(Boolean)));

  function assetIcon(kind: string): string {
    return kind === "models" ? "cube" : kind === "textures" ? "image" : "audio";
  }

  function formatBytes(bytes: number): string {
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  }

  function addModel(path: string): void {
    if (store.playState === "edit") store.addModel(path);
  }
</script>

<div class="asset-browser">
  <div class="assets-header">
    <span class="assets-title">{t("assets.title")}</span>
    {#if store.project}
      <span class="assets-project" title={store.project.root}>{store.project.name}</span>
      <span class="count">{store.project.assets.length}</span>
    {/if}
    <span class="spacer"></span>
    {#if store.project}
      <button class="mini-btn" title={t("assets.importModel")} onclick={() => importAssetAction("models")}>
        <Icon name="cube" size={11} /> {t("assets.importModel")}
      </button>
      <button class="mini-btn" title={t("assets.importTexture")} onclick={() => importAssetAction("textures")}>
        {t("assets.importTexture")}
      </button>
      <button class="mini-btn" title={t("assets.importAudio")} onclick={() => importAssetAction("audio")}>
        {t("assets.importAudio")}
      </button>
      <button class="icon-btn" title={t("assets.refresh")} onclick={() => refreshProjectAction()}>
        <Icon name="rotate" size={12} />
      </button>
    {/if}
  </div>

  <div class="assets-grid-wrap">
    {#if !store.project}
      <div class="assets-empty">
        <p>{t("assets.needProject")}</p>
        <div class="assets-empty-actions">
          <button class="mini-btn" disabled={!isTauri} onclick={() => newProjectAction()}>{t("project.new")}</button>
          <button class="mini-btn" disabled={!isTauri} onclick={() => openProjectAction()}>{t("project.open")}</button>
        </div>
      </div>
    {:else if store.project.assets.length === 0}
      <div class="assets-empty">{t("assets.empty")}</div>
    {:else}
      <div class="assets-grid">
        {#each store.project.assets as asset (asset.id)}
          {@const used = usedPaths.has(asset.path)}
          <button
            class="asset-card"
            class:used
            title={asset.path}
            onclick={() => asset.kind === "models" && addModel(asset.path)}
          >
            <span class="asset-thumb">
              {#await thumbOf(asset)}
                <Icon name={assetIcon(asset.kind)} size={22} />
              {:then url}
                {#if url}<img src={url} alt={asset.path} draggable="false" />{:else}<Icon name={assetIcon(asset.kind)} size={22} />{/if}
              {/await}
            </span>
            <span class="asset-name">{asset.path.split("/").pop()}</span>
            <span class="asset-meta">{formatBytes(asset.bytes)}</span>
            {#if asset.kind === "models"}
              {#if used}<span class="used-badge">{t("assets.used")}</span>{/if}
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
