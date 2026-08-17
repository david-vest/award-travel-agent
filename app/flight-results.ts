import type { FlightRecommendation } from "../src/contracts/travel-search";

export type FlightSort =
  | "recommended"
  | "points_asc"
  | "points_desc"
  | "fees_asc"
  | "date_asc"
  | "stops_asc"
  | "duration_asc"
  | "depart_asc";

export type ResultStopsFilter = "any" | "nonstop" | "up_to_one" | "connecting";

export type FlightResultFilters = {
  stops: ResultStopsFilter;
  cabins: string[];
  programs: string[];
  maxPoints: number | null;
  maxFeesUsd: number | null;
  maxDurationMinutes: number | null;
};

export const DEFAULT_FLIGHT_FILTERS: FlightResultFilters = {
  stops: "any",
  cabins: [],
  programs: [],
  maxPoints: null,
  maxFeesUsd: null,
  maxDurationMinutes: null,
};

export const FLIGHT_SORT_OPTIONS: Array<{ value: FlightSort; label: string }> = [
  { value: "recommended", label: "Roam's ranking" },
  { value: "points_asc", label: "Points: low to high" },
  { value: "points_desc", label: "Points: high to low" },
  { value: "fees_asc", label: "Taxes & fees" },
  { value: "date_asc", label: "Departure date" },
  { value: "stops_asc", label: "Fewest stops" },
  { value: "duration_asc", label: "Shortest duration" },
  { value: "depart_asc", label: "Earliest departure" },
];

function numeric(value: number | undefined): number {
  return value ?? Number.POSITIVE_INFINITY;
}

function departureTime(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function activeFlightFilterCount(filters: FlightResultFilters): number {
  return [
    filters.stops !== "any",
    filters.cabins.length > 0,
    filters.programs.length > 0,
    filters.maxPoints != null,
    filters.maxFeesUsd != null,
    filters.maxDurationMinutes != null,
  ].filter(Boolean).length;
}

export function applyFlightControls(
  recommendations: FlightRecommendation[],
  sort: FlightSort,
  filters: FlightResultFilters,
): FlightRecommendation[] {
  const filtered = recommendations.filter((flight) => {
    const stops = flight.stops ?? (flight.direct ? 0 : undefined);
    if (filters.stops === "nonstop" && stops !== 0) return false;
    if (filters.stops === "up_to_one" && (stops == null || stops > 1)) return false;
    if (filters.stops === "connecting" && (stops == null || stops === 0)) return false;
    if (filters.cabins.length > 0 && !filters.cabins.includes(flight.cabin)) return false;
    if (filters.programs.length > 0 && !filters.programs.includes(flight.program.id)) return false;
    if (filters.maxPoints != null && flight.miles > filters.maxPoints) return false;
    if (filters.maxFeesUsd != null) {
      if (!flight.taxes || flight.taxes.currency !== "USD" || flight.taxes.amount > filters.maxFeesUsd) return false;
    }
    if (filters.maxDurationMinutes != null && (flight.durationMinutes == null || flight.durationMinutes > filters.maxDurationMinutes)) return false;
    return true;
  });

  return [...filtered].sort((a, b) => {
    let comparison = 0;
    if (sort === "recommended") comparison = a.rank - b.rank;
    if (sort === "points_asc") comparison = a.miles - b.miles;
    if (sort === "points_desc") comparison = b.miles - a.miles;
    if (sort === "fees_asc") comparison = numeric(a.taxes?.currency === "USD" ? a.taxes.amount : undefined) - numeric(b.taxes?.currency === "USD" ? b.taxes.amount : undefined);
    if (sort === "date_asc") comparison = a.date.localeCompare(b.date);
    if (sort === "stops_asc") comparison = numeric(a.stops ?? (a.direct ? 0 : undefined)) - numeric(b.stops ?? (b.direct ? 0 : undefined));
    if (sort === "duration_asc") comparison = numeric(a.durationMinutes) - numeric(b.durationMinutes);
    if (sort === "depart_asc") comparison = departureTime(a.departsAt) - departureTime(b.departsAt);
    return comparison || a.rank - b.rank;
  });
}
