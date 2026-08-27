import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateType } from "../state";
import type { RetrievedDoc } from "../../rag/retriever";

const invoke = vi.fn();
vi.mock("../models", () => ({
  chat: vi.fn(() => ({ withStructuredOutput: vi.fn(() => ({ invoke })) })),
}));

import {
  assessCandidateExperience,
  validateCandidateAssessments,
} from "./assess-candidate-experience";

const doc = (over: Partial<RetrievedDoc> = {}): RetrievedDoc => ({
  id: "product-1",
  collection: "products",
  text: "Every seat has direct aisle access.",
  sources: ["https://example.com/source"],
  updated: "2026-08-01",
  dimensions: ["cabin_product"],
  match: { confidence: "high", reasons: ["carrier", "aircraft", "cabin"], stale: false, semanticSupplement: false },
  ...over,
});

describe("candidate experience assessment", () => {
  beforeEach(() => invoke.mockReset());

  it("accepts only option IDs and evidence IDs belonging to that option", () => {
    expect(() => validateCandidateAssessments({ assessments: [{
      optionId: "a:business",
      dimensions: [{ dimension: "cabin_product", score: 90, evidenceIds: ["other"], rationale: "Strong seat." }],
    }] }, { "a:business": [doc()] })).toThrow(/Invalid evidence/);
  });

  it("rejects missing output cardinality instead of partially trusting the model", () => {
    expect(() => validateCandidateAssessments({ assessments: [] }, { "a:business": [doc()] })).toThrow(/cardinality/);
  });

  it("makes one listwise call whose payload omits price and schedule facts", async () => {
    invoke.mockResolvedValueOnce({ assessments: [{
      optionId: "a:business",
      dimensions: [{ dimension: "cabin_product", score: 92, evidenceIds: ["product-1"], rationale: "Direct aisle access." }],
    }] });
    const result = await assessCandidateExperience({
      candidateShortlist: [{ availabilityId: "a", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 120_000, direct: true, airlines: "NH" }],
      tripSummaries: [{ availabilityId: "a", tripId: "trip-secret", flightNumbers: ["NH7"], aircraft: ["777-300ER"], carriers: ["NH"], stops: 0, durationMinutes: 660 }],
      optionEvidence: { "a:business": [doc()] },
    } as unknown as AgentStateType);

    expect(invoke).toHaveBeenCalledOnce();
    const payload = JSON.stringify(invoke.mock.calls[0]?.[0]);
    expect(payload).not.toContain("120000");
    expect(payload).not.toContain("NH7");
    expect(payload).not.toContain("660");
    expect(result.candidateAssessments?.["a:business"]?.dimensions.cabin_product?.score).toBe(92);
  });

  it("degrades to objective-only assessments when validation fails", async () => {
    invoke.mockResolvedValueOnce({ assessments: [] });
    const result = await assessCandidateExperience({
      candidateShortlist: [{ availabilityId: "a", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60_000, direct: true, airlines: "NH" }],
      optionEvidence: { "a:business": [doc()] },
      degradedReasons: ["rag_retrieval_failed"],
    } as unknown as AgentStateType);
    expect(result.candidateAssessments?.["a:business"]?.confidence).toBe("low");
    expect(result.degradedReasons).toEqual(["rag_retrieval_failed", "candidate_assessment_failed"]);
  });
});
