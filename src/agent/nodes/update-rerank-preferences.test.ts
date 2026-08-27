import { beforeEach, describe, expect, it, vi } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import { seedRecommendationPreferences } from "../../domain/recommendation-preferences";
import type { AgentStateType, RecommendationSnapshot } from "../state";

const invoke = vi.fn();
vi.mock("../models", () => ({
  chat: vi.fn(() => ({ withStructuredOutput: vi.fn(() => ({ invoke })) })),
}));

import {
  mergeRerankPreferenceUpdate,
  updateRerankPreferences,
} from "./update-rerank-preferences";

function snapshot(): RecommendationSnapshot {
  return {
    awardResults: [{ availabilityId: "a", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60_000, direct: true, airlines: "NH" }],
    candidateShortlist: [{ availabilityId: "a", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60_000, direct: true, airlines: "NH" }],
    tripSummaries: [],
    kbDocs: [],
    optionEvidence: {},
    candidateAssessments: {},
    recommendations: [],
    recommendationPreferences: seedRecommendationPreferences({ experienceWeight: 50, priorities: ["schedule"] }),
    searchStatus: "searched",
    refreshedAt: "2026-08-26T00:00:00Z",
  };
}

describe("preference-only reranking", () => {
  beforeEach(() => invoke.mockReset());

  it("updates the existing profile instead of resetting it to form defaults", () => {
    const current = snapshot().recommendationPreferences;
    const result = mergeRerankPreferenceUpdate(current, {
      experienceAdjustment: -20,
      priorities: ["cabin_product"],
      avoidEarlyDepartures: false,
      avoidLateArrivals: false,
      rationale: "Prefer lower cost while retaining the seat priority.",
    }, "model");
    expect(result.experienceWeight).toBe(30);
    expect(result.priorities).toEqual(["schedule", "cabin_product"]);
    expect(result.priorityWeights.cabin_product).toBe(70);
  });

  it("restores cached candidates and assessments without invoking any provider-facing node", async () => {
    invoke.mockResolvedValueOnce({
      experienceAdjustment: -20,
      priorities: [],
      avoidEarlyDepartures: false,
      avoidLateArrivals: false,
      rationale: "Prefer lower cost.",
    });
    const cached = snapshot();
    const result = await updateRerankPreferences({
      messages: [new HumanMessage("make it cheaper")],
      recommendationSnapshot: cached,
    } as unknown as AgentStateType);
    expect(result).toMatchObject({
      intent: "rerank",
      awardResults: cached.awardResults,
      candidateShortlist: cached.candidateShortlist,
      candidateAssessments: cached.candidateAssessments,
      searchStatus: "searched",
    });
    expect(result.recommendationPreferences?.experienceWeight).toBe(30);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("uses the deterministic keyword fallback during a model outage", async () => {
    invoke.mockRejectedValueOnce(new Error("model unavailable"));
    const result = await updateRerankPreferences({
      messages: [new HumanMessage("make it cheaper")],
      recommendationSnapshot: snapshot(),
    } as unknown as AgentStateType);
    expect(result.recommendationPreferences).toMatchObject({ experienceWeight: 30, source: "keyword_fallback" });
  });
});
