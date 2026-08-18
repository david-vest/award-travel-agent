import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "evals/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      // A few points under the measured baseline (87.38/77.06/88.73/90.63 as
      // of 2026-08-17) so incidental variance doesn't fail CI, while a real
      // regression still does.
      thresholds: {
        statements: 84,
        branches: 74,
        functions: 85,
        lines: 87,
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
});
