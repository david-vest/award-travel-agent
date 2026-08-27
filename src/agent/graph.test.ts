import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import type { AgentStateType } from "./state";

// Mock every node module so traversal can be asserted without live model,
// seats.aero, or Mongo calls — buildGraphWithoutCheckpointer() wires these
// node functions directly into the graph, so replacing the modules
// wholesale is enough; nothing inside them (chat(), mongoClient(), etc.)
// ever runs.
vi.mock("./nodes/guard", () => ({
  guardInput: vi.fn(),
  refuse: vi.fn(),
}));
vi.mock("./nodes/triage", () => ({ triage: vi.fn() }));
vi.mock("./nodes/plan-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nodes/plan-search")>();
  return { ...actual, planSearch: vi.fn() };
});
vi.mock("./nodes/plan-discovery", () => ({ planDiscovery: vi.fn() }));
vi.mock("./nodes/prepare-ui-search", () => ({ prepareUiSearch: vi.fn() }));
vi.mock("./nodes/resolve-ui-locations", () => ({ resolveUiLocations: vi.fn() }));
vi.mock("./nodes/search", () => ({ searchAwards: vi.fn(), searchPositioningOptions: vi.fn(), needsPositioningSearch: vi.fn() }));
vi.mock("./nodes/interpret-preferences", () => ({ interpretPreferences: vi.fn() }));
vi.mock("./nodes/build-candidate-shortlist", () => ({ buildCandidateShortlist: vi.fn() }));
vi.mock("./nodes/enrich", () => ({ enrichTrips: vi.fn() }));
vi.mock("./nodes/retrieve", () => ({ retrieveKnowledgeNode: vi.fn() }));
vi.mock("./nodes/rank-recommendations", () => ({ rankRecommendations: vi.fn() }));
vi.mock("./nodes/synthesize", () => ({ synthesize: vi.fn() }));

import { buildGraphWithoutCheckpointer } from "./graph";
import { guardInput, refuse } from "./nodes/guard";
import { triage } from "./nodes/triage";
import { planSearch, setPlanSearchClock } from "./nodes/plan-search";
import { planDiscovery } from "./nodes/plan-discovery";
import { prepareUiSearch } from "./nodes/prepare-ui-search";
import { resolveUiLocations } from "./nodes/resolve-ui-locations";
import { searchAwards, searchPositioningOptions, needsPositioningSearch } from "./nodes/search";
import { interpretPreferences } from "./nodes/interpret-preferences";
import { buildCandidateShortlist } from "./nodes/build-candidate-shortlist";
import { enrichTrips } from "./nodes/enrich";
import { retrieveKnowledgeNode } from "./nodes/retrieve";
import { rankRecommendations } from "./nodes/rank-recommendations";
import { synthesize } from "./nodes/synthesize";
import * as degradeModule from "./nodes/degrade";

describe("graph", () => {
  it("compiles", () => {
    expect(() => buildGraphWithoutCheckpointer()).not.toThrow();
  });

  it("exposes every expected node", () => {
    const graph = buildGraphWithoutCheckpointer();
    const nodes = Object.keys(graph.getGraph().nodes);
    for (const expected of [
      "guard_input",
      "refuse",
      "triage",
      "plan_search",
      "plan_discovery",
      "prepare_ui_search",
      "resolve_ui_locations",
      "search_awards",
      "search_positioning",
      "interpret_preferences",
      "build_candidate_shortlist",
      "enrich_trips",
      "retrieve_knowledge",
      "rank_recommendations",
      "synthesize",
    ]) {
      expect(nodes).toContain(expected);
    }
  });

  it("renders a mermaid diagram for the README", async () => {
    const graph = buildGraphWithoutCheckpointer();
    const mermaid = await graph.getGraph().drawMermaid();
    expect(mermaid).toContain("synthesize");
  });

  it("includes the loop nodes", () => {
    const nodes = Object.keys(buildGraphWithoutCheckpointer().getGraph().nodes);
    for (const expected of [
      "refresh_availability",
      "verify_groundedness",
      "degrade",
    ]) {
      expect(nodes).toContain(expected);
    }
  });
});

/**
 * State-flow bugs (e.g. a node visited when it shouldn't be, or a node
 * skipped when it should run) are invisible to the structural tests above —
 * they only check the graph's shape, never actually traverse it. These
 * tests stub every node to record its name into `visited` and then run a
 * real `.invoke()`, so routing decisions (routers.ts) are exercised for
 * real against the compiled graph.
 */
describe("graph traversal", () => {
  let visited: string[];

  /**
   * Records `name` into `visited` when called, then resolves with `ret`.
   * Generic (rather than a single shared `Partial<AgentStateType>` param
   * type) because node return types aren't uniform: most nodes return
   * `Partial<AgentStateType>`, but plan-search/plan-discovery return the
   * narrower `AgentStateUpdate` (whose `searchPlan` no longer admits `null`
   * now that guard.ts never emits it). Inferring `T` from each call's own
   * literal keeps every call site checked against the mocked node's actual
   * declared return type.
   */
  function rec<T extends object>(name: string, ret: T = {} as T) {
    return vi.fn(async () => {
      visited.push(name);
      return ret;
    });
  }

  beforeEach(() => {
    visited = [];
    vi.mocked(guardInput).mockImplementation(
      rec("guard_input", { intent: null, refusalReason: null }),
    );
    vi.mocked(refuse).mockImplementation(rec("refuse", { draft: "refused" }));
    vi.mocked(triage).mockImplementation(rec("triage", { intent: "route_search" }));
    vi.mocked(planSearch).mockImplementation(rec("plan_search", { searchPlan: null }));
    vi.mocked(planDiscovery).mockImplementation(
      rec("plan_discovery", { searchPlan: null }),
    );
    vi.mocked(prepareUiSearch).mockImplementation(
      rec("prepare_ui_search", { searchPlan: null }),
    );
    vi.mocked(resolveUiLocations).mockImplementation(
      rec("resolve_ui_locations"),
    );
    vi.mocked(searchAwards).mockImplementation(rec("search_awards", { awardResults: [] }));
    vi.mocked(searchPositioningOptions).mockImplementation(rec("search_positioning", { awardResults: [], positioningSearchComplete: true }));
    vi.mocked(needsPositioningSearch).mockReturnValue(false);
    vi.mocked(interpretPreferences).mockImplementation(rec("interpret_preferences"));
    vi.mocked(buildCandidateShortlist).mockImplementation(rec("build_candidate_shortlist", { candidateShortlist: [] }));
    vi.mocked(enrichTrips).mockImplementation(
      rec("enrich_trips", { tripSummaries: [] }),
    );
    vi.mocked(retrieveKnowledgeNode).mockImplementation(
      rec("retrieve_knowledge", { kbDocs: [] }),
    );
    vi.mocked(rankRecommendations).mockImplementation(
      rec("rank_recommendations", { recommendations: [] }),
    );
    vi.mocked(synthesize).mockImplementation(rec("synthesize", { draft: "answer" }));
  });

  function invokeGraph(text: string, extra: Partial<AgentStateType> = {}) {
    const graph = buildGraphWithoutCheckpointer();
    return graph.invoke({ messages: [new HumanMessage(text)], ...extra } as AgentStateType);
  }

  it("visits plan_search, not plan_discovery, for a route_search intent", async () => {
    vi.mocked(triage).mockImplementation(rec("triage", { intent: "route_search" }));
    await invokeGraph("ORD to NRT business class");
    expect(visited).toContain("plan_search");
    expect(visited).toContain("interpret_preferences");
    expect(visited).toContain("build_candidate_shortlist");
    expect(visited).not.toContain("plan_discovery");
  });

  it("[REGRESSION] uses an injected clock in plan_search when one is set, for a frozen clock end to end in evals", async () => {
    const frozen = new Date("2026-01-01T00:00:00Z");
    setPlanSearchClock(() => frozen);
    try {
      vi.mocked(planSearch).mockImplementation(async (state, now) => {
        visited.push("plan_search");
        expect(now).toBe(frozen);
        return { searchPlan: null };
      });
      await invokeGraph("ORD to NRT business class");
      expect(visited).toContain("plan_search");
    } finally {
      setPlanSearchClock(undefined);
    }
  });

  it("[REGRESSION] falls back to plan_search's own real-clock default when no clock is injected", async () => {
    setPlanSearchClock(undefined);
    vi.mocked(planSearch).mockImplementation(async (state, now) => {
      visited.push("plan_search");
      expect(now).toBeUndefined();
      return { searchPlan: null };
    });
    await invokeGraph("ORD to NRT business class");
    expect(visited).toContain("plan_search");
  });

  it("uses the deterministic UI preparation path for a structured trip request", async () => {
    await invokeGraph("form submission", {
      tripRequest: {
        origin: { code: "SFO", airports: ["SFO"], custom: false },
        destinations: [{ code: "TYO", airports: ["HND", "NRT"], custom: false }],
        startDate: "2026-09-18", endDate: "2026-09-27", flexDays: 2,
        cabins: ["business"], travelers: 1, stopPreference: "nonstop",
        preferredAirlines: [], creditCardPrograms: ["chase"], awardPrograms: ["united"],
        pointBalances: { creditCards: {}, awardPrograms: {} },
      },
    });
    expect(visited).toContain("prepare_ui_search");
    expect(visited).toContain("resolve_ui_locations");
    expect(visited).toContain("interpret_preferences");
    expect(visited).toContain("build_candidate_shortlist");
    expect(visited).not.toContain("triage");
    expect(visited).not.toContain("plan_search");
  });

  it("loops through positioning search once when exact results fail the quality gate", async () => {
    vi.mocked(needsPositioningSearch).mockReturnValueOnce(true).mockReturnValue(false);
    await invokeGraph("ORD to FUK business class");
    expect(visited.filter((node) => node === "search_positioning")).toHaveLength(1);
    expect(visited.filter((node) => node === "build_candidate_shortlist")).toHaveLength(2);
    expect(visited.filter((node) => node === "enrich_trips")).toHaveLength(2);
  });

  it("visits plan_discovery, not plan_search, for a discovery intent", async () => {
    vi.mocked(triage).mockImplementation(rec("triage", { intent: "discovery" }));
    await invokeGraph("where can I go in business class for 100k miles?");
    expect(visited).toContain("plan_discovery");
    expect(visited).toContain("interpret_preferences");
    expect(visited).toContain("build_candidate_shortlist");
    expect(visited).not.toContain("plan_search");
  });

  it("routes a knowledge intent straight to retrieve_knowledge, skipping both planners", async () => {
    vi.mocked(triage).mockImplementation(rec("triage", { intent: "knowledge" }));
    await invokeGraph("does Lufthansa charge fuel surcharges on award tickets?");
    expect(visited).toContain("retrieve_knowledge");
    expect(visited).not.toContain("plan_search");
    expect(visited).not.toContain("plan_discovery");
    expect(visited).not.toContain("search_awards");
  });

  it("skips every downstream node and goes straight to emit when guard rejects", async () => {
    vi.mocked(guardInput).mockImplementation(
      rec("guard_input", { intent: "rejected", refusalReason: "no" }),
    );
    await invokeGraph("do something unrelated to travel");
    expect(visited).toEqual(["guard_input", "refuse"]);
  });

  /**
   * Regression test for the Phase 5 revisionCount off-by-one: the wrapper
   * used to increment revisionCount on every synthesize pass, including the
   * first clean one, so by the time verify_groundedness ran after that
   * first pass, revisionCount was already 1 — equal to MAX_REVISIONS — and
   * routeAfterVerify degraded immediately without ever retrying. This test
   * doesn't mock verify_groundedness or degrade (graph.ts wires the real
   * ones in, and neither makes a model/network call), so routers.ts's real
   * routing decisions run against a synthesize output that always contains
   * a fabricated, ungroundable claim.
   */
  it("retries synthesize exactly once on a groundedness violation before degrading", async () => {
    vi.mocked(triage).mockImplementation(rec("triage", { intent: "route_search" }));
    vi.mocked(searchAwards).mockImplementation(
      rec("search_awards", { awardResults: [] }),
    );
    // No real awardResults/tripSummaries/kbDocs ever populated, so any
    // mileage figure quoted in the draft is unsupported and verify's real
    // findViolations will flag it every time, forcing exactly one retry.
    vi.mocked(synthesize).mockImplementation(
      rec("synthesize", { draft: "This costs a fabricated 92,000 miles." }),
    );
    // verify_groundedness and degrade are the REAL (unmocked) nodes — they
    // do no model/network work, so they're left wired in for real, exactly
    // like every other test in this describe block. Spy (pass-through) on
    // degrade just so its visit is recorded in `visited` for the assertion
    // below; its actual behavior is untouched.
    const degradeSpy = vi.spyOn(degradeModule, "degrade");

    await invokeGraph("ORD to NRT business class");

    const synthesizeVisits = visited.filter((n) => n === "synthesize");
    expect(synthesizeVisits).toHaveLength(2);
    expect(degradeSpy).toHaveBeenCalledTimes(1);

    degradeSpy.mockRestore();
  });
});
