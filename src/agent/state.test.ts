import { describe, it, expect, vi } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseChannel, BinaryOperatorAggregate } from "@langchain/langgraph";
import { AgentState, type SearchPlan } from "./state";

// `Annotation.Root(...).spec[key]` is typed as `BaseChannel`, but at runtime
// (@langchain/langgraph@1.4.9) it is always the BinaryOperatorAggregate
// instance that `Annotation<T>({ reducer, default })` constructs, exposing
// the reducer/default functions as `.operator` / `.initialValueFactory` (not
// `.reducer` / `.default`, as the plan's Step 1 draft assumed). This narrows
// the type to match the documented reducer-channel shape.
const asAggregate = <V, U>(channel: BaseChannel<V, U>) =>
  channel as unknown as BinaryOperatorAggregate<V, U>;

describe("AgentState", () => {
  it("appends messages rather than replacing them", () => {
    const spec = asAggregate(AgentState.spec.messages);
    // messagesStateReducer mutates lc_kwargs.id on each message, so it needs
    // real BaseMessage instances rather than the plan's bare-object fakes
    // (which crash: `Cannot set properties of undefined (setting 'id')`).
    const merged = spec.operator(
      [new HumanMessage("a")],
      [new AIMessage("b")],
    );
    expect(merged).toHaveLength(2);
  });

  it("replaces awardResults rather than appending, so a re-search does not duplicate", () => {
    const spec = asAggregate(AgentState.spec.awardResults);
    const merged = spec.operator([{ availabilityId: "a" } as never], [
      { availabilityId: "b" } as never,
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].availabilityId).toBe("b");
  });

  it("defaults revisionCount to zero", () => {
    expect(asAggregate(AgentState.spec.revisionCount).initialValueFactory?.()).toBe(0);
  });

  it("increments revisionCount by addition so the retry budget is countable", () => {
    const spec = asAggregate(AgentState.spec.revisionCount);
    expect(spec.operator(0, 1)).toBe(1);
    expect(spec.operator(1, 1)).toBe(2);
  });

  it("defaults collections to empty arrays", () => {
    expect(asAggregate(AgentState.spec.kbDocs).initialValueFactory?.()).toEqual([]);
    expect(asAggregate(AgentState.spec.violations).initialValueFactory?.()).toEqual([]);
  });
});

describe("searchPlan merge reducer", () => {
  const base: SearchPlan = {
    origins: ["ORD"],
    destinations: ["TLS"],
    startDate: "2026-09-15",
    endDate: "2026-09-18",
    cabins: ["business", "first"],
    nonstopOnly: false,
    programs: [],
  };

  it("carries forward sticky fields the update omits", () => {
    const merged = asAggregate(AgentState.spec.searchPlan).operator(base, {
      origins: ["JFK"],
    })!;
    expect(merged.destinations).toEqual(["TLS"]);
    expect(merged.cabins).toEqual(["business", "first"]);
    expect(merged.startDate).toBe("2026-09-15");
    expect(merged.endDate).toBe("2026-09-18");
    expect(merged.origins).toEqual(["JFK"]);
  });

  it("overwrites a sticky field when the update provides a real value, including explicit false/empty array", () => {
    const merged = asAggregate(AgentState.spec.searchPlan).operator(
      { ...base, nonstopOnly: true },
      { nonstopOnly: false, destinations: [] },
    )!;
    expect(merged.nonstopOnly).toBe(false);
    expect(merged.destinations).toEqual([]);
  });

  it("always resets per-turn diagnostic fields to the update's value, never carrying them forward", () => {
    const withDiagnostics: SearchPlan = {
      ...base,
      rationale: "old rationale",
      unresolvedPlaces: ["Nowhereville"],
    };
    const merged = asAggregate(AgentState.spec.searchPlan).operator(withDiagnostics, {})!;
    expect(merged.rationale).toBeUndefined();
    expect(merged.unresolvedPlaces).toBeUndefined();
  });

  it("defaults startDate/endDate to today..+60d only when neither current nor update has dates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T00:00:00Z"));
    try {
      const merged = asAggregate(AgentState.spec.searchPlan).operator(null, {
        origins: ["ORD"],
      })!;
      expect(merged.startDate).toBe("2026-08-14");
      expect(merged.endDate).toBe("2026-10-13");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps prior dates when current has them and the update omits them", () => {
    const merged = asAggregate(AgentState.spec.searchPlan).operator(base, {})!;
    expect(merged.startDate).toBe("2026-09-15");
    expect(merged.endDate).toBe("2026-09-18");
  });

  it("treats a null update (from guard.ts until Task 5) as no-op, preserving all sticky fields", () => {
    // Until Task 5 removes guard.ts's RESET_TURN_STATE's `searchPlan: null`,
    // guard_input emits null on every turn. Treating it as "no fields specified"
    // preserves the previous turn's plan, maintaining carry-forward semantics.
    const merged = asAggregate(AgentState.spec.searchPlan).operator(base, null)!;
    expect(merged.origins).toEqual(["ORD"]);
    expect(merged.destinations).toEqual(["TLS"]);
    expect(merged.startDate).toBe("2026-09-15");
    expect(merged.endDate).toBe("2026-09-18");
    expect(merged.cabins).toEqual(["business", "first"]);
    expect(merged.nonstopOnly).toBe(false);
    expect(merged.programs).toEqual([]);
  });
});
