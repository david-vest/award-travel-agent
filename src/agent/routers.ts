import type { AgentStateType } from "./state";
import { shouldRefresh } from "./nodes/refresh";
import { needsPositioningSearch } from "./nodes/search";
import { needsSearchConstraintClarification } from "./nodes/clarify-search-constraints";

export function routeAfterGuard(state: AgentStateType): "triage" | "resolve_ui_locations" | "refuse" {
  if (state.intent === "rejected") return "refuse";
  return state.tripRequest ? "resolve_ui_locations" : "triage";
}

export function routeAfterTriage(
  state: AgentStateType,
): "plan_search" | "plan_discovery" | "retrieve_knowledge" | "update_rerank_preferences" {
  switch (state.intent) {
    case "route_search":
      return "plan_search";
    case "discovery":
      return "plan_discovery";
    case "knowledge":
      return "retrieve_knowledge";
    case "rerank":
      return "update_rerank_preferences";
    default:
      // Unexpected intent: answer from knowledge rather than crashing the turn.
      return "retrieve_knowledge";
  }
}

/** One retry, then degrade. Unbounded self-correction is where demos hang. */
export const MAX_REVISIONS = 1;

export function routeAfterSearch(
  state: AgentStateType,
): "clarify_search_constraints" | "refresh_availability" | "build_candidate_shortlist" {
  if (needsSearchConstraintClarification(state)) return "clarify_search_constraints";
  return shouldRefresh(state) ? "refresh_availability" : "build_candidate_shortlist";
}

export function routeAfterClarification(
  state: AgentStateType,
): "search_awards" | "build_candidate_shortlist" {
  return state.clarificationResolution === "keep_constraints"
    ? "build_candidate_shortlist"
    : "search_awards";
}

export function routeAfterEnrich(
  state: AgentStateType,
): "search_positioning" | "retrieve_knowledge" {
  return needsPositioningSearch(state) ? "search_positioning" : "retrieve_knowledge";
}

export function routeAfterVerify(
  state: AgentStateType,
): "synthesize" | "degrade" | "emit" {
  const violations = state.violations ?? [];
  if (violations.length === 0) return "emit";
  return (state.revisionCount ?? 0) < MAX_REVISIONS ? "synthesize" : "degrade";
}
