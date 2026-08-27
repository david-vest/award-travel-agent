import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { AwardOption, TripSummary } from "../tools";
import type { OptionEvidence, RetrievedDoc } from "../rag/retriever";
import type { CandidateAssessments } from "../domain/candidate-assessment";
import type {
  ClarificationChoiceId,
  FlightRecommendation,
  TripRequest,
} from "../contracts/travel-search";
import {
  defaultRecommendationPreferences,
  type RecommendationPreferences,
} from "../domain/recommendation-preferences";

export type Intent = "route_search" | "discovery" | "knowledge" | "rerank" | "rejected";
export type SearchStatus = "not_run" | "searched" | "provider_error";

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
  stopPreference?: "nonstop" | "up_to_one" | "any";
  programs: string[];
  preferredAirlines?: string[];
  travelers?: number;
  /** Program-source keyed points available after combining transferable and direct balances. */
  availablePointsByProgram?: Record<string, number>;
  /** When true, programs missing from availablePointsByProgram have a zero balance. */
  filterByPointBalances?: boolean;
  /** Per-traveler USD cash ceiling, passed to seats.aero and checked again after enrichment. */
  maxTaxesFeesUsd?: number;
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

export type LocationResolution = {
  query: string;
  airports: string[];
  explanation: string;
};

export type SearchAttempt = {
  tier: "exact" | "destination_gateway" | "country_pair" | "region_pair";
  origins: string[];
  destinations: string[];
  reason: string;
  resultCount: number;
};

/** Durable, already-paid-for recommendation inputs reusable across follow-up turns. */
export type RecommendationSnapshot = {
  awardResults: AwardOption[];
  candidateShortlist: AwardOption[];
  tripSummaries: TripSummary[];
  kbDocs: RetrievedDoc[];
  optionEvidence: OptionEvidence;
  candidateAssessments: CandidateAssessments;
  recommendations: FlightRecommendation[];
  recommendationPreferences: RecommendationPreferences;
  searchStatus: SearchStatus;
  refreshedAt: string | null;
};

/** Replace-on-write: a fresh search supersedes the previous one entirely. */
const replace = <T>(defaultValue: () => T) => ({
  reducer: (_current: T, update: T) => update,
  default: defaultValue,
});

/**
 * searchPlan's reducer.
 *
 * Sticky (merge — an omitted update field keeps the checkpointed value from
 * the prior turn): origins, destinations, destinationRegion, startDate,
 * endDate, cabins, nonstopOnly, stopPreference, programs, preferredAirlines,
 * travelers, availablePointsByProgram, filterByPointBalances,
 * maxTaxesFeesUsd. An explicit `false`/`0`/`[]` from the update always wins
 * over a sticky field's carried-forward value — `??` treats only `undefined`
 * as "the update didn't touch this."
 *
 * Per-turn (reset — always takes the update's value, even `undefined`, so a
 * stale diagnostic from an earlier turn never resurfaces): rationale,
 * unresolvedPlaces, ambiguousPlaces, discoveryProbes.
 *
 * A literal `null` update (rather than a partial object) is a deliberate
 * full reset — prepareUiSearch returns this when a UI run carries no
 * request — and bypasses merging entirely rather than throwing on
 * `update.origins`.
 */
export function mergeSearchPlan(
  current: SearchPlan | null,
  update: Partial<SearchPlan> | null,
  now: () => Date = () => new Date(),
): SearchPlan | null {
  if (update === null) return null;
  const merged: SearchPlan = {
    origins: update.origins ?? current?.origins ?? [],
    destinations: update.destinations ?? current?.destinations ?? [],
    destinationRegion: update.destinationRegion ?? current?.destinationRegion,
    startDate: update.startDate ?? current?.startDate,
    endDate: update.endDate ?? current?.endDate,
    cabins: update.cabins ?? current?.cabins ?? [],
    nonstopOnly: update.nonstopOnly ?? current?.nonstopOnly ?? false,
    stopPreference: update.stopPreference ?? current?.stopPreference,
    programs: update.programs ?? current?.programs ?? [],
    preferredAirlines: update.preferredAirlines ?? current?.preferredAirlines,
    travelers: update.travelers ?? current?.travelers,
    availablePointsByProgram: update.availablePointsByProgram ?? current?.availablePointsByProgram,
    filterByPointBalances: update.filterByPointBalances ?? current?.filterByPointBalances,
    maxTaxesFeesUsd: update.maxTaxesFeesUsd ?? current?.maxTaxesFeesUsd,
    rationale: update.rationale,
    unresolvedPlaces: update.unresolvedPlaces,
    ambiguousPlaces: update.ambiguousPlaces,
    discoveryProbes: update.discoveryProbes,
  };
  if (!merged.startDate && !merged.endDate) {
    const today = now();
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

  searchPlan: Annotation<SearchPlan | null, Partial<SearchPlan> | null>({
    reducer: mergeSearchPlan,
    default: () => null,
  }),
  /** Present only for a structured form submission; chat continues through planners. */
  tripRequest: Annotation<TripRequest | null>(replace<TripRequest | null>(() => null)),
  locationResolutions: Annotation<LocationResolution[]>(replace<LocationResolution[]>(() => [])),
  searchAttempts: Annotation<SearchAttempt[]>(replace<SearchAttempt[]>(() => [])),
  positioningSearchComplete: Annotation<boolean>(replace<boolean>(() => false)),
  awardResults: Annotation<AwardOption[]>(replace<AwardOption[]>(() => [])),
  /** Eligible, coverage-preserving subset that is allowed to consume detail lookups. */
  candidateShortlist: Annotation<AwardOption[]>(replace<AwardOption[]>(() => [])),
  searchStatus: Annotation<SearchStatus>(replace<SearchStatus>(() => "not_run")),
  tripSummaries: Annotation<TripSummary[]>(replace<TripSummary[]>(() => [])),
  recommendations: Annotation<FlightRecommendation[]>(replace<FlightRecommendation[]>(() => [])),
  kbDocs: Annotation<RetrievedDoc[]>(replace<RetrievedDoc[]>(() => [])),
  /** Strictly matched scoring evidence, keyed by recommendation option ID. */
  optionEvidence: Annotation<OptionEvidence>(replace<OptionEvidence>(() => ({}))),
  /** Bounded qualitative model output; objective flight facts are scored later in code. */
  candidateAssessments: Annotation<CandidateAssessments>(replace<CandidateAssessments>(() => ({}))),
  /** Not reset by guard_input; replaced only by a completed search/rerank or an explicit new search. */
  recommendationSnapshot: Annotation<RecommendationSnapshot | null>(
    replace<RecommendationSnapshot | null>(() => null),
  ),
  recommendationPreferences: Annotation<RecommendationPreferences>(
    replace<RecommendationPreferences>(defaultRecommendationPreferences),
  ),
  /** Per-turn answer to a consequential search-relaxation interrupt. */
  clarificationResolution: Annotation<ClarificationChoiceId | null>(
    replace<ClarificationChoiceId | null>(() => null),
  ),

  draft: Annotation<string | null>(replace<string | null>(() => null)),
  violations: Annotation<Violation[]>(replace<Violation[]>(() => [])),
  /**
   * Per-turn record of a dependency that failed and was silently degraded
   * around (e.g. refresh, RAG retrieval) rather than failing the turn.
   * guard.ts resets this to [] on every turn (guard_input is the graph's
   * entry node); a node that degrades appends its own reason to whatever
   * the current turn already has, so the trace/UI can distinguish "nothing
   * was wrong" from "a dependency failed and this answer is degraded."
   */
  degradedReasons: Annotation<string[]>(replace<string[]>(() => [])),

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
