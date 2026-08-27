import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStateType } from "../state";

vi.mock("../models", () => ({ chat: vi.fn() }));

import { chat } from "../models";
import {
  interpretPreferenceKeywords,
  interpretPreferences,
  mergePreferenceInterpretation,
} from "./interpret-preferences";

const request = {
  origin: { code: "SFO", airports: ["SFO"], custom: false },
  destinations: [{ code: "TYO", airports: ["HND", "NRT"], custom: false }],
  startDate: "2026-09-18",
  endDate: "2026-09-27",
  flexDays: 0,
  cabins: ["business"],
  travelers: 1,
  stopPreference: "up_to_one",
  preferredAirlines: [],
  creditCardPrograms: [],
  awardPrograms: [],
  pointBalances: { creditCards: {}, awardPrograms: {} },
  rankingPreference: { experienceWeight: 50, priorities: ["schedule"] },
} as const;

function mockInterpretation(result: unknown, rejects = false) {
  const invoke = rejects ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  vi.mocked(chat).mockReturnValue({
    withStructuredOutput: vi.fn().mockReturnValue({ invoke }),
  } as never);
  return invoke;
}

describe("interpretPreferences", () => {
  beforeEach(() => vi.mocked(chat).mockReset());

  it("uses the slider and chips directly without a model call when notes are empty", async () => {
    const result = await interpretPreferences({ tripRequest: request } as unknown as AgentStateType);

    expect(chat).not.toHaveBeenCalled();
    expect(result.recommendationPreferences).toMatchObject({
      experienceWeight: 50,
      priorities: ["schedule"],
      priorityWeights: { schedule: 85, cabin_product: 40 },
      source: "explicit",
    });
  });

  it("interprets early-departure avoidance without changing search constraints", async () => {
    mockInterpretation({
      experienceAdjustment: 0,
      priorities: ["schedule"],
      avoidEarlyDepartures: true,
      avoidLateArrivals: false,
      rationale: "The traveler wants to avoid early departures.",
    });

    const result = await interpretPreferences({
      tripRequest: { ...request, notes: "Please avoid early departures." },
    } as unknown as AgentStateType);

    expect(result.recommendationPreferences?.schedulePreferences.avoidEarlyDepartures).toBe(true);
    expect(result.recommendationPreferences?.experienceWeight).toBe(50);
    expect(result.recommendationPreferences?.source).toBe("model");
  });

  it("applies a bounded experience adjustment for experience-heavy language", async () => {
    mockInterpretation({
      experienceAdjustment: 20,
      priorities: ["cabin_product"],
      avoidEarlyDepartures: false,
      avoidLateArrivals: false,
      rationale: "The traveler would spend more for a better seat.",
    });

    const result = await interpretPreferences({
      tripRequest: { ...request, notes: "I would pay more for a great seat." },
    } as unknown as AgentStateType);

    expect(result.recommendationPreferences).toMatchObject({
      experienceWeight: 70,
      priorities: ["schedule", "cabin_product"],
      priorityWeights: { schedule: 85, cabin_product: 70 },
    });
  });

  it("keeps contradictory cost and experience signals near the explicit slider seed", async () => {
    mockInterpretation({
      experienceAdjustment: 0,
      priorities: ["cabin_product"],
      avoidEarlyDepartures: false,
      avoidLateArrivals: false,
      rationale: "Cost and seat quality are both important.",
    });

    const result = await interpretPreferences({
      tripRequest: { ...request, notes: "Cheapest possible, but I also want the best seat." },
    } as unknown as AgentStateType);

    expect(result.recommendationPreferences?.experienceWeight).toBe(50);
    expect(result.recommendationPreferences?.priorities).toContain("cabin_product");
  });

  it("falls back to deterministic keyword interpretation when the model fails", async () => {
    mockInterpretation(new Error("model unavailable"), true);

    const result = await interpretPreferences({
      tripRequest: { ...request, notes: "Avoid early flights; I would pay more for a lie-flat seat." },
    } as unknown as AgentStateType);

    expect(result.recommendationPreferences).toMatchObject({
      experienceWeight: 70,
      source: "keyword_fallback",
      schedulePreferences: { avoidEarlyDepartures: true },
    });
    expect(result.recommendationPreferences?.priorities).toEqual(expect.arrayContaining(["schedule", "cabin_product"]));
  });

  it("falls back to the balanced seed when model failure text contains no ranking signal", async () => {
    mockInterpretation(new Error("model unavailable"), true);

    const result = await interpretPreferences({
      tripRequest: { ...request, rankingPreference: { experienceWeight: 50, priorities: [] }, notes: "This is our anniversary trip." },
    } as unknown as AgentStateType);

    expect(result.recommendationPreferences).toMatchObject({
      experienceWeight: 50,
      priorities: [],
      source: "keyword_fallback",
    });
  });
});

describe("preference interpretation bounds", () => {
  it("cancels deterministic contradictory keywords", () => {
    const result = interpretPreferenceKeywords("Find the cheapest option, but I would pay more for a great seat.");
    expect(result.experienceAdjustment).toBe(0);
    expect(result.priorities).toContain("cabin_product");
  });

  it("clamps even an out-of-contract adjustment in code", () => {
    const result = mergePreferenceInterpretation(
      { experienceWeight: 90, priorities: [] },
      {
        experienceAdjustment: 999,
        priorities: [],
        avoidEarlyDepartures: false,
        avoidLateArrivals: false,
        rationale: "Untrusted output.",
      },
      "model",
    );
    expect(result.experienceWeight).toBe(100);
  });
});
