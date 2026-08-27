import type { FlightRecommendation } from "../src/contracts/travel-search";
import type { AgentStateType, RecommendationSnapshot, SearchPlan } from "../src/agent/state";
import type { RecommendationPreferences } from "../src/domain/recommendation-preferences";
import type { CandidateAssessments } from "../src/domain/candidate-assessment";
import type { OptionEvidence } from "../src/rag/retriever";
import type { AwardOption, TripSummary } from "../src/tools";

export type RecommendationFixture = {
  caseId: string;
  question: string;
  searchPlan: SearchPlan;
  awardResults: AwardOption[];
  candidateShortlist?: AwardOption[];
  tripSummaries: TripSummary[];
  optionEvidence: OptionEvidence;
  candidateAssessments: CandidateAssessments;
  recommendationPreferences: RecommendationPreferences;
  runAssessmentStability?: boolean;
};

export type RecommendationExpected = {
  viableIds: string[];
  costWinnerId: string;
  preferredHybridWinnerIds: string[];
  maxAssessmentScoreDelta?: number;
  maxRankDelta?: number;
};

export type OperationalMetrics = {
  latencyMs: number;
  modelTokens: number;
  providerCalls: number;
  retrievalDegradations: number;
};

export type RecommendationEvalOutput = {
  hybrid: FlightRecommendation[];
  costExtreme: FlightRecommendation[];
  journeyExtreme: FlightRecommendation[];
  deterministicV1Order: string[];
  sortedViews: Record<string, FlightRecommendation[]>;
  draft: string;
  state: AgentStateType;
  assessmentRuns: CandidateAssessments[];
  assessmentDegraded: boolean;
  metrics: OperationalMetrics;
};

export type RerankingFixture = {
  caseId: string;
  followUp: string;
  searchPlan: SearchPlan;
  snapshot: RecommendationSnapshot;
};

export type RerankingExpected = {
  winnerIds: string[];
  experienceWeight: { min: number; max: number };
  providerCalls: 0;
};

export type RerankingEvalOutput = {
  recommendations: FlightRecommendation[];
  recommendationPreferences: RecommendationPreferences;
  searchRan: boolean;
  draft: string;
  state: AgentStateType;
  metrics: OperationalMetrics;
};
