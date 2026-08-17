export type CabinClass = "economy" | "premium" | "business" | "first";

/** The six regions the seats.aero bulk-availability endpoint accepts. */
export type Region =
  | "North America"
  | "South America"
  | "Europe"
  | "Asia"
  | "Africa"
  | "Oceania";

export const REGIONS: readonly Region[] = [
  "North America",
  "South America",
  "Europe",
  "Asia",
  "Africa",
  "Oceania",
] as const;

/** Mileage programs used as the `source` / `sources` parameter. */
export const MILEAGE_PROGRAMS = [
  "aeromexico", "aeroplan", "alaska", "american", "azul", "connectmiles",
  "delta", "emirates", "ethiopian", "etihad", "eurobonus", "finnair",
  "flyingblue", "jetblue", "lifemiles", "lufthansa", "qantas", "qatar",
  "saudia", "singapore", "smiles", "turkish", "united", "velocity",
  "virginatlantic",
] as const;

export type MileageProgram = (typeof MILEAGE_PROGRAMS)[number];

/** GET /partnerapi/search — requires origin and destination airports. */
export type SearchParams = {
  origin_airport: string; // comma-delimited IATA, e.g. "ORD,MDW"
  destination_airport: string;
  start_date?: string; // YYYY-MM-DD
  end_date?: string;
  cabins?: string; // comma-delimited CabinClass
  carriers?: string;
  sources?: string;
  only_direct_flights?: boolean;
  /** Maximum taxes and fees in USD cents. */
  max_fees?: number;
  take?: number;
  cursor?: number;
  order_by?: "lowest_mileage";
};

/** GET /partnerapi/availability — one program, region-scoped. */
export type RegionalParams = {
  source: MileageProgram;
  origin_region?: Region;
  destination_region?: Region;
  cabin?: CabinClass;
  start_date?: string;
  end_date?: string;
  /** Maximum taxes and fees in USD cents. */
  max_fees?: number;
  take?: number;
  cursor?: number;
};

export type Route = {
  ID: string;
  OriginAirport: string;
  DestinationAirport: string;
  OriginRegion?: string;
  DestinationRegion?: string;
  Distance: number;
  Source: string;
};

export type AvailabilityResult = {
  ID: string;
  RouteID: string;
  Route: Route;
  Date: string;
  ParsedDate: string;
  Source: string;

  YAvailable: boolean;
  WAvailable: boolean;
  JAvailable: boolean;
  FAvailable: boolean;

  YMileageCost: string;
  WMileageCost: string;
  JMileageCost: string;
  FMileageCost: string;

  YDirect: boolean;
  WDirect: boolean;
  JDirect: boolean;
  FDirect: boolean;

  YRemainingSeats?: number;
  WRemainingSeats?: number;
  JRemainingSeats?: number;
  FRemainingSeats?: number;

  Airlines: string;
  JAirlines?: string;
  FAirlines?: string;

  UpdatedAt?: string;
  CreatedAt?: string;
};

export type SearchResponse = {
  data: AvailabilityResult[];
  count: number;
  hasMore: boolean;
  cursor: number;
};

export type TripSegment = {
  FlightNumber: string;
  Carrier?: string;
  OriginAirport: string;
  DestinationAirport: string;
  DepartsAt: string;
  ArrivesAt: string;
  AircraftName?: string;
  Cabin?: string;
  Distance?: number;
};

export type Trip = {
  ID: string;
  RouteID?: string;
  MileageCost?: number;
  TotalDuration?: number;
  TotalTaxes?: number;
  TaxesCurrency?: string;
  Stops?: number;
  Carriers?: string;
  RemainingSeats?: number;
  Cabin?: string;
  DepartsAt?: string;
  ArrivesAt?: string;
  Aircraft?: string[];
  Connections?: string[];
  AvailabilitySegments?: TripSegment[];
};

/** POST /partnerapi/refresh */
export type RefreshItemStatus =
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "fresh"
  | "skipped_outage"
  | "not_refreshable"
  | "not_found"
  | "insufficient_quota";

export type RefreshResponse = {
  complete: boolean;
  items: Array<{ id: string; status: RefreshItemStatus }>;
  processing?: number;
  succeeded?: number;
  failed?: number;
  quota?: { limit: number; used: number; remaining: number; reset_seconds: number };
};

/** Parsed from x-ratelimit-* response headers. */
export type QuotaState = {
  limit: number | null;
  remaining: number | null;
  reset: number | null;
};
