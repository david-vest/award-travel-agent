import { describe, it, expect } from "vitest";
import { averageExpectedScores, contentHash } from "./run";

describe("contentHash", () => {
  it("[REGRESSION] produces the same hash for identical content, so an unchanged dataset is never needlessly resynced", () => {
    const examples = [{ input: { question: "a" }, expected: { intent: "route_search" } }];
    expect(contentHash(examples)).toBe(contentHash([...examples]));
  });

  it("[REGRESSION] produces a different hash when a field changes, so an edited local dataset is detected", () => {
    const a = [{ input: { question: "a" }, expected: { intent: "route_search" } }];
    const b = [{ input: { question: "a" }, expected: { intent: "knowledge" } }];
    expect(contentHash(a)).not.toBe(contentHash(b));
  });

  it("treats a different example order as a different dataset — order is part of the content", () => {
    const a = [{ input: { question: "a" }, expected: {} }, { input: { question: "b" }, expected: {} }];
    const b = [{ input: { question: "b" }, expected: {} }, { input: { question: "a" }, expected: {} }];
    expect(contentHash(a)).not.toBe(contentHash(b));
  });
});

describe("averageExpectedScores", () => {
  it("scores a missing or crashed evaluator as zero instead of silently dropping it", () => {
    const results = {
      results: [{
        evaluationResults: { results: [{ key: "present", score: 1 }] },
      }],
    };
    expect(averageExpectedScores(results, ["present", "missing"])).toBe(0.5);
  });
});
