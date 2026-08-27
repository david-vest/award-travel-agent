import { describe, expect, it, vi } from "vitest";
import type { AgentFeedback } from "../contracts/travel-search";
import { recordAgentFeedback } from "./user-feedback";

const base: AgentFeedback = {
  runId: "10000000-0000-4000-8000-000000000000",
  kind: "rating",
  rating: "up",
  rankingVersion: "evidence-hybrid-v3",
  preferenceProfile: { experienceWeight: 75, priorities: ["cabin_product"] },
  candidateIds: ["candidate-1"],
  evidenceIds: ["evidence-1"],
};

function client() {
  return {
    createFeedback: vi.fn(async () => ({})),
    listAnnotationQueues: vi.fn(async function* () { yield { id: "queue-1" }; }),
    createAnnotationQueue: vi.fn(async () => ({ id: "queue-new" })),
    addRunsToAnnotationQueue: vi.fn(async () => undefined),
  };
}

describe("recordAgentFeedback", () => {
  it("records versioned, balance-free recommendation context", async () => {
    const mock = client();
    await recordAgentFeedback(base, mock as never);
    expect(mock.createFeedback).toHaveBeenCalledWith(
      base.runId,
      "recommendation_quality",
      expect.objectContaining({
        score: true,
        sourceInfo: expect.objectContaining({
          rankingVersion: "evidence-hybrid-v3",
          preferenceProfile: base.preferenceProfile,
          candidateIds: ["candidate-1"],
          evidenceIds: ["evidence-1"],
        }),
      }),
    );
    expect(JSON.stringify(mock.createFeedback.mock.calls[0])).not.toContain("balance");
    expect(mock.addRunsToAnnotationQueue).not.toHaveBeenCalled();
  });

  it("routes a downvote to the human annotation queue", async () => {
    const mock = client();
    await recordAgentFeedback({ ...base, rating: "down" }, mock as never);
    expect(mock.addRunsToAnnotationQueue).toHaveBeenCalledWith("queue-1", [base.runId]);
  });

  it("records the option the traveler would choose", async () => {
    const mock = client();
    await recordAgentFeedback({
      ...base,
      kind: "selected_option",
      rating: undefined,
      selectedOptionId: "candidate-1",
    }, mock as never);
    expect(mock.createFeedback).toHaveBeenCalledWith(
      base.runId,
      "selected_option",
      expect.objectContaining({ value: "candidate-1" }),
    );
  });
});
