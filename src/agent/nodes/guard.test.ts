import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage } from "@langchain/core/messages";
import type { AgentStateType } from "../state";

vi.mock("../models", () => ({
  chat: vi.fn(),
}));

import { chat } from "../models";
import { guardInput } from "./guard";

/** Wires `chat(...).withStructuredOutput(...).invoke(...)` to resolve/reject with `result`. */
function mockGuardResponse(result: unknown) {
  const invoke = vi.fn().mockResolvedValue(result);
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  (chat as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ withStructuredOutput });
  return { invoke, withStructuredOutput };
}

function mockGuardRejection(error: unknown) {
  const invoke = vi.fn().mockRejectedValue(error);
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  (chat as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ withStructuredOutput });
  return { invoke, withStructuredOutput };
}

function stateWith(text: string): AgentStateType {
  return { messages: [new HumanMessage(text)] } as AgentStateType;
}

/** The channels every new turn must start clean on. */
const SEARCH_RESET_FIELDS = {
  awardResults: [],
  searchStatus: "not_run",
  tripSummaries: [],
  recommendations: [],
  locationResolutions: [],
  searchAttempts: [],
  positioningSearchComplete: false,
  kbDocs: [],
  draft: null,
  violations: [],
  refreshedAt: null,
  degradedReasons: [],
};

/** Same, plus refusalReason default-reset — every path except an explicit rejection wants this. */
const RESET_FIELDS = { ...SEARCH_RESET_FIELDS, refusalReason: null };

describe("guardInput", () => {
  beforeEach(() => {
    vi.mocked(chat).mockReset();
  });

  it("resets all search-derived state on the empty-text early return", async () => {
    const result = await guardInput(stateWith(""));
    expect(result).toMatchObject(RESET_FIELDS);
    expect(result.intent).toBeNull();
    expect(result.refusalReason).toBeNull();
  });

  it("accepts a validated structured trip request without spending a model call", async () => {
    const result = await guardInput({
      ...stateWith("form submission"),
      tripRequest: {
        origin: { code: "SFO", airports: ["SFO"], custom: false },
        destinations: [{ code: "TYO", airports: ["HND"], custom: false }],
        startDate: "2026-09-18", endDate: "2026-09-27", flexDays: 2,
        cabins: ["business"], travelers: 1, stopPreference: "nonstop",
        preferredAirlines: [], creditCardPrograms: ["chase"], awardPrograms: ["united"],
        pointBalances: { creditCards: {}, awardPrograms: {} },
      },
    } as AgentStateType);
    expect(chat).not.toHaveBeenCalled();
    expect(result).toMatchObject(RESET_FIELDS);
  });

  it("resets all search-derived state when the model allows the message", async () => {
    mockGuardResponse({ allowed: true, reason: "" });
    const result = await guardInput(stateWith("business class to Tokyo"));
    expect(result).toMatchObject(RESET_FIELDS);
    expect(result.intent).toBeNull();
    expect(result.refusalReason).toBeNull();
    expect(chat).toHaveBeenCalledWith({
      model: "haiku",
      effort: "low",
      maxTokens: 256,
      disableThinking: true,
    });
  });

  it("resets all search-derived state when the model rejects the message", async () => {
    mockGuardResponse({
      allowed: false,
      reason: "I can only help with award travel.",
    });
    const result = await guardInput(stateWith("tell me a joke"));
    expect(result).toMatchObject(SEARCH_RESET_FIELDS);
    expect(result.intent).toBe("rejected");
    expect(result.refusalReason).toBe("I can only help with award travel.");
  });

  it("fails open (does not block the user) when the model call throws", async () => {
    mockGuardRejection(new Error("OutputParserException: no tool call"));
    const result = await guardInput(stateWith("business class to Tokyo"));
    expect(result).toMatchObject(RESET_FIELDS);
    expect(result.intent).toBeNull();
    expect(result.refusalReason).toBeNull();
  });

  it("neutralizes a leftover revisionCount from a prior turn despite the additive reducer", async () => {
    // revisionCount's reducer is `(current, update) => current + update`, so
    // a naive static `revisionCount: 0` reset would be a no-op (current + 0
    // = current) and would NOT actually clear a count restored from a prior
    // turn's checkpoint. guardInput must instead return the negation of
    // whatever count came in, so current + (-current) lands on exactly 0.
    mockGuardResponse({ allowed: true, reason: "" });
    const priorTurnState = {
      ...stateWith("another question"),
      revisionCount: 1,
    } as AgentStateType;

    const result = await guardInput(priorTurnState);

    expect((priorTurnState.revisionCount ?? 0) + (result.revisionCount ?? 0)).toBe(0);
  });

  it("returns a plain 0 (not -0) when there was no prior revisionCount to clear", async () => {
    mockGuardResponse({ allowed: true, reason: "" });
    const result = await guardInput(stateWith("business class to Tokyo"));
    expect(result.revisionCount).toBe(0);
  });

  it("does not touch searchPlan, letting the checkpointer's prior value carry forward", async () => {
    mockGuardResponse({ allowed: true, reason: "" });
    const result = await guardInput(stateWith("only business or first"));
    expect(result).not.toHaveProperty("searchPlan");
  });

  it("does not touch searchPlan even on the rejected path", async () => {
    mockGuardResponse({
      allowed: false,
      reason: "I can only help with award travel.",
    });
    const result = await guardInput(stateWith("tell me a joke"));
    expect(result).not.toHaveProperty("searchPlan");
  });
});
