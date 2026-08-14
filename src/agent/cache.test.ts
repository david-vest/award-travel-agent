import { describe, it, expect } from "vitest";
import { cachedSystem, plainSystem, estimateTokens, CACHE_MIN_TOKENS } from "./cache";

describe("cachedSystem", () => {
  it("emits array-form content carrying cache_control", () => {
    const msg = cachedSystem("x".repeat(8000));
    const content = msg.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("preserves the prompt text verbatim", () => {
    const text = "System instructions here.".repeat(400);
    const content = cachedSystem(text).content as Array<{ text: string }>;
    expect(content[0].text).toBe(text);
  });

  it("refuses to mark a prompt below the cache minimum", () => {
    expect(() => cachedSystem("too short")).toThrow(/below the .* minimum/i);
  });
});

describe("plainSystem", () => {
  it("uses plain string content with no cache marker", () => {
    const msg = plainSystem("short prompt");
    expect(typeof msg.content).toBe("string");
  });
});

describe("estimateTokens", () => {
  it("approximates four characters per token", () => {
    expect(estimateTokens("a".repeat(4000))).toBeCloseTo(1000, -1);
  });

  it("agrees with the documented cache minimum constant", () => {
    expect(CACHE_MIN_TOKENS).toBe(1024);
  });
});
