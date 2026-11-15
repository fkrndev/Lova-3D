<script lang="ts">
  import Icon from "./ui/Icon.svelte";
  import { store } from "../engine/sceneStore.svelte";
  import { t } from "../i18n/index.svelte";
  import type { GameObject } from "../engine/types";

  let search = $state("");
  let renamingId = $state<string | null>(null);
  let renameDraft = $state("");
  let collapsed = $state<Set<string>>(new Set());
  let dragId = $state<string | null>(null);
  let dragOverId = $state<string | null>(null);

  interface Row {
    obj: GameObject;
    depth: number;
    hasChildren: boolean;
  }

  const rows = $derived.by(() => {
    const objects = store.scene.objects;
    const q = search.trim().toLowerCase();
    if (q !== "") {
      // Search shows a flat list of matches.
      return objects
        .filter((o) => o.name.toLowerCase().includes(q))
        .map<Row>((obj) => ({ obj, depth: 0, hasChildren: false }));
    }

    const childrenOf = new Map<string | null, GameObject[]>();
    for (const o of objects) {
      const key = o.parentId && objects.some((p) => p.id === o.parentId) ? o.parentId : null;
      const list = childrenOf.get(key) ?? [];
      list.push(o);
      childrenOf.set(key, list);
    }

    const out: Row[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const obj of childrenOf.get(parent) ?? []) {
        const kids = childrenOf.get(obj.id) ?? [];
        out.push({ obj, depth, hasChildren: kids.length > 0 });
        if (kids.length > 0 && !collapsed.has(obj.id)) walk(obj.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
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

  function toggleCollapse(e: MouseEvent, id: string) {
    e.stopPropagation();
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    collapsed = next;
  }

  // ── drag & drop reparenting ───────────────────────────────────────────
  function onDragStart(e: DragEvent, id: string) {
    dragId = id;
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(e: DragEvent, id: string | null) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dragOverId = id;
  }

  function onDrop(e: DragEvent, id: string | null) {
    e.preventDefault();
    e.stopPropagation();
    const dragged = dragId ?? e.dataTransfer?.getData("text/plain") ?? null;
    dragId = null;
    dragOverId = null;
    if (dragged) store.reparent(dragged, id);
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

  <div
    class="tree"
    role="tree"
    tabindex={-1}
    ondragover={(e) => onDragOver(e, null)}
    ondrop={(e) => onDrop(e, null)}
    ondragleave={() => (dragOverId = null)}
  >
    {#each rows as row (row.obj.id)}
      {@const obj = row.obj}
      <div
        class="tree-row"
        class:selected={store.isSelected(obj.id)}
        class:dimmed={!obj.visible}
        class:drop-target={dragOverId === obj.id}
        role="treeitem"
        aria-selected={store.isSelected(obj.id)}
        tabindex={-1}
        style={`padding-left:${6 + row.depth * 14}px`}
        draggable={renamingId === null}
        ondragstart={(e) => onDragStart(e, obj.id)}
        ondragover={(e) => onDragOver(e, obj.id)}
        ondrop={(e) => onDrop(e, obj.id)}
        onclick={(e) => rowClick(e, obj.id)}
        ondblclick={() => startRename(obj.id, obj.name)}
        onkeydown={(e) => {
          if (e.key === "Enter") store.select(obj.id, e.ctrlKey || e.shiftKey);
        }}
      >
        <button
          class="chevron"
          class:hidden={!row.hasChildren}
          class:collapsed={collapsed.has(obj.id)}
          title={t("hierarchy.toggle")}
          onclick={(e) => toggleCollapse(e, obj.id)}
        >
          <Icon name="chevron" size={12} />
        </button>

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
          {#if obj.behaviors.length > 0 || obj.script}
            <span class="behavior-dot" title={t("inspector.behaviors")}><Icon name="bolt" size={10} /></span>
          {/if}
          {#if obj.physics}
            <span class="physics-dot" title={t("inspector.physics")}>◦</span>
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
