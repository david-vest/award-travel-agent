export const RANKING_EXPERIENCE_WEIGHTS = [0, 25, 50, 75, 100] as const;

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

