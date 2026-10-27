import { defineConfig } from "vitest/config";

// Each package is its own vitest project. LIVE=1 enables live-provider tests.
export default defineConfig({
  test: { projects: ["packages/*"] },
});
