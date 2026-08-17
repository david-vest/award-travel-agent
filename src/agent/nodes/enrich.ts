// src/agent/nodes/enrich.ts
import { makeGetTripDetailsTool, type AwardOption, type TripSummary } from "../../tools";
import { chat } from "../models";
import { plainSystem } from "../cache";
import { ENRICH_PROMPT } from "../prompts/enrich";
import type { AgentStateType } from "../state";
import { ENRICH_TOP_N, getClient } from "./search";

export type ToolCallLike = { name: string; args: Record<string, unknown> };

/**
 * Deduped availabilityIds the model actually asked to look up, restricted to
 * `candidateIds` — the ones actually offered to the model. Guards against a
 * hallucinated or malformed id triggering a wasted lookup.
 */
export function idsFromToolCalls(
  toolCalls: ToolCallLike[],
  candidateIds: string[],
): string[] {
  const candidates = new Set(candidateIds);
  const ids = toolCalls
    .filter((c) => c.name === "get_trip_details")
    .map((c) => c.args.availabilityId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id) => candidates.has(id));
  return [...new Set(ids)];
}

/**
 * Deliberately excludes flight numbers and aircraft — that is exactly what
 * get_trip_details exists to fetch. Showing it here would remove the reason
 * to call the tool at all.
 */
export function describeCandidates(options: AwardOption[]): string {
  return options
    .map(
      (o, i) =>
        `${i + 1}. id=${o.availabilityId} ${o.origin}-${o.destination} ` +
        `${o.date} program=${o.program} cabin=${o.cabin} miles=${o.miles} ` +
        `nonstop=${o.direct}`,
    )
    .join("\n");
}

/**
 * The one node in this graph where the model genuinely decides whether to
 * call a tool. Safe here because the candidate list is capped at
 * ENRICH_TOP_N before the model ever sees it — the worst case is a handful of
 * wasted lookups, not an unbounded bill.
 */
export async function enrichTrips(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const top = (state.awardResults ?? []).slice(0, ENRICH_TOP_N);
  if (top.length === 0) return { tripSummaries: [] };

  let response: { tool_calls?: ToolCallLike[] };
  let tripsTool: ReturnType<typeof makeGetTripDetailsTool>;
  try {
    const client = await getClient();
    tripsTool = makeGetTripDetailsTool(client);
    const model = chat({ effort: "low" }).bindTools([tripsTool]);
    response = await model.invoke([
      plainSystem(ENRICH_PROMPT),
      { role: "user", content: describeCandidates(top) },
    ]);
  } catch {
    return { tripSummaries: [] }; // enrichment is additive; its absence must not fail the turn
  }

  const ids = idsFromToolCalls(
    response.tool_calls ?? [],
    top.map((o) => o.availabilityId),
  );
  if (ids.length === 0) return { tripSummaries: [] };

  const summaries: TripSummary[] = [];
  const requestedCabins = state.searchPlan?.cabins;

  // Sequential rather than parallel: a burst of up to five is a fast way to
  // trip the rate limiter, and the latency difference is not user-visible.
  for (const id of ids) {
    try {
      const raw = await tripsTool.invoke({ availabilityId: id });
      const parsed = JSON.parse(raw) as { trips?: TripSummary[] };
      const trips = parsed.trips ?? [];
      // One availabilityId can bundle trips across every cabin seats.aero
      // knows about; without this filter a business/first request gets
      // flooded with economy alternates that bury the cabins actually asked
      // for and burn context on options the user can't use.
      const relevant =
        requestedCabins && requestedCabins.length > 0
          ? trips.filter((t) => !t.cabin || requestedCabins.includes(t.cabin))
          : trips;
      summaries.push(...relevant);
    } catch {
      continue; // enrichment is additive; its absence must not fail the turn
    }
  }

  const merged = new Map((state.tripSummaries ?? []).map((summary) => [`${summary.availabilityId}:${summary.tripId}`, summary]));
  for (const summary of summaries) merged.set(`${summary.availabilityId}:${summary.tripId}`, summary);
  return { tripSummaries: [...merged.values()] };
}
