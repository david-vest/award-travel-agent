import type { AgentStateType, Violation } from "../state";

/** Mileage figures are large and always near the word "miles" or a k suffix. */
const MILEAGE_PATTERNS = [
  /(\d{1,3}(?:,\d{3})+)\s*(?:miles|points|pts)/gi,
  /(\d{4,7})\s*(?:miles|points|pts)/gi,
  /(\d{1,3}(?:\.\d)?)k\s*(?:miles|points|pts)/gi,
];

const FLIGHT_NUMBER = /\b([A-Z]{2}\d{1,4})\b/g;
const CITED_ID = /\[([a-z0-9]+(?:-[a-z0-9]+)+)\]/g;
const AIRLINE_MENTION = /\(([A-Z]{2})\)/g;

/**
 * Bounded, curated lookup covering the airlines this project's KB and
 * fixtures actually reference (see knowledge/products/*.md frontmatter and
 * src/tools/seats-aero/types.ts) plus the other major carriers common in
 * this domain. Not an exhaustive global airline database by design — a
 * draft naming a real-world airline outside this list simply isn't checked
 * by the name-based violation below (it would still be caught if it used a
 * parenthesized code or a flight number).
 */
const AIRLINE_NAMES: Record<string, string> = {
  NH: "ANA",
  LH: "Lufthansa",
  TK: "Turkish Airlines",
  UA: "United Airlines",
  AC: "Air Canada",
  CX: "Cathay Pacific",
  SQ: "Singapore Airlines",
  EK: "Emirates",
  EY: "Etihad Airways",
  BR: "EVA Air",
  QR: "Qatar Airways",
  JL: "Japan Airlines",
  OS: "Austrian Airlines",
  TG: "Thai Airways",
  AF: "Air France",
  KL: "KLM",
  AV: "Avianca",
  LX: "Swiss",
  MS: "EgyptAir",
  AA: "American Airlines",
  DL: "Delta Air Lines",
  BA: "British Airways",
  VS: "Virgin Atlantic",
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Airline codes named in plain English (e.g. "Fly Lufthansa nonstop..."). */
function extractAirlineNames(text: string): string[] {
  const found = new Set<string>();
  for (const [code, name] of Object.entries(AIRLINE_NAMES)) {
    const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
    if (pattern.test(text)) found.add(code);
  }
  return [...found];
}

/** Mileage costs quoted in the answer, normalized to whole miles. */
export function extractMileageFigures(text: string): number[] {
  const found = new Set<number>();

  for (const pattern of MILEAGE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      const value =
        raw.includes("k") || /^\d{1,3}(\.\d)?$/.test(raw)
          ? Math.round(parseFloat(raw) * 1000)
          : Number(raw.replace(/,/g, ""));
      if (Number.isFinite(value) && value > 0) found.add(value);
    }
  }

  return [...found];
}

export function extractFlightNumbers(text: string): string[] {
  return [...new Set([...text.matchAll(FLIGHT_NUMBER)].map((m) => m[1]))];
}

export function extractCitedIds(text: string): string[] {
  return [...new Set([...text.matchAll(CITED_ID)].map((m) => m[1]))];
}

function extractAirlineCodes(text: string): string[] {
  return [...new Set([...text.matchAll(AIRLINE_MENTION)].map((m) => m[1]))];
}

/** Accepts a k-rounded figure that matches a real one, e.g. 87.5k for 87,500. */
function isCloseTo(claimed: number, real: number): boolean {
  if (real === claimed) return true;
  return (
    Math.abs(real - claimed) <= 500 &&
    Math.round(real / 1000) === Math.round(claimed / 1000)
  );
}

/**
 * Accepts a claimed figure that either matches a real one directly (or via
 * k-rounding), or is a small positive-integer multiple (round-trip / small-
 * group phrasings) or pairwise sum/difference (running-total / remaining-
 * balance phrasings) of real figures — natural arithmetic a helpful answer
 * might state in plain language. Deliberately bounded to a small fixed set
 * of relationships rather than a general expression evaluator.
 */
function matchesAnyMileage(claimed: number, actual: Set<number>): boolean {
  for (const real of actual) {
    if (isCloseTo(claimed, real)) return true;
  }

  for (const real of actual) {
    for (const factor of [2, 3, 4]) {
      if (isCloseTo(claimed, real * factor)) return true;
    }
  }

  for (const a of actual) {
    for (const b of actual) {
      if (a === b) continue;
      if (isCloseTo(claimed, a + b)) return true;
      if (a > b && isCloseTo(claimed, a - b)) return true;
    }
  }

  return false;
}

/**
 * Deterministic. No model call: extracting claims and checking set membership
 * is faster, free, and — unlike an LLM judge — incapable of hallucinating its
 * own verdict.
 */
export function findViolations(
  draft: string,
  state: AgentStateType,
): Violation[] {
  const violations: Violation[] = [];

  const options = state.awardResults ?? [];
  const trips = state.tripSummaries ?? [];
  const docs = state.kbDocs ?? [];

  // Mileage can be legitimately quoted from the availability search result,
  // the per-trip detail lookup (synthesize.ts's "Flight details" block
  // renders `t.miles`, joined to awardResults via availabilityId), OR a
  // retrieved knowledge-base excerpt — the knowledge branch (triage ->
  // retrieve_knowledge -> synthesize) never runs a search at all, so its
  // only source of real mileage figures (e.g. award-chart numbers quoted
  // from a sweet-spot doc) is kbDocs. All three are real tool output, so
  // all three count as grounding.
  const realMiles = new Set([
    ...options.map((o) => o.miles),
    ...trips.map((t) => t.miles).filter((m): m is number => m != null),
    ...docs.flatMap((d) => extractMileageFigures(d.text)),
  ]);
  const realFlights = new Set(trips.flatMap((t) => t.flightNumbers));
  // Same reasoning as realMiles above: a knowledge-branch doc legitimately
  // discusses real airlines by name or code in its prose (e.g. "ANA's
  // business class..."), and without this, the plain-English airline-name
  // check below would flag every such answer — recreating the exact
  // knowledge-branch regression Fix 3 addresses, just for airline names.
  const realAirlines = new Set([
    ...options.flatMap((o) => o.airlines.split(",").map((a) => a.trim().toUpperCase())),
    ...trips.flatMap((t) => t.carriers.map((c) => c.toUpperCase())),
    ...docs.flatMap((d) => extractAirlineCodes(d.text)),
    ...docs.flatMap((d) => extractAirlineNames(d.text)),
  ]);
  const realDocIds = new Set(docs.map((d) => d.id));

  for (const claimed of extractMileageFigures(draft)) {
    if (!matchesAnyMileage(claimed, realMiles)) {
      violations.push({
        kind: "unsupported_number",
        detail: `The answer states ${claimed.toLocaleString()} miles, which appears in no search result.`,
      });
    }
  }

  for (const flight of extractFlightNumbers(draft)) {
    if (!realFlights.has(flight)) {
      violations.push({
        kind: "unsupported_flight",
        detail: `The answer names flight ${flight}, which appears in no trip detail.`,
      });
    }
  }

  for (const code of extractAirlineCodes(draft)) {
    if (!realAirlines.has(code)) {
      violations.push({
        kind: "unsupported_airline",
        detail: `The answer names airline ${code}, which operates none of the returned options.`,
      });
    }
  }

  // A fabricated airline named in plain English (e.g. "Fly Lufthansa
  // nonstop...") has no parenthesized code and often no flight number
  // either, so it slips past both checks above unless matched by name.
  for (const code of extractAirlineNames(draft)) {
    if (!realAirlines.has(code)) {
      violations.push({
        kind: "unsupported_airline",
        detail: `The answer names ${AIRLINE_NAMES[code]}, which operates none of the returned options.`,
      });
    }
  }

  for (const id of extractCitedIds(draft)) {
    if (!realDocIds.has(id)) {
      violations.push({
        kind: "uncited_claim",
        detail: `The answer cites [${id}], which was not among the retrieved documents.`,
      });
    }
  }

  return violations;
}

export async function verifyGroundedness(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const draft = state.draft ?? "";
  return { violations: findViolations(draft, state) };
}
