import type { AgentStateType } from "./state";

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
