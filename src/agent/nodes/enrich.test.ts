// src/agent/nodes/enrich.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentStateType } from "../state";
import type { AwardOption } from "../../tools";

vi.mock("../models", () => ({ chat: vi.fn() }));
vi.mock("./search", () => ({
  getClient: vi.fn().mockResolvedValue({}),
  ENRICH_TOP_N: 5,
}));
vi.mock("../../tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tools")>();
  return { ...actual, makeGetTripDetailsTool: vi.fn() };
});

import { chat } from "../models";
import { makeGetTripDetailsTool } from "../../tools";
import { describeCandidates, idsFromToolCalls, enrichTrips } from "./enrich";

const opt = (over: Partial<AwardOption> = {}): AwardOption => ({
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

describe("idsFromToolCalls", () => {
  it("extracts availabilityId from a get_trip_details call", () => {
    const ids = idsFromToolCalls(
      [{ name: "get_trip_details", args: { availabilityId: "a1" } }],
      ["a1"],
    );
    expect(ids).toEqual(["a1"]);
  });

  it("dedupes repeated calls to the same id", () => {
    const ids = idsFromToolCalls(
      [
        { name: "get_trip_details", args: { availabilityId: "a1" } },
        { name: "get_trip_details", args: { availabilityId: "a1" } },
      ],
      ["a1"],
    );
    expect(ids).toEqual(["a1"]);
  });

  it("ignores calls to a different tool", () => {
    const ids = idsFromToolCalls(
      [{ name: "some_other_tool", args: { availabilityId: "a1" } }],
      ["a1"],
    );
    expect(ids).toEqual([]);
  });

  it("ignores a call with a missing or malformed id", () => {
    const ids = idsFromToolCalls(
      [
        { name: "get_trip_details", args: {} },
        { name: "get_trip_details", args: { availabilityId: 42 } },
      ],
      ["a1"],
    );
    expect(ids).toEqual([]);
  });

  it("returns an empty list when the model called nothing", () => {
    expect(idsFromToolCalls([], ["a1"])).toEqual([]);
  });

  it("ignores an id that wasn't in the offered candidate list", () => {
    // A hallucinated or otherwise malformed id must not trigger a lookup,
    // even though it's shaped like a valid one.
    const ids = idsFromToolCalls(
      [{ name: "get_trip_details", args: { availabilityId: "hallucinated" } }],
      ["a1", "a2"],
    );
    expect(ids).toEqual([]);
  });

  it("keeps only the subset of requested ids that were actually offered", () => {
    const ids = idsFromToolCalls(
      [
        { name: "get_trip_details", args: { availabilityId: "a1" } },
        { name: "get_trip_details", args: { availabilityId: "hallucinated" } },
      ],
      ["a1", "a2"],
    );
    expect(ids).toEqual(["a1"]);
  });
});

describe("describeCandidates", () => {
  it("lists each option with its id, route, and price", () => {
    const text = describeCandidates([opt()]);
    expect(text).toContain("id=a1");
    expect(text).toContain("ORD-NRT");
    expect(text).toContain("87500");
  });

  it("never leaks flight numbers or aircraft — that's what the tool call is for", () => {
    const text = describeCandidates([opt()]);
    expect(text).not.toMatch(/NH\d/);
    expect(text.toLowerCase()).not.toContain("aircraft");
  });

  it("numbers options so the model can reference them unambiguously", () => {
    const text = describeCandidates([
      opt({ availabilityId: "a1" }),
      opt({ availabilityId: "a2" }),
    ]);
    expect(text).toMatch(/^1\./m);
    expect(text).toMatch(/^2\./m);
  });
});

describe("enrichTrips", () => {
  beforeEach(() => {
    vi.mocked(chat).mockReset();
    vi.mocked(makeGetTripDetailsTool).mockReset();
  });

  /** Wires `chat(...).bindTools(...).invoke(...)` to resolve with `response`. */
  function mockModelResponse(response: unknown) {
    const invoke = vi.fn().mockResolvedValue(response);
    const bindTools = vi.fn().mockReturnValue({ invoke });
    vi.mocked(chat).mockReturnValue({ bindTools } as never);
    return invoke;
  }

  it("degrades to an empty result when the tool-selection model call fails", async () => {
    // enrichment is additive; a transient API error here must not fail the turn
    const invoke = vi.fn().mockRejectedValue(new Error("API down"));
    vi.mocked(chat).mockReturnValue({
      bindTools: vi.fn().mockReturnValue({ invoke }),
    } as never);
    vi.mocked(makeGetTripDetailsTool).mockReturnValue({
      invoke: vi.fn(),
    } as never);

    const result = await enrichTrips({
      awardResults: [opt()],
    } as AgentStateType);

    expect(result).toEqual({ tripSummaries: [] });
  });

  it("only looks up ids that were actually offered as candidates", async () => {
    const toolInvoke = vi.fn().mockResolvedValue(JSON.stringify({ trips: [] }));
    vi.mocked(makeGetTripDetailsTool).mockReturnValue({
      invoke: toolInvoke,
    } as never);
    mockModelResponse({
      tool_calls: [
        { name: "get_trip_details", args: { availabilityId: "a1" } },
        { name: "get_trip_details", args: { availabilityId: "hallucinated" } },
      ],
    });

    await enrichTrips({
      awardResults: [opt({ availabilityId: "a1" })],
    } as AgentStateType);

    expect(toolInvoke).toHaveBeenCalledTimes(1);
    expect(toolInvoke).toHaveBeenCalledWith({ availabilityId: "a1" });
  });

  it("drops trips outside the requested cabins so off-cabin noise doesn't reach synthesis", async () => {
    const toolInvoke = vi.fn().mockResolvedValue(
      JSON.stringify({
        trips: [
          { availabilityId: "a1", tripId: "t-economy", cabin: "economy", flightNumbers: ["AA1"], aircraft: [], carriers: [], stops: 1 },
          { availabilityId: "a1", tripId: "t-first", cabin: "first", flightNumbers: ["AA2"], aircraft: [], carriers: [], stops: 1 },
          { availabilityId: "a1", tripId: "t-unknown", flightNumbers: ["AA3"], aircraft: [], carriers: [], stops: 1 },
        ],
      }),
    );
    vi.mocked(makeGetTripDetailsTool).mockReturnValue({
      invoke: toolInvoke,
    } as never);
    mockModelResponse({
      tool_calls: [{ name: "get_trip_details", args: { availabilityId: "a1" } }],
    });

    const result = await enrichTrips({
      awardResults: [opt({ availabilityId: "a1" })],
      searchPlan: { cabins: ["business", "first"] },
    } as AgentStateType);

    const ids = (result.tripSummaries ?? []).map((t) => t.tripId);
    expect(ids).toContain("t-first");
    expect(ids).toContain("t-unknown"); // cabin-less trips are kept — we can't classify them
    expect(ids).not.toContain("t-economy");
  });
});
