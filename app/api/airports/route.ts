import { NextResponse } from "next/server";
import { AIRPORTS } from "../../../src/tools/locations/data";
import { SEATS_AERO_SEARCH_CODES } from "../../../src/tools/seats-aero/multi-city-codes";

const CITY_CODES: Record<string, string> = {
  Tokyo: "TYO",
  Seoul: "SEL",
  London: "LON",
  Paris: "PAR",
  "New York": "NYC",
  Chicago: "CHI",
  "San Francisco": "SFO",
  Washington: "WAS",
};

type SearchResult = {
  kind: "airport" | "city" | "group";
  code: string;
  city: string;
  country: string;
  airports: string[];
};

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,”“'’()—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function groupScore(group: (typeof SEATS_AERO_SEARCH_CODES)[number], query: string): number {
  const code = group.code.toLowerCase();
  const label = normalize(group.label);
  const aliases = group.aliases.map(normalize);
  if (code === query) return 0;
  if (label === query || aliases.includes(query)) return 1;
  if (code.startsWith(query)) return 2;
  if (label.startsWith(query) || aliases.some((alias) => alias.startsWith(query))) return 3;
  if (label.includes(query) || aliases.some((alias) => alias.includes(query))) return 4;
  return Number.POSITIVE_INFINITY;
}

export async function GET(request: Request) {
  const query = normalize(new URL(request.url).searchParams.get("q") ?? "");

  if (!query) return NextResponse.json([]);

  const groups: SearchResult[] = SEATS_AERO_SEARCH_CODES
    .map((group) => ({ group, score: groupScore(group, query) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || a.group.label.localeCompare(b.group.label))
    .slice(0, 4)
    .map(({ group }) => ({
      kind: "group",
      code: group.code,
      city: group.label,
      country: `Seats.aero · ${group.region}`,
      // SearchPlan accepts provider-native three-letter search targets in this
      // field as well as ordinary IATA airports.
      airports: [group.code],
    }));

  const matches = AIRPORTS.filter((airport) =>
    airport.iata.toLowerCase().includes(query)
    || airport.city.toLowerCase().includes(query)
    || airport.country.toLowerCase().includes(query),
  ).sort((a, b) => {
    const score = (airport: (typeof AIRPORTS)[number]) => {
      if (airport.iata.toLowerCase() === query) return 0;
      if (airport.iata.toLowerCase().startsWith(query)) return 1;
      if (airport.city.toLowerCase() === query) return 2;
      if (airport.city.toLowerCase().startsWith(query)) return 3;
      return 4;
    };
    return score(a) - score(b) || a.city.localeCompare(b.city);
  });

  const results: SearchResult[] = [...groups];
  const groupCodes = new Set(groups.map((group) => group.code));
  const cities = new Map<string, typeof matches>();
  for (const airport of matches.slice(0, 80)) {
    const key = `${airport.city}|${airport.country}`;
    cities.set(key, [...(cities.get(key) ?? []), airport]);
  }

  for (const [key, airports] of cities) {
    const [city, country] = key.split("|");
    if ((airports.length > 1 || CITY_CODES[city]) && !groupCodes.has(CITY_CODES[city])) {
      results.push({
        kind: "city",
        code: CITY_CODES[city] ?? airports[0].iata,
        city,
        country,
        airports: airports.map((airport) => airport.iata).slice(0, 4),
      });
    }
  }

  for (const airport of matches) {
    results.push({
      kind: "airport",
      code: airport.iata,
      city: airport.city,
      country: airport.country,
      airports: [airport.iata],
    });
  }

  const seen = new Set<string>();
  return NextResponse.json(results.filter((result) => {
    const key = `${result.kind}:${result.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8));
}
