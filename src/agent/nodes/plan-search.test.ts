import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { estimateTokens, CACHE_MIN_TOKENS } from "../cache";
import { PLAN_SEARCH_PROMPT } from "../prompts/plan-search";
import type { AgentStateType } from "../state";

vi.mock("../models", () => ({
  chat: vi.fn(),
}));

vi.mock("../../tools/locations/resolve", () => ({
  resolveLocation: vi.fn(),
}));

import { chat } from "../models";
import { resolveLocation } from "../../tools/locations/resolve";
import { buildPlannerContext, searchPlanSchema, planSearch } from "./plan-search";

/** Wires `chat(...).withStructuredOutput(...).invoke(...)` to resolve with `result`. */
function mockPlannerResponse(result: unknown) {
  const invoke = vi.fn().mockResolvedValue(result);
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  (chat as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ withStructuredOutput });
  return { invoke, withStructuredOutput };
}

function stateWith(text: string): AgentStateType {
  return { messages: [new HumanMessage(text)] } as AgentStateType;
}

describe("buildPlannerContext", () => {
  const now = new Date("2026-08-11T00:00:00Z");

  it("includes today's date so relative windows resolve", () => {
    expect(buildPlannerContext("this summer", now)).toContain("2026-08-11");
  });

  it("includes the user's question", () => {
    expect(buildPlannerContext("ORD to NRT", now)).toContain("ORD to NRT");
  });

  it("states the current year explicitly", () => {
    expect(buildPlannerContext("q", now)).toContain("2026");
  });

  it("includes prior-turn context when supplied", () => {
    const ctx = buildPlannerContext(
      "actually nonstop only",
      now,
      "User: ORD to NRT business class in September\nAssistant: Here are a few options...",
    );
    expect(ctx).toContain("ORD to NRT business class in September");
    expect(ctx).toContain("actually nonstop only");
  });

  it("omits the prior-context section when none is supplied", () => {
    expect(buildPlannerContext("ORD to NRT", now)).not.toContain(
      "Earlier in this conversation",
    );
  });
});

describe("PLAN_SEARCH_PROMPT", () => {
  it("is long enough to actually cache", () => {
    expect(estimateTokens(PLAN_SEARCH_PROMPT)).toBeGreaterThanOrEqual(
      CACHE_MIN_TOKENS,
    );
  });

  it("contains no date, year, or other volatile value", () => {
    // A date in the cached system prompt would invalidate the prefix daily.
    expect(PLAN_SEARCH_PROMPT).not.toMatch(/20\d\d-\d\d-\d\d/);
    expect(PLAN_SEARCH_PROMPT).not.toMatch(/\b20[2-9]\d\b/);
  });
});

describe("searchPlanSchema", () => {
  it("defaults nonstopOnly to false", () => {
    const p = searchPlanSchema.parse({ origins: ["ORD"], destinations: ["NRT"] });
    expect(p.nonstopOnly).toBe(false);
  });

  it("defaults cabins to all four", () => {
    const p = searchPlanSchema.parse({ origins: ["ORD"], destinations: ["NRT"] });
    expect(p.cabins).toHaveLength(4);
  });

  it("rejects an empty origins list", () => {
    expect(() =>
      searchPlanSchema.parse({ origins: [], destinations: ["NRT"] }),
    ).toThrow();
  });
});

describe("planSearch place resolution", () => {
  beforeEach(() => {
    vi.mocked(resolveLocation).mockReset();
    vi.mocked(chat).mockReset();
  });

  it("carries an unresolved place name onto the plan instead of dropping it", async () => {
    // The model named a real origin and a destination that doesn't match any
    // known airport or city.
    mockPlannerResponse({
      origins: ["Chicago"],
      destinations: ["Nowhereville"],
      cabins: ["economy", "premium", "business", "first"],
      nonstopOnly: false,
      programs: [],
    });

    vi.mocked(resolveLocation).mockImplementation((query: string) => {
      if (query === "Chicago") {
        return { kind: "airports", iatas: ["ORD", "MDW"], label: "Chicago" };
      }
      return { kind: "unknown", query };
    });

    const result = await planSearch(stateWith("flights to Nowhereville from Chicago"));

    expect(result.searchPlan?.unresolvedPlaces).toContain("Nowhereville");
    expect(result.searchPlan?.origins).toEqual(["ORD", "MDW"]);
  });

  it("carries an ambiguous match's candidates onto the plan instead of dropping it", async () => {
    // The model named an origin that matches multiple cities.
    mockPlannerResponse({
      origins: ["San"],
      destinations: ["Tokyo"],
      cabins: ["economy", "premium", "business", "first"],
      nonstopOnly: false,
      programs: [],
    });

    vi.mocked(resolveLocation).mockImplementation((query: string) => {
      if (query === "San") {
        return {
          kind: "ambiguous",
          query: "San",
          candidates: ["San Francisco", "San Diego", "San Jose"],
        };
      }
      return { kind: "airports", iatas: ["NRT", "HND"], label: "Tokyo" };
    });

    const result = await planSearch(stateWith("flights from San to Tokyo"));

    expect(result.searchPlan?.ambiguousPlaces).toContainEqual({
      query: "San",
      candidates: ["San Francisco", "San Diego", "San Jose"],
    });
    expect(result.searchPlan?.destinations).toEqual(["NRT", "HND"]);
  });

  it("carries prior-turn context into the planner request for a follow-up message", async () => {
    const { invoke } = mockPlannerResponse({
      origins: ["ORD"],
      destinations: ["NRT"],
      cabins: ["economy", "premium", "business", "first"],
      nonstopOnly: true,
      programs: [],
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "ORD",
    } as never);

    const state = {
      messages: [
        new HumanMessage("ORD to NRT business class in September"),
        new AIMessage("Here are a few options..."),
        new HumanMessage("actually nonstop only"),
      ],
    } as AgentStateType;

    await planSearch(state);

    const sentUserContent = invoke.mock.calls[0]?.[0]?.[1]?.content as string;
    expect(sentUserContent).toContain("ORD to NRT business class in September");
    expect(sentUserContent).toContain("actually nonstop only");
  });

  it("defaults startDate/endDate to today/today+window when the model omits them", async () => {
    mockPlannerResponse({
      origins: ["ORD"],
      destinations: ["NRT"],
      cabins: ["economy", "premium", "business", "first"],
      nonstopOnly: false,
      programs: [],
      // startDate/endDate deliberately omitted, as if the model didn't supply them.
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "ORD",
    } as never);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00Z"));
    try {
      const result = await planSearch(stateWith("ORD to NRT"));
      expect(result.searchPlan?.startDate).toBe("2026-08-11");
      expect(result.searchPlan?.endDate).toBe("2026-10-10"); // +60 days
    } finally {
      vi.useRealTimers();
    }
  });
});
