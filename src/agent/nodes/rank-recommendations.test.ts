import { describe, expect, it } from "vitest";
import type { AgentStateType } from "../state";
import { rankRecommendations } from "./rank-recommendations";

describe("rankRecommendations", () => {
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
});
