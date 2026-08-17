import type { Region } from "./types";

type SearchCodeDefinition = {
  code: string;
  label: string;
  region: Region;
  aliases: readonly string[];
};

/**
 * Complete seats.aero multi-city/region-code catalog. These are provider-native
 * search values, not invented IATA codes. Keep this synchronized with the
 * published table rather than teaching the planner a partial, hand-picked set.
 *
 * Source (updated 2026-07-22):
 * https://docs.seats.aero/article/36-how-to-search-by-airport-city-or-region-code
 */
export const SEATS_AERO_SEARCH_CODES = [
  { code: "AAH", label: "American Airlines — major hubs", region: "North America", aliases: ["american airlines hubs", "american airlines major hubs", "aa hubs"] },
  { code: "ANZ", label: "Australia and New Zealand — large airports", region: "Oceania", aliases: ["australia and new zealand", "australia & new zealand", "australia new zealand"] },
  { code: "ASA", label: "Asia — large airports", region: "Asia", aliases: ["asia", "major asian airports", "large asian airports"] },
  { code: "AUL", label: "Australia — large airports", region: "Oceania", aliases: ["australia", "major australian airports", "large australian airports"] },
  { code: "BJS", label: "Beijing metropolitan area", region: "Asia", aliases: ["beijing", "beijing area", "beijing metropolitan area"] },
  { code: "BRL", label: "Brazil — large airports", region: "South America", aliases: ["brazil", "major brazil airports", "large brazil airports"] },
  { code: "CAD", label: "Canada — large airports", region: "North America", aliases: ["canada", "major canadian airports", "large canadian airports"] },
  { code: "CAL", label: "California airports", region: "North America", aliases: ["california", "california airports"] },
  { code: "CAR", label: "Caribbean — large airports", region: "North America", aliases: ["caribbean", "major caribbean airports"] },
  { code: "CHI", label: "Chicago metropolitan area", region: "North America", aliases: ["chicago", "chicago area", "chicago metropolitan area"] },
  { code: "CNA", label: "Mainland China — large airports", region: "Asia", aliases: ["mainland china", "china", "major chinese airports"] },
  { code: "DLL", label: "Delta Air Lines — major hubs", region: "North America", aliases: ["delta hubs", "delta air lines hubs", "delta major hubs"] },
  { code: "EST", label: "East Coast, United States", region: "North America", aliases: ["us east coast", "u.s. east coast", "united states east coast", "east coast united states"] },
  { code: "EUR", label: "Europe — large airports", region: "Europe", aliases: ["europe", "major european airports", "large european airports"] },
  { code: "GCR", label: "Germany — large airports", region: "Europe", aliases: ["germany", "major german airports", "large german airports"] },
  { code: "JPN", label: "Japan — large airports", region: "Asia", aliases: ["japan", "major japanese airports", "large japanese airports"] },
  { code: "LON", label: "London metropolitan area", region: "Europe", aliases: ["london", "london uk", "london area", "london metropolitan area"] },
  { code: "MEA", label: "Middle East — large airports", region: "Asia", aliases: ["middle east", "major middle eastern airports"] },
  { code: "MMW", label: "Midwest, United States", region: "North America", aliases: ["us midwest", "u.s. midwest", "united states midwest", "midwest united states"] },
  { code: "MEX", label: "Mexico — large airports", region: "North America", aliases: ["mexico", "major mexican airports", "large mexican airports"] },
  { code: "NYC", label: "New York City metropolitan area", region: "North America", aliases: ["new york", "new york city", "nyc", "new york area"] },
  { code: "OSA", label: "Osaka metropolitan area", region: "Asia", aliases: ["osaka", "osaka area", "osaka metropolitan area"] },
  { code: "PAR", label: "Paris metropolitan area", region: "Europe", aliases: ["paris", "paris area", "paris metropolitan area"] },
  { code: "QBA", label: "San Francisco Bay Area", region: "North America", aliases: ["san francisco bay area", "bay area", "sf bay area"] },
  { code: "QLA", label: "Los Angeles metropolitan area", region: "North America", aliases: ["los angeles", "los angeles area", "la area", "los angeles metropolitan area"] },
  { code: "QMI", label: "Miami metropolitan area", region: "North America", aliases: ["miami", "miami area", "south florida", "miami metropolitan area"] },
  { code: "RIO", label: "Rio de Janeiro metropolitan area", region: "South America", aliases: ["rio de janeiro", "rio", "rio de janeiro area"] },
  { code: "SAM", label: "South America — large airports", region: "South America", aliases: ["south america", "major south american airports"] },
  { code: "SAO", label: "São Paulo metropolitan area", region: "South America", aliases: ["sao paulo", "são paulo", "sao paulo area"] },
  { code: "SEA", label: "Southeast Asia — large airports", region: "Asia", aliases: ["southeast asia", "south east asia", "major southeast asian airports"] },
  { code: "SCH", label: "Schengen Area — large airports", region: "Europe", aliases: ["schengen", "schengen area", "schengen zone"] },
  { code: "SEL", label: "Seoul metropolitan area", region: "Asia", aliases: ["seoul", "seoul area", "seoul metropolitan area"] },
  { code: "TYO", label: "Tokyo metropolitan area", region: "Asia", aliases: ["tokyo", "tokyo area", "tokyo metropolitan area"] },
  { code: "UAH", label: "United Airlines — major hubs", region: "North America", aliases: ["united hubs", "united airlines hubs", "united major hubs"] },
  { code: "UKD", label: "United Kingdom — large airports", region: "Europe", aliases: ["united kingdom", "uk", "u.k.", "great britain", "major uk airports"] },
  { code: "USA", label: "United States — large airports", region: "North America", aliases: ["usa", "us", "u.s.", "u.s.a.", "united states", "united states of america"] },
  { code: "WAS", label: "Washington, DC metropolitan area", region: "North America", aliases: ["washington dc", "washington d.c.", "dc area", "washington metropolitan area"] },
  { code: "WST", label: "West Coast, United States", region: "North America", aliases: ["us west coast", "u.s. west coast", "united states west coast", "west coast united states"] },
  { code: "YTO", label: "Toronto metropolitan area", region: "North America", aliases: ["toronto", "toronto area", "toronto metropolitan area"] },
] as const satisfies readonly SearchCodeDefinition[];

export type SeatsAeroSearchCode = (typeof SEATS_AERO_SEARCH_CODES)[number]["code"];

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

export function resolveSeatsAeroSearchCode(
  value: string,
): { code: SeatsAeroSearchCode; label: string; region: Region } | undefined {
  const key = normalize(value);
  const match = SEATS_AERO_SEARCH_CODES.find(
    (entry) =>
      entry.code.toLowerCase() === key ||
      entry.aliases.some((alias) => normalize(alias) === key),
  );
  return match
    ? { code: match.code, label: match.label, region: match.region }
    : undefined;
}

/**
 * Finds every published multi-city name/code mentioned in a route fragment.
 * This is used only as a safety net when structured planning omits an endpoint.
 */
export function searchCodesMentioned(value: string): SeatsAeroSearchCode[] {
  const normalizedValue = normalize(value);
  const candidates: {
    code: SeatsAeroSearchCode;
    start: number;
    end: number;
  }[] = [];

  for (const entry of SEATS_AERO_SEARCH_CODES) {
    const terms = [entry.code, ...entry.aliases];
    let best: { start: number; end: number } | undefined;
    for (const term of terms) {
      const normalizedTerm = normalize(term);
      // "us" is common prose. Treat it as the country only when capitalized
      // or punctuated in the original request; longer aliases are unambiguous.
      if (normalizedTerm === "us" && !/\bUS\b|\bU\.S\./.test(value)) continue;
      const padded = ` ${normalizedValue} `;
      const start = padded.indexOf(` ${normalizedTerm} `);
      if (start < 0) continue;
      const match = { start, end: start + normalizedTerm.length };
      if (!best || match.end - match.start > best.end - best.start) best = match;
    }
    if (best) candidates.push({ code: entry.code, ...best });
  }

  // Prefer the most specific published name when aliases overlap: "Southeast
  // Asia" is SEA, not both SEA and the broader ASA; "US East Coast" is EST,
  // not EST plus USA.
  const selected: typeof candidates = [];
  for (const candidate of candidates.sort(
    (a, b) => b.end - b.start - (a.end - a.start),
  )) {
    if (
      selected.some(
        (other) => candidate.start < other.end && candidate.end > other.start,
      )
    ) {
      continue;
    }
    selected.push(candidate);
  }

  return selected.sort((a, b) => a.start - b.start).map((match) => match.code);
}

const ROUTE_SEPARATOR = String.raw`(?:\bto\b|\binto\b|->|→)`;

/**
 * Extracts provider-native endpoints from an explicit route expression. This
 * deliberately recognizes only catalog-backed names/codes; ordinary place
 * parsing remains the planner's job.
 */
export function inferMultiCityRoute(text: string): {
  origins: SeatsAeroSearchCode[];
  destinations: SeatsAeroSearchCode[];
} {
  const fromTo = new RegExp(
    String.raw`\bfrom\b([\s\S]+?)${ROUTE_SEPARATOR}([\s\S]+)`,
    "i",
  ).exec(text);
  const bareTo = new RegExp(
    String.raw`^([\s\S]+?)${ROUTE_SEPARATOR}([\s\S]+)`,
    "i",
  ).exec(text);
  const match = fromTo ?? bareTo;
  if (!match) return { origins: [], destinations: [] };
  return {
    origins: searchCodesMentioned(match[1]),
    destinations: searchCodesMentioned(match[2]),
  };
}

/** Recovers one or more published origin groups from discovery phrasing. */
export function inferMultiCityOrigins(text: string): SeatsAeroSearchCode[] {
  const route = inferMultiCityRoute(text);
  if (route.origins.length > 0) return route.origins;

  const from = /\b(?:from|out of|departing)\b([\s\S]+)/i.exec(text);
  return from ? searchCodesMentioned(from[1]) : [];
}

/** Returns a broad provider-native code only where the published scope matches. */
export function searchCodeForRegion(
  region: string | undefined,
): SeatsAeroSearchCode | undefined {
  if (region === "Europe") return "EUR";
  if (region === "Asia") return "ASA";
  if (region === "South America") return "SAM";
  // USA is narrower than North America, ANZ is narrower than Oceania, and
  // seats.aero publishes no all-Africa code, so do not silently substitute.
  return undefined;
}

export function displaySearchLocation(code: string): string {
  return SEATS_AERO_SEARCH_CODES.find((entry) => entry.code === code)?.label ?? code;
}
