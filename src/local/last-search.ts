import type { AgentStage, ClarificationRequest, FlightRecommendation } from "../contracts/travel-search";
import {
  defaultRankingPreference,
  type RankingPreference,
} from "../domain/recommendation-preferences";
import { lastSearchSnapshotSchema } from "./last-search-schema";

/**
 * Browser-only data for the "resume my last search" experience. It includes
 * trip dates, point balances, recommendations, and recent chat messages.
 * Treat it as device-accessible until the application has authentication and
 * real key management.
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

export type StoredAgentRun = {
  status: "clarification" | "complete" | "error";
  stages: Record<AgentStage, "waiting" | "active" | "complete">;
  stageDetails: Record<AgentStage, string>;
  stageDurations: Partial<Record<AgentStage, number>>;
  recommendations: FlightRecommendation[];
  answer: string;
  error: string | null;
  threadId: string | null;
  /** Optional for snapshots written before Phase 9. */
  runId?: string | null;
  /** Optional for snapshots written before Phase 8. */
  clarification?: ClarificationRequest | null;
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

export function validateLastSearchSnapshot(value: unknown) {
  return lastSearchSnapshotSchema.safeParse(value);
}

export function parseLastSearchSnapshot(raw: string | null): LastSearchSnapshot | null {
  if (!raw) return null;

  try {
    const result = validateLastSearchSnapshot(JSON.parse(raw));
    if (!result.success) return null;

    const snapshot = result.data;
    return {
      ...snapshot,
      form: {
        ...snapshot.form,
        rankingPreference: snapshot.form.rankingPreference ?? defaultRankingPreference(),
      },
      chatMessages: snapshot.chatMessages ?? [],
    };
  } catch {
    return null;
  }
}
