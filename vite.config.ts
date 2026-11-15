import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
  },
  // 3. to make use of `TAURI_ENV_*` variables instead of the standard `VITE_*`:
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Tauri's WebView2 (Windows) supports the full ES2022 feature set.
    target: "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
