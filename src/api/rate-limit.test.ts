import { describe, expect, it } from "vitest";
import { checkRateLimit } from "./rate-limit";

const OPTS = { limit: 3, windowMs: 60_000 };

describe("checkRateLimit", () => {
  it("allows requests under the limit", () => {
    const now = 0;
    expect(checkRateLimit("a", OPTS, now).allowed).toBe(true);
    expect(checkRateLimit("a", OPTS, now).allowed).toBe(true);
    expect(checkRateLimit("a", OPTS, now).allowed).toBe(true);
  });

  it("[REGRESSION] rejects a request at or over the limit within the window", () => {
    const now = 0;
    checkRateLimit("b", OPTS, now);
    checkRateLimit("b", OPTS, now);
    checkRateLimit("b", OPTS, now);
    const fourth = checkRateLimit("b", OPTS, now);
    expect(fourth.allowed).toBe(false);
    if (fourth.allowed) throw new Error("expected fourth request to be rejected");
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it("[REGRESSION] a request outside the window no longer counts against a later window", () => {
    checkRateLimit("c", OPTS, 0);
    checkRateLimit("c", OPTS, 0);
    checkRateLimit("c", OPTS, 0);
    // The window has fully elapsed — the three earlier requests should have aged out.
    const result = checkRateLimit("c", OPTS, OPTS.windowMs + 1);
    expect(result.allowed).toBe(true);
  });

  it("tracks different keys independently", () => {
    checkRateLimit("d1", OPTS, 0);
    checkRateLimit("d1", OPTS, 0);
    checkRateLimit("d1", OPTS, 0);
    const otherKey = checkRateLimit("d2", OPTS, 0);
    expect(otherKey.allowed).toBe(true);
  });

  it("reports remaining requests under the limit", () => {
    const now = 0;
    const remaining = (): number => {
      const result = checkRateLimit("e", OPTS, now);
      if (!result.allowed) throw new Error("expected request to be allowed");
      return result.remaining;
    };
    expect(remaining()).toBe(2);
    expect(remaining()).toBe(1);
    expect(remaining()).toBe(0);
  });
});
