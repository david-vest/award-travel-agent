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

/** The six search-derived channels every new turn must start clean on. */
const SEARCH_RESET_FIELDS = {
  searchPlan: null,
  awardResults: [],
  tripSummaries: [],
  kbDocs: [],
  draft: null,
  violations: [],
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

  it("resets all search-derived state when the model allows the message", async () => {
    mockGuardResponse({ allowed: true, reason: "" });
    const result = await guardInput(stateWith("business class to Tokyo"));
    expect(result).toMatchObject(RESET_FIELDS);
    expect(result.intent).toBeNull();
    expect(result.refusalReason).toBeNull();
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
});
