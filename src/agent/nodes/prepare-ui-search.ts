import { AWARD_PROGRAMS, CREDIT_CARD_PROGRAMS, sourcesForAwardPrograms } from "../../domain/programs";
import { defaultRankingPreference, rankingLevelLabel } from "../../domain/recommendation-preferences";
import type { TripRequest } from "../../contracts/travel-search";
import type { AgentStateType, SearchPlan } from "../state";

function shiftDate(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

/** A compact audit trail that makes a form search readable in thread history. */
export function describeTripRequest(request: TripRequest): string {
  const destinations = request.destinations.map((destination) => destination.code).join(", ");
  const cards = request.creditCardPrograms.join(", ") || "selected point balances";
  const hasBalances = Object.keys(request.pointBalances.creditCards).length > 0 || Object.keys(request.pointBalances.awardPrograms).length > 0;
  const rankingPreference = request.rankingPreference ?? defaultRankingPreference();
  const rankingPriorities = rankingPreference.priorities.length > 0
    ? ` Priorities: ${rankingPreference.priorities.join(", ")}.`
    : "";
  return [
    `Search award travel from ${request.origin.code} to ${destinations}.`,
    `Travel ${request.startDate} through ${request.endDate} with ±${request.flexDays} days flexibility.`,
    `${request.travelers} traveler(s), cabins: ${request.cabins.join(", ")}, stops: ${request.stopPreference}.`,
    `Use ${cards}; award programs: ${request.awardPrograms.join(", ") || "all available"}.`,
    hasBalances ? "Only show awards fundable with the entered point balances." : "",
    request.maxTaxesFeesUsd != null ? `Keep taxes and fees at or below $${request.maxTaxesFeesUsd.toLocaleString()} USD per traveler.` : "",
    `Ranking preference: ${rankingLevelLabel(rankingPreference.experienceWeight)} (${rankingPreference.experienceWeight}/100 toward journey experience).${rankingPriorities}`,
    request.notes ? `Preferences: ${request.notes}` : "",
  ].filter(Boolean).join(" ");
}

/** Combines direct airline balances with every selected transferable-card balance at a nominal 1:1 ratio. */
export function availablePointsByProgram(request: TripRequest): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const programId of request.awardPrograms) {
    const program = AWARD_PROGRAMS.find((item) => item.id === programId);
    if (!program) continue;
    const directBalance = request.pointBalances.awardPrograms[programId] ?? 0;
    const transferableBalance = CREDIT_CARD_PROGRAMS
      .filter((card) => request.creditCardPrograms.includes(card.id) && card.programs.includes(program.id))
      .reduce((sum, card) => sum + (request.pointBalances.creditCards[card.id] ?? 0), 0);
    balances[program.source] = directBalance + transferableBalance;
  }
  return balances;
}

/** Converts explicit UI choices into the graph's existing search contract. */
export async function prepareUiSearch(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const request = state.tripRequest;
  if (!request) return { searchPlan: null, awardResults: [], recommendations: [] };
  const unresolvedPlaces = [request.origin, ...request.destinations]
    .filter((location) => location.airports.length === 0)
    .map((location) => location.code);
  const filterByPointBalances = Object.values(request.pointBalances.creditCards).some((balance) => balance > 0) ||
    Object.values(request.pointBalances.awardPrograms).some((balance) => balance > 0);

  const plan: SearchPlan = {
    origins: request.origin.airports,
    destinations: request.destinations.flatMap((destination) => destination.airports),
    startDate: shiftDate(request.startDate, -request.flexDays),
    endDate: shiftDate(request.endDate, request.flexDays),
    cabins: request.cabins,
    nonstopOnly: request.stopPreference === "nonstop",
    stopPreference: request.stopPreference,
    programs: sourcesForAwardPrograms(request.awardPrograms),
    preferredAirlines: request.preferredAirlines,
    travelers: request.travelers,
    availablePointsByProgram: filterByPointBalances ? availablePointsByProgram(request) : undefined,
    filterByPointBalances,
    maxTaxesFeesUsd: request.maxTaxesFeesUsd,
    rationale: describeTripRequest(request),
    unresolvedPlaces: unresolvedPlaces.length ? unresolvedPlaces : undefined,
  };

  return {
    intent: "route_search",
    searchPlan: plan,
    awardResults: [],
    candidateShortlist: [],
    tripSummaries: [],
    recommendations: [],
    kbDocs: [],
    draft: null,
    violations: [],
    refreshedAt: null,
    searchAttempts: [],
    positioningSearchComplete: false,
  };
}
