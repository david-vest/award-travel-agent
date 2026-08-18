import type { AwardOption, TripSummary } from "../tools";
import { getVectorStore } from "./store";
// A pure IATA→Region lookup despite living in the search node — reused here
// rather than duplicated so the two stay in sync.
import { regionForOrigin } from "../agent/nodes/search";

export type RetrievedDoc = {
  id: string;
  collection: string;
  text: string;
  sources: string[];
  updated: string;
};

const DEFAULT_K = 8;

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

function airlinesIn(options: AwardOption[]): string[] {
  return uniq(
    options.flatMap((o) =>
      o.airlines.split(",").map((a) => a.trim().toUpperCase()),
    ),
  );
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

  return docs.map((d) => ({
    id: String(d.metadata.id ?? "unknown"),
    collection: String(d.metadata.collection ?? "unknown"),
    text: d.pageContent,
    sources: (d.metadata.sources as string[]) ?? [],
    updated: String(d.metadata.updated ?? ""),
  }));
}
