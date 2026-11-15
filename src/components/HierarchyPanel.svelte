<script lang="ts">
  import Icon from "./ui/Icon.svelte";
  import { store } from "../engine/sceneStore.svelte";
  import { t } from "../i18n/index.svelte";

  let search = $state("");
  let renamingId = $state<string | null>(null);
  let renameDraft = $state("");

  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (q === "") return store.scene.objects;
    return store.scene.objects.filter((o) => o.name.toLowerCase().includes(q));
  });

  function startRename(id: string, name: string) {
    renamingId = id;
    renameDraft = name;
  }

  function commitRename() {
    if (renamingId) store.rename(renamingId, renameDraft);
    renamingId = null;
  }

  function renameKey(e: KeyboardEvent) {
    if (e.key === "Enter") commitRename();
    else if (e.key === "Escape") renamingId = null;
  }

  function rowClick(e: MouseEvent, id: string) {
    store.select(id, e.ctrlKey || e.metaKey || e.shiftKey);
  }

  // Focus + select the rename input's text once it appears.
  const autofocus = (el: HTMLInputElement) => {
    requestAnimationFrame(() => {
      el.focus();
      el.select();
    });
  };
</script>

<div class="panel hierarchy-panel">
  <div class="panel-header">
    <span>{t("panel.hierarchy")}</span>
    <span class="count">{store.scene.objects.length}</span>
  </div>

  <div class="search-row">
    <Icon name="search" size={12} />
    <input type="text" placeholder={t("hierarchy.search")} bind:value={search} spellcheck="false" />
  </div>

  <div class="tree">
    {#each filtered as obj (obj.id)}
      <div
        class="tree-row"
        role="treeitem"
        tabindex={-1}
        aria-selected={store.isSelected(obj.id)}
        class:selected={store.isSelected(obj.id)}
        class:dimmed={!obj.visible}
        onclick={(e) => rowClick(e, obj.id)}
        ondblclick={() => startRename(obj.id, obj.name)}
        onkeydown={(e) => {
          if (e.key === "Enter") store.select(obj.id, e.ctrlKey || e.shiftKey);
        }}
      >
        <span class="tree-icon">
          {#if obj.mesh}<Icon name="cube" size={13} />{:else}<Icon name="bulb" size={13} />{/if}
        </span>

        {#if renamingId === obj.id}
          <input
            class="rename-input"
            use:autofocus
            bind:value={renameDraft}
            onblur={commitRename}
            onkeydown={renameKey}
            onclick={(e) => e.stopPropagation()}
          />
        {:else}
          <span class="tree-name">{obj.name}</span>
          {#if obj.behaviors.length > 0}
            <span class="behavior-dot" title={t("inspector.behaviors")}><Icon name="bolt" size={10} /></span>
          {/if}
        {/if}

        <span class="spacer"></span>

        <button
          class="icon-btn"
          title={t("inspector.visible")}
          disabled={store.playState !== "edit"}
          onclick={(e) => {
            e.stopPropagation();
            store.setVisible(obj.id, !obj.visible);
          }}
        >
          <Icon name={obj.visible ? "eye" : "eyeOff"} size={13} />
        </button>

        <button
          class="icon-btn danger"
          title={t("hierarchy.delete")}
          disabled={store.playState !== "edit"}
          onclick={(e) => {
            e.stopPropagation();
            store.select(obj.id);
            store.removeSelected();
          }}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    {:else}
      <div class="empty">{t("hierarchy.empty")}</div>
    {/each}
  </div>
</div>
