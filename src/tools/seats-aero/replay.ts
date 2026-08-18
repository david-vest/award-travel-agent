import { readFile } from "node:fs/promises";
import path from "node:path";
import { SeatsAeroError, validateRefreshIds, type SeatsAeroClient } from "./client";
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

type ManifestEntry = { endpoint: string; params: Record<string, unknown> };

/** The cabin(s) a request or a recorded manifest entry targets, for fallback scoring. */
function cabinsOf(endpoint: string, params: Record<string, unknown>): Set<string> {
  const raw = endpoint === "/availability" ? params.cabin : params.cabins;
  return new Set(String(raw ?? "").split(",").filter(Boolean));
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const item of a) if (b.has(item)) n++;
  return n;
}

/**
 * Serves recorded seats.aero responses. These are real captured payloads, not
 * hand-authored mocks — a wrong parser fails against them, which is the point.
 */
export class ReplaySeatsAeroClient implements SeatsAeroClient {
  constructor(private dir: string = DEFAULT_FIXTURE_DIR) {}
  private manifestPromise?: Promise<Record<string, ManifestEntry> | undefined>;

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
    validateRefreshIds(availabilityIds);
    return {
      complete: true,
      items: availabilityIds.map((id) => ({ id, status: "fresh" as const })),
      processing: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  private loadManifest(): Promise<Record<string, ManifestEntry> | undefined> {
    if (!this.manifestPromise) {
      this.manifestPromise = readFile(path.join(this.dir, "manifest.json"), "utf8")
        .then((raw) => JSON.parse(raw) as Record<string, ManifestEntry>)
        .catch(() => undefined);
    }
    return this.manifestPromise;
  }

  /**
   * The UI lets a reviewer with no key search anything, not just the fixed
   * query set `make record` captured for evals. Rather than fail outright on
   * an unrecorded route/date, serve the recorded fixture for the same
   * endpoint that best matches the request, so the app still demonstrates
   * real seats.aero data end to end. Non-empty fixtures always outrank empty
   * ones — an empty recorded response is a legitimate capture (that route
   * simply had no availability that day) but useless as a stand-in for an
   * unrelated request — and cabin overlap breaks ties among non-empty ones.
   * Falls back to nothing (letting the caller 404) when the manifest is
   * absent or has no fixture for this endpoint at all — that keeps
   * `make record` drift detectable.
   */
  private async findClosestFixture(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (endpoint !== "/search" && endpoint !== "/availability") return undefined;
    const manifest = await this.loadManifest();
    if (!manifest) return undefined;

    const requestedCabins = cabinsOf(endpoint, params);
    let best: { file: string; score: number } | undefined;
    for (const [file, entry] of Object.entries(manifest)) {
      if (entry.endpoint !== endpoint) continue;
      const hasData = await this.hasData(file);
      const cabinScore = overlapCount(requestedCabins, cabinsOf(endpoint, entry.params));
      const score = (hasData ? 1000 : 0) + cabinScore;
      if (!best || score > best.score) best = { file, score };
    }
    return best?.file;
  }

  private async hasData(file: string): Promise<boolean> {
    try {
      const raw = await readFile(path.join(this.dir, file), "utf8");
      const body = JSON.parse(raw) as { data?: unknown[] };
      return Array.isArray(body.data) && body.data.length > 0;
    } catch {
      return false;
    }
  }

  private async load<T>(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const exactFile = fixtureFile(endpoint, params);
    let file = path.join(this.dir, exactFile);

    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      const fallback = await this.findClosestFixture(endpoint, params);
      if (fallback === undefined) {
        throw new SeatsAeroError(
          404,
          `No fixture for ${endpoint} ${JSON.stringify(params)}.\n` +
            `Expected: ${file}\n` +
            `Run \`make record\` with SEATS_AERO_API_KEY set to capture it.`,
          { code: "FIXTURE_MISSING" },
        );
      }
      file = path.join(this.dir, fallback);
      raw = await readFile(file, "utf8");
    }

    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new SeatsAeroError(
        404,
        `Corrupt fixture at ${file}: ${(err as Error).message}. ` +
          `Delete it and re-record the fixture.`,
        { code: "FIXTURE_CORRUPT" },
      );
    }
  }
}
