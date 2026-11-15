<script lang="ts">
  interface Props {
    value: string;
    disabled?: boolean;
    onInput: (v: string) => void;
    onCommit?: () => void;
  }

  let { value, disabled = false, onInput, onCommit }: Props = $props();
</script>

<div class="colorfield" class:disabled>
  <input
    type="color"
    {value}
    {disabled}
    oninput={(e) => onInput(e.currentTarget.value)}
    onchange={() => onCommit?.()}
  />
  <span class="hex">{value.toUpperCase()}</span>
</div>
