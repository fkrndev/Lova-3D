<script lang="ts">
  import Icon from "./ui/Icon.svelte";
  import ColorField from "./ui/ColorField.svelte";
  import NumberField from "./ui/NumberField.svelte";
  import Vector3Field from "./ui/Vector3Field.svelte";
  import { store } from "../engine/sceneStore.svelte";
  import { t } from "../i18n/index.svelte";
  import {
    BEHAVIOR_KINDS,
    MESH_KINDS,
    LIGHT_KINDS,
    type Behavior,
    type BehaviorKind,
    type GameObject,
    type Vec3,
  } from "../engine/types";

  const selected = $derived.by(() => {
    const id = store.primarySelection;
    return id ? store.getObject(id) : undefined;
  });
  const editing = $derived(store.playState === "edit");

  let behaviorChoice = $state("");

  const SCRIPT_EXAMPLE = `// Lova 3D script — runs on Play.
// api: position, rotation (deg), scale, find(name), key(code), log(...)
let speed = 2;

function onStart() {
  api.log(api.name + " started");
}

function onUpdate(dt, t) {
  // Example: player controller
  // if (api.key("KeyA")) api.position = { ...api.position, x: api.position.x - speed * dt };
  // if (api.key("KeyD")) api.position = { ...api.position, x: api.position.x + speed * dt };

  // Example: float around the start position
  // api.position = { x: Math.cos(t * speed) * 2, y: 1 + Math.sin(t * 2) * 0.5, z: 0 };
}
`;

  // ── transform helpers ────────────────────────────────────────────────
  function setTransformPart(part: "position" | "rotation" | "scale", v: Vec3): void {
    const obj = selected;
    if (!obj) return;
    store.updateTransform(obj.id, { ...obj.transform, [part]: v });
    store.commitSoon();
  }

  function commitSoon(): void {
    store.commitSoon();
  }

  // ── behaviors ────────────────────────────────────────────────────────
  function addBehavior(kind: string): void {
    const obj = selected;
    if (obj && kind) store.addBehavior(obj.id, kind as BehaviorKind);
    behaviorChoice = "";
  }

  function behaviorParam(b: Behavior, key: string, v: number | Vec3): void {
    const obj = selected;
    if (!obj) return;
    store.patchBehavior(obj.id, b.id, { [key]: v } as Partial<Behavior>);
    store.commitSoon();
  }

  const typeLabel = (obj: GameObject): string =>
    obj.mesh ? t(`mesh.${obj.mesh.kind}`) : t(`light.${obj.light!.kind}`);
</script>

<div class="panel inspector-panel">
  <div class="panel-header">
    <span>{t("panel.inspector")}</span>
    {#if selected}
      <span class="header-obj">
        <Icon name={selected.mesh ? "cube" : "bulb"} size={12} />
        {typeLabel(selected)}
      </span>
    {/if}
  </div>

  <div class="inspector-body">
    {#if selected}
      <!-- ── Object ──────────────────────────────────────────────── -->
      <section class="isection">
        <h3>{t("inspector.object")}</h3>
        <label class="row">
          <span class="lbl">{t("inspector.name")}</span>
          <input
            type="text"
            class="text-input"
            value={selected.name}
            disabled={!editing}
            spellcheck="false"
            oninput={(e) => (selected.name = e.currentTarget.value)}
            onchange={() => store.commit()}
          />
        </label>
        <label class="row">
          <span class="lbl">{t("inspector.visible")}</span>
          <input
            type="checkbox"
            class="checkbox"
            checked={selected.visible}
            disabled={!editing}
            onchange={(e) => store.setVisible(selected.id, e.currentTarget.checked)}
          />
        </label>
      </section>

      <!-- ── Transform ───────────────────────────────────────────── -->
      <section class="isection">
        <h3>{t("inspector.transform")}</h3>
        <div class="row">
          <span class="lbl">{t("inspector.position")}</span>
          <Vector3Field
            value={selected.transform.position}
            step={0.1}
            disabled={!editing}
            onInput={(v) => setTransformPart("position", v)}
            onCommit={commitSoon}
          />
        </div>
        <div class="row">
          <span class="lbl">{t("inspector.rotation")}</span>
          <Vector3Field
            value={selected.transform.rotation}
            step={1}
            disabled={!editing}
            onInput={(v) => setTransformPart("rotation", v)}
            onCommit={commitSoon}
          />
        </div>
        <div class="row">
          <span class="lbl">{t("inspector.scale")}</span>
          <Vector3Field
            value={selected.transform.scale}
            step={0.1}
            min={0.01}
            disabled={!editing}
            onInput={(v) => setTransformPart("scale", v)}
            onCommit={commitSoon}
          />
        </div>
      </section>

      <!-- ── Mesh + Material ─────────────────────────────────────── -->
      {#if selected.mesh}
        <section class="isection">
          <h3>{t("inspector.mesh")}</h3>
          {#if selected.mesh.kind === "model"}
            <div class="row">
              <span class="lbl">{t("inspector.kind")}</span>
              <input type="text" class="text-input" value={selected.modelPath ?? ""} disabled title={selected.modelPath} />
            </div>
          {:else}
            <label class="row">
              <span class="lbl">{t("inspector.kind")}</span>
              <select
                class="select"
                value={selected.mesh.kind}
                disabled={!editing}
                onchange={(e) => store.patchMesh(selected.id, { kind: e.currentTarget.value as never })}
              >
                {#each MESH_KINDS as kind (kind)}
                  <option value={kind}>{t(`mesh.${kind}`)}</option>
                {/each}
              </select>
            </label>
          {/if}
        </section>

        {#if selected.material}
          <section class="isection">
            <h3>{t("inspector.material")}</h3>
            <div class="row">
              <span class="lbl">{t("inspector.color")}</span>
              <ColorField
                value={selected.material.color}
                disabled={!editing}
                onInput={(v) => store.patchMaterial(selected.id, { color: v })}
                onCommit={commitSoon}
              />
            </div>
            <div class="row">
              <span class="lbl">{t("inspector.emissive")}</span>
              <ColorField
                value={selected.material.emissive}
                disabled={!editing}
                onInput={(v) => store.patchMaterial(selected.id, { emissive: v })}
                onCommit={commitSoon}
              />
            </div>
            <div class="row">
              <span class="lbl">{t("inspector.metallic")}</span>
              <input
                type="range"
                class="range"
                min={0}
                max={1}
                step={0.05}
                value={selected.material.metallic}
                disabled={!editing}
                oninput={(e) => store.patchMaterial(selected.id, { metallic: Number(e.currentTarget.value) })}
                onchange={commitSoon}
              />
            </div>
            <div class="row">
              <span class="lbl">{t("inspector.roughness")}</span>
              <input
                type="range"
                class="range"
                min={0}
                max={1}
                step={0.05}
                value={selected.material.roughness}
                disabled={!editing}
                oninput={(e) => store.patchMaterial(selected.id, { roughness: Number(e.currentTarget.value) })}
                onchange={commitSoon}
              />
            </div>
            <label class="row">
              <span class="lbl">{t("inspector.wireframe")}</span>
              <input
                type="checkbox"
                class="checkbox"
                checked={selected.material.wireframe}
                disabled={!editing}
                onchange={(e) => store.patchMaterial(selected.id, { wireframe: e.currentTarget.checked })}
              />
            </label>
          </section>
        {/if}
      {/if}

      <!-- ── Light ───────────────────────────────────────────────── -->
      {#if selected.light}
        <section class="isection">
          <h3>{t("inspector.light")}</h3>
          <label class="row">
            <span class="lbl">{t("inspector.kind")}</span>
            <select
              class="select"
              value={selected.light.kind}
              disabled={!editing}
              onchange={(e) => store.patchLight(selected.id, { kind: e.currentTarget.value as never })}
            >
              {#each LIGHT_KINDS as kind (kind)}
                <option value={kind}>{t(`light.${kind}`)}</option>
              {/each}
            </select>
          </label>
          <div class="row">
            <span class="lbl">{t("inspector.intensity")}</span>
            <NumberField
              value={selected.light.intensity}
              step={0.1}
              min={0}
              max={10}
              precision={2}
              disabled={!editing}
              onInput={(v) => store.patchLight(selected.id, { intensity: v })}
              onCommit={commitSoon}
            />
          </div>
          <div class="row">
            <span class="lbl">{t("inspector.diffuse")}</span>
            <ColorField
              value={selected.light.diffuse}
              disabled={!editing}
              onInput={(v) => store.patchLight(selected.id, { diffuse: v })}
              onCommit={commitSoon}
            />
          </div>
          {#if selected.light.kind === "spot"}
            <div class="row">
              <span class="lbl">{t("inspector.angle")}</span>
              <NumberField
                value={selected.light.angleDeg}
                step={1}
                min={1}
                max={179}
                precision={1}
                disabled={!editing}
                onInput={(v) => store.patchLight(selected.id, { angleDeg: v })}
                onCommit={commitSoon}
              />
            </div>
            <div class="row">
              <span class="lbl">{t("inspector.exponent")}</span>
              <NumberField
                value={selected.light.exponent}
                step={0.5}
                min={0}
                max={128}
                precision={1}
                disabled={!editing}
                onInput={(v) => store.patchLight(selected.id, { exponent: v })}
                onCommit={commitSoon}
              />
            </div>
          {/if}
        </section>
      {/if}

      <!-- ── Behaviors ───────────────────────────────────────────── -->
      <section class="isection">
        <h3>{t("inspector.behaviors")}</h3>

        {#each selected.behaviors as b (b.id)}
          <div class="behavior-card">
            <div class="behavior-head">
              <label class="inline-check">
                <input
                  type="checkbox"
                  class="checkbox"
                  checked={b.enabled}
                  disabled={!editing}
                  onchange={(e) => store.patchBehavior(selected.id, b.id, { enabled: e.currentTarget.checked })}
                />
                <span>{t(`behavior.${b.kind}`)}</span>
              </label>
              <button
                class="icon-btn danger"
                title={t("inspector.remove")}
                disabled={!editing}
                onclick={() => store.removeBehavior(selected.id, b.id)}
              >
                <Icon name="x" size={11} />
              </button>
            </div>

            {#if b.kind === "spin"}
              <div class="row">
                <span class="lbl">{t("inspector.speed")} °/s</span>
                <Vector3Field
                  value={b.speed}
                  step={5}
                  disabled={!editing}
                  onInput={(v) => behaviorParam(b, "speed", v)}
                  onCommit={commitSoon}
                />
              </div>
            {:else if b.kind === "bob"}
              <div class="row">
                <span class="lbl">{t("inspector.amplitude")}</span>
                <NumberField
                  value={b.amplitude}
                  step={0.05}
                  min={0}
                  precision={2}
                  disabled={!editing}
                  onInput={(v) => behaviorParam(b, "amplitude", v)}
                  onCommit={commitSoon}
                />
              </div>
              <div class="row">
                <span class="lbl">{t("inspector.speed")}</span>
                <NumberField
                  value={b.speed}
                  step={0.1}
                  min={0}
                  precision={2}
                  disabled={!editing}
                  onInput={(v) => behaviorParam(b, "speed", v)}
                  onCommit={commitSoon}
                />
              </div>
            {:else if b.kind === "orbit"}
              <div class="row">
                <span class="lbl">{t("inspector.radius")}</span>
                <NumberField
                  value={b.radius}
                  step={0.1}
                  min={0}
                  precision={2}
                  disabled={!editing}
                  onInput={(v) => behaviorParam(b, "radius", v)}
                  onCommit={commitSoon}
                />
              </div>
              <div class="row">
                <span class="lbl">{t("inspector.speed")} °/s</span>
                <NumberField
                  value={b.speed}
                  step={5}
                  precision={1}
                  disabled={!editing}
                  onInput={(v) => behaviorParam(b, "speed", v)}
                  onCommit={commitSoon}
                />
              </div>
            {/if}
          </div>
        {:else}
          <div class="empty small">{t("inspector.behaviorNone")}</div>
        {/each}

        {#if editing}
          <select class="select" value={behaviorChoice} onchange={(e) => addBehavior(e.currentTarget.value)}>
            <option value="">{t("inspector.addBehavior")}</option>
            {#each BEHAVIOR_KINDS as kind (kind)}
              <option value={kind}>{t(`behavior.${kind}`)}</option>
            {/each}
          </select>
        {/if}
      </section>

      <!-- ── Physics ─────────────────────────────────────────────── -->
      {#if selected.mesh}
        <section class="isection">
          <h3>{t("inspector.physics")}</h3>
          <label class="row">
            <span class="lbl">{t("inspector.kind")}</span>
            <select
              class="select"
              value={selected.physics?.type ?? "none"}
              disabled={!editing}
              onchange={(e) => {
                const v = e.currentTarget.value;
                if (v === "none") store.removePhysics(selected.id);
                else store.setPhysics(selected.id, v as "static" | "dynamic");
              }}
            >
              <option value="none">{t("physics.none")}</option>
              <option value="static">{t("physics.static")}</option>
              <option value="dynamic">{t("physics.dynamic")}</option>
            </select>
          </label>

          {#if selected.physics}
            <div class="row">
              <span class="lbl">{t("physics.bounce")}</span>
              <NumberField
                value={selected.physics.bounce}
                step={0.05}
                min={0}
                max={1}
                precision={2}
                disabled={!editing}
                onInput={(v) => store.patchPhysics(selected.id, { bounce: v })}
                onCommit={commitSoon}
              />
            </div>
            <div class="row">
              <span class="lbl">{t("physics.gravityScale")}</span>
              <NumberField
                value={selected.physics.gravityScale}
                step={0.1}
                min={-2}
                max={3}
                precision={2}
                disabled={!editing}
                onInput={(v) => store.patchPhysics(selected.id, { gravityScale: v })}
                onCommit={commitSoon}
              />
            </div>
            <div class="row">
              <span class="lbl">{t("physics.velocity")}</span>
              <Vector3Field
                value={selected.physics.velocity}
                step={0.1}
                disabled={!editing}
                onInput={(v) => store.patchPhysics(selected.id, { velocity: v })}
                onCommit={commitSoon}
              />
            </div>
          {/if}
        </section>
      {/if}

      <!-- ── Sensor ───────────────────────────────────────────────── -->
      <section class="isection">
        <h3>{t("inspector.sensor")}</h3>
        <label class="row">
          <span class="lbl">{t("inspector.enabled")}</span>
          <input
            type="checkbox"
            class="checkbox"
            checked={!!selected.sensor}
            disabled={!editing}
            onchange={(e) => store.setSensor(selected.id, e.currentTarget.checked)}
          />
        </label>
        {#if selected.sensor}
          <div class="row">
            <span class="lbl">{t("inspector.sensorRadius")}</span>
            <NumberField
              value={selected.sensor.radius}
              step={0.1}
              min={0.05}
              precision={2}
              disabled={!editing}
              onInput={(v) => store.patchSensor(selected.id, { radius: v })}
              onCommit={commitSoon}
            />
          </div>
          <p class="script-hint">{t("inspector.sensorHint")}</p>
        {/if}
      </section>

      <!-- ── Script ──────────────────────────────────────────────── -->
      <section class="isection">
        <h3>{t("inspector.script")}</h3>
        <textarea
          class="script-editor"
          rows={10}
          spellcheck="false"
          placeholder={t("script.placeholder")}
          disabled={!editing}
          oninput={(e) => store.setScript(selected.id, e.currentTarget.value)}
         >{selected.script ?? ""}</textarea
        >
        <div class="script-actions">
          <button
            class="mini-btn"
            disabled={!editing}
            onclick={() => store.setScript(selected.id, SCRIPT_EXAMPLE)}
          >
            {t("script.example")}
          </button>
        </div>
        <p class="script-hint">{t("script.hint")}</p>
      </section>
    {:else}
      <!-- ── Environment (no selection) ──────────────────────────── -->
      <section class="isection">
        <h3>{t("inspector.environment")}</h3>
        <label class="row">
          <span class="lbl">{t("inspector.sceneName")}</span>
          <input
            type="text"
            class="text-input"
            value={store.scene.name}
            disabled={!editing}
            spellcheck="false"
            oninput={(e) => store.setSceneName(e.currentTarget.value)}
          />
        </label>
        <div class="row">
          <span class="lbl">{t("inspector.background")}</span>
          <ColorField
            value={store.scene.environment.background}
            disabled={!editing}
            onInput={(v) => store.setEnvironment({ background: v })}
          />
        </div>
        <div class="row">
          <span class="lbl">{t("inspector.ambient")}</span>
          <input
            type="range"
            class="range"
            min={0}
            max={2}
            step={0.05}
            value={store.scene.environment.ambient}
            disabled={!editing}
            oninput={(e) => store.setEnvironment({ ambient: Number(e.currentTarget.value) })}
          />
        </div>
      </section>
      <div class="empty">{t("inspector.selectHint")}</div>
    {/if}
  </div>
</div>
