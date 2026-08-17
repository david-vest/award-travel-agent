import { chat } from "../models";
import { cachedSystem } from "../cache";
import { SYNTHESIZE_PROMPT } from "../prompts/synthesize";
import type { AgentStateType } from "../state";
import { lastUserText } from "./triage";
import { probesFromPlan } from "./plan-discovery";
import { destinationsForSearch } from "./search";
import { displaySearchLocation } from "../../tools/seats-aero/multi-city-codes";

// The writer needs the best choices, not every raw match. This matches the
// number enriched with flight details and keeps broad searches concise.
const MAX_OPTIONS_IN_CONTEXT = 5;

/**
 * Mirrors search.ts's own early-return conditions exactly: a knowledge intent
 * never reaches a search node at all, a discovery search needs a resolved
 * origin and at least one probe to actually run (search.ts's discovery
 * branch loops over probesFromPlan(plan) — an empty list means zero API
 * calls happened even though a plan exists), and a route_search needs both
 * origins and destinations resolved. Used to decide whether an empty
 * awardResults means "searched, found nothing" versus "never actually
 * searched" — see buildSynthesisContext.
 */
function searchWasAttempted(state: AgentStateType): boolean {
  if (state.intent === "knowledge") return false;
  const plan = state.searchPlan;
  if (!plan || plan.origins.length === 0) return false;
  if (state.intent === "discovery") return probesFromPlan(plan).length > 0;
  return destinationsForSearch(plan.destinations, plan.destinationRegion).length > 0;
}

function formatDateWindow(start?: string, end?: string): string {
  if (!start && !end) return "";
  if (start === end || !end) return ` on ${start}`;
  if (!start) return ` through ${end}`;
  return ` from ${start} through ${end}`;
}

/** Guaranteed-short fallback for a flight request that produced no flights. */
export function buildNoFlightsDraft(state: AgentStateType): string {
  const plan = state.searchPlan;
  if (state.searchStatus === "provider_error") {
    return (
      "I couldn't complete the flight search because seats.aero did not return a usable response. " +
      "Would you like me to retry it?"
    );
  }

  if (!searchWasAttempted(state) || !plan) {
    const unresolved = plan?.unresolvedPlaces ?? [];
    if (unresolved.length > 0) {
      return `I couldn't search because I didn't recognize ${unresolved.join(", ")}. What airport, city, or seats.aero search code should I use instead?`;
    }
    return "I still need a searchable origin and destination. What airport, city, or seats.aero multi-city code should I use?";
  }

  const destinations = destinationsForSearch(plan.destinations, plan.destinationRegion);
  const originText = plan.origins.map(displaySearchLocation).join(", ");
  const destinationText = destinations.map(displaySearchLocation).join(", ");
  const cabinText = plan.cabins.length > 0 ? ` in ${plan.cabins.join(" or ")}` : "";
  const dateText = formatDateWindow(plan.startDate, plan.endDate);
  const attemptCount = state.searchAttempts?.length ?? 0;
  const attemptText =
    attemptCount > 1
      ? `after ${attemptCount} seats.aero searches`
      : "after checking seats.aero";
  return (
    `I couldn't find award flights from ${originText} to ${destinationText}${cabinText}${dateText}, ` +
    `${attemptText}. ` +
    "Would you like me to widen the dates, change the cabin, or try specific airports?"
  );
}

/**
 * All volatile content lives in the user turn: results, knowledge, violations,
 * timestamps. The system prompt above it stays byte-identical across every
 * request, which is what makes it cacheable.
 */
export function buildSynthesisContext(state: AgentStateType): string {
  const parts: string[] = [];

  parts.push(`User question:\n${lastUserText(state)}`);

  if (state.locationResolutions?.length) {
    parts.push(
      `Destination-to-airport choices (explain these briefly to the user):\n` +
        state.locationResolutions.map((resolution) =>
          `- ${resolution.query} → ${resolution.airports.join(", ")}: ${resolution.explanation}`,
        ).join("\n"),
    );
  }

  if (state.searchAttempts?.length) {
    parts.push(
      `Bounded route-search ladder (${state.searchAttempts.length} of 4 calls used):\n` +
        state.searchAttempts.map((attempt, index) =>
          `${index + 1}. ${attempt.origins.join(",")} → ${attempt.destinations.join(",")} (${attempt.tier}): ${attempt.resultCount} results. ${attempt.reason}`,
        ).join("\n") +
        "\nWhen a recommended route differs from the request, explicitly explain the separate positioning flight(s) needed.",
    );
  }

  // Gated on intent, like searchWasAttempted above: a knowledge-intent turn
  // never writes searchPlan itself, so guard.ts no longer nulling it (Task 5)
  // means a place that failed to resolve on an EARLIER search turn can still
  // be sitting in state.searchPlan.unresolvedPlaces here. Surfacing it into
  // an unrelated knowledge-only answer would be a stale-diagnostic leak.
  const unresolvedPlaces =
    state.intent === "knowledge" ? [] : (state.searchPlan?.unresolvedPlaces ?? []);
  const ambiguousPlaces =
    state.intent === "knowledge" ? [] : (state.searchPlan?.ambiguousPlaces ?? []);
  if (unresolvedPlaces.length > 0 || ambiguousPlaces.length > 0) {
    const lines: string[] = [];
    if (unresolvedPlaces.length > 0) {
      lines.push(`Places not recognized: ${unresolvedPlaces.join(", ")}.`);
    }
    for (const a of ambiguousPlaces) {
      lines.push(`"${a.query}" matched multiple cities: ${a.candidates.join(", ")}.`);
    }
    parts.push(
      `Location resolution notes (mention these to the user plainly — do not ` +
        `silently ignore them):\n${lines.join("\n")}`,
    );
  }

  const allOptions = state.awardResults ?? [];
  const options = allOptions.slice(0, MAX_OPTIONS_IN_CONTEXT);
  if (options.length === 0) {
    if (state.intent === "knowledge") {
      parts.push("No availability search was performed for this question.");
    } else if (!searchWasAttempted(state)) {
      parts.push(
        "No search was run: the request's origin/destination could not be resolved.",
      );
    } else {
      parts.push(
        "Award options found: NONE. No award availability was returned for this search.",
      );
    }
  } else {
    parts.push(
      `Ranked award options shown in the flight-card rail (${options.length} of ${allOptions.length} returned; first is the current recommendation):\n` +
        options
          .map(
            (o, i) =>
              `${i + 1}. id=${o.availabilityId} ${o.origin}-${o.destination} ${o.date} ` +
              `program=${o.program} cabin=${o.cabin} miles=${o.miles} ` +
              `taxes=${o.taxes ?? "unknown"} taxesCurrency=${o.taxesCurrency ?? "unknown"} ` +
              `nonstop=${o.direct} airlines=${o.airlines} ` +
              `seats=${o.remainingSeats ?? "unknown"} dataUpdatedAt=${o.updatedAt ?? "unknown"} ` +
              `searchTier=${o.searchTier ?? "exact"} requestedRoute=${o.requestedOrigins?.join("/") ?? "unknown"}-${o.requestedDestinations?.join("/") ?? "unknown"}`,
          )
          .join("\n"),
    );
  }

  const trips = state.tripSummaries ?? [];
  if (trips.length > 0) {
    parts.push(
      `Flight-card details (use only when a field adds decision value; do not restate each card):\n` +
        trips
          .map(
            (t) =>
              `- for=${t.availabilityId} cabin=${t.cabin ?? "unknown"} miles=${t.miles ?? "unknown"} ` +
              `taxes=${t.totalTaxes ?? "unknown"} taxesCurrency=${t.taxesCurrency ?? "unknown"} ` +
              `flights=${t.flightNumbers.join(",")} aircraft=${t.aircraft.join(",")} ` +
              `stops=${t.stops} connections=${t.connections?.map((connection) =>
                `${connection.airport}${connection.layoverMinutes != null ? `(${connection.layoverMinutes}m)` : ""}`,
              ).join(",") || "none"} durationMinutes=${t.durationMinutes ?? "unknown"} ` +
              `departsAt=${t.departsAt ?? "unknown"} arrivesAt=${t.arrivesAt ?? "unknown"} ` +
              `seats=${t.remainingSeats ?? "unknown"} carriers=${t.carriers.join(",")}`,
          )
          .join("\n"),
    );
  }

  const docs =
    state.intent === "knowledge" || options.length > 0 ? (state.kbDocs ?? []) : [];
  if (docs.length > 0) {
    parts.push(
      `Knowledge base excerpts (cite by id in square brackets):\n` +
        docs
          .map(
            (d) =>
              `[${d.id}] (${d.collection}, updated ${d.updated})\n${d.text}` +
              (d.sources.length > 0 ? `\nSources: ${d.sources.join(", ")}` : ""),
          )
          .join("\n\n"),
    );
  }

  const violations = state.violations ?? [];
  if (violations.length > 0) {
    parts.push(
      `Your previous draft made claims the data does not support. Correct these ` +
        `and rewrite the answer:\n` +
        violations.map((v) => `- ${v.kind}: ${v.detail}`).join("\n"),
    );
  }

  if (state.refreshedAt) {
    parts.push(`Availability was re-confirmed with the provider at ${state.refreshedAt}.`);
  }

  return parts.join("\n\n");
}

export async function synthesize(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  if (state.intent !== "knowledge" && (state.awardResults?.length ?? 0) === 0) {
    return { draft: buildNoFlightsDraft(state) };
  }

  try {
    const model = chat({ effort: "medium" });
    const res = await model.invoke([
      cachedSystem(SYNTHESIZE_PROMPT),
      { role: "user", content: buildSynthesisContext(state) },
    ]);

    const text =
      typeof res.content === "string"
        ? res.content
        : (res.content as Array<{ text?: string }>)
            .map((b) => b.text ?? "")
            .join("");

    return { draft: text };
  } catch {
    return { draft: fallbackSynthesis(state) };
  }
}

/** A grounded fallback keeps the recorded-fixture demo useful without an LLM key. */
function fallbackSynthesis(state: AgentStateType): string {
  const options = state.awardResults ?? [];
  if (options.length === 0) {
    return [
      "**Bottom line:** I couldn’t find award availability matching those exact constraints.",
      "**Next step:** Widen the dates, allow a connection, or add another points program and search again.",
    ].join("\n\n");
  }
  const lead = options[0];
  const positioning = Boolean(lead.searchTier && lead.searchTier !== "exact");
  const fit = lead.direct
    ? "It is the strongest verified nonstop match."
    : "It is the strongest verified match, but it includes a connection.";
  return [
    `**Bottom line:** Start with the first flight card. ${fit}`,
    positioning
      ? `**What matters:** This option uses the ${lead.searchTier?.replaceAll("_", " ")} fallback and requires separate positioning travel.`
      : "",
    "**Next step:** Confirm the seat with the booking program before transferring points.",
  ].filter(Boolean).join("\n\n");
}
