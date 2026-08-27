import { describe, expect, it } from "vitest";
import {
  parseLastSearchSnapshot,
  validateLastSearchSnapshot,
  type LastSearchSnapshot,
} from "./last-search";

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
    rankingPreference: { experienceWeight: 75, priorities: ["cabin_product", "schedule"] },
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

  it("restores a checkpointed clarification after a page or process restart", () => {
    const clarification = {
      ...snapshot,
      run: {
        ...snapshot.run!,
        status: "clarification" as const,
        runId: "10000000-0000-4000-8000-000000000000",
        clarification: {
          id: "no-nonstop-premium-cabin",
          prompt: "Which constraint should I relax?",
          choices: [
            { id: "allow_one_stop" as const, label: "Allow one stop", description: "Keep business class." },
            { id: "try_premium_economy" as const, label: "Try premium economy", description: "Keep nonstop." },
            { id: "keep_constraints" as const, label: "Keep my brief", description: "Do not broaden." },
          ],
        },
      },
    };
    expect(parseLastSearchSnapshot(JSON.stringify(clarification))).toEqual(clarification);
  });

  it("restores older snapshots without chat history", () => {
    const legacySnapshot = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    delete legacySnapshot.chatMessages;
    expect(parseLastSearchSnapshot(JSON.stringify(legacySnapshot))).toEqual({
      ...legacySnapshot,
      chatMessages: [],
    });
  });

  it("migrates an older saved form without ranking preferences to Balanced", () => {
    const legacySnapshot = JSON.parse(JSON.stringify(snapshot)) as {
      form: Record<string, unknown>;
    } & Record<string, unknown>;
    delete legacySnapshot.form.rankingPreference;

    expect(parseLastSearchSnapshot(JSON.stringify(legacySnapshot))).toMatchObject({
      form: { rankingPreference: { experienceWeight: 50, priorities: [] } },
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
    expect(parseLastSearchSnapshot(JSON.stringify({
      ...snapshot,
      form: { ...snapshot.form, rankingPreference: { experienceWeight: 40, priorities: [] } },
    }))).toBeNull();
    expect(parseLastSearchSnapshot(JSON.stringify({
      ...snapshot,
      form: { ...snapshot.form, rankingPreference: { experienceWeight: 50, priorities: ["unknown"] } },
    }))).toBeNull();
  });

  it("reports the exact invalid field for debugging", () => {
    const invalid = {
      ...snapshot,
      run: {
        ...snapshot.run,
        recommendations: [{
          ...snapshot.run!.recommendations[0],
          taxes: { amount: "free", currency: "USD" },
        }],
      },
    };

    const result = validateLastSearchSnapshot(invalid);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["run", "recommendations", 0, "taxes", "amount"]);
    }
  });
});
