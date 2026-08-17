import { z } from "zod";
import { plainSystem } from "../cache";
import { chat } from "../models";
import type { AgentStateType, LocationResolution } from "../state";
import { AIRPORTS } from "../../tools/locations/data";
import { resolveLocation } from "../../tools/locations/resolve";
import { resolveSeatsAeroSearchCode } from "../../tools/seats-aero/multi-city-codes";

const knownIatas = new Set(AIRPORTS.map((airport) => airport.iata));
const resolutionSchema = z.object({
  resolutions: z.array(z.object({
    requestIndex: z.number().int().min(0),
    airportCodes: z.array(z.string().length(3)).min(1).max(4),
    explanation: z.string(),
  })),
});

type LocationInput = { code: string; airports: string[]; custom: boolean };

function deterministicResolution(location: LocationInput): LocationResolution | null {
  if (location.airports.length) return null;
  const query = location.code.trim();
  // Known provider groups must win even when the user entered them through
  // the free-form UI path. Otherwise "Asia" is sent to the model, whose output
  // is intentionally restricted to real IATA airports and cannot return ASA.
  const searchCode = resolveSeatsAeroSearchCode(query);
  if (searchCode) {
    return { query, airports: [searchCode.code], explanation: `${query} resolved to Seats.aero search code ${searchCode.code}.` };
  }
  const resolved = resolveLocation(query);
  // Regions without an equivalent provider group still get a deterministic,
  // bounded set of major gateways instead of becoming an empty search.
  if (resolved.kind === "region") {
    return { query, airports: resolved.representativeIatas, explanation: `${query} resolved to major gateways in ${resolved.region}.` };
  }
  // Other custom places are deliberately resolved by the agent. This is how
  // “Sorrento” maps to its practical gateway rather than a brittle local map.
  if (location.custom) return null;
  if (resolved.kind === "airports") {
    return { query, airports: resolved.iatas, explanation: `${query} resolved to ${resolved.iatas.join(", ")}.` };
  }
  return null;
}

function applyResolution(location: LocationInput, resolutions: LocationResolution[]): LocationInput {
  if (location.airports.length) return location;
  const match = resolutions.find((resolution) => resolution.query.toLowerCase() === location.code.trim().toLowerCase());
  return match ? { ...location, airports: match.airports } : location;
}

/** Resolves free-form places to validated commercial IATA airports before search. */
export async function resolveUiLocations(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const request = state.tripRequest;
  if (!request) return { locationResolutions: [] };
  const locations = [request.origin, ...request.destinations];
  const deterministic = locations.map(deterministicResolution).filter((item): item is LocationResolution => Boolean(item));
  const resolvedQueries = new Set(deterministic.map((item) => item.query.toLowerCase()));
  const unresolved = locations.filter((location) => !location.airports.length && !resolvedQueries.has(location.code.trim().toLowerCase()));
  let inferred: LocationResolution[] = [];

  if (unresolved.length) {
    try {
      const model = chat({ effort: "low", disableThinking: true }).withStructuredOutput(resolutionSchema, { name: "location_resolution" });
      const result = await model.invoke([
        plainSystem("Map each destination name to the nearest sensible commercial airport(s) for an award-flight search. Prefer the gateway travelers actually use; for example Sorrento, Italy maps to NAP. Return IATA codes only and briefly explain the choice."),
        { role: "user", content: unresolved.map((location, index) => `${index}. ${location.code}`).join("\n") },
      ]);
      inferred = result.resolutions.flatMap((resolution) => {
        const requested = unresolved[resolution.requestIndex];
        if (!requested) return [];
        const airports = [...new Set(resolution.airportCodes.map((code) => code.toUpperCase()).filter((code) => knownIatas.has(code)))];
        return airports.length ? [{ query: requested.code, airports, explanation: resolution.explanation }] : [];
      });
    } catch {
      inferred = [];
    }
  }

  const resolutions = [...deterministic, ...inferred];
  return {
    tripRequest: {
      ...request,
      origin: applyResolution(request.origin, resolutions),
      destinations: request.destinations.map((destination) => applyResolution(destination, resolutions)),
    },
    locationResolutions: resolutions,
  };
}
