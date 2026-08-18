import { describe, it, expect } from "vitest";
import type { AgentStateType } from "../../src/agent/state";
import { hallucinationCheck } from "./hallucination";

describe("hallucinationCheck", () => {
  it("scores 0 with no state captured, so a missing state can't silently pass as grounded", () => {
    const result = hallucinationCheck({ outputs: { draft: "some answer" } });
    expect(result).toEqual({ key: "groundedness", score: 0, comment: "no state captured" });
  });

  it("scores 1 when every figure in the draft traces to real tool results", () => {
    const state = {
      awardResults: [{ availabilityId: "a1", miles: 87500, airlines: "NH" } as never],
      tripSummaries: [],
      kbDocs: [],
    } as unknown as AgentStateType;
    const result = hallucinationCheck({ outputs: { draft: "This costs 87500 miles.", state } });
    expect(result.score).toBe(1);
    expect(result.key).toBe("groundedness");
  });

  it("scores 0 and names the violation when the draft invents a mileage figure the tools never returned", () => {
    const state = {
      awardResults: [{ availabilityId: "a1", miles: 87500, airlines: "NH" } as never],
      tripSummaries: [],
      kbDocs: [],
    } as unknown as AgentStateType;
    const result = hallucinationCheck({ outputs: { draft: "This costs 12345 miles.", state } });
    expect(result.score).toBe(0);
    expect(result.comment).toMatch(/unsupported_number/);
  });
});
