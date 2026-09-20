// The performance spec: budgets over synthetic data, run on demand with `pnpm test:perf` so
// the unit suite stays fast. Node's environment is enough: nothing here touches the DOM.

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/perf/**/*.perf.test.ts"],
    globals: false,
    testTimeout: 60_000,
  },
});
