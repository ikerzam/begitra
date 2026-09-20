/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // The dependency scanner otherwise globs the whole project for `*.html` entries, which
  // walks the Rust `target` folder and the benchmark repositories under `bench/repos`
  // (millions of files): the dev server took minutes to answer its first request and the
  // window stayed blank. The one entry is the app's HTML.
  optimizeDeps: {
    entries: ["index.html"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and the benchmark repositories
      ignored: ["**/src-tauri/**", "**/bench/repos/**", "**/dist/**"],
    },
  },

  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    globals: false,
  },
}));
