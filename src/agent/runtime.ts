import { buildGraph, buildGraphWithoutCheckpointer } from "./graph";

type AgentGraph = ReturnType<typeof buildGraphWithoutCheckpointer>;

let graphPromise: Promise<AgentGraph> | undefined;

/**
 * Reuse the compiled graph and its Mongo client across route-handler
 * requests. Only a SUCCESSFUL buildGraph() is memoized — a transient
 * failure (e.g. Mongo briefly unreachable at startup) must not become a
 * permanent fallback for the process lifetime. On failure, the fallback
 * (uncheckpointed) graph serves this one call, but the memoized promise is
 * cleared so the next call retries buildGraph() fresh.
 */
export function getAgentGraph(): Promise<AgentGraph> {
  if (!graphPromise) {
    graphPromise = buildGraph();
  }
  return graphPromise.catch(() => {
    graphPromise = undefined;
    return buildGraphWithoutCheckpointer();
  });
}
