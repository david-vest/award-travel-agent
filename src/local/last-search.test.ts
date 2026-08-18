import { describe, expect, it } from "vitest";
import { parseLastSearchSnapshot, type LastSearchSnapshot } from "./last-search";

const snapshot: LastSearchSnapshot = {
  version: 1,
  savedAt: "2026-08-17T12:00:00.000Z",
  form: {
    origin: { kind: "airport", code: "SFO", city: "San Francisco", country: "United States", airports: ["SFO"] },
    destinations: [{ kind: "group", code: "ASA", city: "Asia", country: "Seats.aero multi-city region", airports: [] }],
    startDate: "2026-09-18",
    endDate: "2026-09-27",
    flexDays: 3,
    cabins: ["business"],
    travelers: "2 travelers",
    selectedCreditPrograms: ["chase"],
    selectedAwardPrograms: ["united"],
    creditCardBalances: { chase: "125000" },
    awardProgramBalances: {},
    maxFees: "350",
    stops: "one",
    preferredAirlines: ["NH"],
    notes: "Avoid early departures",
  },
  chatMessages: [
    { id: "assistant-1", role: "assistant", content: "This is the strongest option." },
    { id: "user-1", role: "user", content: "Which option has the lowest fees?" },
  ],
  run: {
    status: "complete",
    stages: { search: "complete", rules: "complete", rank: "complete" },
    stageDetails: { search: "Found live space.", rules: "Verified details.", rank: "Ranked options." },
    stageDurations: { search: 1200, rules: 800, rank: 300 },
    recommendations: [{
      id: "award-1",
      rank: 1,
      origin: "SFO",
      destination: "HND",
      date: "2026-09-20",
      cabin: "business",
      miles: 75000,
      taxes: { amount: 5.6, currency: "USD" },
      program: { id: "united", label: "United MileagePlus" },
      carriers: ["NH"],
      direct: true,
      stops: 0,
      flightNumbers: ["NH 107"],
      aircraft: ["77W"],
      reason: "Best nonstop value.",
      scoreFactors: [{ label: "Cabin", value: "Business" }],
      confidence: "high",
    }],
    answer: "This is the strongest option.",
    error: null,
    threadId: "c448f475-43b8-43d1-a5b3-9f91ef9b54a9",
  },
};

describe("parseLastSearchSnapshot", () => {
  it("restores a valid form and completed run", () => {
    expect(parseLastSearchSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("allows a submitted form whose run was interrupted", () => {
    const pending = { ...snapshot, run: null };
    expect(parseLastSearchSnapshot(JSON.stringify(pending))).toEqual(pending);
  });

  it("restores older snapshots without chat history", () => {
    const legacySnapshot = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    delete legacySnapshot.chatMessages;
    expect(parseLastSearchSnapshot(JSON.stringify(legacySnapshot))).toEqual({
      ...legacySnapshot,
      chatMessages: [],
    });
  });

  it("ignores corrupt, unknown-version, and unsafe nested data", () => {
    expect(parseLastSearchSnapshot("{not json")).toBeNull();
    expect(parseLastSearchSnapshot(JSON.stringify({ ...snapshot, version: 2 }))).toBeNull();
    expect(parseLastSearchSnapshot(JSON.stringify({
      ...snapshot,
      run: {
        ...snapshot.run,
        recommendations: [{ ...snapshot.run!.recommendations[0], taxes: { amount: "free", currency: "USD" } }],
      },
    }))).toBeNull();
  });
});
