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
      yield { search_awards: { awardResults: [{ availabilityId: "avail-1", cabin: "business", miles: 60000 }] } };
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
        },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);

    const events = await collectEvents(response);
    const resultsEvent = events.find((e): e is Extract<AgentEvent, { type: "results" }> => e.type === "results");
    expect(resultsEvent).toBeDefined();
    expect(resultsEvent?.recommendations).toHaveLength(1);

    const completeEvent = events.find((e): e is Extract<AgentEvent, { type: "complete" }> => e.type === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.recommendations).toHaveLength(1);
    expect(completeEvent?.searchRan).toBe(true);
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
});
