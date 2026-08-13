import { describe, it, expect } from "vitest";
import { buildPreFilter, buildRetrievalQuery } from "./retriever";
import type { AwardOption, TripSummary } from "../tools";

const option = (over: Partial<AwardOption> = {}): AwardOption => ({
  availabilityId: "a1",
  origin: "ORD",
  destination: "NRT",
  date: "2026-09-14",
  program: "aeroplan",
  cabin: "business",
  miles: 87500,
  direct: true,
  airlines: "NH",
  ...over,
});

describe("buildPreFilter", () => {
  it("filters to airlines that actually appeared in results", () => {
    const f = buildPreFilter([option({ airlines: "NH" })]);
    expect(f?.airlines).toEqual({ $in: ["NH"] });
  });

  it("splits comma-delimited airline strings", () => {
    const f = buildPreFilter([option({ airlines: "NH, AC" })]);
    expect(f?.airlines).toEqual({ $in: ["NH", "AC"] });
  });

  it("includes programs seen in results", () => {
    const f = buildPreFilter([option({ program: "aeroplan" })]);
    expect(f?.programs).toEqual({ $in: ["aeroplan"] });
  });

  it("returns undefined when there are no results, so knowledge questions search everything", () => {
    expect(buildPreFilter([])).toBeUndefined();
  });

  it("dedupes airlines across many options", () => {
    const f = buildPreFilter([
      option({ airlines: "NH" }),
      option({ airlines: "NH" }),
      option({ airlines: "AC" }),
    ]);
    expect((f?.airlines as { $in: string[] }).$in.sort()).toEqual(["AC", "NH"]);
  });
});

describe("buildRetrievalQuery", () => {
  it("includes the user question", () => {
    const q = buildRetrievalQuery("best way to Tokyo?", []);
    expect(q).toContain("best way to Tokyo?");
  });

  it("enriches the query with programs and cabins actually returned", () => {
    const q = buildRetrievalQuery("options?", [option()]);
    expect(q).toContain("aeroplan");
    expect(q).toContain("business");
  });

  it("mentions destinations so seasonality documents can match", () => {
    const q = buildRetrievalQuery("options?", [option({ destination: "NRT" })]);
    expect(q).toContain("NRT");
  });

  it("folds trip aircraft into the query so products reviews can match the specific plane", () => {
    const trip: TripSummary = {
      availabilityId: "a1",
      tripId: "t1",
      flightNumbers: ["NH1"],
      aircraft: ["777-300ER"],
      carriers: ["NH"],
      stops: 0,
    };
    const q = buildRetrievalQuery("options?", [option()], [trip]);
    expect(q).toContain("777-300ER");
  });
});

describe("buildPreFilter and trips", () => {
  it("does not hard-filter on aircraft — spelling variance would silently exclude the right products review", () => {
    // buildPreFilter takes no trips parameter at all (see design note above) —
    // this test exists to catch a future accidental regression toward filtering.
    const f = buildPreFilter([option()]);
    expect(f).not.toHaveProperty("aircraft");
  });
});
