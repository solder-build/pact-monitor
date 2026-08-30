import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // The demo entrypoint is wiring, not logic — exclude it (like wrap excludes index.ts).
      include: ["src/**/*.ts"],
      exclude: ["src/**/__tests__/**", "src/index.ts", "src/demo/**"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
      },
    },
  },
});
