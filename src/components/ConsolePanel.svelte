<script lang="ts">
  import Icon from "./ui/Icon.svelte";
  import { store } from "../engine/sceneStore.svelte";
  import { t } from "../i18n/index.svelte";
  import type { LogKind } from "../engine/types";
  import type { TKey } from "../i18n/en";

  let filter = $state<"all" | LogKind>("all");
  let listEl: HTMLElement | undefined = $state();

  const shown = $derived(filter === "all" ? store.logs : store.logs.filter((l) => l.kind === filter));

  // Keep the latest entry in view.
  $effect(() => {
    void store.logs.length;
    listEl?.scrollTo({ top: listEl.scrollHeight });
  });

  const filters: Array<{ id: "all" | LogKind; label: TKey }> = [
    { id: "all", label: "console.all" },
    { id: "info", label: "console.info" },
    { id: "warn", label: "console.warn" },
    { id: "error", label: "console.error" },
  ];
</script>

<div class="panel console-panel">
  <div class="panel-header">
    <span>{t("panel.console")}</span>
    <div class="header-actions">
      {#each filters as f (f.id)}
        <button class="filter-btn" class:active={filter === f.id} onclick={() => (filter = f.id)}>
          {t(f.label)}
        </button>
      {/each}
      <button class="icon-btn" title={t("console.clear")} onclick={() => store.clearLogs()}>
        <Icon name="trash" size={12} />
      </button>
    </div>
  </div>

  <div class="console-list" bind:this={listEl}>
    {#each shown as entry (entry.id)}
      <div class="console-row {entry.kind}">
        <span class="console-time">{entry.time}</span>
        <span class="console-kind">{entry.kind}</span>
        <span class="console-text">{entry.text}</span>
      </div>
    {:else}
      <div class="empty">{t("console.empty")}</div>
    {/each}
  </div>
</div>
