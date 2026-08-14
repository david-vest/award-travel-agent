import { describe, it, expect } from "vitest";
import { routeAfterGuard, routeAfterTriage } from "./routers";
import type { AgentStateType } from "./state";

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
