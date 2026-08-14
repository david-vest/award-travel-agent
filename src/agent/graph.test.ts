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
vi.mock("./nodes/plan-search", () => ({ planSearch: vi.fn() }));
vi.mock("./nodes/plan-discovery", () => ({ planDiscovery: vi.fn() }));
vi.mock("./nodes/search", () => ({ searchAwards: vi.fn() }));
vi.mock("./nodes/enrich", () => ({ enrichTrips: vi.fn() }));
vi.mock("./nodes/retrieve", () => ({ retrieveKnowledgeNode: vi.fn() }));
vi.mock("./nodes/synthesize", () => ({ synthesize: vi.fn() }));

import { buildGraphWithoutCheckpointer } from "./graph";
import { guardInput, refuse } from "./nodes/guard";
import { triage } from "./nodes/triage";
import { planSearch } from "./nodes/plan-search";
import { planDiscovery } from "./nodes/plan-discovery";
import { searchAwards } from "./nodes/search";
import { enrichTrips } from "./nodes/enrich";
import { retrieveKnowledgeNode } from "./nodes/retrieve";
import { synthesize } from "./nodes/synthesize";

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
      "search_awards",
      "enrich_trips",
      "retrieve_knowledge",
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

  /** Records `name` into `visited` when called, then resolves with `ret`. */
  function rec(name: string, ret: Partial<AgentStateType> = {}) {
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
    vi.mocked(searchAwards).mockImplementation(rec("search_awards", { awardResults: [] }));
    vi.mocked(enrichTrips).mockImplementation(
      rec("enrich_trips", { tripSummaries: [] }),
    );
    vi.mocked(retrieveKnowledgeNode).mockImplementation(
      rec("retrieve_knowledge", { kbDocs: [] }),
    );
    vi.mocked(synthesize).mockImplementation(rec("synthesize", { draft: "answer" }));
  });

  function invokeGraph(text: string) {
    const graph = buildGraphWithoutCheckpointer();
    return graph.invoke({ messages: [new HumanMessage(text)] } as AgentStateType);
  }

  it("visits plan_search, not plan_discovery, for a route_search intent", async () => {
    vi.mocked(triage).mockImplementation(rec("triage", { intent: "route_search" }));
    await invokeGraph("ORD to NRT business class");
    expect(visited).toContain("plan_search");
    expect(visited).not.toContain("plan_discovery");
  });

  it("visits plan_discovery, not plan_search, for a discovery intent", async () => {
    vi.mocked(triage).mockImplementation(rec("triage", { intent: "discovery" }));
    await invokeGraph("where can I go in business class for 100k miles?");
    expect(visited).toContain("plan_discovery");
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
});
