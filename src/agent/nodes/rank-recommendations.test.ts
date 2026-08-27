import { describe, expect, it } from "vitest";
import type { AgentStateType } from "../state";
import { rankRecommendations } from "./rank-recommendations";

describe("rankRecommendations", () => {
  it("creates recommendation cards only for shortlisted, fully assessed options", async () => {
    const shortlisted = { availabilityId: "shortlisted", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60_000, direct: true, airlines: "UA" } as const;
    const rawOnly = { availabilityId: "raw-only", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 40_000, direct: true, airlines: "UA" } as const;
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [] },
      awardResults: [rawOnly, shortlisted],
      candidateShortlist: [shortlisted],
      tripSummaries: [],
    } as unknown as AgentStateType);

    expect(result.recommendations?.map((item) => item.id)).toEqual(["shortlisted:business"]);
    expect(result.awardResults).toHaveLength(2);
  });

  it("puts a viable nonstop preferred-carrier option first and omits connections for nonstop searches", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: true, stopPreference: "nonstop", programs: ["united"], travelers: 2, preferredAirlines: ["NH"] },
      awardResults: [
        { availabilityId: "connection", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 50000, direct: false, airlines: "UA", remainingSeats: 2 },
        { availabilityId: "nonstop", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: true, airlines: "NH", remainingSeats: 2 },
      ],
      tripSummaries: [{ availabilityId: "nonstop", tripId: "trip-1", flightNumbers: ["NH 7"], aircraft: ["777-300ER"], carriers: ["NH"], stops: 0, remainingSeats: 2 }],
    } as unknown as AgentStateType);

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations?.[0]).toMatchObject({ id: "nonstop:business", rank: 1, direct: true, carriers: ["NH"], remainingSeats: 2 });
    expect(result.awardResults?.map((option) => option.availabilityId)).toEqual(["nonstop", "connection"]);
  });

  it("passes connection details through to a displayed recommendation", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [] },
      awardResults: [{ availabilityId: "connection", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: false, airlines: "UA" }],
      tripSummaries: [{ availabilityId: "connection", tripId: "trip-1", flightNumbers: ["UA 1", "UA 2"], aircraft: [], carriers: ["UA"], stops: 1, connections: [{ airport: "LAX", layoverMinutes: 95 }] }],
    } as unknown as AgentStateType);
    expect(result.recommendations?.[0].connections).toEqual([{ airport: "LAX", layoverMinutes: 95 }]);
    expect(result.recommendations?.[0].scoreFactors).toContainEqual({ label: "Layover", value: "1h 35m total" });
  });

  it("prefers a shorter layover when points, fees, and stops are equal", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [] },
      awardResults: [
        { availabilityId: "long", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: false, airlines: "UA" },
        { availabilityId: "short", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: false, airlines: "UA" },
      ],
      tripSummaries: [
        { availabilityId: "long", tripId: "trip-long", flightNumbers: [], aircraft: [], carriers: ["UA"], stops: 1, connections: [{ airport: "LAX", layoverMinutes: 300 }] },
        { availabilityId: "short", tripId: "trip-short", flightNumbers: [], aircraft: [], carriers: ["UA"], stops: 1, connections: [{ airport: "LAX", layoverMinutes: 60 }] },
      ],
    } as unknown as AgentStateType);

    expect(result.recommendations?.map((item) => item.id)).toEqual(["short:business", "long:business"]);
  });

  it("prefers fewer stops when points, fees, and total layover time are equal", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [] },
      awardResults: [
        { availabilityId: "two-stops", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: false, airlines: "UA" },
        { availabilityId: "one-stop", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: false, airlines: "UA" },
      ],
      tripSummaries: [
        { availabilityId: "two-stops", tripId: "trip-two", flightNumbers: [], aircraft: [], carriers: ["UA"], stops: 2, connections: [{ airport: "LAX", layoverMinutes: 30 }, { airport: "SEA", layoverMinutes: 30 }] },
        { availabilityId: "one-stop", tripId: "trip-one", flightNumbers: [], aircraft: [], carriers: ["UA"], stops: 1, connections: [{ airport: "SEA", layoverMinutes: 60 }] },
      ],
    } as unknown as AgentStateType);

    expect(result.recommendations?.map((item) => item.id)).toEqual(["one-stop:business", "two-stops:business"]);
    expect(result.recommendations?.[0].scoreFactors).toContainEqual({ label: "Stops", value: "1 stop" });
  });

  it("labels positioning options while keeping a modest exact-route preference", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["ORD"], destinations: ["FUK"], cabins: ["business"], nonstopOnly: false, programs: [] },
      awardResults: [
        { availabilityId: "exact", origin: "ORD", destination: "FUK", date: "2026-09-18", program: "united", cabin: "business", miles: 65000, direct: true, airlines: "UA", searchTier: "exact", requestedOrigins: ["ORD"], requestedDestinations: ["FUK"] },
        { availabilityId: "fallback", origin: "SFO", destination: "NRT", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: true, airlines: "UA", searchTier: "destination_gateway", searchReason: "Broadened to Japan gateways.", requestedOrigins: ["ORD"], requestedDestinations: ["FUK"] },
      ],
      tripSummaries: [],
    } as unknown as AgentStateType);

    expect(result.recommendations?.[0].id).toBe("exact:business");
    expect(result.recommendations?.[1].positioning).toMatchObject({ before: "ORD → SFO", after: "NRT → FUK" });
  });

  it("keeps a unique recommendation identity when one availability has several cabins", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["economy", "business"], nonstopOnly: false, programs: [] },
      awardResults: [
        { availabilityId: "same", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "economy", miles: 35000, direct: true, airlines: "UA" },
        { availabilityId: "same", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: true, airlines: "UA" },
      ],
      tripSummaries: [],
    } as unknown as AgentStateType);
    expect(result.recommendations?.map((item) => item.id)).toEqual(["same:economy", "same:business"]);
  });

  it("ranks a cheaper-fee, higher-miles option above an expensive-fee, lower-miles option", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["MIA"], destinations: ["CDG"], cabins: ["business"], nonstopOnly: false, programs: [] },
      awardResults: [
        { availabilityId: "ba", origin: "JFK", destination: "CDG", date: "2026-09-18", program: "british_airways", cabin: "business", miles: 45000, taxes: 1000, taxesCurrency: "USD", direct: true, airlines: "BA" },
        { availabilityId: "alaska", origin: "MIA", destination: "CDG", date: "2026-09-18", program: "alaska", cabin: "business", miles: 55000, taxes: 50, taxesCurrency: "USD", direct: true, airlines: "AF" },
      ],
      tripSummaries: [],
    } as unknown as AgentStateType);

    expect(result.recommendations?.[0].id).toBe("alaska:business");
  });

  it("falls back to the search result's own taxes when no trip was enriched", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [] },
      awardResults: [
        { availabilityId: "unenriched", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, taxes: 112.9, taxesCurrency: "USD", direct: true, airlines: "UA" },
      ],
      tripSummaries: [],
    } as unknown as AgentStateType);

    expect(result.recommendations?.[0].taxes).toEqual({ amount: 112.9, currency: "USD" });
  });

  it("includes a taxes-and-fees score factor", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [] },
      awardResults: [
        { availabilityId: "priced", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, taxes: 112.9, taxesCurrency: "USD", direct: true, airlines: "UA" },
      ],
      tripSummaries: [],
    } as unknown as AgentStateType);

    expect(result.recommendations?.[0].scoreFactors).toContainEqual({ label: "Taxes & fees", value: "$112.90" });
  });

  it("still excludes an option whose unenriched taxes exceed maxTaxesFeesUsd", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [], maxTaxesFeesUsd: 100 },
      awardResults: [
        { availabilityId: "over-budget", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, taxes: 250, taxesCurrency: "USD", direct: true, airlines: "UA" },
      ],
      tripSummaries: [],
    } as unknown as AgentStateType);

    expect(result.recommendations).toHaveLength(0);
  });

  it("[REGRESSION] a recommendation's refreshedAt reflects the option's own refreshConfirmedAt, not an unrelated confirmed option's global timestamp", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [] },
      awardResults: [
        { availabilityId: "confirmed", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: true, airlines: "UA", updatedAt: "2026-08-10T00:00:00Z", refreshConfirmedAt: "2026-08-17T12:00:00Z" },
        { availabilityId: "not-refreshed", origin: "SFO", destination: "HND", date: "2026-09-18", program: "delta", cabin: "business", miles: 61000, direct: true, airlines: "DL", updatedAt: "2026-08-10T00:00:00Z" },
      ],
      tripSummaries: [],
      // A stale global timestamp from refreshing a DIFFERENT, unrelated option this turn.
      refreshedAt: "2026-08-17T12:00:00Z",
    } as unknown as AgentStateType);

    const byId = new Map((result.recommendations ?? []).map((r) => [r.id.split(":")[0], r]));
    expect(byId.get("confirmed")?.refreshedAt).toBe("2026-08-17T12:00:00Z");
    // Must fall back to its own updatedAt, never the unrelated global refreshedAt.
    expect(byId.get("not-refreshed")?.refreshedAt).toBe("2026-08-10T00:00:00Z");
  });

  it("[REGRESSION] hard-excludes an option with fewer confirmed seats than travelers, rather than merely down-ranking it", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [], travelers: 2 },
      awardResults: [
        { availabilityId: "one-seat", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: true, airlines: "UA", remainingSeats: 1 },
      ],
      tripSummaries: [],
    } as unknown as AgentStateType);

    expect(result.recommendations).toHaveLength(0);
  });

  it("does not exclude an option with an unknown seat count, even when travelers is set", async () => {
    const result = await rankRecommendations({
      searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["business"], nonstopOnly: false, programs: [], travelers: 2 },
      awardResults: [
        { availabilityId: "unknown-seats", origin: "SFO", destination: "HND", date: "2026-09-18", program: "united", cabin: "business", miles: 60000, direct: true, airlines: "UA" },
      ],
      tripSummaries: [],
    } as unknown as AgentStateType);

    expect(result.recommendations).toHaveLength(1);
  });
});
