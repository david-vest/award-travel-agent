import { describe, expect, it } from "vitest";
import type { AwardOption, TripSummary } from "../../tools";
import type { SearchPlan } from "../state";
import {
  CANDIDATE_SHORTLIST_CAP,
  eligibleCandidates,
  selectCandidateShortlist,
} from "./build-candidate-shortlist";

const plan: SearchPlan = {
  origins: ["SFO"],
  destinations: ["HND"],
  cabins: ["business"],
  nonstopOnly: false,
  stopPreference: "any",
  programs: [],
  travelers: 1,
};

const option = (id: string, over: Partial<AwardOption> = {}): AwardOption => ({
  availabilityId: id,
  origin: "SFO",
  destination: "HND",
  date: "2026-09-18",
  program: "united",
  cabin: "business",
  miles: 50_000,
  taxes: 50,
  taxesCurrency: "USD",
  direct: false,
  airlines: "UA",
  searchTier: "exact",
  ...over,
});

describe("selectCandidateShortlist", () => {
  it("preserves a slightly more expensive nonstop outside the provider's cheapest 20", () => {
    const cheapestConnections = Array.from({ length: 25 }, (_, index) =>
      option(`cheap-${index}`, { miles: 40_000 + index, direct: false }),
    );
    const nonstop = option("nonstop", { miles: 60_000, direct: true, airlines: "NH" });

    const selected = selectCandidateShortlist([...cheapestConnections, nonstop], plan);

    expect(selected).toHaveLength(CANDIDATE_SHORTLIST_CAP);
    expect(selected.map((candidate) => candidate.availabilityId)).toContain("cheap-0");
    expect(selected.map((candidate) => candidate.availabilityId)).toContain("nonstop");
  });

  it("preserves a low-fee alternative outside the cheapest mileage results", () => {
    const cheapest = Array.from({ length: 25 }, (_, index) =>
      option(`cheap-${index}`, { miles: 40_000 + index, taxes: 300 }),
    );
    const lowFees = option("low-fees", { miles: 70_000, taxes: 5 });

    const selected = selectCandidateShortlist([...cheapest, lowFees], plan);
    expect(selected.map((candidate) => candidate.availabilityId)).toContain("low-fees");
  });

  it("preserves a preferred carrier even when it is not among the cheapest options", () => {
    const cheapest = Array.from({ length: 25 }, (_, index) =>
      option(`cheap-${index}`, { miles: 40_000 + index, airlines: "UA" }),
    );
    const preferred = option("preferred", { miles: 70_000, airlines: "NH" });

    const selected = selectCandidateShortlist(
      [...cheapest, preferred],
      { ...plan, preferredAirlines: ["NH"] },
    );

    expect(selected.map((candidate) => candidate.availabilityId)).toContain("preferred");
  });

  it("covers different programs, dates, and search tiers deterministically", () => {
    const options = [
      ...Array.from({ length: 22 }, (_, index) => option(`base-${index}`, { miles: 40_000 + index })),
      option("program", { miles: 70_000, program: "aeroplan" }),
      option("date", { miles: 71_000, date: "2026-09-20" }),
      option("positioning", { miles: 72_000, searchTier: "destination_gateway" }),
    ];

    const first = selectCandidateShortlist(options, plan);
    const second = selectCandidateShortlist(options, plan);
    expect(first).toEqual(second);
    expect(first.map((candidate) => candidate.availabilityId)).toEqual(expect.arrayContaining(["program", "date", "positioning"]));
  });

  it("applies hard cabin, seat, nonstop, balance, and known-fee constraints before selection", () => {
    const constrainedPlan: SearchPlan = {
      ...plan,
      nonstopOnly: true,
      stopPreference: "nonstop",
      travelers: 2,
      filterByPointBalances: true,
      availablePointsByProgram: { united: 130_000 },
      maxTaxesFeesUsd: 100,
    };
    const options = [
      option("eligible", { miles: 60_000, direct: true, remainingSeats: 2 }),
      option("connection", { direct: false, remainingSeats: 2 }),
      option("one-seat", { direct: true, remainingSeats: 1 }),
      option("wrong-cabin", { direct: true, remainingSeats: 2, cabin: "economy" }),
      option("too-expensive", { direct: true, remainingSeats: 2, miles: 70_000 }),
      option("fees", { direct: true, remainingSeats: 2, taxes: 150 }),
    ];

    expect(eligibleCandidates(options, constrainedPlan).map(({ option: candidate }) => candidate.availabilityId)).toEqual(["eligible"]);
  });

  it("deduplicates by availability id and cabin while retaining distinct cabins", () => {
    const options = [
      option("same", { miles: 60_000 }),
      option("same", { miles: 55_000 }),
      option("same", { cabin: "economy", miles: 30_000 }),
    ];
    const selected = selectCandidateShortlist(options, { ...plan, cabins: ["business", "economy"] });

    expect(selected).toHaveLength(2);
    expect(selected.map((candidate) => `${candidate.availabilityId}:${candidate.cabin}`)).toEqual(expect.arrayContaining(["same:business", "same:economy"]));
  });

  it("uses already-known trip detail for stop and aircraft coverage", () => {
    const options = Array.from({ length: 25 }, (_, index) => option(`base-${index}`, { miles: 40_000 + index }));
    const aircraftCandidate = option("different-aircraft", { miles: 80_000, airlines: "UA" });
    const trips: TripSummary[] = [{
      availabilityId: "different-aircraft",
      tripId: "trip-aircraft",
      flightNumbers: [],
      aircraft: ["A350"],
      carriers: ["UA"],
      stops: 1,
    }];

    expect(selectCandidateShortlist([...options, aircraftCandidate], plan, trips).map((candidate) => candidate.availabilityId)).toContain("different-aircraft");
  });
});
