import type { AwardOption, TripSummary } from "../tools";
import { getVectorStore } from "./store";

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
 * Restricts the vector search to documents about carriers and programs that
 * actually came back from the API. This is the payoff for retrieving *after*
 * searching — before the search, none of this is known.
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

  const filter: Record<string, unknown> = {};
  if (airlines.length > 0) filter.airlines = { $in: airlines };
  if (programs.length > 0) filter.programs = { $in: programs };

  return Object.keys(filter).length > 0 ? filter : undefined;
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

export async function retrieveKnowledge(
  userQuestion: string,
  options: AwardOption[],
  trips: TripSummary[] = [],
  k: number = DEFAULT_K,
): Promise<RetrievedDoc[]> {
  const store = await getVectorStore();
  const query = buildRetrievalQuery(userQuestion, options, trips);
  const preFilter = buildPreFilter(options);

  const docs = await store.similaritySearch(query, k, preFilter);

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
