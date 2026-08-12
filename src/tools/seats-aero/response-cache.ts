import type { Db } from "mongodb";
import type { SeatsAeroClient } from "./client";
import { requestKey } from "./request-key";
import type {
  RegionalParams,
  RefreshResponse,
  Route,
  SearchParams,
  SearchResponse,
  Trip,
} from "./types";

/** Matches the 6h staleness threshold the refresh gate uses. */
export const CACHE_TTL_SECONDS = 6 * 60 * 60;

export interface CacheStore {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/**
 * MongoDB-backed store. The TTL index does the expiry — no sweeper needed.
 * Call once at startup; creating the index is idempotent.
 */
export async function mongoCacheStore(db: Db): Promise<CacheStore> {
  const col = db.collection("seats_aero_cache");
  await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: CACHE_TTL_SECONDS });
  await col.createIndex({ key: 1 }, { unique: true });

  return {
    async get(key) {
      const doc = await col.findOne({ key });
      return doc?.value;
    },
    async set(key, value) {
      await col.updateOne(
        { key },
        { $set: { key, value, createdAt: new Date() } },
        { upsert: true },
      );
    },
  };
}

/**
 * Decorator, not a subclass — caching is orthogonal to how a response is
 * obtained, so neither the live nor the replay client needs to know about it.
 */
export function withResponseCache(
  inner: SeatsAeroClient,
  store: CacheStore,
): SeatsAeroClient {
  async function through<T>(
    endpoint: string,
    params: Record<string, unknown>,
    call: () => Promise<T>,
  ): Promise<T> {
    const key = requestKey(endpoint, params);
    const hit = await store.get(key);
    if (hit !== undefined) return hit as T;
    const fresh = await call();
    await store.set(key, fresh);
    return fresh;
  }

  return {
    search: (p: SearchParams) =>
      through<SearchResponse>("/search", p, () => inner.search(p)),
    regionalAvailability: (p: RegionalParams) =>
      through<SearchResponse>("/availability", p, () =>
        inner.regionalAvailability(p),
      ),
    trips: (id: string) =>
      through<{ data: Trip[] }>(`/trips/${id}`, {}, () => inner.trips(id)),
    routes: (source: string) =>
      through<Route[]>("/routes", { source }, () => inner.routes(source)),
    // Deliberately uncached: refresh exists to defeat stale data.
    refresh: (ids: string[]): Promise<RefreshResponse> => inner.refresh(ids),
    quota: () => inner.quota(),
  };
}
