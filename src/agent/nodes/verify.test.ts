import { describe, it, expect } from "vitest";
import {
  extractCitedIds,
  extractFlightNumbers,
  extractMileageFigures,
  findViolations,
} from "./verify";
import type { AgentStateType } from "../state";

const state = (over: Partial<AgentStateType> = {}): AgentStateType =>
  ({
    awardResults: [
      {
        availabilityId: "a1",
        origin: "ORD",
        destination: "NRT",
        date: "2026-09-14",
        program: "aeroplan",
        cabin: "business",
        miles: 87500,
        direct: true,
        airlines: "NH",
      },
    ],
    tripSummaries: [
      {
        availabilityId: "a1",
        tripId: "t1",
        flightNumbers: ["NH12"],
        aircraft: ["777-300ER"],
        carriers: ["NH"],
        stops: 0,
        cabin: "business",
        miles: 87500,
      },
    ],
    kbDocs: [
      {
        id: "ana-777",
        collection: "products",
        text: "x",
        sources: [],
        updated: "2026-06-01",
      },
    ],
    ...over,
  }) as AgentStateType;

describe("extractMileageFigures", () => {
  it("finds comma-formatted figures", () => {
    expect(extractMileageFigures("costs 87,500 miles")).toContain(87500);
  });

  it("finds bare figures followed by miles", () => {
    expect(extractMileageFigures("costs 87500 miles")).toContain(87500);
  });

  it("finds k-suffixed figures", () => {
    expect(extractMileageFigures("about 87.5k miles")).toContain(87500);
  });

  it("ignores numbers that are not mileage, like years and seat counts", () => {
    const found = extractMileageFigures("In 2026 there are 2 seats left");
    expect(found).not.toContain(2026);
    expect(found).not.toContain(2);
  });
});

describe("extractFlightNumbers", () => {
  it("finds airline-code flight numbers", () => {
    expect(extractFlightNumbers("take NH12 from ORD")).toEqual(["NH12"]);
  });

  it("does not treat a bare airport code as a flight number", () => {
    expect(extractFlightNumbers("fly from ORD to NRT")).toEqual([]);
  });
});

describe("extractCitedIds", () => {
  it("finds bracketed document ids", () => {
    expect(extractCitedIds("great seat [ana-777]")).toEqual(["ana-777"]);
  });

  it("ignores bracketed text that is not an id", () => {
    expect(extractCitedIds("see [1] and [note]")).toEqual([]);
  });
});

describe("findViolations", () => {
  it("does not accept facts from raw options that never entered the assessed shortlist", () => {
    const st = state({
      awardResults: [
        ...state().awardResults,
        { availabilityId: "raw", origin: "ORD", destination: "NRT", date: "2026-09-14", program: "united", cabin: "business", miles: 99_999, direct: true, airlines: "UA" },
      ],
      candidateShortlist: state().awardResults,
    });

    const violations = findViolations("The recommended option costs 99,999 miles.", st);
    expect(violations.some((violation) => violation.kind === "unsupported_number")).toBe(true);
  });

  it("passes a draft whose numbers all come from results", () => {
    const draft = "Aeroplan has business for 87,500 miles on NH12. [ana-777]";
    expect(findViolations(draft, state())).toEqual([]);
  });

  it("flags an invented mileage figure", () => {
    const v = findViolations("It costs 92,000 miles.", state());
    expect(v.some((x) => x.kind === "unsupported_number")).toBe(true);
  });

  it("flags an invented flight number", () => {
    const v = findViolations("Take NH99 to Tokyo.", state());
    expect(v.some((x) => x.kind === "unsupported_flight")).toBe(true);
  });

  it("flags a citation to a document that was never retrieved", () => {
    const v = findViolations("As noted [made-up-doc].", state());
    expect(v.some((x) => x.kind === "uncited_claim")).toBe(true);
  });

  it("flags an airline that appears in no result", () => {
    const v = findViolations("Fly Lufthansa (LH) for 87,500 miles.", state());
    expect(v.some((x) => x.kind === "unsupported_airline")).toBe(true);
  });

  it("does not flag anything when there were no results and the draft says so", () => {
    const empty = state({ awardResults: [], tripSummaries: [] });
    expect(
      findViolations("No award space was found for those dates.", empty),
    ).toEqual([]);
  });

  it("allows rounded phrasing that matches a real figure", () => {
    const draft = "roughly 87.5k miles";
    expect(findViolations(draft, state())).toEqual([]);
  });

  // Extra edge cases beyond the plan's own list.

  it("has nothing to flag when the draft contains no numbers at all", () => {
    const draft = "Business class award space to Tokyo looks promising this month.";
    expect(findViolations(draft, state())).toEqual([]);
  });

  it("flags only the fabricated figure when a real and an invented one both appear", () => {
    const draft = "Options run from 87,500 miles up to a steep 250,000 miles.";
    const v = findViolations(draft, state());
    const numberViolations = v.filter((x) => x.kind === "unsupported_number");
    expect(numberViolations).toHaveLength(1);
    expect(numberViolations[0].detail).toContain("250,000");
  });

  it("treats a mileage figure quoted from a retrieved KB doc as grounded (knowledge branch)", () => {
    // The knowledge branch (triage -> retrieve_knowledge -> synthesize)
    // never runs a search, so it has no awardResults/tripSummaries at all —
    // its only real source of mileage figures is the retrieved KB excerpt.
    const st = state({
      awardResults: [],
      tripSummaries: [],
      kbDocs: [
        {
          id: "ana-sweet-spot",
          collection: "sweet-spots",
          text: "ANA First via Virgin Atlantic runs 85,000 miles one-way in first class.",
          sources: [],
          updated: "2026-06-01",
        },
      ],
    });
    const draft = "ANA First via Virgin Atlantic is 85,000 miles one-way in first. [ana-sweet-spot]";
    expect(findViolations(draft, st)).toEqual([]);
  });

  it("still flags a mileage figure absent from both search results and KB docs", () => {
    const st = state({
      awardResults: [],
      tripSummaries: [],
      kbDocs: [
        {
          id: "ana-sweet-spot",
          collection: "sweet-spots",
          text: "ANA First via Virgin Atlantic runs 85,000 miles one-way in first class.",
          sources: [],
          updated: "2026-06-01",
        },
      ],
    });
    const v = findViolations("It actually costs 999,999 miles.", st);
    expect(v.some((x) => x.kind === "unsupported_number")).toBe(true);
  });

  it("treats a trip-level mileage figure as grounded even when only the trip summary carries it", () => {
    // tripSummaries is joined to awardResults via availabilityId, but the
    // per-trip `miles` field (from trip-details, e.g. synthesize.ts's
    // "Flight details" block) is a legitimate, independently quotable
    // number even if it isn't (or isn't only) reflected in awardResults.
    const st = state({
      candidateShortlist: state().awardResults,
      tripSummaries: [
        {
          availabilityId: "a1",
          tripId: "t1",
          flightNumbers: ["NH12"],
          aircraft: ["777-300ER"],
          carriers: ["NH"],
          stops: 0,
          cabin: "business",
          miles: 65000,
        },
      ],
    });
    const v = findViolations("This trip runs 65,000 miles per the detail lookup.", st);
    expect(v.some((x) => x.kind === "unsupported_number")).toBe(false);
  });

  describe("derived arithmetic (multiples and sums/differences of real figures)", () => {
    it("allows a round-trip 2x multiple phrased as a total", () => {
      const draft = "Round trip that's 175,000 miles total.";
      expect(findViolations(draft, state())).toEqual([]);
    });

    it("allows a 2x multiple phrased for two passengers", () => {
      const draft = "For two passengers you'd need 175,000 miles.";
      expect(findViolations(draft, state())).toEqual([]);
    });

    it("allows a subtraction phrased as points remaining after booking", () => {
      // realMiles includes 87,500 (the fixture's award option/trip) — add a
      // second real figure so a genuine difference exists to check against.
      const st = state({
        awardResults: [
          {
            availabilityId: "a1",
            origin: "ORD",
            destination: "NRT",
            date: "2026-09-14",
            program: "aeroplan",
            cabin: "business",
            miles: 87500,
            direct: true,
            airlines: "NH",
          },
          {
            availabilityId: "a2",
            origin: "ORD",
            destination: "NRT",
            date: "2026-09-15",
            program: "aeroplan",
            cabin: "business",
            miles: 100000,
            direct: true,
            airlines: "NH",
          },
        ],
      });
      const draft = "about 12,500 points left over after booking the 87,500 mile ticket";
      expect(findViolations(draft, st)).toEqual([]);
    });

    it("still flags a genuinely fabricated figure unrelated to any derived relationship", () => {
      // 87,500 * 2 = 175,000, *3 = 262,500, *4 = 350,000 — 400,000 matches
      // none of those, nor any sum/difference of the single real figure.
      const v = findViolations("It costs 400,000 miles.", state());
      expect(v.some((x) => x.kind === "unsupported_number")).toBe(true);
    });
  });

  describe("plain-English airline names (no parenthesized code, no flight number)", () => {
    it("flags a fabricated carrier named in prose with a real mileage figure", () => {
      const draft = "Fly Lufthansa nonstop from ORD to Tokyo for 87,500 miles in business.";
      const v = findViolations(draft, state());
      expect(v.some((x) => x.kind === "unsupported_airline")).toBe(true);
    });

    it("does not flag a named airline that actually operates a returned option", () => {
      // Fixture's real airline is NH (ANA).
      const draft = "Fly ANA nonstop from ORD to Tokyo for 87,500 miles in business.";
      const v = findViolations(draft, state());
      expect(v.some((x) => x.kind === "unsupported_airline")).toBe(false);
    });
  });
});
