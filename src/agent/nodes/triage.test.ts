import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { AgentStateType } from "../state";

vi.mock("../models", () => ({
  chat: vi.fn(),
}));

import { chat } from "../models";
import { lastUserText, triage, conversationContext, CONVERSATION_CONTEXT_MAX_TOKENS } from "./triage";

const state = (messages: unknown[]): AgentStateType =>
  ({ messages }) as AgentStateType;

function mockTriageRejection(error: unknown) {
  const invoke = vi.fn().mockRejectedValue(error);
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  (chat as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ withStructuredOutput });
}

describe("lastUserText", () => {
  it("returns the most recent human message", () => {
    const s = state([
      new HumanMessage("first"),
      new AIMessage("reply"),
      new HumanMessage("second"),
    ]);
    expect(lastUserText(s)).toBe("second");
  });

  it("ignores AI messages", () => {
    const s = state([new HumanMessage("only human"), new AIMessage("noise")]);
    expect(lastUserText(s)).toBe("only human");
  });

  it("returns an empty string when there is no human message", () => {
    expect(lastUserText(state([new AIMessage("hi")]))).toBe("");
  });

  it("flattens array-form content", () => {
    const s = state([
      new HumanMessage({ content: [{ type: "text", text: "block form" }] }),
    ]);
    expect(lastUserText(s)).toBe("block form");
  });
});

describe("triage", () => {
  beforeEach(() => {
    vi.mocked(chat).mockReset();
  });

  it("falls back to route_search for an obvious flight request when the model call throws", async () => {
    mockTriageRejection(new Error("OutputParserException: no tool call"));
    const result = await triage(state([new HumanMessage("business class to Tokyo")]));
    expect(result).toEqual({ intent: "route_search" });
    expect(chat).toHaveBeenCalledWith({
      model: "haiku",
      effort: "low",
      maxTokens: 256,
      disableThinking: true,
    });
  });

  it.each([
    "Flights from the USA to Europe in business",
    "USA -> EUR",
    "California or New York to London or Paris",
  ])("deterministically routes a published multi-city route: %s", async (text) => {
    const result = await triage(state([new HumanMessage(text)]));
    expect(result).toEqual({ intent: "route_search" });
    expect(chat).not.toHaveBeenCalled();
  });

  it("keeps a pure knowledge fallback when no search signal is present", async () => {
    mockTriageRejection(new Error("API down"));
    const result = await triage(
      state([new HumanMessage("Can Chase points transfer to Alaska?")]),
    );
    expect(result).toEqual({ intent: "knowledge" });
  });

  it.each(["make it cheaper", "prioritize the seat", "avoid long layovers"])(
    "deterministically reuses verified recommendations for: %s",
    async (text) => {
      const result = await triage({
        messages: [new HumanMessage(text)],
        recommendationSnapshot: {},
      } as unknown as AgentStateType);
      expect(result).toEqual({ intent: "rerank" });
      expect(chat).not.toHaveBeenCalled();
    },
  );

  it.each(["business class instead", "nonstop only", "2 travelers", "from SFO to CDG"])(
    "does not classify a hard search change as rerank: %s",
    async (text) => {
      mockTriageRejection(new Error("API down"));
      const result = await triage({
        messages: [new HumanMessage(text)],
        recommendationSnapshot: {},
        searchPlan: { origins: ["SFO"], destinations: ["HND"], cabins: ["economy"], nonstopOnly: false, programs: [] },
      } as unknown as AgentStateType);
      expect(result.intent).toBe("route_search");
    },
  );
});

describe("conversationContext", () => {
  it("returns an empty string when there are no prior messages", async () => {
    const s = state([new HumanMessage("first")]);
    expect(await conversationContext(s)).toBe("");
  });

  it("includes prior turns within the token budget", async () => {
    const s = state([
      new HumanMessage("business class to Tokyo"),
      new AIMessage("Here are a few options..."),
      new HumanMessage("actually nonstop only"),
    ]);
    const ctx = await conversationContext(s);
    expect(ctx).toContain("business class to Tokyo");
    expect(ctx).toContain("Here are a few options");
  });

  it("drops the oldest turns once the token budget is exceeded", async () => {
    const old = new HumanMessage("x".repeat(CONVERSATION_CONTEXT_MAX_TOKENS * 4 + 100));
    const recent = new HumanMessage("recent question");
    const s = state([old, recent, new HumanMessage("current turn")]);
    const ctx = await conversationContext(s);
    expect(ctx).toContain("recent question");
    expect(ctx).not.toContain("xxxxxxxxxx");
  });
});
