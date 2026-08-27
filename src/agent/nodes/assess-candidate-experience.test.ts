import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateType } from "../state";
import type { RetrievedDoc } from "../../rag/retriever";

const invoke = vi.fn();
vi.mock("../models", () => ({
  chat: vi.fn(() => ({ withStructuredOutput: vi.fn(() => ({ invoke })) })),
}));

import {
  assessCandidateExperience,
  CANDIDATE_ASSESSMENT_BATCH_SIZE,
  CANDIDATE_ASSESSMENT_CONCURRENCY,
  CANDIDATE_RATIONALE_MAX_CHARS,
  strongestEvidencePerDimension,
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

const option = (id: string) => ({
  availabilityId: id,
  origin: "SFO",
  destination: "HND",
  date: "2026-09-18",
  program: "united",
  cabin: "business" as const,
  miles: 120_000,
  direct: true,
  airlines: "NH",
});

function inputOptions(messages: unknown): Array<{ optionId: string; evidence: Array<{ evidenceId: string }> }> {
  const content = (messages as Array<{ content?: string }>)[1]?.content;
  return JSON.parse(content ?? "{}").options ?? [];
}

function successfulAssessments(messages: unknown) {
  return {
    assessments: inputOptions(messages).map(({ optionId, evidence }) => ({
      optionId,
      dimensions: [{
        dimension: "cabin_product" as const,
        score: 92,
        evidenceIds: [evidence[0]!.evidenceId],
        rationale: "Direct aisle access.",
      }],
    })),
  };
}

describe("candidate experience assessment", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("accepts only option IDs and evidence IDs belonging to that option", () => {
    expect(() => validateCandidateAssessments({ assessments: [{
      optionId: "a:business",
      dimensions: [{ dimension: "cabin_product", score: 90, evidenceIds: ["other"], rationale: "Strong seat." }],
    }] }, { "a:business": [doc()] })).toThrow(/Invalid evidence/);
  });

  it("rejects missing output cardinality instead of partially trusting the model", () => {
    expect(() => validateCandidateAssessments({ assessments: [] }, { "a:business": [doc()] })).toThrow(/cardinality/);
  });

  it("normalizes verbose model rationales without rejecting an otherwise valid batch", () => {
    const verboseRationale = "Broad partner coverage reduces risk, but variable transfer ratios, irreversible transfers, posting delays, and recent partner exits still require careful verification before moving points.";
    const result = validateCandidateAssessments({ assessments: [{
      optionId: "a:business",
      dimensions: [{
        dimension: "transfer_risk",
        score: 65,
        evidenceIds: ["product-1"],
        rationale: verboseRationale,
      }],
    }] }, { "a:business": [doc({ dimensions: ["transfer_risk"] })] });

    const rationale = result["a:business"]?.dimensions.transfer_risk?.rationale;
    expect(rationale?.length).toBeLessThanOrEqual(CANDIDATE_RATIONALE_MAX_CHARS);
    expect(rationale).toMatch(/…$/u);
  });

  it("keeps only the strongest document for each dimension", () => {
    const selected = strongestEvidencePerDimension([
      doc({ id: "weak-cabin", dimensions: ["cabin_product"], match: { confidence: "medium", reasons: [], stale: false, semanticSupplement: false } }),
      doc({ id: "strong-product", dimensions: ["cabin_product", "booking_ease"], match: { confidence: "high", reasons: [], stale: false, semanticSupplement: false } }),
      doc({ id: "weak-booking", dimensions: ["booking_ease"], match: { confidence: "low", reasons: [], stale: false, semanticSupplement: false } }),
      doc({ id: "transfer", dimensions: ["transfer_risk"], match: { confidence: "high", reasons: [], stale: false, semanticSupplement: false } }),
    ]);

    expect(selected.map((item) => item.id)).toEqual(["strong-product", "transfer"]);
    expect(selected[0]?.dimensions).toEqual(["cabin_product", "booking_ease"]);
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
    expect(payload).not.toContain("https://example.com/source");
    expect(result.candidateAssessments?.["a:business"]?.dimensions.cabin_product?.score).toBe(92);
  });

  it("assesses candidates in five-option batches with at most two calls in flight", async () => {
    const candidates = Array.from({ length: 11 }, (_, index) => option(`candidate-${index + 1}`));
    const optionEvidence = Object.fromEntries(candidates.map((candidate) => [
      `${candidate.availabilityId}:business`,
      [doc({ id: `evidence-${candidate.availabilityId}` })],
    ]));
    let active = 0;
    let maxActive = 0;
    invoke.mockImplementation(async (messages) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return successfulAssessments(messages);
    });

    const result = await assessCandidateExperience({
      candidateShortlist: candidates,
      optionEvidence,
    } as unknown as AgentStateType);

    expect(maxActive).toBe(CANDIDATE_ASSESSMENT_CONCURRENCY);
    expect(invoke.mock.calls.map(([messages]) => inputOptions(messages).length)).toEqual([
      CANDIDATE_ASSESSMENT_BATCH_SIZE,
      CANDIDATE_ASSESSMENT_BATCH_SIZE,
      1,
    ]);
    expect(Object.keys(result.candidateAssessments ?? {})).toHaveLength(11);
    expect(result.degradedReasons).toBeUndefined();
  });

  it("preserves successful batches when another batch fails", async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => option(`candidate-${index + 1}`));
    const optionEvidence = Object.fromEntries(candidates.map((candidate) => [
      `${candidate.availabilityId}:business`,
      [doc({ id: `evidence-${candidate.availabilityId}` })],
    ]));
    invoke.mockImplementation(async (messages) => {
      if (inputOptions(messages).length === 1) throw new Error("truncated tool call");
      return successfulAssessments(messages);
    });

    const result = await assessCandidateExperience({
      candidateShortlist: candidates,
      optionEvidence,
    } as unknown as AgentStateType);

    expect(result.candidateAssessments?.["candidate-1:business"]?.dimensions.cabin_product?.score).toBe(92);
    expect(result.candidateAssessments?.["candidate-6:business"]?.dimensions).toEqual({});
    expect(result.degradedReasons).toEqual(["candidate_assessment_failed"]);
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
