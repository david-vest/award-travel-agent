import { interrupt } from "@langchain/langgraph";
import type {
  ClarificationChoiceId,
  ClarificationRequest,
} from "../../contracts/travel-search";
import type { AgentStateType, AgentStateUpdate } from "../state";

export const SEARCH_CONSTRAINT_CLARIFICATION: ClarificationRequest = {
  id: "no-nonstop-premium-cabin",
  prompt: "I found no nonstop business or first-class awards. Which constraint should I relax?",
  choices: [
    {
      id: "allow_one_stop",
      label: "Allow one stop",
      description: "Keep the premium cabin and include itineraries with one connection.",
    },
    {
      id: "try_premium_economy",
      label: "Try premium economy",
      description: "Keep the nonstop requirement and search a lower cabin.",
    },
    {
      id: "keep_constraints",
      label: "Keep my brief",
      description: "Do not broaden the search; summarize the exact result instead.",
    },
  ],
};

/**
 * Human review is reserved for a choice that materially changes the trip.
 * Missing locations and ordinary defaults are handled by deterministic nodes;
 * a provider outage also must not masquerade as a preference question.
 */
export function needsSearchConstraintClarification(state: AgentStateType): boolean {
  const plan = state.searchPlan;
  return (
    state.intent !== "discovery" &&
    state.searchStatus === "searched" &&
    (state.awardResults?.length ?? 0) === 0 &&
    Boolean(plan?.nonstopOnly || plan?.stopPreference === "nonstop") &&
    Boolean(plan?.cabins.some((cabin) => cabin === "business" || cabin === "first")) &&
    !state.clarificationResolution
  );
}

export function clarifySearchConstraints(): AgentStateUpdate {
  const choiceId = interrupt<ClarificationRequest, ClarificationChoiceId>(
    SEARCH_CONSTRAINT_CLARIFICATION,
  );

  if (choiceId === "allow_one_stop") {
    return {
      clarificationResolution: choiceId,
      searchPlan: { nonstopOnly: false, stopPreference: "up_to_one" },
      positioningSearchComplete: false,
    };
  }

  if (choiceId === "try_premium_economy") {
    return {
      clarificationResolution: choiceId,
      searchPlan: { cabins: ["premium"] },
      positioningSearchComplete: false,
    };
  }

  return { clarificationResolution: "keep_constraints" };
}
