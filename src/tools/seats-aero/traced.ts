import { traceable } from "langsmith/traceable";
import type { SeatsAeroClient } from "./client";
import type {
  RefreshResponse,
  RegionalParams,
  Route,
  SearchParams,
  SearchResponse,
  Trip,
} from "./types";

/**
 * Makes every seats.aero call a child span in the LangSmith trace. Without
 * this, a discovery turn is one opaque 12-second node; with it you can see six
 * probes, their individual latencies, and the quota remaining after each.
 *
 * quota() stays untraced — it is a synchronous local read, and a span per call
 * would bury the spans that matter.
 */
export function withTracing(inner: SeatsAeroClient): SeatsAeroClient {
  const meta = () => ({ quotaRemaining: inner.quota().remaining });

  return {
    search: traceable(
      async (params: SearchParams): Promise<SearchResponse> => {
        const res = await inner.search(params);
        return res;
      },
      { name: "seats_aero.search", run_type: "tool", metadata: meta() },
    ),

    regionalAvailability: traceable(
      async (params: RegionalParams): Promise<SearchResponse> =>
        inner.regionalAvailability(params),
      { name: "seats_aero.regional_availability", run_type: "tool", metadata: meta() },
    ),

    trips: traceable(
      async (id: string): Promise<{ data: Trip[] }> => inner.trips(id),
      { name: "seats_aero.trips", run_type: "tool", metadata: meta() },
    ),

    routes: traceable(
      async (source: string): Promise<Route[]> => inner.routes(source),
      { name: "seats_aero.routes", run_type: "tool", metadata: meta() },
    ),

    refresh: traceable(
      async (ids: string[]): Promise<RefreshResponse> => inner.refresh(ids),
      { name: "seats_aero.refresh", run_type: "tool", metadata: meta() },
    ),

    quota: () => inner.quota(),
  };
}
