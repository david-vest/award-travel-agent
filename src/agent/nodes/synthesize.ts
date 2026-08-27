import { chat } from "../models";
import { cachedSystem } from "../cache";
import { SYNTHESIZE_PROMPT } from "../prompts/synthesize";
import type { AgentStateType } from "../state";
import { lastUserText } from "./triage";
import { probesFromPlan } from "./plan-discovery";
import { destinationsForSearch } from "./search";
import { displaySearchLocation } from "../../tools/seats-aero/multi-city-codes";
import { awardProgramForSource, transferPartnersFor } from "../../domain/programs";
import { canonicalTripForOption } from "../../tools";

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

  const allOptions = state.candidateShortlist === undefined
    ? state.awardResults ?? []
    : state.candidateShortlist;
  const options = allOptions.slice(0, MAX_OPTIONS_IN_CONTEXT);
  const optionNumberByAvailabilityId = new Map(options.map((option, index) => [option.availabilityId, index + 1]));
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
              `${i + 1}. ${o.origin}-${o.destination} ${o.date} ` +
              `program=${o.program} cabin=${o.cabin} miles=${o.miles} ` +
              `taxes=${o.taxes ?? "unknown"} taxesCurrency=${o.taxesCurrency ?? "unknown"} ` +
              `nonstop=${o.direct} airlines=${o.airlines} ` +
              `seats=${o.remainingSeats ?? "unknown"} dataUpdatedAt=${o.updatedAt ?? "unknown"} ` +
              `searchTier=${o.searchTier ?? "exact"} requestedRoute=${o.requestedOrigins?.join("/") ?? "unknown"}-${o.requestedDestinations?.join("/") ?? "unknown"}`,
          )
          .join("\n"),
    );

    // Only meaningful for a structured form search, where the selected
    // cards are known — a chat turn has no card selection to restrict by,
    // so this block is omitted entirely rather than naming every card that
    // could theoretically transfer to a shown program.
    const selectedCards = state.tripRequest?.creditCardPrograms ?? [];
    if (selectedCards.length > 0) {
      const uniqueSources = [...new Set(options.map((o) => o.program))];
      const transferLines = uniqueSources.flatMap((source) => {
        const program = awardProgramForSource(source);
        if (!program) return [];
        const partners = transferPartnersFor(program.id, selectedCards);
        if (partners.length === 0) return [];
        return [`- ${program.name} (${source}): ${partners.map((p) => p.name).join(", ")}`];
      });
      if (transferLines.length > 0) {
        parts.push(
          `Card transfer partners for programs shown (only mention a card if it appears here; say nothing about transferring for a program not listed):\n${transferLines.join("\n")}`,
        );
      }
    }
  }

  const trips = options.flatMap((option) => {
    const trip = canonicalTripForOption(option, state.tripSummaries ?? []);
    return trip ? [trip] : [];
  });
  if (trips.length > 0) {
    parts.push(
      `Flight-card details (use only when a field adds decision value; do not restate each card):\n` +
        trips
          .map(
            (t) =>
              `- for option ${optionNumberByAvailabilityId.get(t.availabilityId)} cabin=${t.cabin ?? "unknown"} miles=${t.miles ?? "unknown"} ` +
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
      `Internal research excerpts (use only for decision-changing facts; paraphrase, never mention "research note" or these excerpts by name, and never state a source's id — the URL below, if any, may be cited in prose when it changes the recommendation):\n` +
        docs
          .map((d, index) => {
            const sourcesLine = d.sources.length > 0 ? `\nSources: ${d.sources.join(", ")}` : "";
            return `Research note ${index + 1} (${d.collection}, updated ${d.updated})\n${d.text}${sourcesLine}`;
          })
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

    return { draft: sanitizeUserFacingAnalysis(text, state) };
  } catch {
    return { draft: fallbackSynthesis(state) };
  }
}

/** Defense in depth: internal evidence identifiers are never part of Roam's analysis. */
export function sanitizeUserFacingAnalysis(draft: string, state: Pick<AgentStateType, "awardResults" | "tripSummaries" | "kbDocs">): string {
  const identifiers = new Set([
    ...(state.awardResults ?? []).map((option) => option.availabilityId),
    ...(state.tripSummaries ?? []).flatMap((trip) => [trip.availabilityId, trip.tripId]),
    ...(state.kbDocs ?? []).map((doc) => doc.id),
  ].filter(Boolean));

  let sanitized = draft;
  for (const identifier of identifiers) {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    sanitized = sanitized.replace(new RegExp(`\\[\\s*${escaped}\\s*\\]`, "g"), "");
    sanitized = sanitized.replace(new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`, "g"), "$1");
  }
  return sanitized.replace(/[ \t]+\n/g, "\n").replace(/ {2,}/g, " ").trim();
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
