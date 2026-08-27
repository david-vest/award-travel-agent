import { beforeEach, describe, it, expect, vi } from "vitest";

const { similaritySearch, findKnowledgeDocuments } = vi.hoisted(() => ({
  similaritySearch: vi.fn(),
  findKnowledgeDocuments: vi.fn(),
}));
vi.mock("./store", () => ({
  getVectorStore: vi.fn(async () => ({ similaritySearch })),
  findKnowledgeDocuments,
}));

import {
  buildPreFilter,
  buildRetrievalQuery,
  linkEvidenceToOptions,
  normalizeAircraft,
  retrieveEvidenceForOptions,
  retrieveKnowledge,
} from "./retriever";
import type { RetrievedDoc } from "./retriever";
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

/** Pulls out the `$or` branch matching a given top-level field, if present. */
function orClauseFor(filter: Record<string, unknown> | undefined, field: string): unknown {
  const clauses = (filter?.$or ?? []) as Record<string, unknown>[];
  return clauses.find((c) => field in c)?.[field];
}

describe("buildPreFilter", () => {
  it("[REGRESSION] ORs airlines/programs/regions together rather than ANDing them — a program-only document must not be excluded by an empty airlines match", () => {
    // option()'s defaults populate both an airline and a program, so any
    // realistic call here exercises the multi-facet $or shape, not a
    // single-condition filter.
    const f = buildPreFilter([option({ airlines: "NH", program: "aeroplan" })]);
    expect(f).toHaveProperty("$or");
    expect(orClauseFor(f, "airlines")).toEqual({ $in: ["NH"] });
    expect(orClauseFor(f, "programs")).toEqual({ $in: ["aeroplan"] });
  });

  it("splits comma-delimited airline strings", () => {
    const f = buildPreFilter([option({ airlines: "NH, AC" })]);
    expect(orClauseFor(f, "airlines")).toEqual({ $in: ["NH", "AC"] });
  });

  it("includes programs seen in results", () => {
    const f = buildPreFilter([option({ program: "aeroplan" })]);
    expect(orClauseFor(f, "programs")).toEqual({ $in: ["aeroplan"] });
  });

  it("[REGRESSION] includes the region of the returned destinations, so a region-only seasonality document can match", () => {
    // NRT (Tokyo) resolves to the Asia region.
    const f = buildPreFilter([option({ destination: "NRT" })]);
    expect(orClauseFor(f, "regions")).toEqual({ $in: ["Asia"] });
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
    expect(((orClauseFor(f, "airlines") as { $in: string[] }).$in).sort()).toEqual(["AC", "NH"]);
  });
});

/** Minimal $or/$in evaluator — enough to prove the generated filter's real matching behavior, not just its shape. */
function matchesFilter(filter: Record<string, unknown>, doc: Record<string, unknown[]>): boolean {
  const clauses = (filter.$or ?? [filter]) as Record<string, { $in: string[] }>[];
  return clauses.some((clause) =>
    Object.entries(clause).every(([field, { $in }]) => (doc[field] ?? []).some((v) => $in.includes(v as string))),
  );
}

describe("[REGRESSION] buildPreFilter's OR semantics against real document metadata shapes", () => {
  // A route_search for SFO->NRT on Aeroplan/NH — the filter this generates.
  const filter = buildPreFilter([option({ airlines: "NH", program: "aeroplan", destination: "NRT" })]) as Record<string, unknown>;

  it("matches a program-only document (e.g. a transfer/booking note with no airlines tagged)", () => {
    expect(matchesFilter(filter, { airlines: [], programs: ["aeroplan"], regions: [] })).toBe(true);
  });

  it("matches an airline-only document (e.g. a products review with no program tagged)", () => {
    expect(matchesFilter(filter, { airlines: ["NH"], programs: [], regions: [] })).toBe(true);
  });

  it("matches a region-only document (e.g. a seasonality note with neither airlines nor programs tagged)", () => {
    expect(matchesFilter(filter, { airlines: [], programs: [], regions: ["Asia"] })).toBe(true);
  });

  it("does not match a document with none of the three facets", () => {
    expect(matchesFilter(filter, { airlines: ["BA"], programs: ["qatar"], regions: ["Europe"] })).toBe(false);
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

describe("retrieveKnowledge", () => {
  beforeEach(() => {
    similaritySearch.mockReset();
  });

  it("does not fall back to unrelated unfiltered docs for a flight-backed answer", async () => {
    similaritySearch.mockResolvedValueOnce([]);

    expect(await retrieveKnowledge("low taxes?", [option()])).toEqual([]);

    expect(similaritySearch).toHaveBeenCalledTimes(1);
    expect(similaritySearch.mock.calls[0]?.[2]).toBeDefined();
  });

  it("still searches the whole KB for a pure knowledge question", async () => {
    similaritySearch.mockResolvedValueOnce([]);

    await retrieveKnowledge("Can Chase transfer to Alaska?", []);

    expect(similaritySearch).toHaveBeenCalledWith(
      "Can Chase transfer to Alaska?",
      expect.any(Number),
      undefined,
    );
  });
});

const evidence = (over: Partial<RetrievedDoc> = {}): RetrievedDoc => ({
  id: "ana-room",
  collection: "products",
  text: "A sourced product note.",
  sources: ["https://example.com/source"],
  updated: "2026-08-01",
  airlines: ["NH"],
  aircraft: ["Boeing 777-300ER"],
  programs: [],
  regions: [],
  airports: [],
  routes: [],
  dimensions: ["cabin_product"],
  cabin: "business",
  reviewAfter: "2027-01-01",
  ...over,
});

describe("option-specific evidence", () => {
  it("normalizes provider aircraft aliases without broad fuzzy matching", () => {
    expect(normalizeAircraft("77W")).toBe(normalizeAircraft("Boeing 777-300ER"));
    expect(normalizeAircraft("A359")).toBe(normalizeAircraft("Airbus A350-900"));
  });

  it("isolates cabin-product evidence by carrier, aircraft, and cabin", () => {
    const options = [option(), option({ availabilityId: "ua", airlines: "UA" })];
    const trips = [
      { availabilityId: "a1", tripId: "t1", flightNumbers: [], aircraft: ["77W"], carriers: ["NH"], stops: 0 },
      { availabilityId: "ua", tripId: "t2", flightNumbers: [], aircraft: ["777-300ER"], carriers: ["UA"], stops: 0 },
    ];
    const linked = linkEvidenceToOptions(options, trips, [evidence()]);
    expect(linked["a1:business"]).toHaveLength(1);
    expect(linked["ua:business"]).toHaveLength(0);
  });

  it("isolates booking and transfer evidence by the actual award program", () => {
    const booking = evidence({ id: "aeroplan-booking", collection: "booking", airlines: [], aircraft: [], programs: ["aeroplan"], dimensions: ["booking_ease"] });
    const linked = linkEvidenceToOptions(
      [option(), option({ availabilityId: "united", program: "united" })],
      [],
      [booking],
    );
    expect(linked["a1:business"]).toHaveLength(1);
    expect(linked["united:business"]).toHaveLength(0);
  });

  it("uses transfer-risk evidence only for a selected credit-card ecosystem", () => {
    const transfer = evidence({
      id: "chase-transfer",
      collection: "transfers",
      airlines: [],
      aircraft: [],
      programs: ["aeroplan"],
      creditPrograms: ["chase"],
      dimensions: ["transfer_risk"],
    });
    expect(linkEvidenceToOptions([option()], [], [transfer], [], new Date(), ["chase"])["a1:business"]).toHaveLength(1);
    expect(linkEvidenceToOptions([option()], [], [transfer], [], new Date(), ["amex"])["a1:business"]).toHaveLength(0);
  });

  it("matches connection evidence only to an airport used by that itinerary", () => {
    const airportDoc = evidence({ id: "lax-transfer", collection: "airports", airlines: [], aircraft: [], airports: ["LAX"], dimensions: ["connection_quality"] });
    const linked = linkEvidenceToOptions(
      [option({ direct: false })],
      [{ availabilityId: "a1", tripId: "t1", flightNumbers: [], aircraft: [], carriers: ["NH"], stops: 1, connections: [{ airport: "LAX" }] }],
      [airportDoc],
    );
    expect(linked["a1:business"]?.[0].match?.reasons).toContain("connection airport");
  });

  it("downgrades stale exact evidence and rejects unrelated semantic fallback", () => {
    const stale = evidence({ reviewAfter: "2026-01-01" });
    const unrelated = evidence({ id: "unrelated", airlines: ["BA"], aircraft: ["A380"] });
    const linked = linkEvidenceToOptions(
      [option()],
      [{ availabilityId: "a1", tripId: "t1", flightNumbers: [], aircraft: ["77W"], carriers: ["NH"], stops: 0 }],
      [stale],
      [unrelated],
      new Date("2026-08-26T00:00:00Z"),
    );
    expect(linked["a1:business"]).toHaveLength(1);
    expect(linked["a1:business"]?.[0].match).toMatchObject({ stale: true, confidence: "medium" });
  });

  it("performs one bounded exact lookup and one semantic supplement", async () => {
    findKnowledgeDocuments.mockReset();
    similaritySearch.mockReset();
    findKnowledgeDocuments.mockResolvedValueOnce([]);
    similaritySearch.mockResolvedValueOnce([]);
    expect(await retrieveEvidenceForOptions("best option?", [option()])).toEqual({ "a1:business": [] });
    expect(findKnowledgeDocuments).toHaveBeenCalledOnce();
    expect(similaritySearch).toHaveBeenCalledOnce();
    expect(similaritySearch.mock.calls[0]?.[1]).toBe(12);
  });
});
