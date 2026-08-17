import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { estimateTokens, CACHE_MIN_TOKENS } from "../cache";
import { PLAN_SEARCH_PROMPT } from "../prompts/plan-search";
import type { AgentStateType, SearchPlan } from "../state";

vi.mock("../models", () => ({
  chat: vi.fn(),
}));

vi.mock("../../tools/locations/resolve", () => ({
  resolveLocation: vi.fn(),
}));

import { chat } from "../models";
import { resolveLocation } from "../../tools/locations/resolve";
import {
  buildPlannerContext,
  searchPlanSchema,
  planSearch,
} from "./plan-search";
import { inferMultiCityRoute } from "../../tools/seats-aero/multi-city-codes";

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

/**
 * `AgentStateUpdate`'s `searchPlan` field is typed as
 * `Partial<SearchPlan> | null | OverwriteValue<SearchPlan | null>` because
 * LangGraph's `Annotation()` unions every custom-reducer channel's update
 * type with an internal overwrite marker. planSearch never returns that
 * marker, so this narrows the type down to what these tests actually deal
 * with instead of asserting it at every call site.
 */
function planOf(
  result: Awaited<ReturnType<typeof planSearch>>,
): Partial<SearchPlan> | null | undefined {
  return result.searchPlan as Partial<SearchPlan> | null | undefined;
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

describe("inferMultiCityRoute", () => {
  it("recovers USA to EUR when structured planning omits the route", () => {
    expect(
      inferMultiCityRoute(
        "Flights from USA to Europe in business between September 16th-18th",
      ),
    ).toEqual({ origins: ["USA"], destinations: ["EUR"] });
  });

  it("retains multiple published origins and destinations", () => {
    expect(
      inferMultiCityRoute(
        "from California or New York to London, Paris, or Schengen Area",
      ),
    ).toEqual({
      origins: ["CAL", "NYC"],
      destinations: ["LON", "PAR", "SCH"],
    });
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

  it("treats programs as user constraints and searches all when none were named", () => {
    expect(PLAN_SEARCH_PROMPT).toContain("programs: []");
    expect(PLAN_SEARCH_PROMPT).toMatch(/query all\s+seats\.aero programs/i);
    expect(PLAN_SEARCH_PROMPT).not.toMatch(/pick three to five programs/i);
  });
});

describe("searchPlanSchema", () => {
  it("allows omitting nonstopOnly so a turn that doesn't address it can carry the prior value forward", () => {
    const p = searchPlanSchema.parse({});
    expect(p.nonstopOnly).toBeUndefined();
  });

  it("allows omitting cabins so a turn that doesn't address it can carry the prior value forward", () => {
    const p = searchPlanSchema.parse({});
    expect(p.cabins).toBeUndefined();
  });

  it("allows omitting origins entirely, unlike the old required min(1) list", () => {
    const p = searchPlanSchema.parse({});
    expect(p.origins).toBeUndefined();
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

    expect(planOf(result)?.unresolvedPlaces).toContain("Nowhereville");
    expect(planOf(result)?.origins).toEqual(["ORD", "MDW"]);
  });

  it("retries an empty planner result and deterministically preserves multi-city endpoints", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        cabins: ["business", "first"],
        startDate: "2026-09-16",
        endDate: "2026-09-18",
        programs: [],
      });
    const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
    vi.mocked(chat).mockReturnValue({ withStructuredOutput } as never);
    vi.mocked(resolveLocation).mockImplementation((query: string) => ({
      kind: "airports",
      iatas: [query],
      label: query,
    }));

    const result = await planSearch(
      stateWith(
        "Flights from USA to Europe in Business or first with low taxes between September 16th-18th 2026",
      ),
    );

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(planOf(result)).toMatchObject({
      origins: ["USA"],
      destinations: ["EUR"],
      cabins: ["business", "first"],
      startDate: "2026-09-16",
      endDate: "2026-09-18",
      programs: [],
    });
  });

  it("still searches inferred multi-city endpoints when both planner attempts are empty", async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
    vi.mocked(chat).mockReturnValue({ withStructuredOutput } as never);
    vi.mocked(resolveLocation).mockImplementation((query: string) => ({
      kind: "airports",
      iatas: [query],
      label: query,
    }));

    const result = await planSearch(stateWith("USA to Europe"));

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(planOf(result)).toMatchObject({
      origins: ["USA"],
      destinations: ["EUR"],
    });
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

    expect(planOf(result)?.ambiguousPlaces).toContainEqual({
      query: "San",
      candidates: ["San Francisco", "San Diego", "San Jose"],
    });
    expect(planOf(result)?.destinations).toEqual(["NRT", "HND"]);
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

  it("omits startDate/endDate when the model doesn't supply them, leaving the reducer to default or carry them forward", async () => {
    mockPlannerResponse({ origins: ["ORD"], destinations: ["NRT"] });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD"],
      label: "ORD",
    } as never);

    const result = await planSearch(stateWith("ORD to NRT"));
    expect(planOf(result)?.startDate).toBeUndefined();
    expect(planOf(result)?.endDate).toBeUndefined();
  });

  it("omits destinations entirely when the current turn doesn't address it, instead of resetting to empty", async () => {
    mockPlannerResponse({ cabins: ["business"] });
    const result = await planSearch(stateWith("only business, please"));
    expect(planOf(result)).not.toHaveProperty("destinations");
  });

  it("turns a Europe region request into seats.aero's EUR multi-city search code", async () => {
    mockPlannerResponse({
      origins: ["Chicago"],
      destinations: [],
      destinationRegion: "Europe",
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["ORD", "MDW"],
      label: "Chicago",
    } as never);

    const result = await planSearch(stateWith("anywhere in Europe from Chicago"));
    expect(planOf(result)?.destinations).toEqual(["EUR"]);
    expect(planOf(result)?.destinationRegion).toBe("Europe");
  });

  it("drops mileage-program identifiers that seats.aero does not support", async () => {
    mockPlannerResponse({
      origins: ["USA"],
      destinations: [],
      destinationRegion: "Europe",
      programs: ["aeroplan", "avianca", "lifemiles"],
    });
    vi.mocked(resolveLocation).mockReturnValue({
      kind: "airports",
      iatas: ["USA"],
      label: "United States — major airports",
    } as never);

    const result = await planSearch(stateWith("USA to Europe"));

    expect(planOf(result)?.programs).toEqual(["aeroplan", "lifemiles"]);
  });
});
