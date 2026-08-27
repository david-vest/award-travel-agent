import { StateGraph, START, END } from "@langchain/langgraph";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { AIMessage } from "@langchain/core/messages";
import { AgentState, type AgentStateType } from "./state";
import { routeAfterGuard, routeAfterTriage, routeAfterSearch, routeAfterEnrich, routeAfterVerify } from "./routers";
import { guardInput, refuse } from "./nodes/guard";
import { triage } from "./nodes/triage";
import { prepareUiSearch } from "./nodes/prepare-ui-search";
import { resolveUiLocations } from "./nodes/resolve-ui-locations";
import { planSearch, currentPlanSearchClock } from "./nodes/plan-search";
import { planDiscovery } from "./nodes/plan-discovery";
import { searchAwards, searchPositioningOptions } from "./nodes/search";
import { enrichTrips } from "./nodes/enrich";
import { interpretPreferences } from "./nodes/interpret-preferences";
import { buildCandidateShortlist } from "./nodes/build-candidate-shortlist";
import { retrieveKnowledgeNode } from "./nodes/retrieve";
import { assessCandidateExperience } from "./nodes/assess-candidate-experience";
import { rankRecommendations } from "./nodes/rank-recommendations";
import { synthesize } from "./nodes/synthesize";
import { refreshAvailability } from "./nodes/refresh";
import { verifyGroundedness } from "./nodes/verify";
import { degrade } from "./nodes/degrade";
import { mongoClient, DB_NAME } from "../rag/store";

/** Turns the final draft into the assistant message the caller sees. */
async function emit(state: AgentStateType): Promise<Partial<AgentStateType>> {
  return { messages: [new AIMessage(state.draft ?? "")] };
}

// The counter must increment on the node that produces a draft, so the router
// can compare it against MAX_REVISIONS without a separate bookkeeping node.
// Only count this pass as a revision if it's responding to a prior
// groundedness violation — the first, clean synthesis attempt must NOT
// increment the counter, or routeAfterVerify's `revisionCount < MAX_REVISIONS`
// check would already be exhausted before the retry it's meant to allow.
const synthesizeAndCount = async (state: AgentStateType) => {
  const isRevision = (state.violations?.length ?? 0) > 0;
  return {
    ...(await synthesize(state)),
    revisionCount: isRevision ? 1 : 0, // additive reducer
  };
};

/** Shared node/edge wiring for both the checkpointed and uncheckpointed graph. */
function buildStateGraph() {
  return new StateGraph(AgentState)
    .addNode("guard_input", guardInput)
    .addNode("refuse", refuse)
    .addNode("triage", triage)
    .addNode("resolve_ui_locations", resolveUiLocations)
    .addNode("prepare_ui_search", prepareUiSearch)
    // Wrapped: planSearch's optional `now` param (added so evals can pin the
    // clock) structurally conflicts with LangGraph's NodeAction signature at
    // the type level, even though the graph always calls with one argument.
    // currentPlanSearchClock() is undefined in production, so this is
    // planSearch(state, undefined) there — identical to planSearch(state),
    // since a literal undefined still triggers planSearch's own `now`
    // default parameter.
    .addNode("plan_search", (state: AgentStateType) => planSearch(state, currentPlanSearchClock()?.()))
    .addNode("plan_discovery", planDiscovery)
    .addNode("search_awards", searchAwards)
    .addNode("search_positioning", searchPositioningOptions)
    .addNode("interpret_preferences", interpretPreferences)
    .addNode("build_candidate_shortlist", buildCandidateShortlist)
    .addNode("enrich_trips", enrichTrips)
    .addNode("retrieve_knowledge", retrieveKnowledgeNode)
    .addNode("assess_candidate_experience", assessCandidateExperience)
    .addNode("rank_recommendations", rankRecommendations)
    .addNode("synthesize", synthesizeAndCount)
    .addNode("refresh_availability", refreshAvailability)
    .addNode("verify_groundedness", verifyGroundedness)
    .addNode("degrade", degrade)
    .addNode("emit", emit)

    .addEdge(START, "guard_input")
    .addConditionalEdges("guard_input", routeAfterGuard, {
      triage: "triage",
      resolve_ui_locations: "resolve_ui_locations",
      refuse: "refuse",
    })
    .addEdge("refuse", "emit")

    .addConditionalEdges("triage", routeAfterTriage, {
      plan_search: "plan_search",
      plan_discovery: "plan_discovery",
      retrieve_knowledge: "retrieve_knowledge",
    })

    .addEdge("resolve_ui_locations", "prepare_ui_search")
    .addEdge("prepare_ui_search", "interpret_preferences")
    .addEdge("plan_search", "interpret_preferences")
    .addEdge("plan_discovery", "interpret_preferences")
    .addEdge("interpret_preferences", "search_awards")
    .addConditionalEdges("search_awards", routeAfterSearch, {
      refresh_availability: "refresh_availability",
      build_candidate_shortlist: "build_candidate_shortlist",
    })
    .addEdge("refresh_availability", "build_candidate_shortlist")
    .addEdge("build_candidate_shortlist", "enrich_trips")
    .addConditionalEdges("enrich_trips", routeAfterEnrich, {
      search_positioning: "search_positioning",
      retrieve_knowledge: "retrieve_knowledge",
    })
    .addEdge("search_positioning", "build_candidate_shortlist")
    .addEdge("retrieve_knowledge", "assess_candidate_experience")
    .addEdge("assess_candidate_experience", "rank_recommendations")
    .addEdge("rank_recommendations", "synthesize")
    .addEdge("synthesize", "verify_groundedness")
    .addConditionalEdges("verify_groundedness", routeAfterVerify, {
      synthesize: "synthesize",
      degrade: "degrade",
      emit: "emit",
    })
    .addEdge("degrade", "emit")
    .addEdge("emit", END);
}

export function buildGraphWithoutCheckpointer() {
  return buildStateGraph().compile();
}

/**
 * Production graph. The Mongo checkpointer gives real thread persistence —
 * conversations survive a restart and can be resumed by thread_id.
 */
export async function buildGraph() {
  const client = await mongoClient();
  const checkpointer = new MongoDBSaver({ client, dbName: DB_NAME });

  return buildStateGraph().compile({ checkpointer });
}
