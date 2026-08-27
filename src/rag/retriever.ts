import { canonicalTripForOption, type AwardOption, type TripSummary } from "../tools";
import type { Document } from "@langchain/core/documents";
import type { ScoringDimension } from "./frontmatter";
import { SCORING_DIMENSIONS } from "./frontmatter";
import { findKnowledgeDocuments, getVectorStore } from "./store";
// A pure IATA→Region lookup despite living in the search node — reused here
// rather than duplicated so the two stay in sync.
import { regionForOrigin } from "../agent/nodes/search";

export type RetrievedDoc = {
  id: string;
  collection: string;
  text: string;
  sources: string[];
  updated: string;
  airlines?: string[];
  aircraft?: string[];
  programs?: string[];
  creditPrograms?: string[];
  regions?: string[];
  airports?: string[];
  routes?: string[];
  dimensions?: ScoringDimension[];
  cabin?: string;
  productName?: string;
  reviewAfter?: string;
  match?: {
    confidence: "high" | "medium" | "low";
    reasons: string[];
    stale: boolean;
    semanticSupplement: boolean;
  };
};

export type OptionEvidence = Record<string, RetrievedDoc[]>;

const DEFAULT_K = 8;

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

export function optionId(option: AwardOption): string {
  return `${option.availabilityId}:${option.cabin}`;
}

const AIRCRAFT_ALIASES: Record<string, string> = {
  "77W": "777300ER",
  "B77W": "777300ER",
  "789": "7879",
  "B789": "7879",
  "788": "7878",
  "B788": "7878",
  "78X": "78710",
  "B78X": "78710",
  "359": "A350900",
  "A359": "A350900",
  "35K": "A3501000",
  "A35K": "A3501000",
  "388": "A380800",
  "A388": "A380800",
  "346": "A340600",
  "A346": "A340600",
  "333": "A330300",
  "A333": "A330300",
  "763": "767300",
  "B763": "767300",
};

/** Provider and editorial aircraft labels normalized to one conservative join key. */
export function normalizeAircraft(value: string): string {
  const compact = value
    .toUpperCase()
    .replace(/\b(?:BOEING|AIRBUS)\b/g, "")
    .replace(/[^A-Z0-9]/g, "");
  return AIRCRAFT_ALIASES[compact] ?? compact;
}

function airlinesIn(options: AwardOption[]): string[] {
  return uniq(
    options.flatMap((o) =>
      o.airlines.split(",").map((a) => a.trim().toUpperCase()),
    ),
  );
}

function stringArray(value: unknown, transform?: (item: string) => string): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((item) => transform ? transform(item) : item).filter(Boolean);
}

function fromDocument(document: Document): RetrievedDoc {
  const metadata = document.metadata;
  const dimensions = stringArray(metadata.dimensions)
    .filter((dimension): dimension is ScoringDimension =>
      SCORING_DIMENSIONS.includes(dimension as ScoringDimension));
  return {
    id: String(metadata.id ?? "unknown"),
    collection: String(metadata.collection ?? "unknown"),
    text: document.pageContent,
    sources: stringArray(metadata.sources),
    updated: String(metadata.updated ?? ""),
    airlines: stringArray(metadata.airlines, (item) => item.toUpperCase()),
    aircraft: stringArray(metadata.aircraft),
    programs: stringArray(metadata.programs, (item) => item.toLowerCase()),
    creditPrograms: stringArray(metadata.creditPrograms, (item) => item.toLowerCase()),
    regions: stringArray(metadata.regions),
    airports: stringArray(metadata.airports, (item) => item.toUpperCase()),
    routes: stringArray(metadata.routes, (item) => item.toUpperCase()),
    dimensions,
    cabin: metadata.cabin ? String(metadata.cabin).toLowerCase() : undefined,
    productName: metadata.productName ? String(metadata.productName) : undefined,
    reviewAfter: metadata.reviewAfter ? String(metadata.reviewAfter) : undefined,
  };
}

/**
 * Restricts the vector search to documents relevant to what actually came
 * back from the API — a carrier, a program, or a destination's region. This
 * is the payoff for retrieving *after* searching — before the search, none
 * of this is known.
 *
 * The three facets are ORed, not ANDed: a document tagged with only one
 * facet (e.g. a program-only transfer note, or a region-only seasonality
 * note with no airlines/programs at all) must still match on that facet
 * alone. ANDing them — the original implementation — silently excluded any
 * document that didn't carry every facet, which in practice meant most of
 * the knowledge base whenever a search actually returned results.
 *
 * Returns undefined when there are no results (a pure knowledge question), so
 * the whole KB stays searchable in that case.
 */
export function buildPreFilter(
  options: AwardOption[],
): Record<string, unknown> | undefined {
  if (options.length === 0) return undefined;

  const airlines = airlinesIn(options);
  const programs = uniq(options.map((o) => o.program.toLowerCase()));
  const regions = uniq(options.map((o) => regionForOrigin(o.destination)));

  const clauses: Record<string, unknown>[] = [];
  if (airlines.length > 0) clauses.push({ airlines: { $in: airlines } });
  if (programs.length > 0) clauses.push({ programs: { $in: programs } });
  if (regions.length > 0) clauses.push({ regions: { $in: regions } });

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];
  return { $or: clauses };
}

/**
 * The embedded query is the user's question plus a summary of what came back.
 * "Is this a good deal?" embeds poorly on its own; the same question alongside
 * "aeroplan business NH ORD-NRT 87500 miles" retrieves the right documents.
 *
 * Aircraft (from `trips`, when available) is folded in here rather than into
 * `buildPreFilter` — see the design note at the top of this task. Semantic
 * similarity tolerates "777-300ER" vs. "Boeing 777-300ER" the way a strict
 * metadata filter would not, and this is the only KB signal that lets the
 * `products` collection (aircraft-specific cabin reviews) actually surface.
 */
export function buildRetrievalQuery(
  userQuestion: string,
  options: AwardOption[],
  trips: TripSummary[] = [],
): string {
  if (options.length === 0) return userQuestion;

  const programs = uniq(options.map((o) => o.program));
  const cabins = uniq(options.map((o) => o.cabin));
  const airlines = airlinesIn(options);
  const destinations = uniq(options.map((o) => o.destination)).slice(0, 8);
  const aircraft = uniq(trips.flatMap((t) => t.aircraft));

  const lines = [
    userQuestion,
    "",
    `Programs: ${programs.join(", ")}`,
    `Cabins: ${cabins.join(", ")}`,
    `Airlines: ${airlines.join(", ")}`,
    `Destinations: ${destinations.join(", ")}`,
  ];
  if (aircraft.length > 0) lines.push(`Aircraft: ${aircraft.join(", ")}`);

  return lines.join("\n");
}

/** Voyage's free/unfunded tier caps at 3 requests/minute — see retryOn429's comment. */
const RATE_LIMIT_RETRY_DELAY_MS = 21_000;

/**
 * A 429 from Voyage is a transient rate-limit, not a genuine outage — the
 * account is capped at 3 requests/minute until a payment method is added.
 * retrieve.ts's caller-level catch treats ANY throw here as "outage, degrade
 * gracefully," which is correct for a real failure but wastes a retrieval
 * that would have succeeded 21 seconds later. One retry, paced just past the
 * window, converts most of those into successful retrievals instead of
 * papering over rate-limit noise as if the vector store were actually down.
 */
async function retryOn429<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!String((err as Error)?.message).includes("429")) throw err;
    await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_DELAY_MS));
    return fn();
  }
}

export async function retrieveKnowledge(
  userQuestion: string,
  options: AwardOption[],
  trips: TripSummary[] = [],
  k: number = DEFAULT_K,
): Promise<RetrievedDoc[]> {
  const store = await getVectorStore();
  const query = buildRetrievalQuery(userQuestion, options, trips);
  const preFilter = buildPreFilter(options);

  const docs = await retryOn429(() => store.similaritySearch(query, k, preFilter));

  // For a flight-backed answer, an empty carrier/program-filtered result is
  // the correct result. Falling back to the whole KB injects unrelated airline
  // trivia that cannot help compare the flights actually found. Pure knowledge
  // questions still have no preFilter and continue to search the whole KB.

  return docs.map(fromDocument);
}

type CandidateContext = {
  option: AwardOption;
  trip?: TripSummary;
  carriers: string[];
  aircraft: string[];
  programs: string[];
  creditPrograms: string[];
  airports: string[];
  routes: string[];
};

function candidateContext(option: AwardOption, trips: TripSummary[], creditPrograms: string[] = []): CandidateContext {
  const trip = canonicalTripForOption(option, trips);
  const carriers = uniq(
    (trip?.carriers?.length ? trip.carriers : option.airlines.split(","))
      .map((carrier) => carrier.trim().toUpperCase()),
  );
  const airports = uniq((trip?.connections ?? []).map((connection) => connection.airport.toUpperCase()));
  const path = [option.origin.toUpperCase(), ...airports, option.destination.toUpperCase()];
  const routes = uniq([
    `${option.origin.toUpperCase()}-${option.destination.toUpperCase()}`,
    ...path.slice(0, -1).map((origin, index) => `${origin}-${path[index + 1]}`),
  ]);
  return {
    option,
    trip,
    carriers,
    aircraft: uniq((trip?.aircraft ?? []).map(normalizeAircraft)),
    programs: [option.program.toLowerCase()],
    creditPrograms: creditPrograms.map((program) => program.toLowerCase()),
    airports,
    routes,
  };
}

function overlaps(left: string[], right: string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

function matchReasons(
  candidate: CandidateContext,
  doc: RetrievedDoc,
): string[] | undefined {
  const dimensions = new Set(doc.dimensions ?? []);
  if (dimensions.has("cabin_product")) {
    const airlineMatch = overlaps(candidate.carriers, doc.airlines ?? []);
    const aircraftMatch = overlaps(candidate.aircraft, (doc.aircraft ?? []).map(normalizeAircraft));
    const cabinMatch = !doc.cabin || doc.cabin === candidate.option.cabin.toLowerCase();
    if (airlineMatch && aircraftMatch && cabinMatch) return ["carrier", "aircraft", "cabin"];
  }
  if (dimensions.has("booking_ease") && overlaps(candidate.programs, doc.programs ?? [])) {
    return ["booking program"];
  }
  if (
    dimensions.has("transfer_risk")
    && overlaps(candidate.programs, doc.programs ?? [])
    && overlaps(candidate.creditPrograms, doc.creditPrograms ?? [])
  ) {
    return ["transfer program"];
  }
  if (dimensions.has("connection_quality")) {
    if (overlaps(candidate.airports, doc.airports ?? [])) return ["connection airport"];
    if (overlaps(candidate.routes, doc.routes ?? [])) return ["operated route"];
  }
  return undefined;
}

function downgradedConfidence(
  semanticSupplement: boolean,
  stale: boolean,
): "high" | "medium" | "low" {
  if (semanticSupplement) return stale ? "low" : "medium";
  return stale ? "medium" : "high";
}

/**
 * Pure strict join used by retrieval and tests. Semantic similarity can choose
 * candidate documents, but this function decides whether each document is
 * actually applicable to each option.
 */
export function linkEvidenceToOptions(
  options: AwardOption[],
  trips: TripSummary[],
  exactDocs: RetrievedDoc[],
  semanticDocs: RetrievedDoc[] = [],
  now: Date = new Date(),
  creditPrograms: string[] = [],
): OptionEvidence {
  const exactIds = new Set(exactDocs.map((doc) => doc.id));
  const allDocs = [...exactDocs, ...semanticDocs.filter((doc) => !exactIds.has(doc.id))];
  return Object.fromEntries(options.map((option) => {
    const candidate = candidateContext(option, trips, creditPrograms);
    const matched = allDocs.flatMap((doc) => {
      if (doc.sources.length === 0 || (doc.dimensions?.length ?? 0) === 0) return [];
      const reasons = matchReasons(candidate, doc);
      if (!reasons) return [];
      const semanticSupplement = !exactIds.has(doc.id);
      const reviewAfter = doc.reviewAfter ? Date.parse(doc.reviewAfter) : Number.NaN;
      const stale = Number.isFinite(reviewAfter) && now.getTime() > reviewAfter;
      return [{
        ...doc,
        match: {
          confidence: downgradedConfidence(semanticSupplement, stale),
          reasons,
          stale,
          semanticSupplement,
        },
      } satisfies RetrievedDoc];
    }).sort((a, b) => {
      const confidence = { high: 0, medium: 1, low: 2 } as const;
      return confidence[a.match!.confidence] - confidence[b.match!.confidence]
        || a.id.localeCompare(b.id);
    }).slice(0, 8);
    return [optionId(option), matched];
  }));
}

function evidenceFacetFilter(options: AwardOption[], trips: TripSummary[], creditPrograms: string[]): Record<string, unknown> | undefined {
  const candidates = options.map((option) => candidateContext(option, trips, creditPrograms));
  const airlines = uniq(candidates.flatMap((candidate) => candidate.carriers));
  const programs = uniq(candidates.flatMap((candidate) => candidate.programs));
  const airports = uniq(candidates.flatMap((candidate) => candidate.airports));
  const routes = uniq(candidates.flatMap((candidate) => candidate.routes));
  const cardPrograms = uniq(candidates.flatMap((candidate) => candidate.creditPrograms));
  const clauses: Record<string, unknown>[] = [];
  if (airlines.length) clauses.push({ airlines: { $in: airlines } });
  if (programs.length) clauses.push({ programs: { $in: programs } });
  if (airports.length) clauses.push({ airports: { $in: airports } });
  if (routes.length) clauses.push({ routes: { $in: routes } });
  if (cardPrograms.length) clauses.push({ creditPrograms: { $in: cardPrograms } });
  return clauses.length ? { $or: clauses } : undefined;
}

/** Exact facet retrieval first, then one bounded semantic supplement. */
export async function retrieveEvidenceForOptions(
  userQuestion: string,
  options: AwardOption[],
  trips: TripSummary[] = [],
  now: Date = new Date(),
  creditPrograms: string[] = [],
): Promise<OptionEvidence> {
  if (options.length === 0) return {};
  const facets = evidenceFacetFilter(options, trips, creditPrograms);
  if (!facets) return Object.fromEntries(options.map((option) => [optionId(option), []]));
  const filter = {
    $and: [
      { dimensions: { $in: [...SCORING_DIMENSIONS] } },
      { sources: { $exists: true, $ne: [] } },
      facets,
    ],
  };
  const exactDocuments = await findKnowledgeDocuments(filter);

  const store = await getVectorStore();
  const semanticDocuments = await retryOn429(() => store.similaritySearch(
    buildRetrievalQuery(userQuestion, options, trips),
    12,
    { $and: [{ dimensions: { $in: [...SCORING_DIMENSIONS] } }, facets] },
  ));

  return linkEvidenceToOptions(
    options,
    trips,
    exactDocuments.map(fromDocument),
    semanticDocuments.map(fromDocument),
    now,
    creditPrograms,
  );
}
