import { buildGraph, buildGraphWithoutCheckpointer } from "./graph";

type AgentGraph = ReturnType<typeof buildGraphWithoutCheckpointer>;

let graphPromise: Promise<AgentGraph> | undefined;

/** Reuse the compiled graph and its Mongo client across route-handler requests. */
export function getAgentGraph(): Promise<AgentGraph> {
  if (!graphPromise) {
    graphPromise = buildGraph().catch(() => buildGraphWithoutCheckpointer());
  }
  return graphPromise;
}
