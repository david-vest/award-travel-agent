import { describe, expect, it } from "vitest";
import type { FlightRecommendation } from "../src/contracts/travel-search";
import { applyFlightControls, DEFAULT_FLIGHT_FILTERS } from "./flight-results";

const flight = (over: Partial<FlightRecommendation>): FlightRecommendation => ({
  id: "a:business",
  rank: 1,
  origin: "SFO",
  destination: "HND",
  date: "2026-09-18",
  cabin: "business",
  miles: 60_000,
  taxes: { amount: 38, currency: "USD" },
  program: { id: "united", label: "United MileagePlus" },
  carriers: ["NH"],
  direct: true,
  stops: 0,
  durationMinutes: 660,
  flightNumbers: ["NH7"],
  aircraft: ["777-300ER"],
  reason: "Best fit.",
  scoreFactors: [],
  confidence: "high",
  ...over,
});

describe("applyFlightControls", () => {
  const options = [
    flight({ id: "ranked", rank: 1, miles: 80_000 }),
    flight({ id: "cheap", rank: 2, miles: 55_000, direct: false, stops: 1, durationMinutes: 840 }),
    flight({ id: "expensive", rank: 3, miles: 120_000, taxes: { amount: 420, currency: "USD" } }),
  ];

  it("keeps Roam's deterministic order by default", () => {
    expect(applyFlightControls(options, "recommended", DEFAULT_FLIGHT_FILTERS).map((item) => item.id)).toEqual(["ranked", "cheap", "expensive"]);
  });

  it("sorts by points without changing the underlying recommendation ranks", () => {
    const sorted = applyFlightControls(options, "points_asc", DEFAULT_FLIGHT_FILTERS);
    expect(sorted.map((item) => item.id)).toEqual(["cheap", "ranked", "expensive"]);
    expect(sorted.find((item) => item.id === "ranked")?.rank).toBe(1);
  });

  it("combines stops, points, and fee ceilings", () => {
    const filtered = applyFlightControls(options, "recommended", {
      ...DEFAULT_FLIGHT_FILTERS,
      stops: "nonstop",
      maxPoints: 100_000,
      maxFeesUsd: 100,
    });
    expect(filtered.map((item) => item.id)).toEqual(["ranked"]);
  });

  it("hides unknown or non-USD fees when the user sets a USD ceiling", () => {
    const filtered = applyFlightControls([
      flight({ id: "unknown", taxes: undefined }),
      flight({ id: "eur", taxes: { amount: 20, currency: "EUR" } }),
    ], "recommended", { ...DEFAULT_FLIGHT_FILTERS, maxFeesUsd: 100 });
    expect(filtered).toEqual([]);
  });
});
