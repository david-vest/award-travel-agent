// evals/evaluators/plan-similarity.test.ts
import { describe, it, expect } from "vitest";
import { planSimilarity, setF1, windowIoU } from "./plan-similarity";

describe("setF1", () => {
  it("scores 1 for an exact match", () => {
    expect(setF1(["ORD", "MDW"], ["ORD", "MDW"])).toBe(1);
  });

  it("gives partial credit for a partial match", () => {
    // found ORD, missed MDW: precision 1, recall 0.5 → F1 = 0.667
    expect(setF1(["ORD"], ["ORD", "MDW"])).toBeCloseTo(0.667, 2);
  });

  it("scores 0 for no overlap", () => {
    expect(setF1(["SFO"], ["ORD"])).toBe(0);
  });

  it("scores 1 when both are empty", () => {
    expect(setF1([], [])).toBe(1);
  });

  it("ignores ordering", () => {
    expect(setF1(["MDW", "ORD"], ["ORD", "MDW"])).toBe(1);
  });
});

describe("windowIoU", () => {
  it("scores 1 for identical windows", () => {
    expect(
      windowIoU({ start: "2026-09-01", end: "2026-09-30" }, { start: "2026-09-01", end: "2026-09-30" }),
    ).toBe(1);
  });

  it("gives partial credit for overlap", () => {
    const score = windowIoU(
      { start: "2026-09-01", end: "2026-09-30" },
      { start: "2026-09-15", end: "2026-10-15" },
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("scores 0 for disjoint windows", () => {
    expect(
      windowIoU({ start: "2026-09-01", end: "2026-09-10" }, { start: "2026-10-01", end: "2026-10-10" }),
    ).toBe(0);
  });

  it("scores 1 when neither side specifies a window", () => {
    expect(windowIoU({}, {})).toBe(1);
  });
});

describe("planSimilarity", () => {
  it("gives a perfect plan a score of 1", () => {
    const plan = {
      origins: ["ORD"], destinations: ["NRT"], cabins: ["business"],
      nonstopOnly: true, startDate: "2026-09-01", endDate: "2026-09-30",
    };
    expect(planSimilarity({ outputs: plan, referenceOutputs: plan }).score).toBe(1);
  });

  it("penalises a missed origin without failing the whole plan", () => {
    const result = planSimilarity({
      outputs: { origins: ["ORD"], destinations: ["NRT"], cabins: ["business"], nonstopOnly: true },
      referenceOutputs: { origins: ["ORD", "MDW"], destinations: ["NRT"], cabins: ["business"], nonstopOnly: true },
    });
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.score).toBeLessThan(1);
  });

  it("explains which field lost points", () => {
    const result = planSimilarity({
      outputs: { origins: ["SFO"], destinations: ["NRT"], cabins: ["business"], nonstopOnly: true },
      referenceOutputs: { origins: ["ORD"], destinations: ["NRT"], cabins: ["business"], nonstopOnly: true },
    });
    expect(result.comment).toContain("origins");
  });
});
