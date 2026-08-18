import type { FlightRecommendation } from "../../contracts/travel-search";
import { awardProgramForSource } from "../../domain/programs";
import type { AwardOption, TripSummary } from "../../tools";
import type { AgentStateType } from "../state";
import { filterByPointBalances } from "./search";
import { blendedCost } from "../points-value";

/** Trip-detail taxes are the confirmed figure; the search result's own taxes are the best fallback before enrichment has run. */
function effectiveTaxes(option: AwardOption, trip?: TripSummary): { amount: number; currency: string } | undefined {
  if (trip?.totalTaxes != null) return { amount: trip.totalTaxes, currency: trip.taxesCurrency ?? "USD" };
  if (option.taxes != null) return { amount: option.taxes, currency: option.taxesCurrency ?? "USD" };
  return undefined;
}

function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

function primaryCarrier(option: AwardOption, trip?: TripSummary): string[] {
  const carriers = trip?.carriers?.length ? trip.carriers : option.airlines.split(",");
  return carriers.map((carrier) => carrier.trim().toUpperCase()).filter(Boolean);
}

function confidence(option: AwardOption, trip?: TripSummary): FlightRecommendation["confidence"] {
  if (option.remainingSeats && option.remainingSeats >= 2 && trip?.departsAt) return "high";
  if (option.remainingSeats || trip?.departsAt) return "medium";
  return "low";
}

const POSITIONING_PENALTY: Record<NonNullable<AwardOption["searchTier"]>, number> = {
  exact: 0,
  destination_gateway: 10_000,
  country_pair: 20_000,
  region_pair: 35_000,
};

/** Points-equivalent comfort costs used only to order otherwise viable awards. */
const STOP_PENALTY = 6_000;
const LAYOVER_PENALTY_PER_HOUR = 500;
const MAX_SCORED_LAYOVER_MINUTES = 24 * 60;

function stopCount(option: AwardOption, trip?: TripSummary): number {
  if (option.direct) return 0;
  return Math.max(1, trip?.stops ?? trip?.connections?.length ?? 1);
}

function knownLayoverMinutes(trip?: TripSummary): number | undefined {
  const known = (trip?.connections ?? [])
    .map((connection) => connection.layoverMinutes)
    .filter((minutes): minutes is number => minutes != null && Number.isFinite(minutes) && minutes >= 0);
  if (known.length === 0) return undefined;
  return known.reduce((total, minutes) => total + minutes, 0);
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ""}` : `${remainder}m`;
}

/**
 * The product ranking is deterministic and inspectable. The model later
 * explains this ranking; it does not silently decide which provider result is
 * allowed to lead the rail.
 */
export async function rankRecommendations(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const plan = state.searchPlan;
  const tripByAvailability = new Map((state.tripSummaries ?? []).map((trip) => [trip.availabilityId, trip]));
  const budgetEligibleOptions = plan ? filterByPointBalances(state.awardResults ?? [], plan) : (state.awardResults ?? []);
  const scored = budgetEligibleOptions.map((option) => {
    const trip = tripByAvailability.get(option.availabilityId);
    const taxes = effectiveTaxes(option, trip);
    if (plan?.maxTaxesFeesUsd != null && taxes != null && taxes.currency === "USD" && taxes.amount > plan.maxTaxesFeesUsd) return null;
    const carriers = primaryCarrier(option, trip);
    const factors: FlightRecommendation["scoreFactors"] = [{ label: "Points", value: `${option.miles.toLocaleString()} miles` }];
    if (taxes != null) factors.push({ label: "Taxes & fees", value: taxes.currency === "USD" ? formatUsd(taxes.amount) : `${taxes.amount} ${taxes.currency}` });
    // Blended so a lower-mileage, higher-fee option doesn't automatically
    // outrank a higher-mileage, lower-fee one — see points-value.ts.
    let score = blendedCost(option.miles, taxes?.amount, taxes?.currency);

    const tier = option.searchTier ?? "exact";
    score += POSITIONING_PENALTY[tier];
    if (tier !== "exact") factors.push({ label: "Positioning", value: tier.replaceAll("_", " ") });

    const stops = stopCount(option, trip);
    const layoverMinutes = knownLayoverMinutes(trip);
    if (option.direct) {
      score -= plan?.stopPreference === "up_to_one" ? 4_000 : 1_500;
      factors.push({ label: "Stops", value: "Nonstop" });
    } else if (plan?.stopPreference === "nonstop") {
      score += 1_000_000;
      factors.push({ label: "Stops", value: "Connection — excluded by preference" });
    } else {
      score += stops * STOP_PENALTY;
      factors.push({ label: "Stops", value: `${stops} stop${stops === 1 ? "" : "s"}` });
      if (layoverMinutes != null) {
        score += (Math.min(layoverMinutes, MAX_SCORED_LAYOVER_MINUTES) / 60) * LAYOVER_PENALTY_PER_HOUR;
        factors.push({ label: "Layover", value: `${formatMinutes(layoverMinutes)} total` });
      }
    }

    if (plan?.preferredAirlines?.some((airline) => carriers.includes(airline))) {
      score -= 3_000;
      factors.push({ label: "Airline", value: "Preferred carrier" });
    }

    const seats = option.remainingSeats ?? trip?.remainingSeats;
    if (seats != null && plan?.travelers) {
      if (seats >= plan.travelers) {
        score -= 800;
        factors.push({ label: "Seats", value: `${seats} available` });
      } else {
        score += 500_000;
        factors.push({ label: "Seats", value: `${seats} known — fewer than ${plan.travelers} travelers` });
      }
    }

    const program = awardProgramForSource(option.program);
    factors.push({ label: "Program", value: program?.name ?? option.program });
    return { option, trip, carriers, score, factors, taxes };
  }).filter((item): item is NonNullable<typeof item> => item !== null && item.score < 1_000_000).sort((a, b) => a.score - b.score || a.option.miles - b.option.miles);

  const recommendations: FlightRecommendation[] = scored.map(({ option, trip, carriers, factors, taxes }, index) => {
    const program = awardProgramForSource(option.program);
    const leading = index === 0;
    const tier = option.searchTier ?? "exact";
    const needsPositioning = tier !== "exact";
    const before = needsPositioning && !(option.requestedOrigins ?? []).includes(option.origin)
      ? `${(option.requestedOrigins ?? []).join("/")} → ${option.origin}`
      : undefined;
    const after = needsPositioning && !(option.requestedDestinations ?? []).includes(option.destination)
      ? `${option.destination} → ${(option.requestedDestinations ?? []).join("/")}`
      : undefined;
    return {
      id: `${option.availabilityId}:${option.cabin}`,
      rank: index + 1,
      origin: option.origin,
      destination: option.destination,
      date: option.date,
      cabin: option.cabin,
      miles: option.miles,
      taxes,
      program: { id: option.program, label: program?.name ?? option.program },
      carriers,
      direct: option.direct,
      stops: trip?.stops ?? (option.direct ? 0 : undefined),
      connections: trip?.connections,
      remainingSeats: option.remainingSeats ?? trip?.remainingSeats,
      departsAt: trip?.departsAt,
      arrivesAt: trip?.arrivesAt,
      durationMinutes: trip?.durationMinutes,
      flightNumbers: trip?.flightNumbers ?? [],
      aircraft: trip?.aircraft ?? [],
      refreshedAt: state.refreshedAt ?? option.updatedAt,
      reason: leading
        ? `Best overall fit for your selected points, cabin, and stop preferences.`
        : `A verified alternative with ${option.direct ? "a nonstop route" : "a competitive connecting itinerary"}.`,
      scoreFactors: factors,
      confidence: confidence(option, trip),
      positioning: needsPositioning ? {
        tier,
        before,
        after,
        explanation: option.searchReason ?? "This option uses a nearby gateway and requires a separate positioning segment.",
      } : undefined,
    };
  });

  const order = new Map(recommendations.map((recommendation) => [recommendation.id, recommendation.rank]));
  return {
    awardResults: [...budgetEligibleOptions].sort((a, b) => (order.get(`${a.availabilityId}:${a.cabin}`) ?? Infinity) - (order.get(`${b.availabilityId}:${b.cabin}`) ?? Infinity)),
    recommendations,
  };
}
