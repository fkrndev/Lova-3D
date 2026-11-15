<script lang="ts">
  /**
   * Drag-scrub numeric field: drag horizontally to scrub (Shift = fine),
   * double-click or Tab to type, Enter/blur to commit.
   */
  interface Props {
    value: number;
    step?: number;
    precision?: number;
    min?: number;
    max?: number;
    disabled?: boolean;
    onInput: (v: number) => void;
    onCommit?: () => void;
  }

  let {
    value,
    step = 0.1,
    precision = 2,
    min = -Infinity,
    max = Infinity,
    disabled = false,
    onInput,
    onCommit,
  }: Props = $props();

  let el: HTMLInputElement | undefined = $state();
  let typing = $state(false);
  let dragging = $state(false);
  let startX = 0;
  let startValue = 0;

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const round = (v: number) => Number(v.toFixed(precision));
  const display = () => value.toFixed(precision);

  function down(e: PointerEvent) {
    if (disabled || typing || document.activeElement === el) return;
    dragging = true;
    startX = e.clientX;
    startValue = value;
    el?.setPointerCapture(e.pointerId);
    e.preventDefault(); // keep focus out — this drag is a scrub, not an edit
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    const mult = e.shiftKey ? 0.2 : 1;
    const v = round(clamp(startValue + (e.clientX - startX) * step * mult));
    if (v !== value) onInput(v);
  }

  function up() {
    if (!dragging) return;
    dragging = false;
    onCommit?.();
  }

  function onFocus() {
    typing = true;
    el?.select();
  }

  function onBlur(e: FocusEvent) {
    const raw = (e.target as HTMLInputElement).value;
    const v = parseFloat(raw.replace(",", "."));
    if (Number.isFinite(v)) {
      const r = round(clamp(v));
      if (r !== value) {
        onInput(r);
        onCommit?.();
        return;
      }
    }
    if (el) el.value = display();
    typing = false;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      el?.blur();
    } else if (e.key === "Escape") {
      if (el) el.value = display();
      el?.blur();
    }
  }
</script>

<input
  bind:this={el}
  class="numfield"
  class:dragging
  class:scrubbing={dragging}
  type="text"
  inputmode="decimal"
  spellcheck="false"
  {disabled}
  {...(typing ? {} : { value: display() })}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onfocus={onFocus}
  onblur={onBlur}
  onkeydown={onKeydown}
  ondblclick={() => el?.focus()}
/>
