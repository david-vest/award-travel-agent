import { describe, it, expect } from "vitest";
import { costOf, formatUsd, type TokenUsage } from "./pricing";

const empty: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

describe("costOf", () => {
  it("uses introductory rates on or before 2026-08-31", () => {
    const usage = { ...empty, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // intro: $2 in + $10 out
    expect(costOf(usage, new Date("2026-08-11T00:00:00Z"))).toBeCloseTo(12, 6);
  });

  it("uses standard rates after the introductory window", () => {
    const usage = { ...empty, inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // standard: $3 in + $15 out
    expect(costOf(usage, new Date("2026-09-01T00:00:00Z"))).toBeCloseTo(18, 6);
  });

  it("bills cache reads at 0.1x base input", () => {
    const usage = { ...empty, cacheReadInputTokens: 1_000_000 };
    expect(costOf(usage, new Date("2026-09-01T00:00:00Z"))).toBeCloseTo(0.3, 6);
  });

  it("bills cache writes at 1.25x base input", () => {
    const usage = { ...empty, cacheCreationInputTokens: 1_000_000 };
    expect(costOf(usage, new Date("2026-09-01T00:00:00Z"))).toBeCloseTo(3.75, 6);
  });

  it("is zero for empty usage", () => {
    expect(costOf(empty)).toBe(0);
  });
});

describe("formatUsd", () => {
  it("shows enough precision for sub-cent amounts", () => {
    expect(formatUsd(0.000123)).toBe("$0.000123");
  });

  it("shows cents for larger amounts", () => {
    expect(formatUsd(1.5)).toBe("$1.5000");
  });
});
