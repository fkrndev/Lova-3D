import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // The Svelte plugin compiles the `.svelte.ts` runes modules (sceneStore, i18n).
  plugins: [svelte({ hot: false })],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
