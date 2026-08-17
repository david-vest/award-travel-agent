import type { FlightRecommendation } from "../../contracts/travel-search";
import { awardProgramForSource } from "../../domain/programs";
import type { AwardOption, TripSummary } from "../../tools";
import type { AgentStateType } from "../state";
import { filterByPointBalances } from "./search";

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
    if (plan?.maxTaxesFeesUsd != null && trip?.totalTaxes != null && (trip.taxesCurrency ?? "USD") === "USD" && trip.totalTaxes > plan.maxTaxesFeesUsd) return null;
    const carriers = primaryCarrier(option, trip);
    const factors: FlightRecommendation["scoreFactors"] = [{ label: "Points", value: `${option.miles.toLocaleString()} miles` }];
    let score = option.miles;

    const tier = option.searchTier ?? "exact";
    score += POSITIONING_PENALTY[tier];
    if (tier !== "exact") factors.push({ label: "Positioning", value: tier.replaceAll("_", " ") });

    if (option.direct) {
      score -= plan?.stopPreference === "up_to_one" ? 4_000 : 1_500;
      factors.push({ label: "Stops", value: "Nonstop" });
    } else if (plan?.stopPreference === "nonstop") {
      score += 1_000_000;
      factors.push({ label: "Stops", value: "Connection — excluded by preference" });
    } else {
      factors.push({ label: "Stops", value: trip?.stops != null ? `${trip.stops} stop${trip.stops === 1 ? "" : "s"}` : "Connection" });
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
    return { option, trip, carriers, score, factors };
  }).filter((item): item is NonNullable<typeof item> => item !== null && item.score < 1_000_000).sort((a, b) => a.score - b.score || a.option.miles - b.option.miles);

  const recommendations: FlightRecommendation[] = scored.map(({ option, trip, carriers, factors }, index) => {
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
      taxes: trip?.totalTaxes != null ? { amount: trip.totalTaxes, currency: trip.taxesCurrency ?? "USD" } : undefined,
      program: { id: option.program, label: program?.name ?? option.program },
      carriers,
      direct: option.direct,
      stops: trip?.stops,
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
