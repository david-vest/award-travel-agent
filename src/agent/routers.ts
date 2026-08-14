import type { AgentStateType } from "./state";
import { shouldRefresh } from "./nodes/refresh";

export function routeAfterGuard(state: AgentStateType): "triage" | "refuse" {
  return state.intent === "rejected" ? "refuse" : "triage";
}

export function routeAfterTriage(
  state: AgentStateType,
): "plan_search" | "plan_discovery" | "retrieve_knowledge" {
  switch (state.intent) {
    case "route_search":
      return "plan_search";
    case "discovery":
      return "plan_discovery";
    case "knowledge":
      return "retrieve_knowledge";
    default:
      // Unexpected intent: answer from knowledge rather than crashing the turn.
      return "retrieve_knowledge";
  }
}

/** One retry, then degrade. Unbounded self-correction is where demos hang. */
export const MAX_REVISIONS = 1;

export function routeAfterSearch(
  state: AgentStateType,
): "refresh_availability" | "enrich_trips" {
  return shouldRefresh(state) ? "refresh_availability" : "enrich_trips";
}

export function routeAfterVerify(
  state: AgentStateType,
): "synthesize" | "degrade" | "emit" {
  const violations = state.violations ?? [];
  if (violations.length === 0) return "emit";
  return (state.revisionCount ?? 0) < MAX_REVISIONS ? "synthesize" : "degrade";
}
