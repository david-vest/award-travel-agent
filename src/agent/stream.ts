// src/agent/stream.ts
import type { AgentStateType } from "./state";
import type { AwardOption } from "../tools";

export type LinkedOption = AwardOption & { mapUrl: string };

export type CostSummary = {
  usd: number;
  cacheHitRate: number;
  quotaRemaining: number | null;
  perNode: Array<{ node: string; usd: number }>;
};

export type StreamEvent =
  | { type: "status"; node: string; label: string }
  | { type: "token"; text: string }
  | { type: "done"; options: LinkedOption[]; cost: CostSummary }
  | { type: "error"; message: string };

/**
 * Node names are an implementation detail; users get plain phrases. The map
 * also documents what each node is for, which is why it lives beside the graph.
 */
export const NODE_LABELS: Record<string, string> = {
  guard_input: "Checking your question…",
  triage: "Working out what you're asking…",
  plan_search: "Planning the search…",
  plan_discovery: "Choosing destinations to check…",
  search_awards: "Searching award availability…",
  refresh_availability: "Re-confirming availability with the airline…",
  enrich_trips: "Looking up flight details…",
  retrieve_knowledge: "Consulting the award-travel knowledge base…",
  synthesize: "Writing your answer…",
  verify_groundedness: "Checking every figure against the data…",
  degrade: "Falling back to the raw results…",
  refuse: "…",
  emit: "…",
};

/**
 * `state` is the accumulation of partial node updates streamed so far, not a
 * full `AgentStateType` — early in the run most keys haven't been produced
 * yet. `Partial` here (rather than the plan's `AgentStateType`) is what lets
 * the caller pass that accumulator straight through without an unsafe cast.
 */
export function labelFor(node: string, state?: Partial<AgentStateType>): string {
  const base = NODE_LABELS[node];
  if (!base) return "Working…";

  // The search step is the slow one, so give it real specifics. `state` here
  // is route.ts's shallow-spread accumulation of streamed node updates, not a
  // merged plan — on a follow-up turn it can be the planner node's raw delta
  // (e.g. `{ cabins: ["business"] }`), so origins/programs may be absent.
  if (node === "search_awards" && state?.searchPlan) {
    const origins = state.searchPlan.origins ?? [];
    const programs = state.searchPlan.programs ?? [];
    const from = origins.slice(0, 2).join("/");
    const count = programs.length;
    if (from) {
      return count > 0
        ? `Searching ${count} program${count === 1 ? "" : "s"} from ${from}…`
        : `Searching availability from ${from}…`;
    }
  }

  return base;
}

const encoder = new TextEncoder();

/** Newline-delimited JSON. JSON.stringify escapes embedded newlines for us. */
export function encodeEvent(event: StreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}
