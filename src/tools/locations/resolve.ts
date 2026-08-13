import type { Region } from "../seats-aero/types";
import { AIRPORTS, CITY_ALIASES, MAJOR_HUBS, REGION_SYNONYMS } from "./data";

export type ResolvedLocation =
  | { kind: "airports"; iatas: string[]; label: string }
  | {
      kind: "region";
      region: Region;
      representativeIatas: string[];
      label: string;
    }
  | { kind: "ambiguous"; query: string; candidates: string[] }
  | { kind: "unknown"; query: string };

/** How many airports stand in for a region on a cached-search call. */
const REPRESENTATIVES_PER_REGION = 8;

/** Below this length, a substring match is too broad to be useful (matches almost everything). */
const MIN_SUBSTRING_LENGTH = 3;

/** Above this many, an `ambiguous` candidates list is unusable in a downstream prompt. */
const MAX_AMBIGUOUS_CANDIDATES = 10;

const byIata = new Map(AIRPORTS.map((a) => [a.iata, a]));

/**
 * Deterministic. There is no model call here on purpose: an LLM asked for IATA
 * codes will confidently produce ones that do not exist, and a hallucinated
 * airport becomes a silent empty search rather than an error. The same
 * principle is why an ambiguous match — whether an exact city name that spans
 * multiple countries (e.g. "London") or a partial match spanning multiple
 * cities — returns the honest list of candidates instead of picking one, a
 * table that can't decide says so.
 *
 * Note: a 3-letter query that matches a real IATA code resolves to that
 * airport first, even if it also happens to be a city-name prefix (e.g. "San"
 * is SAN, San Diego's real code) — codes are matched case-insensitively,
 * since users commonly type them lowercase ("lax", "nrt"), and that
 * convenience is worth more than catching the rare case where a 3-letter code
 * coincides with an ambiguous city prefix. Longer queries (5+ letters, like
 * "Santa") never collide with a 3-letter code and go straight to city
 * matching, where genuine ambiguity is caught.
 */
export function resolveLocation(query: string): ResolvedLocation {
  const raw = query.trim();
  if (raw.length === 0) {
    return { kind: "unknown", query: raw };
  }
  const key = raw.toLowerCase();

  // Bare IATA code
  if (/^[A-Za-z]{3}$/.test(raw)) {
    const hit = byIata.get(raw.toUpperCase());
    if (hit) {
      return { kind: "airports", iatas: [hit.iata], label: hit.city };
    }
  }

  // Region synonym — representatives come from the curated MAJOR_HUBS list,
  // not the full generated table, so they're real hubs rather than dataset order.
  const region = Object.hasOwn(REGION_SYNONYMS, key) ? REGION_SYNONYMS[key] : undefined;
  if (region) {
    const representativeIatas = MAJOR_HUBS.filter((a) => a.region === region)
      .slice(0, REPRESENTATIVES_PER_REGION)
      .map((a) => a.iata);
    return { kind: "region", region, representativeIatas, label: region };
  }

  // City (possibly via alias) — exact match first
  const cityKey = Object.hasOwn(CITY_ALIASES, key) ? CITY_ALIASES[key] : key;
  const exact = AIRPORTS.filter((a) => a.city.toLowerCase() === cityKey);
  if (exact.length > 0) {
    // Same city name can exist in unrelated countries (e.g. London, UK vs.
    // London, Ontario) — dedupe on city+country to detect that before merging.
    const countries = [...new Set(exact.map((a) => a.country))];
    if (countries.length > 1) {
      const candidates = countries.sort().map((country) => `${exact[0].city}, ${country}`);
      return { kind: "ambiguous", query: raw, candidates: capCandidates(candidates) };
    }
    return {
      kind: "airports",
      iatas: exact.map((a) => a.iata),
      label: exact[0].city,
    };
  }

  // Partial match fallback — only for queries long enough to be meaningful
  if (cityKey.length >= MIN_SUBSTRING_LENGTH) {
    const partial = AIRPORTS.filter((a) => a.city.toLowerCase().includes(cityKey));
    const distinctCities = [...new Set(partial.map((a) => a.city))];
    if (distinctCities.length === 1) {
      const iatas = partial.map((a) => a.iata);
      return { kind: "airports", iatas, label: distinctCities[0] };
    }
    if (distinctCities.length > 1) {
      return { kind: "ambiguous", query: raw, candidates: capCandidates(distinctCities.sort()) };
    }
  }

  return { kind: "unknown", query: raw };
}

/** Caps a sorted candidates list, appending a synthetic note when truncated. */
function capCandidates(candidates: string[]): string[] {
  if (candidates.length <= MAX_AMBIGUOUS_CANDIDATES) return candidates;
  const kept = candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES);
  const remaining = candidates.length - MAX_AMBIGUOUS_CANDIDATES;
  return [...kept, `... and ${remaining} more`];
}

/** Convenience for building comma-delimited seats.aero params. */
export function toAirportParam(r: ResolvedLocation): string | undefined {
  if (r.kind === "airports") return r.iatas.join(",");
  if (r.kind === "region") return r.representativeIatas.join(",");
  return undefined;
}
