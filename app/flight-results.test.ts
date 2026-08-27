import { describe, expect, it } from "vitest";
import type { FlightRecommendation } from "../src/contracts/travel-search";
import {
  applyFlightControls,
  buildFlightComparisonRows,
  DEFAULT_FLIGHT_FILTERS,
  recommendationDeltas,
} from "./flight-results";

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

describe("recommendation decision support", () => {
  it("formats compact, factual tradeoff deltas against the cheapest option", () => {
    expect(recommendationDeltas(flight({
      tradeoff: {
        comparedWithId: "cheap",
        extraMiles: 17_500,
        feeDifferenceUsd: 42,
        durationSavedMinutes: 260,
        stopsSaved: 1,
      },
    }))).toEqual(["+17.5k points", "+$42 fees", "4h 20m shorter", "1 fewer stop"]);
  });

  it("builds a comparison without mutating server recommendation ranks", () => {
    const compared = [
      flight({ id: "second", rank: 2, qualitativeAssessments: { cabin_product: { score: 88, rationale: "Direct aisle access.", evidenceIds: ["seat-doc"] } }, assessmentConfidence: "high", experienceScore: 84 }),
      flight({ id: "first", rank: 1, miles: 75_000, assessmentConfidence: "low", evidenceIds: [], experienceScore: 72 }),
    ];
    const rows = buildFlightComparisonRows(compared);
    expect(rows.find((row) => row.label === "Roam rank")?.values).toEqual(["#2", "#1"]);
    expect(rows.find((row) => row.label === "Cabin product")?.values[0]).toContain("88/100");
    expect(rows.find((row) => row.label === "Experience evidence")?.values[1]).toContain("Unknown");
    expect(compared.map((option) => option.rank)).toEqual([2, 1]);
  });
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
