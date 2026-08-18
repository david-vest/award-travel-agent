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
      // evals/run.ts is an orchestration script whose bulk (runIntentRouting,
      // runSearchPlanning, runGroundedness, main) calls live LangSmith/
      // Anthropic evaluate() — it needs paid API credentials to exercise and
      // can't be meaningfully unit tested, the same reason src/rag/ingest.ts
      // (also live-infra-dependent) has never been part of this measurement.
      // Its one pure, testable function (contentHash) has its own full test
      // coverage in run.test.ts regardless of this exclude.
      exclude: ["evals/run.ts"],
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
