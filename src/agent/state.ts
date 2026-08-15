import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { AwardOption, TripSummary } from "../tools";
import type { RetrievedDoc } from "../rag/retriever";

export type Intent = "route_search" | "discovery" | "knowledge" | "rejected";

/**
 * One program+region+cabin combination the discovery planner decided is worth
 * checking. Defined here, not in Task 4.5's own file, because SearchPlan
 * below needs to carry a real list of these verbatim — see `discoveryProbes`.
 */
export type DiscoveryProbe = {
  program: string;
  destinationRegion: string;
  cabin: string;
};

/** The structured plan a planner node produces. Data, not an action. */
export type SearchPlan = {
  origins: string[];
  destinations: string[];
  destinationRegion?: string;
  startDate?: string;
  endDate?: string;
  cabins: string[];
  nonstopOnly: boolean;
  programs: string[];
  /** Free-text note explaining choices, surfaced in traces and evals. */
  rationale?: string;
  /**
   * Place names Task 4.4's planner named that resolveLocation could not match
   * at all. Surfaced so synthesize (Task 4.7) can tell the user "I didn't
   * recognize X" instead of the search silently coming back empty.
   */
  unresolvedPlaces?: string[];
  /**
   * Place names that matched more than one real city (e.g. "San" matching San
   * Francisco/Diego/Jose) and were deliberately left unresolved rather than
   * guessed. Surfaced so synthesize can ask which one was meant.
   */
  ambiguousPlaces?: { query: string; candidates: string[] }[];
  /**
   * The discovery planner's actual ordered, budget-capped probe list — each
   * entry can name a DIFFERENT region, unlike the flattened `programs`/
   * `cabins`/`destinationRegion` fields above, which only summarize what's
   * here for display purposes. Task 4.6's search node reads this directly
   * (via Task 4.5's `probesFromPlan`); do not try to reconstruct probes from
   * the flattened fields — a cartesian product of programs x cabins sharing
   * one region is not the same set of probes the model actually chose.
   */
  discoveryProbes?: DiscoveryProbe[];
};

export type Violation = {
  kind: "unsupported_number" | "unsupported_flight" | "unsupported_airline" | "uncited_claim";
  detail: string;
};

/** Replace-on-write: a fresh search supersedes the previous one entirely. */
const replace = <T>(defaultValue: () => T) => ({
  reducer: (_current: T, update: T) => update,
  default: defaultValue,
});

/**
 * searchPlan's reducer. Unlike the other channels' blind `replace`, this
 * merges: a field the current turn's node output omits (undefined) keeps
 * whatever the checkpointer restored from the prior turn ("sticky" trip
 * criteria — origin, destination, dates, cabin). A field the update DOES
 * provide — including an explicit `false` or an empty array, both of which
 * are meaningful, present values, not "unset" — always wins. Per-turn
 * diagnostic fields (rationale, unresolvedPlaces, ambiguousPlaces,
 * discoveryProbes) are the opposite: they always take the update's value,
 * even when that's undefined, because a stale diagnostic from three turns
 * ago must never resurface on an unrelated turn.
 */
function mergeSearchPlan(
  current: SearchPlan | null,
  update: Partial<SearchPlan>,
): SearchPlan {
  const merged: SearchPlan = {
    origins: update.origins ?? current?.origins ?? [],
    destinations: update.destinations ?? current?.destinations ?? [],
    destinationRegion: update.destinationRegion ?? current?.destinationRegion,
    startDate: update.startDate ?? current?.startDate,
    endDate: update.endDate ?? current?.endDate,
    cabins: update.cabins ?? current?.cabins ?? [],
    nonstopOnly: update.nonstopOnly ?? current?.nonstopOnly ?? false,
    programs: update.programs ?? current?.programs ?? [],
    rationale: update.rationale,
    unresolvedPlaces: update.unresolvedPlaces,
    ambiguousPlaces: update.ambiguousPlaces,
    discoveryProbes: update.discoveryProbes,
  };
  if (!merged.startDate && !merged.endDate) {
    const today = new Date();
    merged.startDate = today.toISOString().slice(0, 10);
    merged.endDate = new Date(today.getTime() + 60 * 86_400_000)
      .toISOString()
      .slice(0, 10);
  }
  return merged;
}

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  intent: Annotation<Intent | null>(replace<Intent | null>(() => null)),
  refusalReason: Annotation<string | null>(replace<string | null>(() => null)),

  searchPlan: Annotation<SearchPlan | null, Partial<SearchPlan>>({
    reducer: mergeSearchPlan,
    default: () => null,
  }),
  awardResults: Annotation<AwardOption[]>(replace<AwardOption[]>(() => [])),
  tripSummaries: Annotation<TripSummary[]>(replace<TripSummary[]>(() => [])),
  kbDocs: Annotation<RetrievedDoc[]>(replace<RetrievedDoc[]>(() => [])),

  draft: Annotation<string | null>(replace<string | null>(() => null)),
  violations: Annotation<Violation[]>(replace<Violation[]>(() => [])),

  /** Additive so the retry budget can simply be compared against a limit. */
  revisionCount: Annotation<number>({
    reducer: (current, update) => current + update,
    default: () => 0,
  }),

  /** True when refresh actually re-confirmed data, for UI freshness labeling. */
  refreshedAt: Annotation<string | null>(replace<string | null>(() => null)),
});

export type AgentStateType = typeof AgentState.State;
export type AgentStateUpdate = typeof AgentState.Update;
