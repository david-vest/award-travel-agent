import type { AgentStage, FlightRecommendation } from "../contracts/travel-search";
import {
  RANKING_EXPERIENCE_WEIGHTS,
  RANKING_PRIORITY_VALUES,
  defaultRankingPreference,
  type RankingPreference,
} from "../domain/recommendation-preferences";

/**
 * Unencrypted browser localStorage, scoped to the "resume my last search"
 * UX feature. What's stored: the full search form (including point
 * balances — creditCardBalances/awardProgramBalances — and trip dates), the
 * last run's flight recommendations, and recent chat messages. Every field
 * here is read back on load to repopulate the form; nothing is stored
 * speculatively.
 *
 * There is no authentication/session system in this app (a deliberate scope
 * decision — see docs/superpowers/plans/2026-08-17-phase-5-production-hardening.md),
 * so there's no "clear on logout" concept, and no per-user key to encrypt
 * this against — a device-level attacker with browser access can already
 * read any localStorage key regardless of encryption scheme without a real
 * key-management story. Real protection for this data requires that
 * deferred auth/session system, not a client-side encryption layer without
 * key management, which would be security theater.
 */
export const LAST_SEARCH_STORAGE_KEY = "roam:last-search:v1";

export type StoredLocation = {
  kind: "airport" | "city" | "group" | "custom";
  code: string;
  city: string;
  country: string;
  airports: string[];
};

export type StoredSearchForm = {
  origin: StoredLocation;
  destinations: StoredLocation[];
  startDate: string;
  endDate: string;
  flexDays: number;
  cabins: Array<"economy" | "premium" | "business" | "first">;
  travelers: string;
  selectedCreditPrograms: string[];
  selectedAwardPrograms: string[];
  creditCardBalances: Record<string, string>;
  awardProgramBalances: Record<string, string>;
  maxFees: string;
  stops: "nonstop" | "one" | "any";
  preferredAirlines: string[];
  rankingPreference: RankingPreference;
  notes: string;
};

type StoredSearchFormInput = Omit<StoredSearchForm, "rankingPreference"> & {
  rankingPreference?: RankingPreference;
};

export type StoredAgentRun = {
  status: "complete" | "error";
  stages: Record<AgentStage, "waiting" | "active" | "complete">;
  stageDetails: Record<AgentStage, string>;
  stageDurations: Partial<Record<AgentStage, number>>;
  recommendations: FlightRecommendation[];
  answer: string;
  error: string | null;
  threadId: string | null;
};

export type StoredChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type LastSearchSnapshot = {
  version: 1;
  savedAt: string;
  form: StoredSearchForm;
  /** Null while the first run for this form has not completed. */
  run: StoredAgentRun | null;
  chatMessages: StoredChatMessage[];
};

export function parseLastSearchSnapshot(raw: string | null): LastSearchSnapshot | null {
  if (!raw) return null;

  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || typeof value.savedAt !== "string") return null;
    if (!isSearchForm(value.form) || (value.run !== null && !isAgentRun(value.run))) return null;
    if (value.chatMessages !== undefined && !isChatMessages(value.chatMessages)) return null;
    return {
      ...value,
      form: {
        ...value.form,
        rankingPreference: value.form.rankingPreference ?? defaultRankingPreference(),
      },
      chatMessages: value.chatMessages ?? [],
    } as LastSearchSnapshot;
  } catch {
    return null;
  }
}

function isChatMessages(value: unknown): value is StoredChatMessage[] {
  return Array.isArray(value) && value.every((message) => isRecord(message)
    && typeof message.id === "string"
    && (message.role === "user" || message.role === "assistant")
    && typeof message.content === "string");
}

function isSearchForm(value: unknown): value is StoredSearchFormInput {
  if (!isRecord(value)) return false;
  return isLocation(value.origin)
    && Array.isArray(value.destinations) && value.destinations.length > 0 && value.destinations.every(isLocation)
    && isDateKey(value.startDate) && isDateKey(value.endDate)
    && typeof value.flexDays === "number" && Number.isInteger(value.flexDays) && value.flexDays >= 0 && value.flexDays <= 14
    && isAllowedStringArray(value.cabins, ["economy", "premium", "business", "first"])
    && value.cabins.length > 0
    && typeof value.travelers === "string"
    && isStringArray(value.selectedCreditPrograms)
    && isStringArray(value.selectedAwardPrograms)
    && isStringRecord(value.creditCardBalances)
    && isStringRecord(value.awardProgramBalances)
    && typeof value.maxFees === "string"
    && (value.stops === "nonstop" || value.stops === "one" || value.stops === "any")
    && isStringArray(value.preferredAirlines)
    && (value.rankingPreference === undefined || isRankingPreference(value.rankingPreference))
    && typeof value.notes === "string";
}

function isRankingPreference(value: unknown): value is RankingPreference {
  if (!isRecord(value)) return false;
  if (!Number.isInteger(value.experienceWeight) || !isFiniteNumber(value.experienceWeight)) return false;
  if (!RANKING_EXPERIENCE_WEIGHTS.some((weight) => weight === value.experienceWeight)) return false;
  if (!isAllowedStringArray(value.priorities, RANKING_PRIORITY_VALUES)) return false;
  return value.priorities.length <= RANKING_PRIORITY_VALUES.length && new Set(value.priorities).size === value.priorities.length;
}

function isAgentRun(value: unknown): value is StoredAgentRun {
  if (!isRecord(value)) return false;
  return (value.status === "complete" || value.status === "error")
    && isStageStates(value.stages)
    && isStageDetails(value.stageDetails)
    && isStageDurations(value.stageDurations)
    && Array.isArray(value.recommendations) && value.recommendations.every(isFlightRecommendation)
    && typeof value.answer === "string"
    && (value.error === null || typeof value.error === "string")
    && (value.threadId === null || typeof value.threadId === "string");
}

function isLocation(value: unknown): value is StoredLocation {
  if (!isRecord(value)) return false;
  return isAllowedString(value.kind, ["airport", "city", "group", "custom"])
    && typeof value.code === "string"
    && typeof value.city === "string"
    && typeof value.country === "string"
    && isStringArray(value.airports);
}

function isFlightRecommendation(value: unknown): value is FlightRecommendation {
  if (!isRecord(value) || !isRecord(value.program)) return false;
  return typeof value.id === "string"
    && isFiniteNumber(value.rank)
    && typeof value.origin === "string"
    && typeof value.destination === "string"
    && typeof value.date === "string"
    && typeof value.cabin === "string"
    && isFiniteNumber(value.miles)
    && typeof value.program.id === "string"
    && typeof value.program.label === "string"
    && isStringArray(value.carriers)
    && typeof value.direct === "boolean"
    && (value.taxes === undefined || (isRecord(value.taxes) && isFiniteNumber(value.taxes.amount) && typeof value.taxes.currency === "string"))
    && (value.stops === undefined || isFiniteNumber(value.stops))
    && (value.connections === undefined || (Array.isArray(value.connections) && value.connections.every((connection) => isRecord(connection)
      && typeof connection.airport === "string"
      && (connection.layoverMinutes === undefined || isFiniteNumber(connection.layoverMinutes)))))
    && (value.remainingSeats === undefined || isFiniteNumber(value.remainingSeats))
    && (value.departsAt === undefined || typeof value.departsAt === "string")
    && (value.arrivesAt === undefined || typeof value.arrivesAt === "string")
    && (value.durationMinutes === undefined || isFiniteNumber(value.durationMinutes))
    && isStringArray(value.flightNumbers)
    && isStringArray(value.aircraft)
    && (value.refreshedAt === undefined || typeof value.refreshedAt === "string")
    && typeof value.reason === "string"
    && Array.isArray(value.scoreFactors)
    && value.scoreFactors.every((factor) => isRecord(factor) && typeof factor.label === "string" && typeof factor.value === "string")
    && (value.confidence === "high" || value.confidence === "medium" || value.confidence === "low")
    && (value.positioning === undefined || (isRecord(value.positioning)
      && (value.positioning.tier === "destination_gateway" || value.positioning.tier === "country_pair" || value.positioning.tier === "region_pair")
      && (value.positioning.before === undefined || typeof value.positioning.before === "string")
      && (value.positioning.after === undefined || typeof value.positioning.after === "string")
      && typeof value.positioning.explanation === "string"));
}

function isStageStates(value: unknown): value is StoredAgentRun["stages"] {
  return isRecord(value) && ["search", "rules", "rank"].every((stage) => {
    const state = value[stage];
    return state === "waiting" || state === "active" || state === "complete";
  });
}

function isStageDetails(value: unknown): value is StoredAgentRun["stageDetails"] {
  return isRecord(value) && ["search", "rules", "rank"].every((stage) => typeof value[stage] === "string");
}

function isStageDurations(value: unknown): value is StoredAgentRun["stageDurations"] {
  return isRecord(value) && Object.values(value).every((duration) => typeof duration === "number" && Number.isFinite(duration));
}

function isDateKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAllowedString<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function isAllowedStringArray<T extends string>(value: unknown, allowed: readonly T[]): value is T[] {
  return Array.isArray(value) && value.every((item) => isAllowedString(item, allowed));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
