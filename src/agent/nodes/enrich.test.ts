// src/agent/nodes/enrich.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentStateType } from "../state";
import type { AwardOption } from "../../tools";

vi.mock("./search", () => ({
  getClient: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../tools")>();
  return { ...actual, makeGetTripDetailsTool: vi.fn() };
});

import { makeGetTripDetailsTool } from "../../tools";
import { enrichTrips, ENRICH_DISPLAY_CAP } from "./enrich";

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

describe("enrichTrips", () => {
  beforeEach(() => {
    vi.mocked(makeGetTripDetailsTool).mockReset();
  });

  it("returns no summaries when there are no award results to enrich", async () => {
    const result = await enrichTrips({ awardResults: [] } as unknown as AgentStateType);
    expect(result).toEqual({ tripSummaries: [] });
  });

  it("looks up every displayed option deterministically — no model selection involved", async () => {
    const toolInvoke = vi.fn().mockImplementation(({ availabilityId }: { availabilityId: string }) =>
      Promise.resolve(JSON.stringify({
        trips: [{ availabilityId, tripId: `t-${availabilityId}`, flightNumbers: [], aircraft: [], carriers: [], stops: 0 }],
      })),
    );
    vi.mocked(makeGetTripDetailsTool).mockReturnValue({ invoke: toolInvoke } as never);

    const result = await enrichTrips({
      awardResults: [opt({ availabilityId: "a1" }), opt({ availabilityId: "a2" }), opt({ availabilityId: "a3" })],
    } as AgentStateType);

    const ids = (result.tripSummaries ?? []).map((t) => t.availabilityId).sort();
    expect(ids).toEqual(["a1", "a2", "a3"]);
    expect(toolInvoke).toHaveBeenCalledTimes(3);
  });

  it("looks up each id exactly once", async () => {
    const toolInvoke = vi.fn().mockResolvedValue(JSON.stringify({ trips: [] }));
    vi.mocked(makeGetTripDetailsTool).mockReturnValue({ invoke: toolInvoke } as never);

    await enrichTrips({
      awardResults: [opt({ availabilityId: "a1" }), opt({ availabilityId: "a2" })],
    } as AgentStateType);

    const calledIds = toolInvoke.mock.calls.map((call) => (call[0] as { availabilityId: string }).availabilityId);
    expect(calledIds.filter((id) => id === "a1")).toHaveLength(1);
    expect(calledIds.filter((id) => id === "a2")).toHaveLength(1);
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
    vi.mocked(makeGetTripDetailsTool).mockReturnValue({ invoke: toolInvoke } as never);

    const result = await enrichTrips({
      awardResults: [opt({ availabilityId: "a1" })],
      searchPlan: { cabins: ["business", "first"] },
    } as AgentStateType);

    const ids = (result.tripSummaries ?? []).map((t) => t.tripId);
    expect(ids).toContain("t-first");
    expect(ids).toContain("t-unknown"); // cabin-less trips are kept — we can't classify them
    expect(ids).not.toContain("t-economy");
  });

  it("caps lookups at the display limit rather than every returned result", async () => {
    const toolInvoke = vi.fn().mockResolvedValue(JSON.stringify({ trips: [] }));
    vi.mocked(makeGetTripDetailsTool).mockReturnValue({ invoke: toolInvoke } as never);

    const many = Array.from({ length: 25 }, (_, i) => opt({ availabilityId: `a${i + 1}` }));
    await enrichTrips({ awardResults: many } as AgentStateType);

    expect(toolInvoke).toHaveBeenCalledTimes(ENRICH_DISPLAY_CAP);
  });

  it("[REGRESSION] a failed lookup for one option does not prevent the others from being enriched", async () => {
    // enrichment is additive; one option's transient API error must not sink the turn
    const toolInvoke = vi.fn().mockImplementation(({ availabilityId }: { availabilityId: string }) =>
      availabilityId === "a1"
        ? Promise.reject(new Error("API down"))
        : Promise.resolve(JSON.stringify({
            trips: [{ availabilityId, tripId: `t-${availabilityId}`, flightNumbers: [], aircraft: [], carriers: [], stops: 0 }],
          })),
    );
    vi.mocked(makeGetTripDetailsTool).mockReturnValue({ invoke: toolInvoke } as never);

    const result = await enrichTrips({
      awardResults: [opt({ availabilityId: "a1" }), opt({ availabilityId: "a2" })],
    } as AgentStateType);

    const ids = (result.tripSummaries ?? []).map((t) => t.availabilityId);
    expect(ids).toEqual(["a2"]);
  });
});
