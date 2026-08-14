import { StateGraph, START, END } from "@langchain/langgraph";
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb";
import { AIMessage } from "@langchain/core/messages";
import { AgentState, type AgentStateType } from "./state";
import { routeAfterGuard, routeAfterTriage } from "./routers";
import { guardInput, refuse } from "./nodes/guard";
import { triage } from "./nodes/triage";
import { planSearch } from "./nodes/plan-search";
import { planDiscovery } from "./nodes/plan-discovery";
import { searchAwards } from "./nodes/search";
import { enrichTrips } from "./nodes/enrich";
import { retrieveKnowledgeNode } from "./nodes/retrieve";
import { synthesize } from "./nodes/synthesize";
import { mongoClient, DB_NAME } from "../rag/store";

/** Turns the final draft into the assistant message the caller sees. */
async function emit(state: AgentStateType): Promise<Partial<AgentStateType>> {
  return { messages: [new AIMessage(state.draft ?? "")] };
}

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
    .addNode("synthesize", synthesize)
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
    // Phase 5 inserts the refresh loop between search_awards and enrich_trips.
    .addEdge("search_awards", "enrich_trips")
    .addEdge("enrich_trips", "retrieve_knowledge")
    .addEdge("retrieve_knowledge", "synthesize")
    // Phase 5 replaces this edge with the groundedness gate.
    .addEdge("synthesize", "emit")
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
    .addNode("synthesize", synthesize)
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
    .addEdge("search_awards", "enrich_trips")
    .addEdge("enrich_trips", "retrieve_knowledge")
    .addEdge("retrieve_knowledge", "synthesize")
    .addEdge("synthesize", "emit")
    .addEdge("emit", END)
    .compile({ checkpointer });
}
