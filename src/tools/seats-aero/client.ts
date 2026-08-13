import type {
  AvailabilityResult,
  QuotaState,
  RefreshResponse,
  RegionalParams,
  Route,
  SearchParams,
  SearchResponse,
  Trip,
} from "./types";

export class SeatsAeroError extends Error {
  public code?: string;

  constructor(
    public status: number,
    message: string,
    options?: { code?: string },
  ) {
    super(message);
    this.name = "SeatsAeroError";
    this.code = options?.code;
  }
}

/** Shared by live and replay so both enforce the same 1-250 batch limit. */
export function validateRefreshIds(ids: string[]): void {
  if (ids.length === 0 || ids.length > 250) {
    throw new SeatsAeroError(400, `refresh accepts 1-250 ids, got ${ids.length}`);
  }
}

/**
 * The only surface the rest of the app knows about. Live and replay both
 * implement it, so no caller can tell which is active.
 */
export interface SeatsAeroClient {
  search(params: SearchParams): Promise<SearchResponse>;
  regionalAvailability(params: RegionalParams): Promise<SearchResponse>;
  trips(availabilityId: string): Promise<{ data: Trip[] }>;
  routes(source: string): Promise<Route[]>;
  /** Not exposed as an LLM tool — it spends daily quota. */
  refresh(availabilityIds: string[]): Promise<RefreshResponse>;
  quota(): QuotaState;
}

export type { AvailabilityResult, SearchResponse, Trip, Route, QuotaState };
