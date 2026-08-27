import { describe, expect, it } from "vitest";
import { seedRecommendationPreferences } from "../../src/domain/recommendation-preferences";
import type { FlightRecommendation } from "../../src/contracts/travel-search";
import type {
  RecommendationEvalOutput,
  RecommendationExpected,
  RecommendationFixture,
  RerankingEvalOutput,
  RerankingExpected,
  RerankingFixture,
} from "../recommendation-types";
import {
  costExtremeWinner,
  hardConstraintCompliance,
  preferenceOnlyNoSearch,
  recommendationIdValidity,
  rerankPreferenceFit,
  sortPreservesServerRanks,
} from "./recommendation-invariants";

const option = {
  availabilityId: "valid",
  origin: "SFO",
  destination: "HND",
  date: "2026-09-18",
  program: "united",
  cabin: "business" as const,
  miles: 60_000,
  taxes: 75,
  taxesCurrency: "USD",
  direct: true,
  airlines: "NH",
  remainingSeats: 2,
};

const recommendation: FlightRecommendation = {
  id: "valid:business",
  rank: 1,
  origin: "SFO",
  destination: "HND",
  date: "2026-09-18",
  cabin: "business",
  miles: 60_000,
  taxes: { amount: 75, currency: "USD" },
  program: { id: "united", label: "United" },
  carriers: ["NH"],
  direct: true,
  stops: 0,
  remainingSeats: 2,
  flightNumbers: [],
  aircraft: [],
  reason: "Lowest viable blended cost.",
  scoreFactors: [],
  confidence: "medium",
  evidenceIds: ["seat-doc"],
};

const fixture: RecommendationFixture = {
  caseId: "unit",
  question: "nonstop for two",
  searchPlan: {
    origins: ["SFO"], destinations: ["HND"], cabins: ["business"], programs: [],
    nonstopOnly: true, stopPreference: "nonstop", travelers: 2, maxTaxesFeesUsd: 100,
  },
  awardResults: [option],
  tripSummaries: [],
  optionEvidence: {
    "valid:business": [{
      id: "seat-doc", collection: "products", text: "Direct aisle access.", sources: [],
      updated: "2026-08-01", dimensions: ["cabin_product"],
    }],
  },
  candidateAssessments: {},
  recommendationPreferences: seedRecommendationPreferences({ experienceWeight: 0, priorities: [] }),
};

const expected: RecommendationExpected = {
  viableIds: ["valid:business"],
  costWinnerId: "valid:business",
  preferredHybridWinnerIds: ["valid:business"],
};

function output(overrides: Partial<RecommendationEvalOutput> = {}): RecommendationEvalOutput {
  return {
    hybrid: [recommendation],
    costExtreme: [recommendation],
    journeyExtreme: [recommendation],
    deterministicV1Order: [recommendation.id],
    sortedViews: { points_asc: [recommendation] },
    draft: "Choose the nonstop.",
    state: {} as RecommendationEvalOutput["state"],
    assessmentRuns: [],
    assessmentDegraded: false,
    metrics: { latencyMs: 1, modelTokens: 0, providerCalls: 0, retrievalDegradations: 0 },
    ...overrides,
  };
}

describe("recommendation release invariants", () => {
  it("passes valid hard constraints, ids, and the independently computed cost winner", () => {
    const args = { inputs: fixture, outputs: output(), referenceOutputs: expected };
    expect(hardConstraintCompliance(args).score).toBe(1);
    expect(recommendationIdValidity(args).score).toBe(1);
    expect(costExtremeWinner(args).score).toBe(1);
  });

  it("fails a recommendation that violates a hard nonstop constraint", () => {
    const connecting = { ...recommendation, direct: false, stops: 1 };
    const inputs = { ...fixture, awardResults: [{ ...option, direct: false }] };
    expect(hardConstraintCompliance({ inputs, outputs: output({ hybrid: [connecting] }), referenceOutputs: expected }).score).toBe(0);
  });

  it("fails cross-option or unknown evidence ids", () => {
    const invalid = { ...recommendation, evidenceIds: ["other-option-doc"] };
    expect(recommendationIdValidity({ inputs: fixture, outputs: output({ hybrid: [invalid] }), referenceOutputs: expected }).score).toBe(0);
  });

  it("detects a client sort that mutates the server-owned rank", () => {
    const mutated = { ...recommendation, rank: 2 };
    expect(sortPreservesServerRanks({ inputs: fixture, outputs: output({ sortedViews: { points_asc: [mutated] } }), referenceOutputs: expected }).score).toBe(0);
  });
});

describe("preference-only reranking release invariant", () => {
  const inputs = { caseId: "rerank", followUp: "make it cheaper", searchPlan: fixture.searchPlan, snapshot: {} } as RerankingFixture;
  const referenceOutputs: RerankingExpected = {
    winnerIds: [recommendation.id], experienceWeight: { min: 0, max: 50 }, providerCalls: 0,
  };
  const outputs = {
    recommendations: [recommendation],
    recommendationPreferences: seedRecommendationPreferences({ experienceWeight: 30, priorities: [] }),
    searchRan: false,
    draft: "",
    state: {},
    metrics: { latencyMs: 1, modelTokens: 0, providerCalls: 0, retrievalDegradations: 0 },
  } as RerankingEvalOutput;

  it("passes only when the graph performs no provider call", () => {
    expect(preferenceOnlyNoSearch({ inputs, outputs, referenceOutputs }).score).toBe(1);
    expect(preferenceOnlyNoSearch({ inputs, outputs: { ...outputs, searchRan: true, metrics: { ...outputs.metrics, providerCalls: 1 } }, referenceOutputs }).score).toBe(0);
  });

  it("accepts bounded directional movement instead of demanding one magic slider value", () => {
    const seatInputs = {
      ...inputs,
      followUp: "Prioritize the best seat",
      snapshot: {
        recommendationPreferences: seedRecommendationPreferences({ experienceWeight: 50, priorities: [] }),
      },
    } as RerankingFixture;
    const seatExpected: RerankingExpected = {
      winnerIds: [recommendation.id], experienceWeight: { min: 50, max: 100 }, providerCalls: 0,
    };
    const seatOutputs = {
      ...outputs,
      recommendationPreferences: seedRecommendationPreferences({ experienceWeight: 58, priorities: ["cabin_product"] }),
    };
    expect(rerankPreferenceFit({ inputs: seatInputs, outputs: seatOutputs, referenceOutputs: seatExpected }).score).toBe(1);
  });

  it("accepts any meaningful cheaper movement that selects the cheaper winner", () => {
    const cheaperInputs = {
      ...inputs,
      snapshot: {
        recommendationPreferences: seedRecommendationPreferences({ experienceWeight: 50, priorities: [] }),
      },
    } as RerankingFixture;
    const cheaperOutputs = {
      ...outputs,
      recommendationPreferences: seedRecommendationPreferences({ experienceWeight: 40, priorities: [] }),
    };
    expect(rerankPreferenceFit({ inputs: cheaperInputs, outputs: cheaperOutputs, referenceOutputs }).score).toBe(1);

    const unchanged = {
      ...cheaperOutputs,
      recommendationPreferences: seedRecommendationPreferences({ experienceWeight: 50, priorities: [] }),
    };
    expect(rerankPreferenceFit({ inputs: cheaperInputs, outputs: unchanged, referenceOutputs }).score).toBe(0);
  });
});
