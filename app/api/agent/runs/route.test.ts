import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent, FlightRecommendation } from "../../../../src/contracts/travel-search";

const mockGraphStream = vi.fn();

vi.mock("../../../../src/agent/runtime", () => ({
  getAgentGraph: vi.fn(async () => ({
    stream: mockGraphStream,
  })),
}));

vi.mock("../../../../src/api/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterMs: 0 })),
}));

import { POST } from "./route";

const sampleFlight: FlightRecommendation = {
  id: "rec-1:business",
  rank: 1,
  origin: "SFO",
  destination: "HND",
  date: "2026-09-18",
  cabin: "business",
  miles: 60_000,
  taxes: { amount: 38, currency: "USD" },
  program: { id: "united", label: "United MileagePlus" },
  carriers: ["NH"],
  direct: true,
  stops: 0,
  flightNumbers: ["NH7"],
  aircraft: ["777-300ER"],
  reason: "Best fit.",
  scoreFactors: [],
  confidence: "high",
};

async function collectEvents(response: Response): Promise<AgentEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: AgentEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data) events.push(JSON.parse(data) as AgentEvent);
    }
  }
  return events;
}

describe("POST /api/agent/runs", () => {
  beforeEach(() => {
    mockGraphStream.mockReset();
  });

  it("emits recommendations and searchRan: true for a structured trip request search", async () => {
    mockGraphStream.mockImplementation(async function* () {
      yield { resolve_ui_locations: {} };
      yield { interpret_preferences: { recommendationPreferences: { experienceWeight: 75, priorities: ["cabin_product", "schedule"], rationale: "Journey first." } } };
      yield { search_awards: { awardResults: [{ availabilityId: "avail-1", cabin: "business", miles: 60000 }] } };
      yield { build_candidate_shortlist: { candidateShortlist: [{ availabilityId: "avail-1" }] } };
      yield { retrieve_knowledge: { kbDocs: [] } };
      yield { rank_recommendations: { recommendations: [sampleFlight] } };
      yield { synthesize: { draft: "Here are the best flight options." } };
    });

    const request = new Request("http://localhost/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          origin: { code: "SFO", airports: ["SFO"], custom: false },
          destinations: [{ code: "TYO", airports: ["HND", "NRT"], custom: false }],
          startDate: "2026-09-18",
          endDate: "2026-09-27",
          flexDays: 0,
          cabins: ["business"],
          travelers: 1,
          stopPreference: "nonstop",
          preferredAirlines: [],
          creditCardPrograms: ["chase"],
          awardPrograms: ["united"],
          pointBalances: { creditCards: {}, awardPrograms: {} },
          rankingPreference: { experienceWeight: 75, priorities: ["cabin_product", "schedule"] },
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const events = await collectEvents(response);
    const resultsEvent = events.find((e): e is Extract<AgentEvent, { type: "results" }> => e.type === "results");
    expect(resultsEvent).toBeDefined();
    expect(resultsEvent?.recommendations).toHaveLength(1);

    const stageDetails = events
      .filter((event): event is Extract<AgentEvent, { type: "stage" }> => event.type === "stage")
      .map((event) => event.detail ?? "");
    expect(stageDetails.some((detail) => detail.includes("75/100 toward journey experience"))).toBe(true);
    expect(stageDetails.some((detail) => detail.includes("coverage-balanced candidate"))).toBe(true);

    const completeEvent = events.find((e): e is Extract<AgentEvent, { type: "complete" }> => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.recommendations).toHaveLength(1);
    expect(completeEvent?.searchRan).toBe(true);

    const config = mockGraphStream.mock.calls[0]?.[1] as { metadata?: Record<string, unknown> };
    expect(config.metadata).toMatchObject({
      ui_version: "roam-search-v2",
      ranking_version: "evidence-hybrid-v3",
      preference_interpreter_version: "bounded-v1",
      evidence_retrieval_version: "option-linked-v1",
      experience_assessment_version: "evidence-bounded-v1",
      preference_rerank_version: "checkpoint-reuse-v1",
      candidate_shortlist_version: "coverage-v1",
      ranking_experience_weight: 75,
      ranking_priorities: ["cabin_product", "schedule"],
    });
  });

  it("traces Balanced as the backward-compatible ranking default", async () => {
    mockGraphStream.mockImplementation(async function* () {
      yield { synthesize: { draft: "No options found." } };
    });

    const request = new Request("http://localhost/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          origin: { code: "SFO", airports: ["SFO"], custom: false },
          destinations: [{ code: "TYO", airports: ["HND", "NRT"], custom: false }],
          startDate: "2026-09-18",
          endDate: "2026-09-27",
          flexDays: 0,
          cabins: ["business"],
          travelers: 1,
          stopPreference: "nonstop",
          preferredAirlines: [],
          creditCardPrograms: ["chase"],
          awardPrograms: ["united"],
          pointBalances: { creditCards: {}, awardPrograms: {} },
        },
      }),
    });

    await collectEvents(await POST(request));

    const config = mockGraphStream.mock.calls[0]?.[1] as { metadata?: Record<string, unknown> };
    expect(config.metadata).toMatchObject({
      ranking_experience_weight: 50,
      ranking_priorities: [],
    });
  });

  it("does not emit empty recommendations on a follow-up question when no search ran", async () => {
    mockGraphStream.mockImplementation(async function* () {
      yield { retrieve_knowledge: { kbDocs: [{ title: "Baggage Rules" }] } };
      yield { rank_recommendations: { recommendations: [] } };
      yield { synthesize: { draft: "United allows 2 free checked bags on business class awards." } };
    });

    const request = new Request("http://localhost/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "How many bags can I bring on the flight?",
        threadId: "a0000000-0000-4000-8000-000000000000",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const events = await collectEvents(response);
    // Should NOT send a results event with empty recommendations
    const resultsEvent = events.find((e) => e.type === "results");
    expect(resultsEvent).toBeUndefined();

    // Complete event should NOT carry empty recommendations that would overwrite existing ones
    const completeEvent = events.find((e): e is Extract<AgentEvent, { type: "complete" }> => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.recommendations).toBeUndefined();
    expect(completeEvent?.searchRan).toBe(false);
    expect(completeEvent?.answer).toBe("United allows 2 free checked bags on business class awards.");
  });

  it("emits new recommendations when a follow-up triggers a new search", async () => {
    mockGraphStream.mockImplementation(async function* () {
      yield { search_awards: { awardResults: [{ availabilityId: "avail-2", cabin: "business", miles: 50000 }] } };
      yield { retrieve_knowledge: { kbDocs: [] } };
      yield { rank_recommendations: { recommendations: [{ ...sampleFlight, id: "rec-2:business", miles: 50_000 }] } };
      yield { synthesize: { draft: "Found new options for next month." } };
    });

    const request = new Request("http://localhost/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Search for flights in October instead",
        threadId: "b0000000-0000-4000-8000-000000000000",
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const events = await collectEvents(response);
    const resultsEvent = events.find((e): e is Extract<AgentEvent, { type: "results" }> => e.type === "results");
    expect(resultsEvent).toBeDefined();
    expect(resultsEvent?.recommendations[0].miles).toBe(50_000);

    const completeEvent = events.find((e): e is Extract<AgentEvent, { type: "complete" }> => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.recommendations).toHaveLength(1);
    expect(completeEvent?.searchRan).toBe(true);
  });

  it("emits reranked recommendations while explicitly reporting that no new search ran", async () => {
    mockGraphStream.mockImplementation(async function* () {
      yield { update_rerank_preferences: { recommendationPreferences: { experienceWeight: 30, priorities: [], rationale: "Prefer lower cost." } } };
      yield { rank_recommendations: { recommendations: [{ ...sampleFlight, id: "cheaper:business", miles: 50_000 }] } };
      yield { synthesize: { draft: "I reused the verified options and moved value higher." } };
    });
    const request = new Request("http://localhost/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "make it cheaper",
        threadId: "c0000000-0000-4000-8000-000000000000",
      }),
    });
    const events = await collectEvents(await POST(request));
    expect(events.find((event): event is Extract<AgentEvent, { type: "results" }> => event.type === "results")?.recommendations[0].id).toBe("cheaper:business");
    const complete = events.find((event): event is Extract<AgentEvent, { type: "complete" }> => event.type === "complete");
    expect(complete).toMatchObject({ searchRan: false, recommendations: [{ id: "cheaper:business" }] });
    const details = events.filter((event): event is Extract<AgentEvent, { type: "stage" }> => event.type === "stage").map((event) => event.detail);
    expect(details).toContain("Reused the existing verified availability; no provider search was run.");
    expect(details).toContain("Reused cached itinerary details and qualitative evidence; no reassessment was needed.");
  });

  it("emits ranked results before real synthesis token deltas", async () => {
    mockGraphStream.mockImplementation(async function* () {
      yield ["updates", { search_awards: { awardResults: [{ availabilityId: "avail-1" }] } }];
      yield ["updates", { rank_recommendations: { recommendations: [sampleFlight] } }];
      yield ["messages", [{ content: "Here are " }, { langgraph_node: "synthesize" }]];
      yield ["messages", [{ content: "the best options." }, { langgraph_node: "synthesize" }]];
      yield ["updates", { synthesize: { draft: "Here are the best options." } }];
    });

    const response = await POST(new Request("http://localhost/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Search again",
        threadId: "d0000000-0000-4000-8000-000000000000",
      }),
    }));
    const events = await collectEvents(response);
    const resultsIndex = events.findIndex((event) => event.type === "results");
    const firstDeltaIndex = events.findIndex((event) => event.type === "answer_delta");
    expect(resultsIndex).toBeGreaterThan(-1);
    expect(firstDeltaIndex).toBeGreaterThan(resultsIndex);
    expect(events.filter((event) => event.type === "answer_delta").map((event) => event.text)).toEqual([
      "Here are ",
      "the best options.",
    ]);
    expect(events.find((event) => event.type === "complete")).toMatchObject({
      answer: "Here are the best options.",
    });
  });

  it("emits a structured clarification and leaves the run resumable", async () => {
    const clarification = {
      id: "no-nonstop-premium-cabin",
      prompt: "Which constraint should I relax?",
      choices: [
        { id: "allow_one_stop", label: "Allow one stop", description: "Keep business class." },
        { id: "try_premium_economy", label: "Try premium economy", description: "Keep nonstop." },
        { id: "keep_constraints", label: "Keep my brief", description: "Do not broaden." },
      ],
    };
    mockGraphStream.mockImplementation(async function* () {
      yield ["updates", { search_awards: { awardResults: [] } }];
      yield ["updates", { __interrupt__: [{ value: clarification }] }];
    });

    const events = await collectEvents(await POST(new Request("http://localhost/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Find nonstop business class",
        threadId: "e0000000-0000-4000-8000-000000000000",
      }),
    })));

    expect(events.find((event) => event.type === "clarification_required")).toMatchObject({ clarification });
    expect(events.some((event) => event.type === "complete")).toBe(false);
  });

  it("resumes the same thread with a LangGraph Command", async () => {
    mockGraphStream.mockImplementation(async function* () {
      yield ["updates", { synthesize: { draft: "Resumed." } }];
    });
    const threadId = "f0000000-0000-4000-8000-000000000000";
    const events = await collectEvents(await POST(new Request("http://localhost/api/agent/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId, resume: { choiceId: "keep_constraints" } }),
    })));

    expect(mockGraphStream.mock.calls[0]?.[0]).toMatchObject({ lg_name: "Command" });
    expect(events[0]).toMatchObject({ type: "run_started", threadId });
    expect(events.find((event) => event.type === "complete")).toMatchObject({ answer: "Resumed." });
  });
});
