<script lang="ts">
  /**
   * Inline SVG icon set (16×16, stroke-based) so the editor ships without an
   * icon font/library dependency.
   */
  const icons: Record<string, string> = {
    new: `<path d="M9 2.5H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5"/><path d="M9 2.5V6h3.5"/><rect x="9.5" y="9" width="5" height="5" rx="0.8"/><path d="M12 10.5v2M11 11.5h2"/>`,
    open: `<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>`,
    save: `<path d="M3 3.5h8L13 5.5v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M5 3.5v3h5v-3"/><rect x="5" y="8.5" width="6" height="4"/>`,
    undo: `<path d="M3.5 6.5H10a3.5 3.5 0 0 1 0 7H7"/><path d="M6 3 3 6.5 6 10"/>`,
    redo: `<path d="M12.5 6.5H6a3.5 3.5 0 0 0 0 7h3"/><path d="M10 3l3 3.5L10 10"/>`,
    play: `<path d="M5 3.2v9.6L13 8z" fill="currentColor" stroke="none"/>`,
    pause: `<path d="M5.5 3.5v9M10.5 3.5v9"/>`,
    stop: `<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>`,
    move: `<path d="M8 1.5v13M1.5 8h13"/><path d="M8 1.5 6.7 2.8M8 1.5l1.3 1.3M8 14.5l-1.3-1.3M8 14.5l1.3-1.3M1.5 8l1.3-1.3M1.5 8l1.3 1.3M14.5 8l-1.3-1.3M14.5 8l-1.3 1.3"/>`,
    rotate: `<path d="M13.2 8A5.2 5.2 0 1 1 11 3.8"/><path d="M13.5 2.5V6h-3.5"/>`,
    scale: `<rect x="2.5" y="2.5" width="6.5" height="6.5" rx="0.5"/><path d="M9.5 6.5 13 3M13 3h-2.6M13 3v2.6"/><path d="M6.5 9.5 3 13M3 13h2.6M3 13v-2.6"/>`,
    plus: `<path d="M8 3v10M3 8h10"/>`,
    trash: `<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8"/><path d="M6.8 7v4.5M9.2 7v4.5"/>`,
    eye: `<path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>`,
    eyeOff: `<path d="M3 13 13 3"/><path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z"/>`,
    cube: `<path d="M8 1.5 14 4.5v7L8 14.5 2 11.5v-7z"/><path d="M2 4.5 8 7.5 14 4.5M8 7.5v7"/>`,
    bulb: `<path d="M8 2a4 4 0 0 1 2.5 7.1c-.5.4-.8 1-.8 1.6H6.3c0-.6-.3-1.2-.8-1.6A4 4 0 0 1 8 2z"/><path d="M6.5 13.5h3M7 15h2"/>`,
    bolt: `<path d="M9 1.5 3.5 9H7l-1 5.5L11.5 7H8z"/>`,
    heart: `<path d="M8 13.5C4.5 11 2 8.8 2 6.2 2 4.4 3.4 3 5.1 3 6.3 3 7.4 3.7 8 4.7 8.6 3.7 9.7 3 10.9 3 12.6 3 14 4.4 14 6.2c0 2.6-2.5 4.8-6 7.3z" fill="currentColor" stroke="none"/>`,
    globe: `<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c-2.5 2.5-2.5 9.5 0 12M8 2c2.5 2.5 2.5 9.5 0 12"/>`,
    duplicate: `<rect x="6" y="6" width="8" height="8" rx="1"/><path d="M10 3H4a1 1 0 0 0-1 1v6"/>`,
    x: `<path d="M4 4l8 8M12 4l-8 8"/>`,
    search: `<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>`,
    chevron: `<path d="M4 6l4 4 4-4"/>`,
    export: `<path d="M8 10.5V2.5M8 2.5 5 5.5M8 2.5l3 3"/><path d="M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>`,
  };

  let { name, size = 15 }: { name: string; size?: number } = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 16 16"
  fill="none"
  stroke="currentColor"
  stroke-width="1.4"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {@html icons[name] ?? ""}
</svg>
