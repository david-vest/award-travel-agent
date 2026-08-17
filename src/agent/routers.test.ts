import { describe, it, expect } from "vitest";
import {
  routeAfterGuard,
  routeAfterTriage,
  routeAfterSearch,
  routeAfterEnrich,
  routeAfterVerify,
  MAX_REVISIONS,
} from "./routers";
import type { AgentStateType } from "./state";
import type { AwardOption } from "../tools";

const s = (over: Partial<AgentStateType>): AgentStateType =>
  over as AgentStateType;

describe("routeAfterGuard", () => {
  it("sends rejected input to refuse", () => {
    expect(routeAfterGuard(s({ intent: "rejected" }))).toBe("refuse");
  });

  it("sends allowed input to triage", () => {
    expect(routeAfterGuard(s({ intent: null }))).toBe("triage");
  });
});

describe("routeAfterTriage", () => {
  it("routes route_search to the search planner", () => {
    expect(routeAfterTriage(s({ intent: "route_search" }))).toBe("plan_search");
  });

  it("routes discovery to the discovery planner", () => {
    expect(routeAfterTriage(s({ intent: "discovery" }))).toBe("plan_discovery");
  });

  it("routes knowledge straight to retrieval, skipping any search", () => {
    expect(routeAfterTriage(s({ intent: "knowledge" }))).toBe(
      "retrieve_knowledge",
    );
  });

  it("falls back to retrieval on an unexpected intent rather than throwing", () => {
    expect(routeAfterTriage(s({ intent: null }))).toBe("retrieve_knowledge");
  });
});

describe("routeAfterSearch", () => {
  const stale = new Date(Date.now() - 12 * 3_600_000).toISOString();
  const base = {
    intent: "route_search" as const,
    searchPlan: {
      origins: ["ORD"],
      destinations: ["NRT"],
      cabins: ["business"],
      nonstopOnly: false,
      programs: [],
    },
    awardResults: [
      { availabilityId: "a1", origin: "ORD", destination: "NRT", date: "2026-09-14",
        program: "aeroplan", cabin: "business", miles: 87500, direct: true,
        airlines: "NH", updatedAt: stale },
    ] as AwardOption[],
  };

  it("routes stale precise results to the refresh node", () => {
    expect(routeAfterSearch(s(base))).toBe("refresh_availability");
  });

  it("skips refresh on discovery", () => {
    expect(routeAfterSearch(s({ ...base, intent: "discovery" }))).toBe(
      "enrich_trips",
    );
  });

  it("skips refresh when there are no results", () => {
    expect(routeAfterSearch(s({ ...base, awardResults: [] }))).toBe("enrich_trips");
  });
});

describe("routeAfterEnrich", () => {
  const plan = { origins: ["ORD"], destinations: ["FUK"], cabins: ["business"], nonstopOnly: false, programs: [] };

  it("routes weak exact results into the positioning ladder", () => {
    expect(routeAfterEnrich(s({ intent: "route_search", searchPlan: plan, awardResults: [], positioningSearchComplete: false }))).toBe("search_positioning");
  });

  it("does not loop after the bounded positioning search completes", () => {
    expect(routeAfterEnrich(s({ intent: "route_search", searchPlan: plan, awardResults: [], positioningSearchComplete: true }))).toBe("retrieve_knowledge");
  });
});

describe("routeAfterVerify", () => {
  it("emits a clean draft", () => {
    expect(routeAfterVerify(s({ violations: [], revisionCount: 0 }))).toBe("emit");
  });

  it("retries once when violations are found", () => {
    const st = s({
      violations: [{ kind: "unsupported_number", detail: "x" }],
      revisionCount: 0,
    });
    expect(routeAfterVerify(st)).toBe("synthesize");
  });

  it("degrades rather than looping when the retry budget is spent", () => {
    const st = s({
      violations: [{ kind: "unsupported_number", detail: "x" }],
      revisionCount: MAX_REVISIONS,
    });
    expect(routeAfterVerify(st)).toBe("degrade");
  });

  it("allows exactly one revision", () => {
    expect(MAX_REVISIONS).toBe(1);
  });
});
