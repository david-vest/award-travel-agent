// src/agent/state-carryover.test.ts
//
// Regression test for the state-carryover bugs observed in LangSmith thread
// b9c93207-e9ff-496b-a20f-ebbb5f75bb71: a business/first request to Toulouse
// with explicit dates lost its destination, dates, and cabin restriction
// across an origin-only follow-up ("USA is valid, seats.aero accepts it")
// and a broad multi-airport follow-up, before the user had to manually
// restate the cabin filter. This drives plan-search/plan-discovery's real
// code through an equivalent turn sequence and applies each turn's output
// through the actual searchPlan reducer (state.ts's mergeSearchPlan), the
// same path the checkpointer takes in production.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseChannel, BinaryOperatorAggregate } from "@langchain/langgraph";
import { AgentState, type AgentStateType, type SearchPlan } from "./state";

vi.mock("./models", () => ({ chat: vi.fn() }));
vi.mock("../tools/locations/resolve", () => ({ resolveLocation: vi.fn() }));

import { chat } from "./models";
import { resolveLocation } from "../tools/locations/resolve";
import { planSearch } from "./nodes/plan-search";
import { planDiscovery } from "./nodes/plan-discovery";

const asAggregate = <V, U>(channel: BaseChannel<V, U>) =>
  channel as unknown as BinaryOperatorAggregate<V, U>;

function mockPlannerResponse(result: unknown) {
  const invoke = vi.fn().mockResolvedValue(result);
  const withStructuredOutput = vi.fn().mockReturnValue({ invoke });
  (chat as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ withStructuredOutput });
}

function conversationWith(...turns: string[]): AgentStateType {
  const messages = turns.flatMap((t, i) =>
    i === turns.length - 1
      ? [new HumanMessage(t)]
      : [new HumanMessage(t), new AIMessage("...")],
  );
  return { messages } as AgentStateType;
}

/**
 * Runs an update through the real searchPlan reducer, same as the
 * checkpointer would. The channel's declared value type is `SearchPlan |
 * null` (matching state.ts's Annotation), but mergeSearchPlan always
 * returns a real SearchPlan, never null — same non-null narrowing
 * state.test.ts uses at each `.operator(...)` call.
 */
function applyUpdate(current: SearchPlan | null, update: Partial<SearchPlan>): SearchPlan {
  return asAggregate(AgentState.spec.searchPlan).operator(current, update)!;
}

describe("[REGRESSION] search-plan survives a multi-turn conversation like the observed bug trace", () => {
  beforeEach(() => {
    vi.mocked(chat).mockReset();
    vi.mocked(resolveLocation).mockReset();
  });

  it("keeps destination, dates, and cabin across an intervening origin-only and discovery-style turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T00:00:00Z"));
    try {
      // Turn 1: full request with explicit destination, dates, and cabin.
      vi.mocked(resolveLocation).mockImplementation((q: string) =>
        q === "Toulouse"
          ? { kind: "airports", iatas: ["TLS"], label: "Toulouse" }
          : { kind: "unknown", query: q },
      );
      mockPlannerResponse({
        destinations: ["Toulouse"],
        cabins: ["business", "first"],
        startDate: "2026-09-15",
        endDate: "2026-09-18",
      });
      let plan = applyUpdate(
        null,
        (
          await planSearch(
            conversationWith(
              "Find any business or first flight to Toulouse between September 15th-18th 2026",
            ),
          )
        ).searchPlan as Partial<SearchPlan>,
      );
      expect(plan.destinations).toEqual(["TLS"]);
      expect(plan.cabins).toEqual(["business", "first"]);
      expect(plan.startDate).toBe("2026-09-15");

      // Turn 2: origin-only follow-up, mirroring "USA is valid, seats.aero accepts it".
      vi.mocked(resolveLocation).mockReturnValue({
        kind: "airports",
        iatas: ["SFO", "LAX", "JFK", "EWR", "ORD", "ATL", "IAD"],
        label: "United States",
      });
      mockPlannerResponse({ origins: ["USA"] });
      plan = applyUpdate(
        plan,
        (
          await planSearch(
            conversationWith(
              "Find any business or first flight to Toulouse between September 15th-18th 2026",
              "USA is valid, seats.aero accepts it",
            ),
          )
        ).searchPlan as Partial<SearchPlan>,
      );
      expect(plan.destinations).toEqual(["TLS"]);
      expect(plan.cabins).toEqual(["business", "first"]);
      expect(plan.startDate).toBe("2026-09-15");
      expect(plan.origins.length).toBeGreaterThan(0);

      // Turn 3: a broad, discovery-style follow-up naming a lot of airports —
      // mentions no destination, dates, or cabin at all.
      mockPlannerResponse({
        probes: [{ program: "flyingblue", destinationRegion: "Europe", cabin: "business" }],
      });
      plan = applyUpdate(
        plan,
        (
          await planDiscovery(
            conversationWith(
              "Find any business or first flight to Toulouse between September 15th-18th 2026",
              "USA is valid, seats.aero accepts it",
              "Look at ORD, JFK, MIA, ATL, BOS, PHL, DFW, IAH to CDG, LHR, FRA, BCN, MAD, CPH, MUC, VIE, Zurich",
            ),
          )
        ).searchPlan as Partial<SearchPlan>,
      );
      expect(plan.destinations).toEqual(["TLS"]);
      expect(plan.startDate).toBe("2026-09-15");
      expect(plan.endDate).toBe("2026-09-18");

      // Turn 4: user re-asserts the cabin restriction alone, as they had to
      // in the real trace ("Only look at Business or first").
      mockPlannerResponse({ cabins: ["business", "first"] });
      plan = applyUpdate(
        plan,
        (
          await planSearch(conversationWith("Only look at Business or first"))
        ).searchPlan as Partial<SearchPlan>,
      );
      expect(plan.destinations).toEqual(["TLS"]);
      expect(plan.cabins).toEqual(["business", "first"]);
      expect(plan.startDate).toBe("2026-09-15");
      expect(plan.endDate).toBe("2026-09-18");
    } finally {
      vi.useRealTimers();
    }
  });
});
