// src/agent/nodes/plan-discovery.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import type { AgentStateType, DiscoveryProbe, SearchPlan } from "../state";

vi.mock("../models", () => ({
  chat: vi.fn(),
}));

vi.mock("../../tools/locations/resolve", () => ({
  resolveLocation: vi.fn(),
}));

import { chat } from "../models";
import { resolveLocation } from "../../tools/locations/resolve";
import {
  capProbes,
  DISCOVERY_BUDGET,
  discoveryPlanSchema,
  probesFromPlan,
  planDiscovery,
} from "./plan-discovery";

/** Wires `chat(...).withStructuredOutput(...).invoke(...)` to resolve with `result`. */
function mockPlannerResponse(result: unknown) {
  const invoke = vi.fn().mockResolvedValue(result);
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  (chat as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ withStructuredOutput });
  return { invoke, withStructuredOutput };
}

function stateWith(text: string): AgentStateType {
  return { messages: [new HumanMessage(text)] } as AgentStateType;
}

function stateWithPriorPlan(text: string, priorPlan: Partial<SearchPlan>): AgentStateType {
  return {
    messages: [new HumanMessage(text)],
    searchPlan: priorPlan,
  } as AgentStateType;
}

/**
 * `AgentStateUpdate`'s `searchPlan` field is typed as
 * `Partial<SearchPlan> | null | OverwriteValue<SearchPlan | null>` because
 * LangGraph's `Annotation()` unions every custom-reducer channel's update
 * type with an internal overwrite marker. planDiscovery never returns that
 * marker, so this narrows the type down to what these tests actually deal
 * with instead of asserting it at every call site.
 */
function planOf(
  result: Awaited<ReturnType<typeof planDiscovery>>,
): Partial<SearchPlan> | null | undefined {
  return result.searchPlan as Partial<SearchPlan> | null | undefined;
}

describe("capProbes", () => {
  it("enforces the budget in code, not by asking the model nicely", () => {
    const probes = Array.from({ length: 20 }, (_, i) => ({ program: `p${i}` }));
    expect(capProbes(probes)).toHaveLength(DISCOVERY_BUDGET);
  });

  it("leaves a list under budget untouched", () => {
    const probes = [{ program: "a" }, { program: "b" }];
    expect(capProbes(probes)).toHaveLength(2);
  });

  it("keeps the earliest probes, which the prompt orders by promise", () => {
    const probes = [{ program: "first" }, { program: "second" }];
    expect(capProbes(probes, 1)).toEqual([{ program: "first" }]);
  });

  it("handles an empty list", () => {
    expect(capProbes([])).toEqual([]);
  });

  it("uses a budget of 6 by default", () => {
    expect(DISCOVERY_BUDGET).toBe(6);
  });
});

describe("discoveryPlanSchema", () => {
  it("allows omitting origin so a follow-up can carry the prior one forward", () => {
    const p = discoveryPlanSchema.parse({ probes: [] });
    expect(p.origin).toBeUndefined();
  });

  it("accepts a plan with probes", () => {
    const p = discoveryPlanSchema.parse({
      origin: "Chicago",
      probes: [
        { program: "aeroplan", destinationRegion: "Europe", cabin: "business" },
      ],
    });
    expect(p.probes).toHaveLength(1);
  });
});

describe("probesFromPlan", () => {
  it("returns the plan's real discoveryProbes verbatim, not a reconstruction", () => {
    // Three probes spanning three DIFFERENT regions — the bug this guards
    // against is a cartesian-product rebuild that would collapse them all
    // onto one region. If discoveryProbes round-trips correctly, each
    // probe's own destinationRegion survives.
    const probes: DiscoveryProbe[] = [
      { program: "aeroplan", destinationRegion: "Europe", cabin: "business" },
      { program: "alaska", destinationRegion: "Asia", cabin: "business" },
      { program: "turkish", destinationRegion: "Africa", cabin: "economy" },
    ];
    const plan: SearchPlan = {
      origins: ["ORD"],
      destinations: [],
      cabins: ["business", "economy"],
      nonstopOnly: false,
      programs: ["aeroplan", "alaska", "turkish"],
      discoveryProbes: probes,
    };
    expect(probesFromPlan(plan)).toEqual(probes);
  });

  it("returns an empty list when the plan has no discoveryProbes", () => {
    const plan: SearchPlan = {
      origins: ["ORD"],
      destinations: [],
      cabins: [],
      nonstopOnly: false,
      programs: [],
    };
    expect(probesFromPlan(plan)).toEqual([]);
  });
});

describe("planDiscovery place resolution", () => {
  beforeEach(() => {
    vi.mocked(resolveLocation).mockReset();
    vi.mocked(chat).mockReset();
  });

  it("[BUG-DROPPED-PLACE] carries an unresolved origin onto the plan instead of silently collapsing to no origins", async () => {
    mockPlannerResponse({
      origin: "Nowhereville",
      probes: [{ program: "aeroplan", destinationRegion: "Europe", cabin: "business" }],
    });

    vi.mocked(resolveLocation).mockReturnValue({ kind: "unknown", query: "Nowhereville" });

    const result = await planDiscovery(stateWith("where should I go from Nowhereville this fall?"));

    expect(planOf(result)?.unresolvedPlaces).toContain("Nowhereville");
    expect(planOf(result)?.origins).toEqual([]);
  });

  it("[BUG-DROPPED-PLACE] carries an ambiguous origin's candidates onto the plan instead of silently collapsing to no origins", async () => {
    mockPlannerResponse({
      origin: "London",
      probes: [{ program: "aeroplan", destinationRegion: "Europe", cabin: "business" }],
    });

    vi.mocked(resolveLocation).mockReturnValue({
      kind: "ambiguous",
      query: "London",
      candidates: ["London, United Kingdom", "London, Canada"],
    });

    const result = await planDiscovery(stateWith("where should I go from London this fall?"));

    expect(planOf(result)?.ambiguousPlaces).toContainEqual({
      query: "London",
      candidates: ["London, United Kingdom", "London, Canada"],
    });
    expect(planOf(result)?.origins).toEqual([]);
  });

  it("[BUG-MISSING-DISABLE-THINKING] disables thinking for its structured-output call, like plan-search.ts and guard.ts do", async () => {
    mockPlannerResponse({
      origin: "Chicago",
      probes: [{ program: "aeroplan", destinationRegion: "Europe", cabin: "business" }],
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "Chicago",
    });

    await planDiscovery(stateWith("where should I go from Chicago this fall?"));

    expect(chat).toHaveBeenCalledWith({
      effort: "low",
      maxTokens: 1_200,
      disableThinking: true,
    });
  });

  it("leaves unresolvedPlaces/ambiguousPlaces unset when the origin resolves cleanly", async () => {
    mockPlannerResponse({
      origin: "Chicago",
      probes: [{ program: "aeroplan", destinationRegion: "Europe", cabin: "business" }],
    });

    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD", "MDW"],
      label: "Chicago",
    });

    const result = await planDiscovery(stateWith("where should I go from Chicago this fall?"));

    expect(planOf(result)?.unresolvedPlaces).toBeUndefined();
    expect(planOf(result)?.ambiguousPlaces).toBeUndefined();
    expect(planOf(result)?.origins).toEqual(["ORD", "MDW"]);
  });

  it("omits origins entirely when the current turn doesn't name one, instead of collapsing to no origins", async () => {
    mockPlannerResponse({
      probes: [{ program: "aeroplan", destinationRegion: "Europe", cabin: "business" }],
    });

    const result = await planDiscovery(stateWith("only business or first"));

    expect(result.searchPlan).not.toHaveProperty("origins");
    expect(resolveLocation).not.toHaveBeenCalled();
  });

  it("recovers a published origin when the discovery model omits it", async () => {
    mockPlannerResponse({
      probes: [
        { program: "aeroplan", destinationRegion: "Europe", cabin: "business" },
      ],
    });

    const result = await planDiscovery(
      stateWith("Flights from the USA to Europe in business"),
    );

    expect(planOf(result)?.origins).toEqual(["USA"]);
    expect(resolveLocation).not.toHaveBeenCalled();
  });

  it("omits destinations so a prior route-search's destination survives the reducer merge", async () => {
    mockPlannerResponse({
      origin: "Chicago",
      probes: [{ program: "aeroplan", destinationRegion: "Europe", cabin: "business" }],
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "Chicago",
    });

    const result = await planDiscovery(stateWith("where should I go from Chicago this fall?"));

    expect(result.searchPlan).not.toHaveProperty("destinations");
  });

  it("does not force nonstopOnly to false, letting a prior route-search's nonstop constraint survive", async () => {
    mockPlannerResponse({
      origin: "Chicago",
      probes: [{ program: "aeroplan", destinationRegion: "Europe", cabin: "business" }],
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "Chicago",
    });

    const result = await planDiscovery(stateWith("where should I go from Chicago this fall?"));

    expect(result.searchPlan).not.toHaveProperty("nonstopOnly");
  });

  it("[BUG-CABIN-WIDENED] filters probes outside a prior turn's sticky cabin restriction, in code, not just via prompt request", async () => {
    mockPlannerResponse({
      origin: "Chicago",
      probes: [
        { program: "aeroplan", destinationRegion: "Europe", cabin: "business" },
        { program: "flyingblue", destinationRegion: "Asia", cabin: "economy" },
        { program: "united", destinationRegion: "Oceania", cabin: "first" },
      ],
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "Chicago",
    });

    const result = await planDiscovery(
      stateWithPriorPlan("where should I go from Chicago this fall?", {
        cabins: ["business", "first"],
      }),
    );

    const plan = planOf(result);
    expect(plan?.cabins).toEqual(["business", "first"]);
    expect(plan?.discoveryProbes?.map((p) => p.cabin)).toEqual(["business", "first"]);
    expect(plan?.discoveryProbes?.some((p) => p.cabin === "economy")).toBe(false);
  });

  it("does not filter probes when there is no prior cabin restriction", async () => {
    mockPlannerResponse({
      origin: "Chicago",
      probes: [
        { program: "aeroplan", destinationRegion: "Europe", cabin: "business" },
        { program: "flyingblue", destinationRegion: "Asia", cabin: "economy" },
      ],
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "Chicago",
    });

    const result = await planDiscovery(stateWith("where should I go from Chicago this fall?"));

    const plan = planOf(result);
    expect(plan?.cabins).toEqual(["business", "economy"]);
    expect(plan?.discoveryProbes).toHaveLength(2);
  });

  it("[BUG-CABIN-ZEROED] falls back to the unfiltered probes when a sticky cabin restriction would zero out every probe", async () => {
    // Prior turn's plan has cabins but no discoveryProbes — a real
    // route_search restriction, not a discovery turn's own summary — so the
    // filter is exercised, not skipped outright by the bootstrapping guard.
    mockPlannerResponse({
      origin: "Chicago",
      probes: [
        { program: "flyingblue", destinationRegion: "Asia", cabin: "economy" },
        { program: "delta", destinationRegion: "Europe", cabin: "economy" },
      ],
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "Chicago",
    });

    const result = await planDiscovery(
      stateWithPriorPlan("what about economy options out of Chicago?", {
        cabins: ["business"],
      }),
    );

    const plan = planOf(result);
    expect(plan?.discoveryProbes).not.toEqual([]);
    expect(plan?.discoveryProbes?.map((p) => p.cabin)).toEqual(["economy", "economy"]);
    expect(plan?.cabins).toEqual(["economy"]);
  });

  it("does not treat a prior discovery turn's own auto-derived cabin summary as a sticky restriction", async () => {
    // Prior plan has both cabins AND discoveryProbes — i.e. it came from a
    // prior discovery turn's own probe-coverage summary, not a real
    // user-stated restriction — so it must not constrain this turn at all,
    // even when some current-turn probes would still match it.
    mockPlannerResponse({
      origin: "Chicago",
      probes: [
        { program: "flyingblue", destinationRegion: "Asia", cabin: "economy" },
        { program: "delta", destinationRegion: "Europe", cabin: "economy" },
      ],
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "Chicago",
    });

    const result = await planDiscovery(
      stateWithPriorPlan("what about economy options out of Chicago?", {
        cabins: ["business"],
        discoveryProbes: [
          { program: "aeroplan", destinationRegion: "Europe", cabin: "business" },
        ],
      }),
    );

    const plan = planOf(result);
    expect(plan?.discoveryProbes?.map((p) => p.cabin)).toEqual(["economy", "economy"]);
    expect(plan?.cabins).toEqual(["economy"]);
  });
});
