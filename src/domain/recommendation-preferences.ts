export const RANKING_EXPERIENCE_WEIGHTS = [0, 25, 50, 75, 100] as const;

export const RECOMMENDATION_PIPELINE_VERSION = "evidence-hybrid-v3";
export const PREFERENCE_INTERPRETER_VERSION = "bounded-v1";
export const CANDIDATE_SHORTLIST_VERSION = "coverage-v1";
export const EVIDENCE_RETRIEVAL_VERSION = "option-linked-v1";
export const EXPERIENCE_ASSESSMENT_VERSION = "evidence-bounded-v1";
export const PREFERENCE_RERANK_VERSION = "checkpoint-reuse-v1";

export const RANKING_LEVELS = [
  { value: 0, label: "Lowest points & fees" },
  { value: 25, label: "Value first" },
  { value: 50, label: "Balanced" },
  { value: 75, label: "Journey first" },
  { value: 100, label: "Best overall journey" },
] as const;

export const RANKING_PRIORITY_VALUES = [
  "cabin_product",
  "schedule",
  "few_connections",
  "connection_quality",
  "booking_ease",
  "low_transfer_risk",
] as const;

export type RankingPriority = (typeof RANKING_PRIORITY_VALUES)[number];

export type RankingPreference = {
  /** 0 is pure cost/value; 100 gives journey experience maximum influence. */
  experienceWeight: number;
  priorities: RankingPriority[];
};

export type RecommendationPreferenceSource = "default" | "explicit" | "model" | "keyword_fallback";

/**
 * The normalized, graph-owned profile used by later assessment and ranking
 * nodes. Search constraints deliberately do not live here: the model may
 * interpret soft preferences, but cannot rewrite dates, cabin, stops,
 * balances, fee ceilings, or party size.
 */
export type RecommendationPreferences = {
  experienceWeight: number;
  priorities: RankingPriority[];
  priorityWeights: Record<RankingPriority, number>;
  schedulePreferences: {
    avoidEarlyDepartures: boolean;
    avoidLateArrivals: boolean;
  };
  rationale: string;
  source: RecommendationPreferenceSource;
};

export const DEFAULT_RANKING_PREFERENCE: RankingPreference = {
  experienceWeight: 50,
  priorities: [],
};

export function defaultRankingPreference(): RankingPreference {
  return { experienceWeight: DEFAULT_RANKING_PREFERENCE.experienceWeight, priorities: [] };
}

export function rankingLevelLabel(experienceWeight: number): string {
  return RANKING_LEVELS.find((level) => level.value === experienceWeight)?.label ?? "Custom";
}

const BASE_PRIORITY_WEIGHT = 40;
const EXPLICIT_PRIORITY_WEIGHT = 85;

export function seedRecommendationPreferences(
  rankingPreference: RankingPreference = defaultRankingPreference(),
  source: RecommendationPreferenceSource = "default",
): RecommendationPreferences {
  const priorities = [...new Set(rankingPreference.priorities)];
  const priorityWeights = Object.fromEntries(
    RANKING_PRIORITY_VALUES.map((priority) => [
      priority,
      priorities.includes(priority) ? EXPLICIT_PRIORITY_WEIGHT : BASE_PRIORITY_WEIGHT,
    ]),
  ) as Record<RankingPriority, number>;

  return {
    experienceWeight: rankingPreference.experienceWeight,
    priorities,
    priorityWeights,
    schedulePreferences: {
      avoidEarlyDepartures: false,
      avoidLateArrivals: false,
    },
    rationale: `${rankingLevelLabel(rankingPreference.experienceWeight)} ranking preference.`,
    source,
  };
}

export function defaultRecommendationPreferences(): RecommendationPreferences {
  return seedRecommendationPreferences(defaultRankingPreference(), "default");
}
