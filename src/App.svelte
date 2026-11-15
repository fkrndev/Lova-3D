<script lang="ts">
  import { onMount } from "svelte";
  import ConsolePanel from "./components/ConsolePanel.svelte";
  import HierarchyPanel from "./components/HierarchyPanel.svelte";
  import InspectorPanel from "./components/InspectorPanel.svelte";
  import StatusBar from "./components/StatusBar.svelte";
  import Toolbar from "./components/Toolbar.svelte";
  import ViewportPanel from "./components/ViewportPanel.svelte";
  import { newSceneAction, openSceneAction, saveAsSceneAction, saveSceneAction } from "./engine/actions";
  import { store } from "./engine/sceneStore.svelte";
  import { isTauri } from "./engine/io";
  import { t } from "./i18n/index.svelte";

  let viewportPanel: ViewportPanel;

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      // During play mode the keyboard belongs to game scripts.
      if (store.playState !== "edit") return;
      const target = e.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if (typing) return;

      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (ctrl && key === "z") {
        e.preventDefault();
        e.shiftKey ? store.redo() : store.undo();
      } else if (ctrl && key === "y") {
        e.preventDefault();
        store.redo();
      } else if (ctrl && key === "d") {
        e.preventDefault();
        store.duplicateSelected();
      } else if (ctrl && key === "s") {
        e.preventDefault();
        e.shiftKey ? saveAsSceneAction() : saveSceneAction();
      } else if (ctrl && key === "o") {
        e.preventDefault();
        openSceneAction();
      } else if (!ctrl && key === "w") {
        store.gizmoMode = "position";
      } else if (!ctrl && key === "e") {
        store.gizmoMode = "rotation";
      } else if (!ctrl && key === "r") {
        store.gizmoMode = "scale";
      } else if (key === "f") {
        viewportPanel?.focusSelection();
      } else if (key === "delete" || key === "backspace") {
        store.removeSelected();
      } else if (key === "escape") {
        store.select(null);
      }
    };

    window.addEventListener("keydown", onKeydown);

    // Native close guard: confirm before losing unsaved work.
    let unlistenClose: (() => void) | undefined;
    if (isTauri) {
      void (async () => {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { ask } = await import("@tauri-apps/plugin-dialog");
        const win = getCurrentWindow();
        unlistenClose = await win.onCloseRequested(async (ev) => {
          if (!store.dirty) return;
          ev.preventDefault();
          const ok = await ask(t("confirm.close"), { title: "Lova 3D" });
          if (ok) await win.destroy();
        });
      })();
    }

    return () => {
      window.removeEventListener("keydown", onKeydown);
      unlistenClose?.();
    };
  });
</script>

<div class="app">
  <Toolbar />
  <div class="main">
    <HierarchyPanel />
    <div class="center">
      <ViewportPanel bind:this={viewportPanel} />
      <ConsolePanel />
    </div>
    <InspectorPanel />
  </div>
  <StatusBar />
</div>
