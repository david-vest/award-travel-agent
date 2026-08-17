import { NextResponse } from "next/server";
import { AIRPORTS } from "../../../src/tools/locations/data";

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
  kind: "airport" | "city";
  code: string;
  city: string;
  country: string;
  airports: string[];
};

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim().toLowerCase() ?? "";

  if (!query) return NextResponse.json([]);

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

  const results: SearchResult[] = [];
  const cities = new Map<string, typeof matches>();
  for (const airport of matches.slice(0, 80)) {
    const key = `${airport.city}|${airport.country}`;
    cities.set(key, [...(cities.get(key) ?? []), airport]);
  }

  for (const [key, airports] of cities) {
    const [city, country] = key.split("|");
    if (airports.length > 1 || CITY_CODES[city]) {
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
