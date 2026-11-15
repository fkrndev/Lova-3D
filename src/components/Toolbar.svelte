<script lang="ts">
  import Icon from "./ui/Icon.svelte";
  import { store } from "../engine/sceneStore.svelte";
  import {
    newSceneAction,
    openSceneAction,
    saveSceneAction,
    saveAsSceneAction,
    exportHtmlAction,
  } from "../engine/actions";
  import { i18n, t, type Locale } from "../i18n/index.svelte";
  import { LIGHT_KINDS, MESH_KINDS } from "../engine/types";

  let addOpen = $state(false);

  const editing = $derived(store.playState === "edit");

  function toggleAdd() {
    addOpen = !addOpen;
  }

  function onGlobalPointerDown(e: PointerEvent) {
    if (addOpen && !(e.target as HTMLElement).closest(".add-menu")) addOpen = false;
  }

  function setMode(mode: "position" | "rotation" | "scale") {
    if (editing) store.gizmoMode = mode;
  }
</script>

<svelte:window onpointerdown={onGlobalPointerDown} />

<div class="toolbar">
  <div class="brand">
    <span class="brand-heart"><Icon name="heart" size={16} /></span>
    <span class="brand-name">{t("app.name")}</span>
    <span class="brand-version">v0.1</span>
  </div>

  <div class="tgroup">
    <button class="tbtn" title={t("toolbar.new")} onclick={() => newSceneAction()}>
      <Icon name="new" />
    </button>
    <button class="tbtn" title={t("toolbar.open")} onclick={() => openSceneAction()}>
      <Icon name="open" />
    </button>
    <button class="tbtn" title={t("toolbar.save")} onclick={() => saveSceneAction()} disabled={!editing}>
      <Icon name="save" />
    </button>
    <button class="tbtn" title={t("toolbar.export")} onclick={() => exportHtmlAction()} disabled={!editing}>
      <Icon name="export" />
    </button>
  </div>

  <div class="tgroup add-menu">
    <button class="tbtn wide" onclick={toggleAdd} disabled={!editing}>
      <Icon name="plus" />
      <span>{t("toolbar.add")}</span>
    </button>
    {#if addOpen}
      <div class="dropdown">
        <div class="dropdown-group">{t("toolbar.meshes")}</div>
        {#each MESH_KINDS as kind (kind)}
          <button class="dropdown-item" onclick={() => { store.addMesh(kind); addOpen = false; }}>
            <Icon name="cube" size={13} />
            <span>{t(`mesh.${kind}`)}</span>
          </button>
        {/each}
        <div class="dropdown-group">{t("toolbar.lights")}</div>
        {#each LIGHT_KINDS as kind (kind)}
          <button class="dropdown-item" onclick={() => { store.addLight(kind); addOpen = false; }}>
            <Icon name="bulb" size={13} />
            <span>{t(`light.${kind}`)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="tgroup">
    <button
      class="tbtn"
      title={t("toolbar.play")}
      onclick={() => store.play()}
      disabled={store.playState === "playing"}
    >
      <Icon name="play" />
    </button>
    <button
      class="tbtn"
      title={t("toolbar.pause")}
      onclick={() => store.pause()}
      disabled={store.playState !== "playing"}
    >
      <Icon name="pause" />
    </button>
    <button
      class="tbtn"
      title={t("toolbar.stop")}
      onclick={() => store.stop()}
      disabled={store.playState === "edit"}
    >
      <Icon name="stop" />
    </button>
  </div>

  {#if editing}
    <div class="tgroup seg">
      <button class="tbtn" class:active={store.gizmoMode === "position"} title={t("toolbar.move")} onclick={() => setMode("position")}>
        <Icon name="move" />
      </button>
      <button class="tbtn" class:active={store.gizmoMode === "rotation"} title={t("toolbar.rotate")} onclick={() => setMode("rotation")}>
        <Icon name="rotate" />
      </button>
      <button class="tbtn" class:active={store.gizmoMode === "scale"} title={t("toolbar.scale")} onclick={() => setMode("scale")}>
        <Icon name="scale" />
      </button>
    </div>

    <div class="tgroup">
      <button class="tbtn" title={t("log.undo")} onclick={() => store.undo()} disabled={!store.canUndo}>
        <Icon name="undo" />
      </button>
      <button class="tbtn" title={t("log.redo")} onclick={() => store.redo()} disabled={!store.canRedo}>
        <Icon name="redo" />
      </button>
    </div>
  {/if}

  <div class="spacer"></div>

  <div class="tgroup">
    <select
      class="locale-select"
      value={i18n.locale}
      onchange={(e) => i18n.set(e.currentTarget.value as Locale)}
      title="Language / Bahasa"
      aria-label="Language"
    >
      <option value="en">English</option>
      <option value="id">Bahasa Indonesia</option>
    </select>
  </div>

  <div class="fps-chip" title={t("status.fps")}>{store.fps} FPS</div>
</div>
