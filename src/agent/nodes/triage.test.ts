import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { AgentStateType } from "../state";

vi.mock("../models", () => ({
  chat: vi.fn(),
}));

import { chat } from "../models";
import { lastUserText, triage } from "./triage";

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

  it("falls back to knowledge intent when the model call throws, rather than failing the turn", async () => {
    mockTriageRejection(new Error("OutputParserException: no tool call"));
    const result = await triage(state([new HumanMessage("business class to Tokyo")]));
    expect(result).toEqual({ intent: "knowledge" });
  });
});
