import type { AvailabilityResult, CabinClass } from "./seats-aero/types";

/** One bookable option: a single cabin on a single date via a single program. */
export type AwardOption = {
  availabilityId: string;
  origin: string;
  destination: string;
  date: string;
  program: string;
  cabin: CabinClass;
  miles: number;
  direct: boolean;
  airlines: string;
  remainingSeats?: number;
  updatedAt?: string;
};

const CABIN_FIELDS = [
  { cabin: "economy", prefix: "Y" },
  { cabin: "premium", prefix: "W" },
  { cabin: "business", prefix: "J" },
  { cabin: "first", prefix: "F" },
] as const;

/**
 * Flattens seats.aero's four-cabins-per-record shape into one option per
 * available cabin. Everything downstream works on AwardOption — the raw shape
 * stops here.
 */
export function normalizeResults(raw: AvailabilityResult[]): AwardOption[] {
  const out: AwardOption[] = [];

  for (const r of raw) {
    for (const { cabin, prefix } of CABIN_FIELDS) {
      const available = r[`${prefix}Available` as keyof AvailabilityResult];
      if (!available) continue;

      const miles = Number(r[`${prefix}MileageCost` as keyof AvailabilityResult]);
      // A zero or non-numeric cost means the record is junk, not a free seat.
      if (!Number.isFinite(miles) || miles <= 0) continue;

      out.push({
        availabilityId: r.ID,
        origin: r.Route.OriginAirport,
        destination: r.Route.DestinationAirport,
        date: (r.ParsedDate || r.Date).slice(0, 10),
        program: r.Source,
        cabin,
        miles,
        direct: Boolean(r[`${prefix}Direct` as keyof AvailabilityResult]),
        // Economy/premium (Y/W) have no per-cabin airlines field on
        // AvailabilityResult, so they fall back to the record-level combined
        // `Airlines` field — broader than the J/F per-cabin data, which makes
        // downstream filtering/groundedness checks for those two cabins
        // slightly more permissive (never wrong-blocking, just less precise).
        airlines: String(
          r[`${prefix}Airlines` as keyof AvailabilityResult] ?? r.Airlines ?? "",
        ),
        remainingSeats: r[
          `${prefix}RemainingSeats` as keyof AvailabilityResult
        ] as number | undefined,
        updatedAt: r.UpdatedAt,
      });
    }
  }

  return out;
}
