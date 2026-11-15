<script lang="ts">
  import NumberField from "./NumberField.svelte";
  import type { Vec3 } from "../../engine/types";

  interface Props {
    value: Vec3;
    step?: number;
    min?: number;
    max?: number;
    disabled?: boolean;
    onInput: (v: Vec3) => void;
    onCommit?: () => void;
  }

  let { value, step = 0.1, min, max, disabled = false, onInput, onCommit }: Props = $props();

  const axes = [
    { key: "x", label: "X", cls: "ax-x" },
    { key: "y", label: "Y", cls: "ax-y" },
    { key: "z", label: "Z", cls: "ax-z" },
  ] as const;
</script>

<div class="vec3">
  {#each axes as a (a.key)}
    <span class="axis {a.cls}">{a.label}</span>
    <NumberField
      value={value[a.key]}
      {step}
      {min}
      {max}
      {disabled}
      onInput={(v) => onInput({ ...value, [a.key]: v })}
      {onCommit}
    />
  {/each}
</div>
