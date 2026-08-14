import { StateGraph, START, END } from "@langchain/langgraph";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { AIMessage } from "@langchain/core/messages";
import { AgentState, type AgentStateType } from "./state";
import { routeAfterGuard, routeAfterTriage, routeAfterSearch, routeAfterVerify } from "./routers";
import { guardInput, refuse } from "./nodes/guard";
import { triage } from "./nodes/triage";
import { planSearch } from "./nodes/plan-search";
import { planDiscovery } from "./nodes/plan-discovery";
import { searchAwards } from "./nodes/search";
import { enrichTrips } from "./nodes/enrich";
import { retrieveKnowledgeNode } from "./nodes/retrieve";
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

export function buildGraphWithoutCheckpointer() {
  return new StateGraph(AgentState)
    .addNode("guard_input", guardInput)
    .addNode("refuse", refuse)
    .addNode("triage", triage)
    .addNode("plan_search", planSearch)
    .addNode("plan_discovery", planDiscovery)
    .addNode("search_awards", searchAwards)
    .addNode("enrich_trips", enrichTrips)
    .addNode("retrieve_knowledge", retrieveKnowledgeNode)
    .addNode("synthesize", synthesizeAndCount)
    .addNode("refresh_availability", refreshAvailability)
    .addNode("verify_groundedness", verifyGroundedness)
    .addNode("degrade", degrade)
    .addNode("emit", emit)

    .addEdge(START, "guard_input")
    .addConditionalEdges("guard_input", routeAfterGuard, {
      triage: "triage",
      refuse: "refuse",
    })
    .addEdge("refuse", "emit")

    .addConditionalEdges("triage", routeAfterTriage, {
      plan_search: "plan_search",
      plan_discovery: "plan_discovery",
      retrieve_knowledge: "retrieve_knowledge",
    })

    .addEdge("plan_search", "search_awards")
    .addEdge("plan_discovery", "search_awards")
    .addConditionalEdges("search_awards", routeAfterSearch, {
      refresh_availability: "refresh_availability",
      enrich_trips: "enrich_trips",
    })
    .addEdge("refresh_availability", "enrich_trips")
    .addEdge("enrich_trips", "retrieve_knowledge")
    .addEdge("retrieve_knowledge", "synthesize")
    .addEdge("synthesize", "verify_groundedness")
    .addConditionalEdges("verify_groundedness", routeAfterVerify, {
      synthesize: "synthesize",
      degrade: "degrade",
      emit: "emit",
    })
    .addEdge("degrade", "emit")
    .addEdge("emit", END)
    .compile();
}

/**
 * Production graph. The Mongo checkpointer gives real thread persistence —
 * conversations survive a restart and can be resumed by thread_id.
 */
export async function buildGraph() {
  const client = await mongoClient();
  const checkpointer = new MongoDBSaver({ client, dbName: DB_NAME });

  return new StateGraph(AgentState)
    .addNode("guard_input", guardInput)
    .addNode("refuse", refuse)
    .addNode("triage", triage)
    .addNode("plan_search", planSearch)
    .addNode("plan_discovery", planDiscovery)
    .addNode("search_awards", searchAwards)
    .addNode("enrich_trips", enrichTrips)
    .addNode("retrieve_knowledge", retrieveKnowledgeNode)
    .addNode("synthesize", synthesizeAndCount)
    .addNode("refresh_availability", refreshAvailability)
    .addNode("verify_groundedness", verifyGroundedness)
    .addNode("degrade", degrade)
    .addNode("emit", emit)

    .addEdge(START, "guard_input")
    .addConditionalEdges("guard_input", routeAfterGuard, {
      triage: "triage",
      refuse: "refuse",
    })
    .addEdge("refuse", "emit")
    .addConditionalEdges("triage", routeAfterTriage, {
      plan_search: "plan_search",
      plan_discovery: "plan_discovery",
      retrieve_knowledge: "retrieve_knowledge",
    })
    .addEdge("plan_search", "search_awards")
    .addEdge("plan_discovery", "search_awards")
    .addConditionalEdges("search_awards", routeAfterSearch, {
      refresh_availability: "refresh_availability",
      enrich_trips: "enrich_trips",
    })
    .addEdge("refresh_availability", "enrich_trips")
    .addEdge("enrich_trips", "retrieve_knowledge")
    .addEdge("retrieve_knowledge", "synthesize")
    .addEdge("synthesize", "verify_groundedness")
    .addConditionalEdges("verify_groundedness", routeAfterVerify, {
      synthesize: "synthesize",
      degrade: "degrade",
      emit: "emit",
    })
    .addEdge("degrade", "emit")
    .addEdge("emit", END)
    .compile({ checkpointer });
}
