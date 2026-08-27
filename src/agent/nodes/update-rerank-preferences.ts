import { getCurrentRunTree } from "langsmith/traceable";
import {
  interpretPreferenceKeywords,
  preferenceInterpretationSchema,
  type PreferenceInterpretation,
} from "./interpret-preferences";
import { chat } from "../models";
import { plainSystem } from "../cache";
import { INTERPRET_PREFERENCES_PROMPT } from "../prompts/interpret-preferences";
import { lastUserText } from "./triage";
import type { AgentStateType } from "../state";
import type {
  RecommendationPreferences,
  RecommendationPreferenceSource,
} from "../../domain/recommendation-preferences";

const INFERRED_PRIORITY_WEIGHT = 70;

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function mergeRerankPreferenceUpdate(
  current: RecommendationPreferences,
  update: PreferenceInterpretation,
  source: RecommendationPreferenceSource,
): RecommendationPreferences {
  const priorities = [...new Set([...current.priorities, ...update.priorities])];
  const priorityWeights = { ...current.priorityWeights };
  for (const priority of update.priorities) {
    priorityWeights[priority] = Math.max(priorityWeights[priority], INFERRED_PRIORITY_WEIGHT);
  }
  return {
    experienceWeight: clamp(current.experienceWeight + update.experienceAdjustment),
    priorities,
    priorityWeights,
    schedulePreferences: {
      avoidEarlyDepartures: current.schedulePreferences.avoidEarlyDepartures || update.avoidEarlyDepartures,
      avoidLateArrivals: current.schedulePreferences.avoidLateArrivals || update.avoidLateArrivals,
    },
    rationale: `${current.rationale} Follow-up: ${update.rationale}`.slice(0, 480),
    source,
  };
}

export async function updateRerankPreferences(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const snapshot = state.recommendationSnapshot;
  if (!snapshot) return { intent: "route_search" };
  const text = lastUserText(state);
  let interpretation: PreferenceInterpretation;
  let source: RecommendationPreferenceSource = "model";
  try {
    const model = chat({ model: "haiku", effort: "low", maxTokens: 500, disableThinking: true })
      .withStructuredOutput(preferenceInterpretationSchema, { name: "rerank_preference_update" });
    interpretation = preferenceInterpretationSchema.parse(await model.invoke([
      plainSystem(INTERPRET_PREFERENCES_PROMPT),
      { role: "user", content: `Update only the current soft ranking preference from this follow-up:\n${text}` },
    ]));
  } catch {
    interpretation = interpretPreferenceKeywords(text);
    source = "keyword_fallback";
  }
  const preferences = mergeRerankPreferenceUpdate(snapshot.recommendationPreferences, interpretation, source);
  try {
    const run = getCurrentRunTree(true);
    if (run) run.metadata = { ...run.metadata, rerank_reused_candidates: true, rerank_experience_weight: preferences.experienceWeight, rerank_priorities: preferences.priorities };
  } catch {
    // Observability cannot block a rerank.
  }
  return {
    intent: "rerank",
    awardResults: snapshot.awardResults,
    candidateShortlist: snapshot.candidateShortlist,
    tripSummaries: snapshot.tripSummaries,
    kbDocs: snapshot.kbDocs,
    optionEvidence: snapshot.optionEvidence,
    candidateAssessments: snapshot.candidateAssessments,
    recommendations: snapshot.recommendations,
    recommendationPreferences: preferences,
    searchStatus: snapshot.searchStatus,
    refreshedAt: snapshot.refreshedAt,
  };
}
