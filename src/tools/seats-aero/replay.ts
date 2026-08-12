import { readFile } from "node:fs/promises";
import path from "node:path";
import { SeatsAeroError, type SeatsAeroClient } from "./client";
import { requestKey } from "./request-key";
import type {
  QuotaState,
  RefreshResponse,
  RegionalParams,
  Route,
  SearchParams,
  SearchResponse,
  Trip,
} from "./types";

export const DEFAULT_FIXTURE_DIR = path.resolve(
  process.cwd(),
  "fixtures/seats-aero",
);

export function fixtureFile(
  endpoint: string,
  params: Record<string, unknown>,
): string {
  return `${requestKey(endpoint, params)}.json`;
}

/**
 * Serves recorded seats.aero responses. These are real captured payloads, not
 * hand-authored mocks — a wrong parser fails against them, which is the point.
 */
export class ReplaySeatsAeroClient implements SeatsAeroClient {
  constructor(private dir: string = DEFAULT_FIXTURE_DIR) {}

  quota(): QuotaState {
    // Replay mode spends no quota. Report a full budget so the cost HUD has
    // something coherent to display without special-casing the mode.
    return { limit: 1000, remaining: 1000, reset: 0 };
  }

  search(params: SearchParams): Promise<SearchResponse> {
    return this.load<SearchResponse>("/search", params);
  }

  regionalAvailability(params: RegionalParams): Promise<SearchResponse> {
    return this.load<SearchResponse>("/availability", params);
  }

  trips(availabilityId: string): Promise<{ data: Trip[] }> {
    return this.load<{ data: Trip[] }>(`/trips/${availabilityId}`, {});
  }

  routes(source: string): Promise<Route[]> {
    return this.load<Route[]>("/routes", { source });
  }

  /**
   * Fixtures are frozen, so nothing can go stale and nothing needs refreshing.
   * Reporting every id as `fresh` is also what the live API does for data that
   * is already current — and `fresh` items cost no quota there either.
   */
  async refresh(availabilityIds: string[]): Promise<RefreshResponse> {
    return {
      complete: true,
      items: availabilityIds.map((id) => ({ id, status: "fresh" as const })),
      processing: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  private async load<T>(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const file = path.join(this.dir, fixtureFile(endpoint, params));
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch {
      throw new SeatsAeroError(
        404,
        `No fixture for ${endpoint} ${JSON.stringify(params)}.\n` +
          `Expected: ${file}\n` +
          `Run \`make record\` with SEATS_AERO_API_KEY set to capture it.`,
      );
    }
  }
}
