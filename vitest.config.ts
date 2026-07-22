// Standalone Vitest config — deliberately NOT reusing vite.config.ts, so the
// react-router/Shopify dev plugins never load in the test pipeline. Tests are
// plain node-environment unit tests colocated with the code they cover.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
  },
});
