import { describe, it, expect } from "vitest";
import { exactIntent } from "./exact-intent";

describe("exactIntent", () => {
  it("scores 1 for a match", () => {
    expect(
      exactIntent({
        outputs: { intent: "route_search" },
        referenceOutputs: { intent: "route_search" },
      }).score,
    ).toBe(1);
  });

  it("scores 0 for a mismatch", () => {
    expect(
      exactIntent({
        outputs: { intent: "discovery" },
        referenceOutputs: { intent: "route_search" },
      }).score,
    ).toBe(0);
  });

  it("scores 0 when the intent is missing", () => {
    expect(
      exactIntent({ outputs: {}, referenceOutputs: { intent: "knowledge" } }).score,
    ).toBe(0);
  });

  it("uses a stable key so LangSmith can chart it over time", () => {
    expect(
      exactIntent({
        outputs: { intent: "knowledge" },
        referenceOutputs: { intent: "knowledge" },
      }).key,
    ).toBe("intent_exact_match");
  });
});
