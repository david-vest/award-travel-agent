import { z } from "zod";
import { getCurrentRunTree } from "langsmith/traceable";
import {
  RANKING_PRIORITY_VALUES,
  defaultRankingPreference,
  rankingLevelLabel,
  seedRecommendationPreferences,
  type RankingPreference,
  type RankingPriority,
  type RecommendationPreferences,
  type RecommendationPreferenceSource,
} from "../../domain/recommendation-preferences";
import { chat } from "../models";
import { plainSystem } from "../cache";
import { INTERPRET_PREFERENCES_PROMPT } from "../prompts/interpret-preferences";
import type { AgentStateType } from "../state";
import { lastUserText } from "./triage";

const MAX_EXPERIENCE_ADJUSTMENT = 20;
const INFERRED_PRIORITY_WEIGHT = 70;

export const preferenceInterpretationSchema = z.object({
  experienceAdjustment: z.number().int().min(-MAX_EXPERIENCE_ADJUSTMENT).max(MAX_EXPERIENCE_ADJUSTMENT).default(0),
  priorities: z.array(z.enum(RANKING_PRIORITY_VALUES)).max(RANKING_PRIORITY_VALUES.length).default([]),
  avoidEarlyDepartures: z.boolean().default(false),
  avoidLateArrivals: z.boolean().default(false),
  rationale: z.string().trim().min(1).max(240),
});

export type PreferenceInterpretation = z.infer<typeof preferenceInterpretationSchema>;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function uniquePriorities(priorities: RankingPriority[]): RankingPriority[] {
  return [...new Set(priorities)].slice(0, RANKING_PRIORITY_VALUES.length);
}

/** Deterministic safety net used when structured model interpretation is unavailable. */
export function interpretPreferenceKeywords(notes: string): PreferenceInterpretation {
  const priorities: RankingPriority[] = [];
  const cheap = /\b(?:cheap(?:er|est)?|lowest (?:points|miles|cost)|save (?:points|miles)|minimi[sz]e (?:points|miles|cost|fees)|value first)\b/i.test(notes);
  const experience = /\b(?:pay more|spend more|better experience|best experience|great seat|best seat|comfort(?:able)?|journey first)\b/i.test(notes);
  if (/\b(?:seat|cabin product|comfort|lie[- ]flat|suite)\b/i.test(notes)) priorities.push("cabin_product");
  if (/\b(?:schedule|departure|arrival|early flight|late arrival|overnight|red[- ]eye)\b/i.test(notes)) priorities.push("schedule");
  if (/\b(?:nonstop|direct|few(?:er)? stops?|simple connections?|easy connections?)\b/i.test(notes)) priorities.push("few_connections");
  if (/\b(?:connection|layover|transfer airport|simple transfer|easy transfer)\b/i.test(notes)) priorities.push("connection_quality");
  if (/\b(?:easy booking|simple booking|book online|phone booking|call center)\b/i.test(notes)) priorities.push("booking_ease");
  if (/\b(?:transfer risk|stranded points|speculative transfer|instant transfer)\b/i.test(notes)) priorities.push("low_transfer_risk");

  const experienceAdjustment = (experience ? MAX_EXPERIENCE_ADJUSTMENT : 0) - (cheap ? MAX_EXPERIENCE_ADJUSTMENT : 0);
  const signals = [
    cheap ? "lower cost" : "",
    experience ? "journey experience" : "",
    priorities.length ? `${uniquePriorities(priorities).join(", ")} priorities` : "",
  ].filter(Boolean);

  return {
    experienceAdjustment,
    priorities: uniquePriorities(priorities),
    avoidEarlyDepartures: /\b(?:avoid|no|not|hate)\s+(?:very\s+)?early\b|\bno early (?:departures?|flights?)\b/i.test(notes),
    avoidLateArrivals: /\b(?:avoid|no|not|hate)\s+(?:very\s+)?late (?:arrivals?|landings?)\b|\bno late (?:arrivals?|landings?)\b/i.test(notes),
    rationale: signals.length > 0
      ? `Detected ${signals.join(" and ")}.`
      : "No additional soft ranking preference was detected.",
  };
}

export function mergePreferenceInterpretation(
  rankingPreference: RankingPreference,
  interpretation: PreferenceInterpretation,
  source: RecommendationPreferenceSource,
): RecommendationPreferences {
  const seeded = seedRecommendationPreferences(rankingPreference, source);
  const inferredPriorities = uniquePriorities(interpretation.priorities);
  const priorities = uniquePriorities([...seeded.priorities, ...inferredPriorities]);
  const priorityWeights = { ...seeded.priorityWeights };
  for (const priority of inferredPriorities) {
    priorityWeights[priority] = Math.max(priorityWeights[priority], INFERRED_PRIORITY_WEIGHT);
  }

  const experienceAdjustment = clamp(
    interpretation.experienceAdjustment,
    -MAX_EXPERIENCE_ADJUSTMENT,
    MAX_EXPERIENCE_ADJUSTMENT,
  );
  const experienceWeight = clamp(seeded.experienceWeight + experienceAdjustment, 0, 100);

  return {
    experienceWeight,
    priorities,
    priorityWeights,
    schedulePreferences: {
      avoidEarlyDepartures: interpretation.avoidEarlyDepartures,
      avoidLateArrivals: interpretation.avoidLateArrivals,
    },
    rationale: `${rankingLevelLabel(rankingPreference.experienceWeight)} seed; ${interpretation.rationale}`,
    source,
  };
}

function attachTraceMetadata(preferences: RecommendationPreferences): void {
  try {
    const run = getCurrentRunTree(true);
    if (!run) return;
    run.metadata = {
      ...run.metadata,
      preference_source: preferences.source,
      preference_experience_weight: preferences.experienceWeight,
      preference_priorities: preferences.priorities,
      preference_rationale: preferences.rationale,
    };
  } catch {
    // Tracing is observability, never a reason to fail a recommendation run.
  }
}

export async function interpretPreferences(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const rankingPreference = state.tripRequest?.rankingPreference ?? defaultRankingPreference();
  const notes = state.tripRequest ? (state.tripRequest.notes ?? "").trim() : lastUserText(state).trim();

  if (!notes) {
    const preferences = seedRecommendationPreferences(
      rankingPreference,
      state.tripRequest?.rankingPreference ? "explicit" : "default",
    );
    attachTraceMetadata(preferences);
    return { recommendationPreferences: preferences };
  }

  let interpretation: PreferenceInterpretation;
  let source: RecommendationPreferenceSource = "model";
  try {
    const model = chat({
      model: "haiku",
      effort: "low",
      maxTokens: 500,
      disableThinking: true,
    }).withStructuredOutput(preferenceInterpretationSchema, { name: "recommendation_preferences" });
    const raw = await model.invoke([
      plainSystem(INTERPRET_PREFERENCES_PROMPT),
      { role: "user", content: `Soft preference text:\n${notes}` },
    ]);
    interpretation = preferenceInterpretationSchema.parse(raw);
  } catch {
    interpretation = interpretPreferenceKeywords(notes);
    source = "keyword_fallback";
  }

  const preferences = mergePreferenceInterpretation(rankingPreference, interpretation, source);
  attachTraceMetadata(preferences);
  return { recommendationPreferences: preferences };
}
